import { WeixinBotDO as BaseWeixinBotDO } from "./weixin-bot.js";
import { sendTextMessage } from "./ilink.js";
import type { Env, WeixinAccountState } from "./types.js";

const ACCOUNT_KEY = "account";
const RETENTION_KEY = "retention.v1";
const MIB = 1024 * 1024;
const DEFAULT_RETENTION_LIMIT_BYTES = 700 * MIB;
const MIN_RETENTION_LIMIT_BYTES = 50 * MIB;
const MAX_RETENTION_LIMIT_BYTES = 700 * MIB;
const RETENTION_TARGET_RATIO = 0.9;
const CLEANUP_BATCH_SIZE = 20;
const MAX_CLEANUP_BATCHES = 50;

type RetentionState = {
  limitBytes: number;
  updatedAt?: string;
  lastCleanupAt?: string;
  totalDeletedMessages?: number;
  totalDeletedMediaBytes?: number;
};

type RetentionUsage = {
  messageBytes: number;
  mediaBytes: number;
  historyBytes: number;
  databaseBytes: number;
};

type CleanupRow = {
  message_ref: string;
  media_bytes: number;
};

function clampLimitBytes(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RETENTION_LIMIT_BYTES;
  return Math.min(MAX_RETENTION_LIMIT_BYTES, Math.max(MIN_RETENTION_LIMIT_BYTES, Math.trunc(numeric)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WeixinBotDO extends BaseWeixinBotDO {
  private async retentionState(): Promise<RetentionState> {
    const stored = await this.ctx.storage.get<RetentionState>(RETENTION_KEY);
    return {
      ...(stored || {}),
      limitBytes: clampLimitBytes(stored?.limitBytes),
    };
  }

  private historyUsage(): RetentionUsage {
    const messageRow = this.ctx.storage.sql.exec<{ bytes: number }>(`
      SELECT COALESCE(SUM(
        LENGTH(CAST(COALESCE(source_id,'') AS BLOB)) +
        LENGTH(CAST(COALESCE(text,'') AS BLOB)) +
        LENGTH(CAST(COALESCE(context_token,'') AS BLOB)) +
        LENGTH(CAST(COALESCE(from_user_id,'') AS BLOB)) +
        LENGTH(CAST(COALESCE(reply_to,'') AS BLOB)) +
        LENGTH(CAST(COALESCE(metadata_json,'') AS BLOB)) +
        LENGTH(CAST(COALESCE(external_ids_json,'') AS BLOB)) +
        LENGTH(CAST(COALESCE(error,'') AS BLOB)) + 512
      ),0) AS bytes FROM messages
    `).toArray()[0];
    const mediaRow = this.ctx.storage.sql.exec<{ count: number; bytes: number; chunks: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes, COALESCE(SUM(chunk_count),0) AS chunks FROM media_objects",
    ).toArray()[0];
    const messageBytes = Number(messageRow?.bytes || 0);
    const mediaBytes = Number(mediaRow?.bytes || 0);
    const mediaOverhead = Number(mediaRow?.count || 0) * 256 + Number(mediaRow?.chunks || 0) * 128;
    return {
      messageBytes,
      mediaBytes,
      historyBytes: messageBytes + mediaBytes + mediaOverhead,
      databaseBytes: Number(this.ctx.storage.sql.databaseSize || 0),
    };
  }

  private deleteMessageBatch(messageRefs: string[]): void {
    if (!messageRefs.length) return;
    const placeholders = messageRefs.map(() => "?").join(",");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM media_chunks WHERE media_ref IN (SELECT media_ref FROM media_objects WHERE message_ref IN (${placeholders}))`,
        ...messageRefs,
      );
      this.ctx.storage.sql.exec(`DELETE FROM media_objects WHERE message_ref IN (${placeholders})`, ...messageRefs);
      this.ctx.storage.sql.exec(`DELETE FROM messages WHERE message_ref IN (${placeholders})`, ...messageRefs);
    });
  }

  private async notifyCleanup(summary: {
    deletedMessages: number;
    deletedMediaBytes: number;
    afterBytes: number;
    limitBytes: number;
  }): Promise<void> {
    try {
      const account = await this.ctx.storage.get<WeixinAccountState>(ACCOUNT_KEY);
      if (!account?.token || !account.userId) return;
      const mb = (bytes: number) => (bytes / MIB).toFixed(1);
      await sendTextMessage(this.env, {
        baseUrl: account.baseUrl,
        token: account.token,
        toUserId: account.userId,
        contextToken: account.contextToken,
        text: `微信 MCP 已自动清理历史数据：删除 ${summary.deletedMessages} 条较早的已处理消息及其附件，附件约 ${mb(summary.deletedMediaBytes)} MB。当前保留数据约 ${mb(summary.afterBytes)} MB，配置上限 ${mb(summary.limitBytes)} MB。尚未处理的微信消息不会被自动删除。`,
      });
    } catch (error) {
      console.error("WeixinBotDO retention notification failed:", errorMessage(error));
    }
  }

  private async enforceRetention() {
    const retention = await this.retentionState();
    let usage = this.historyUsage();
    const beforeBytes = usage.historyBytes;
    if (beforeBytes <= retention.limitBytes) {
      return {
        pruned: false,
        beforeBytes,
        afterBytes: beforeBytes,
        limitBytes: retention.limitBytes,
        deletedMessages: 0,
        deletedMediaBytes: 0,
      };
    }

    const targetBytes = Math.floor(retention.limitBytes * RETENTION_TARGET_RATIO);
    let deletedMessages = 0;
    let deletedMediaBytes = 0;

    for (let cycle = 0; cycle < MAX_CLEANUP_BATCHES && usage.historyBytes > targetBytes; cycle += 1) {
      const rows = this.ctx.storage.sql.exec<CleanupRow>(`
        SELECT m.message_ref AS message_ref, COALESCE(SUM(mo.size_bytes),0) AS media_bytes
        FROM messages m
        LEFT JOIN media_objects mo ON mo.message_ref=m.message_ref
        WHERE NOT (m.direction='inbound' AND m.status='pending')
        GROUP BY m.message_ref
        ORDER BY m.created_at ASC
        LIMIT ?
      `, CLEANUP_BATCH_SIZE).toArray();
      if (!rows.length) break;
      const refs = rows.map((row) => row.message_ref);
      deletedMessages += refs.length;
      deletedMediaBytes += rows.reduce((sum, row) => sum + Number(row.media_bytes || 0), 0);
      this.deleteMessageBatch(refs);
      usage = this.historyUsage();
      if (rows.length < CLEANUP_BATCH_SIZE) break;
    }

    if (deletedMessages > 0) {
      retention.lastCleanupAt = new Date().toISOString();
      retention.totalDeletedMessages = Number(retention.totalDeletedMessages || 0) + deletedMessages;
      retention.totalDeletedMediaBytes = Number(retention.totalDeletedMediaBytes || 0) + deletedMediaBytes;
      await this.ctx.storage.put(RETENTION_KEY, retention);
      await this.notifyCleanup({
        deletedMessages,
        deletedMediaBytes,
        afterBytes: usage.historyBytes,
        limitBytes: retention.limitBytes,
      });
    }

    return {
      pruned: deletedMessages > 0,
      beforeBytes,
      afterBytes: usage.historyBytes,
      limitBytes: retention.limitBytes,
      targetBytes,
      deletedMessages,
      deletedMediaBytes,
      pendingProtected: usage.historyBytes > retention.limitBytes && deletedMessages === 0,
    };
  }

  private async safeEnforceRetention() {
    try {
      return await this.enforceRetention();
    } catch (error) {
      console.error("WeixinBotDO retention check failed:", errorMessage(error));
      return { pruned: false, error: errorMessage(error) };
    }
  }

  private async setRetention(body: Record<string, unknown>) {
    const limitMB = Number(body.limitMB);
    if (!Number.isFinite(limitMB)) throw new Error("历史数据保留上限必须是数字");
    const limitBytes = Math.round(limitMB * MIB);
    if (limitBytes < MIN_RETENTION_LIMIT_BYTES || limitBytes > MAX_RETENTION_LIMIT_BYTES) {
      throw new Error("历史数据保留上限范围为 50-700 MB/用户");
    }
    const retention = await this.retentionState();
    retention.limitBytes = limitBytes;
    retention.updatedAt = new Date().toISOString();
    await this.ctx.storage.put(RETENTION_KEY, retention);
    const cleanup = await this.safeEnforceRetention();
    return { success: true, retention: await this.retentionState(), usage: this.historyUsage(), cleanup };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/retention") {
      return Response.json({ retention: await this.retentionState(), usage: this.historyUsage() });
    }
    if (request.method === "POST" && url.pathname === "/retention") {
      try {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        return Response.json(await this.setRetention(body));
      } catch (error) {
        return Response.json({ error: "retention_error", message: errorMessage(error) }, { status: 400 });
      }
    }

    const response = await super.fetch(request);

    if (request.method === "GET" && url.pathname === "/status" && response.ok) {
      try {
        const data = await response.json() as Record<string, unknown>;
        const retention = await this.retentionState();
        const usage = this.historyUsage();
        return Response.json({
          ...data,
          mediaSoftQuotaBytes: retention.limitBytes,
          historyBytes: usage.historyBytes,
          databaseBytes: usage.databaseBytes,
          historyLimitBytes: retention.limitBytes,
          historyTargetBytes: Math.floor(retention.limitBytes * RETENTION_TARGET_RATIO),
          retentionLastCleanupAt: retention.lastCleanupAt || null,
          retentionDeletedMessages: Number(retention.totalDeletedMessages || 0),
          retentionDeletedMediaBytes: Number(retention.totalDeletedMediaBytes || 0),
        });
      } catch (error) {
        console.error("WeixinBotDO status retention augmentation failed:", errorMessage(error));
      }
    }

    if (response.ok && request.method === "POST" && ["/send", "/send-media", "/poll", "/reply"].includes(url.pathname)) {
      await this.safeEnforceRetention();
    }

    return response;
  }
}
