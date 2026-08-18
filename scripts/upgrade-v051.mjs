import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);
function rep(s, from, to, label) {
  if (!s.includes(from)) throw new Error(`patch not found: ${label}`);
  return s.replace(from, to);
}
function re(s, pattern, to, label) {
  if (!pattern.test(s)) throw new Error(`regex patch not found: ${label}`);
  pattern.lastIndex = 0;
  return s.replace(pattern, to);
}

const core = `export const VERSION = "0.5.1";
export const MIB = 1024 * 1024;
export const DEFAULT_RETENTION_LIMIT_BYTES = 700 * MIB;
export const MIN_RETENTION_LIMIT_BYTES = 50 * MIB;
export const MAX_RETENTION_LIMIT_BYTES = 700 * MIB;
export const RETENTION_TARGET_RATIO = 0.9;
export const SAFE_ACCOUNT_HISTORY_BUDGET_BYTES = 4 * 1024 * MIB;
export const SEND_CHUNK_SIZE = 1800;
export const MAX_SEND_CHUNKS = 40;
export const SEND_CHUNK_DELAY_MS = 300;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function splitText(text: string, max = SEND_CHUNK_SIZE): string[] {
  const source = text.trim();
  if (!source) return [];
  if (source.length <= max) return [source];
  const chunks: string[] = [];
  let rest = source;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\\n", max);
    if (cut < Math.floor(max * 0.6)) cut = rest.lastIndexOf("。", max) + 1;
    if (cut < Math.floor(max * 0.6)) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

export function normalizeProfileId(value: unknown): string {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
    throw new Error("用户标识只能使用小写字母、数字、_、-，长度 1-32，且必须以字母或数字开头");
  }
  return id;
}

export function normalizeHttpsBaseUrl(value: string): string {
  const raw = String(value || "").trim().replace(/\\/$/, "");
  const candidate = /^https?:\\/\\//i.test(raw) ? raw : \\`https://\\${raw}\\`;
  const url = new URL(candidate);
  if (url.protocol !== "https:") throw new Error("微信 iLink/CDN 地址必须使用 HTTPS");
  return url.toString().replace(/\\/$/, "");
}

export function retentionTargetBytes(limitBytes: number): number {
  return Math.floor(limitBytes * RETENTION_TARGET_RATIO);
}

export function isWithinSafeHistoryBudget(limits: number[]): boolean {
  return limits.reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0) <= SAFE_ACCOUNT_HISTORY_BUDGET_BYTES;
}
`;
write('src/core.ts', core);

const retention = `import {
  DEFAULT_RETENTION_LIMIT_BYTES,
  MAX_RETENTION_LIMIT_BYTES,
  MIN_RETENTION_LIMIT_BYTES,
  MIB,
  retentionTargetBytes,
} from "./core.js";

const RETENTION_KEY = "retention.v1";
const CLEANUP_BATCH_SIZE = 20;
const MAX_CLEANUP_BATCHES = 100;

export type RetentionState = {
  limitBytes: number;
  updatedAt?: string;
  lastCleanupAt?: string;
  totalDeletedMessages?: number;
  totalDeletedMediaBytes?: number;
};

export type RetentionUsage = {
  messageBytes: number;
  mediaBytes: number;
  historyBytes: number;
  databaseBytes: number;
};

export type RetentionCleanupSummary = {
  pruned: boolean;
  beforeBytes: number;
  afterBytes: number;
  limitBytes: number;
  targetBytes: number;
  deletedMessages: number;
  deletedMediaBytes: number;
  pendingProtected?: boolean;
};

type CleanupRow = { message_ref: string; media_bytes: number };

function clampLimitBytes(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RETENTION_LIMIT_BYTES;
  return Math.min(MAX_RETENTION_LIMIT_BYTES, Math.max(MIN_RETENTION_LIMIT_BYTES, Math.trunc(numeric)));
}

export async function loadRetention(storage: any): Promise<RetentionState> {
  const stored = await storage.get<RetentionState>(RETENTION_KEY);
  return { ...(stored || {}), limitBytes: clampLimitBytes(stored?.limitBytes) };
}

export function historyUsage(storage: any): RetentionUsage {
  const messageRow = storage.sql.exec<{ bytes: number }>(\\`
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
  \\`).toArray()[0];
  const mediaRow = storage.sql.exec<{ count: number; bytes: number; chunks: number }>(
    "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes, COALESCE(SUM(chunk_count),0) AS chunks FROM media_objects",
  ).toArray()[0];
  const messageBytes = Number(messageRow?.bytes || 0);
  const mediaBytes = Number(mediaRow?.bytes || 0);
  const mediaOverhead = Number(mediaRow?.count || 0) * 256 + Number(mediaRow?.chunks || 0) * 128;
  return {
    messageBytes,
    mediaBytes,
    historyBytes: messageBytes + mediaBytes + mediaOverhead,
    databaseBytes: Number(storage.sql.databaseSize || 0),
  };
}

function deleteBatch(storage: any, refs: string[]): void {
  if (!refs.length) return;
  const placeholders = refs.map(() => "?").join(",");
  storage.transactionSync(() => {
    storage.sql.exec(\\`DELETE FROM media_chunks WHERE media_ref IN (SELECT media_ref FROM media_objects WHERE message_ref IN (\\${placeholders}))\\`, ...refs);
    storage.sql.exec(\\`DELETE FROM media_objects WHERE message_ref IN (\\${placeholders})\\`, ...refs);
    storage.sql.exec(\\`DELETE FROM messages WHERE message_ref IN (\\${placeholders})\\`, ...refs);
  });
}

export async function retentionStatus(storage: any) {
  const retention = await loadRetention(storage);
  const usage = historyUsage(storage);
  return {
    retention,
    usage,
    targetBytes: retentionTargetBytes(retention.limitBytes),
  };
}

export async function enforceRetention(
  storage: any,
  notify?: (summary: RetentionCleanupSummary) => Promise<void>,
): Promise<RetentionCleanupSummary> {
  const retention = await loadRetention(storage);
  let usage = historyUsage(storage);
  const beforeBytes = usage.historyBytes;
  const targetBytes = retentionTargetBytes(retention.limitBytes);
  let deletedMessages = 0;
  let deletedMediaBytes = 0;
  if (beforeBytes <= retention.limitBytes) {
    return { pruned: false, beforeBytes, afterBytes: beforeBytes, limitBytes: retention.limitBytes, targetBytes, deletedMessages, deletedMediaBytes };
  }
  for (let cycle = 0; cycle < MAX_CLEANUP_BATCHES && usage.historyBytes > targetBytes; cycle += 1) {
    const rows = storage.sql.exec<CleanupRow>(\\`
      SELECT m.message_ref AS message_ref, COALESCE(SUM(mo.size_bytes),0) AS media_bytes
      FROM messages m
      LEFT JOIN media_objects mo ON mo.message_ref=m.message_ref
      WHERE NOT (m.direction='inbound' AND m.status='pending')
      GROUP BY m.message_ref
      ORDER BY m.created_at ASC
      LIMIT ?
    \\`, CLEANUP_BATCH_SIZE).toArray();
    if (!rows.length) break;
    const refs = rows.map((row: CleanupRow) => row.message_ref);
    deletedMessages += refs.length;
    deletedMediaBytes += rows.reduce((sum: number, row: CleanupRow) => sum + Number(row.media_bytes || 0), 0);
    deleteBatch(storage, refs);
    usage = historyUsage(storage);
    if (rows.length < CLEANUP_BATCH_SIZE) break;
  }
  const summary: RetentionCleanupSummary = {
    pruned: deletedMessages > 0,
    beforeBytes,
    afterBytes: usage.historyBytes,
    limitBytes: retention.limitBytes,
    targetBytes,
    deletedMessages,
    deletedMediaBytes,
    pendingProtected: usage.historyBytes > retention.limitBytes && deletedMessages === 0,
  };
  if (deletedMessages > 0) {
    retention.lastCleanupAt = new Date().toISOString();
    retention.totalDeletedMessages = Number(retention.totalDeletedMessages || 0) + deletedMessages;
    retention.totalDeletedMediaBytes = Number(retention.totalDeletedMediaBytes || 0) + deletedMediaBytes;
    await storage.put(RETENTION_KEY, retention);
    if (notify) await notify(summary);
  }
  return summary;
}

export async function setRetentionLimit(storage: any, limitMB: unknown, notify?: (summary: RetentionCleanupSummary) => Promise<void>) {
  const numeric = Number(limitMB);
  if (!Number.isFinite(numeric)) throw new Error("历史数据保留上限必须是数字");
  const limitBytes = Math.round(numeric * MIB);
  if (limitBytes < MIN_RETENTION_LIMIT_BYTES || limitBytes > MAX_RETENTION_LIMIT_BYTES) {
    throw new Error("历史数据保留上限范围为 50-700 MB/用户");
  }
  const state = await loadRetention(storage);
  state.limitBytes = limitBytes;
  state.updatedAt = new Date().toISOString();
  await storage.put(RETENTION_KEY, state);
  const cleanup = await enforceRetention(storage, notify);
  return { success: true, retention: await loadRetention(storage), usage: historyUsage(storage), cleanup };
}

export async function clearRetentionState(storage: any): Promise<void> {
  await storage.delete(RETENTION_KEY);
}
`;
write('src/retention.ts', retention);

// ilink.ts
let s = read('src/ilink.ts');
s = rep(s, 'import { Buffer } from "node:buffer";\n', 'import { Buffer } from "node:buffer";\nimport { VERSION, normalizeHttpsBaseUrl } from "./core.js";\n', 'ilink core import');
s = rep(s, 'const BOT_AGENT = "weixin-mcp-worker/0.4.0";', 'const BOT_AGENT = `weixin-mcp-worker/${VERSION}`;', 'bot agent version');
s = re(s, /function normalizeBaseUrl\(value\?: string\): string \{[\s\S]*?\n\}/, 'function normalizeBaseUrl(value?: string): string {\n  return normalizeHttpsBaseUrl(String(value || ILINK_FIXED_BASE_URL));\n}', 'https base url');
s = rep(s, 'async function sendItem(\n', 'export class WeixinSendError extends Error {\n  constructor(public readonly ret: number, message: string) {\n    super(message);\n    this.name = "WeixinSendError";\n  }\n}\n\nasync function sendItem(\n', 'send error class');
s = rep(s, '    throw new Error(`Weixin send failed: ret=${response.ret}, errmsg=${response.errmsg || "unknown"}`);', '    throw new WeixinSendError(response.ret, `Weixin send failed: ret=${response.ret}, errmsg=${response.errmsg || "unknown"}`);', 'structured send error');
s = rep(s, '  const target = upload.upload_full_url?.trim()\n    || (upload.upload_param ? `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}` : "");\n  if (!target) throw new Error("微信 getUploadUrl 未返回上传地址");', '  const rawTarget = upload.upload_full_url?.trim()\n    || (upload.upload_param ? `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}` : "");\n  if (!rawTarget) throw new Error("微信 getUploadUrl 未返回上传地址");\n  const target = normalizeHttpsBaseUrl(rawTarget);', 'https upload target');
write('src/ilink.ts', s);

// media.ts
s = read('src/media.ts');
s = rep(s, 'import { Buffer } from "node:buffer";\n', 'import { Buffer } from "node:buffer";\nimport { normalizeHttpsBaseUrl } from "./core.js";\n', 'media core import');
s = s.replace('export const MEDIA_SOFT_QUOTA_BYTES = 750 * 1024 * 1024;\n', '');
s = rep(s, '  if (fullUrl?.trim()) return fullUrl.trim();', '  if (fullUrl?.trim()) return normalizeHttpsBaseUrl(fullUrl.trim());', 'https media full url');
write('src/media.ts', s);

// weixin-bot.ts
s = read('src/weixin-bot.ts');
s = rep(s, '  uploadMediaBuffer,\n} from "./ilink.js";', '  uploadMediaBuffer,\n  WeixinSendError,\n} from "./ilink.js";', 'bot import send error');
s = s.replace('  MEDIA_SOFT_QUOTA_BYTES,\n', '');
s = rep(s, '} from "./media.js";\n', '} from "./media.js";\nimport { MAX_SEND_CHUNKS, SEND_CHUNK_DELAY_MS, normalizeProfileId, sleep, splitText } from "./core.js";\nimport { clearRetentionState, enforceRetention, historyUsage, retentionStatus, setRetentionLimit, type RetentionCleanupSummary } from "./retention.js";\n', 'bot core retention imports');
s = s.replace('const SEND_CHUNK_SIZE = 3500;\n', '');
s = re(s, /function splitText\(text: string, max = SEND_CHUNK_SIZE\): string\[] \{[\s\S]*?\n\}\n\n/, '', 'remove local splitText');
s = re(s, /function normalizeProfileId\(value: unknown\): string \{[\s\S]*?\n\}\n\n/, '', 'remove local normalizeProfileId');
s = rep(s, '  private async syncState(): Promise<WeixinSyncState> {\n    return (await this.ctx.storage.get<WeixinSyncState>(SYNC_KEY)) || { getUpdatesBuf: "" };\n  }\n', `  private async syncState(): Promise<WeixinSyncState> {
    return (await this.ctx.storage.get<WeixinSyncState>(SYNC_KEY)) || { getUpdatesBuf: "" };
  }

  private async notifyRetentionCleanup(summary: RetentionCleanupSummary): Promise<void> {
    const account = await this.account();
    if (!account?.token || !account.userId) return;
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    try {
      await this.sendTextWithRecovery(account, account.userId,
        \\`微信 MCP 已自动清理历史数据：删除 \\${summary.deletedMessages} 条较早的已处理消息及其附件，附件约 \\${mb(summary.deletedMediaBytes)} MB。当前保留数据约 \\${mb(summary.afterBytes)} MB，配置上限 \\${mb(summary.limitBytes)} MB。尚未处理的微信消息不会被自动删除。\\`);
    } catch (error) {
      console.error("WeixinBotDO retention notification failed:", errorMessage(error));
    }
  }

  private async safeEnforceRetention() {
    this.ensureSchema();
    try {
      return await enforceRetention(this.ctx.storage, (summary) => this.notifyRetentionCleanup(summary));
    } catch (error) {
      console.error("WeixinBotDO retention check failed:", errorMessage(error));
      return { pruned: false, error: errorMessage(error) };
    }
  }

  private async sendWithContextRecovery<T>(
    account: WeixinAccountState,
    preferredContextToken: string | undefined,
    sender: (contextToken?: string) => Promise<T>,
  ): Promise<{ value: T; contextToken?: string; recovery: "none" | "refreshed" | "without_context" }> {
    const initial = preferredContextToken || account.contextToken;
    try {
      return { value: await sender(initial), contextToken: initial, recovery: "none" };
    } catch (error) {
      if (!(error instanceof WeixinSendError) || error.ret !== -2) throw error;
    }

    try { await this.poll(20); } catch (pollError) {
      console.warn("WeixinBotDO context refresh poll failed:", errorMessage(pollError));
    }
    const latest = (await this.account()) || account;
    if (latest.contextToken && latest.contextToken !== initial) {
      try {
        const value = await sender(latest.contextToken);
        account.contextToken = latest.contextToken;
        return { value, contextToken: latest.contextToken, recovery: "refreshed" };
      } catch (error) {
        if (!(error instanceof WeixinSendError) || error.ret !== -2) throw error;
      }
    }

    try {
      const value = await sender(undefined);
      if (account.contextToken === initial) delete account.contextToken;
      await this.ctx.storage.put(ACCOUNT_KEY, account);
      return { value, contextToken: undefined, recovery: "without_context" };
    } catch (error) {
      if (error instanceof WeixinSendError && error.ret === -2) {
        throw new Error("微信会话上下文已失效。请先在微信里给 ClawBot 发一条消息刷新会话，然后重试。");
      }
      throw error;
    }
  }

  private sendTextWithRecovery(account: WeixinAccountState, toUserId: string, text: string, contextToken?: string) {
    return this.sendWithContextRecovery(account, contextToken, (token) => sendTextMessage(this.env, {
      baseUrl: account.baseUrl, token: account.token, toUserId, text, contextToken: token,
    }));
  }
`, 'insert recovery retention methods');
s = rep(s, '    const [account, login, sync] = await Promise.all([this.account(), this.login(), this.syncState()]);', '    const [account, login, sync, retained] = await Promise.all([this.account(), this.login(), this.syncState(), retentionStatus(this.ctx.storage)]);', 'status retention promise');
s = s.replace('      mediaSoftQuotaBytes: MEDIA_SOFT_QUOTA_BYTES,\n', '');
s = rep(s, '      mediaSingleFileLimitBytes: MAX_MEDIA_BYTES,', '      mediaSingleFileLimitBytes: MAX_MEDIA_BYTES,\n      historyBytes: retained.usage.historyBytes,\n      databaseBytes: retained.usage.databaseBytes,\n      historyLimitBytes: retained.retention.limitBytes,\n      historyTargetBytes: retained.targetBytes,\n      retentionLastCleanupAt: retained.retention.lastCleanupAt || null,\n      retentionDeletedMessages: Number(retained.retention.totalDeletedMessages || 0),\n      retentionDeletedMediaBytes: Number(retained.retention.totalDeletedMediaBytes || 0),', 'status retention fields');
s = re(s, /    const usage = this\.mediaUsage\(\);\n    if \(usage\.bytes \+ media\.bytes\.byteLength > MEDIA_SOFT_QUOTA_BYTES\) \{[\s\S]*?\n    \}\n/, '', 'remove 750 media quota guard');
s = re(s, /        if \(\/媒体存储达到软上限\/\.test\(detail\)\) \{[\s\S]*?\n        \} else \{\n          await this\.alertStorageFull\(error\);\n        \}/, '        await this.alertStorageFull(error);', 'remove inbound 750 warning');
s = re(s, /          if \(\/媒体存储达到软上限\/\.test\(historyWarning\)\) await this\.alertText\([^;]+;\n          else await this\.alertStorageFull\(mediaError\);/, '          await this.alertStorageFull(mediaError);', 'remove outbound 750 warning');
s = s.replace(/if \(chunks\.length > 20\) throw new Error\("消息过长；单次最多发送约 7 万字符"\);/g, 'if (chunks.length > MAX_SEND_CHUNKS) throw new Error("消息过长；单次最多发送约 7 万字符");');
s = s.replace(/if \(chunks\.length > 20\) throw new Error\("回复过长；单次最多发送约 7 万字符"\);/g, 'if (chunks.length > MAX_SEND_CHUNKS) throw new Error("回复过长；单次最多发送约 7 万字符");');
s = s.replace(/if \(captions\.length > 20\) throw new Error\("caption 过长"\);/g, 'if (captions.length > MAX_SEND_CHUNKS) throw new Error("caption 过长");');
// text send loops
s = re(s, /      for \(const chunk of chunks\) \{\n        messageIds\.push\(await sendTextMessage\(this\.env, \{[\s\S]*?\n        \}\)\);\n      \}/, `      let contextToken = account.contextToken;
      let recovery = "none";
      for (let i = 0; i < chunks.length; i += 1) {
        const sent = await this.sendTextWithRecovery(account, account.userId, chunks[i], contextToken);
        messageIds.push(sent.value);
        contextToken = sent.contextToken;
        if (sent.recovery !== "none") recovery = sent.recovery;
        if (i < chunks.length - 1) await sleep(SEND_CHUNK_DELAY_MS);
      }`, 'send text resilient loop');
s = rep(s, '      return { success: true, messageRef: ref, recipient: maskId(account.userId), usedContextToken: Boolean(account.contextToken), chunks: chunks.length, messageIds };', '      const cleanup = await this.safeEnforceRetention();\n      return { success: true, messageRef: ref, recipient: maskId(account.userId), usedContextToken: Boolean(account.contextToken), chunks: chunks.length, messageIds, recovery, cleanup };', 'send cleanup result');
// caption loop
s = re(s, /        for \(const chunk of captions\) \{\n          messageIds\.push\(await sendTextMessage\(this\.env, \{[\s\S]*?\n          \}\)\);\n        \}/, `        let captionContext = account.contextToken;
        for (let i = 0; i < captions.length; i += 1) {
          const sent = await this.sendTextWithRecovery(account, account.userId, captions[i], captionContext);
          messageIds.push(sent.value);
          captionContext = sent.contextToken;
          if (i < captions.length - 1) await sleep(SEND_CHUNK_DELAY_MS);
        }
        if (captions.length) await sleep(SEND_CHUNK_DELAY_MS);`, 'caption resilient loop');
s = rep(s, '      messageIds.push(await sendUploadedMediaMessage(this.env, {\n        baseUrl: account.baseUrl,\n        token: account.token,\n        toUserId: account.userId,\n        kind,\n        uploaded,\n        fileName,\n        contextToken: account.contextToken,\n      }));', '      const mediaSent = await this.sendWithContextRecovery(account, account.contextToken, (contextToken) => sendUploadedMediaMessage(this.env, {\n        baseUrl: account.baseUrl, token: account.token, toUserId: account.userId, kind, uploaded, fileName, contextToken,\n      }));\n      messageIds.push(mediaSent.value);', 'media context recovery');
s = rep(s, '      return {\n        success: true,\n        messageRef: outboundRef,\n        kind,\n        fileName,\n        sizeBytes: bytes.byteLength,\n        messageIds,\n        historyWarning,\n      };', '      const cleanup = await this.safeEnforceRetention();\n      return { success: true, messageRef: outboundRef, kind, fileName, sizeBytes: bytes.byteLength, messageIds, historyWarning, cleanup };', 'media cleanup');
// reply loop
s = re(s, /      for \(const chunk of chunks\) \{\n        messageIds\.push\(await sendTextMessage\(this\.env, \{[\s\S]*?contextToken: row\.context_token \|\| account\.contextToken,[\s\S]*?\n        \}\)\);\n      \}/, `      let replyContext = row.context_token || account.contextToken;
      for (let i = 0; i < chunks.length; i += 1) {
        const sent = await this.sendTextWithRecovery(account, row.from_user_id, chunks[i], replyContext);
        messageIds.push(sent.value);
        replyContext = sent.contextToken;
        if (i < chunks.length - 1) await sleep(SEND_CHUNK_DELAY_MS);
      }`, 'reply resilient loop');
s = rep(s, '      return { success: true, alreadyReplied: false, messageRef, outboundMessageRef: outboundRef, chunks: chunks.length, messageIds, repliedAt };', '      const cleanup = await this.safeEnforceRetention();\n      return { success: true, alreadyReplied: false, messageRef, outboundMessageRef: outboundRef, chunks: chunks.length, messageIds, repliedAt, cleanup };', 'reply cleanup');
s = rep(s, '    const pending = this.pendingMessages(limit);', '    await this.safeEnforceRetention();\n    const pending = this.pendingMessages(limit);', 'poll cleanup');
s = rep(s, '  private async reset() {\n    this.ensureSchema();\n    await this.ctx.storage.delete([ACCOUNT_KEY, LOGIN_KEY, SYNC_KEY]);\n    this.clearMessages();\n    return { success: true };\n  }', '  private async reset() {\n    this.ensureSchema();\n    await this.ctx.storage.delete([ACCOUNT_KEY, LOGIN_KEY, SYNC_KEY]);\n    await clearRetentionState(this.ctx.storage);\n    this.clearMessages();\n    return { success: true };\n  }', 'reset retention');
s = rep(s, '      if (request.method === "GET" && url.pathname === "/status") return json(await this.status());', '      if (request.method === "GET" && url.pathname === "/status") return json(await this.status());\n      if (request.method === "GET" && url.pathname === "/retention") { this.ensureSchema(); return json(await retentionStatus(this.ctx.storage)); }', 'retention GET');
s = rep(s, '      if (url.pathname === "/registry/create") return json(await this.registryCreate(body));', '      if (url.pathname === "/registry/create") return json(await this.registryCreate(body));\n      if (url.pathname === "/retention") { this.ensureSchema(); return json(await setRetentionLimit(this.ctx.storage, body.limitMB, (summary) => this.notifyRetentionCleanup(summary))); }', 'retention POST');
write('src/weixin-bot.ts', s);

// index.ts
s = read('src/index.ts');
s = rep(s, 'import { Buffer } from "node:buffer";\n', 'import { Buffer } from "node:buffer";\nimport { DEFAULT_RETENTION_LIMIT_BYTES, MAX_RETENTION_LIMIT_BYTES, MIN_RETENTION_LIMIT_BYTES, MIB, SAFE_ACCOUNT_HISTORY_BUDGET_BYTES, VERSION, normalizeProfileId } from "./core.js";\n', 'index core import');
s = s.replace('const VERSION = "0.4.0";\n', '');
s = re(s, /function normalizeProfileId\(value: unknown\): string \{[\s\S]*?\n\}\n\n/, '', 'index remove normalize');
s = re(s, /async function usersWithStatus\(env: Env\) \{[\s\S]*?\n\}\n\nasync function resolveRecipients/, `async function usersWithStatus(env: Env) {
  const list = await profiles(env);
  const statuses = await Promise.all(list.map(async (user) => {
    try { return { ...user, status: await callUser(env, user.id, "/status", { method: "GET" }) }; }
    catch (error) { return { ...user, status: { connected: false, error: error instanceof Error ? error.message : String(error), historyLimitBytes: DEFAULT_RETENTION_LIMIT_BYTES, historyBytes: 0 } }; }
  }));
  const totalHistoryBytes = statuses.reduce((sum, u) => sum + Number((u.status as JsonObject).historyBytes || 0), 0);
  const totalHistoryLimitBytes = statuses.reduce((sum, u) => sum + Number((u.status as JsonObject).historyLimitBytes || DEFAULT_RETENTION_LIMIT_BYTES), 0);
  return { users: statuses, storagePlan: { totalHistoryBytes, totalHistoryLimitBytes, safeBudgetBytes: SAFE_ACCOUNT_HISTORY_BUDGET_BYTES, withinSafeBudget: totalHistoryLimitBytes <= SAFE_ACCOUNT_HISTORY_BUDGET_BYTES } };
}

async function resolveRecipients`, 'users storage plan');
s = re(s, /async function sendMediaToRecipients\([\s\S]*?\n\}\n\nasync function mediaToolResult/, `async function sendMediaToRecipients(
  env: Env,
  params: { recipients?: string[]; kind: SendableMediaKind; dataBase64?: string; sourceMediaRef?: string; mimeType?: string; fileName?: string; caption?: string },
) {
  const targets = await resolveRecipients(env, params.recipients);
  const source = await resolveMediaSource(env, params);
  const dataBase64 = Buffer.from(source.bytes).toString("base64");
  const results: JsonObject[] = [];
  for (const user of targets) {
    try {
      const response = await callUser(env, user.id, "/send-media", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: source.kind, dataBase64, mimeType: source.mimeType, fileName: source.fileName, caption: params.caption || "" }),
      });
      results.push({ user: { id: user.id, name: user.name }, success: true, ...response });
    } catch (error) {
      results.push({ user: { id: user.id, name: user.name }, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { success: results.every((item) => item.success), source: { kind: source.kind, mimeType: source.mimeType, fileName: source.fileName, sizeBytes: source.bytes.byteLength }, recipients: results };
}

async function mediaToolResult`, 'serial media send');
s = re(s, /async function aggregateMessages\(env: Env, limit: number\) \{[\s\S]*?\n\}\n\nasync function readGlobalMedia/, `async function aggregateMessages(env: Env, limit: number, offset: number) {
  const list = await profiles(env);
  const perUserNeed = Math.min(1000, Math.max(limit, limit + offset));
  const data = await Promise.all(list.map(async (user) => {
    try {
      const response = await callUser(env, user.id, \\`/messages?limit=\\${perUserNeed}&offset=0\\`, { method: "GET" });
      return { total: Number(response.total || 0), messages: (Array.isArray(response.messages) ? response.messages : []).map((message: JsonObject) => routeMessage(message, user)) };
    } catch { return { total: 0, messages: [] as JsonObject[] }; }
  }));
  const messages: JsonObject[] = data.flatMap((item) => item.messages);
  messages.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return { total: data.reduce((sum, item) => sum + item.total, 0), limit, offset, messages: messages.slice(offset, offset + limit) };
}

async function readGlobalMedia`, 'message pagination');
s = rep(s, '    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100));\n    return Response.json(await aggregateMessages(env, limit));', '    const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100));\n    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);\n    return Response.json(await aggregateMessages(env, limit, offset));', 'admin pagination params');
s = rep(s, '  if (pathname === "/admin/api/users/create") {\n    return Response.json(await callRegistry(env, "/registry/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));\n  }', `  if (pathname === "/admin/api/users/create") {
    const snapshot = await usersWithStatus(env);
    if (snapshot.storagePlan.totalHistoryLimitBytes + DEFAULT_RETENTION_LIMIT_BYTES > SAFE_ACCOUNT_HISTORY_BUDGET_BYTES) {
      throw new Error("新增用户会使本项目配置的历史保留上限超过 4GB 安全预算；请先在设置中降低现有用户的保留上限");
    }
    return Response.json(await callRegistry(env, "/registry/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }`, 'create budget guard');
s = rep(s, '  if (pathname === "/admin/api/users/update") {', `  if (pathname === "/admin/api/retention") {
    const userId = normalizeProfileId(body.userId);
    const limitMB = Number(body.limitMB);
    const limitBytes = Math.round(limitMB * MIB);
    if (!Number.isFinite(limitMB) || limitBytes < MIN_RETENTION_LIMIT_BYTES || limitBytes > MAX_RETENTION_LIMIT_BYTES) throw new Error("历史数据保留上限范围为 50-700 MB/用户");
    const snapshot = await usersWithStatus(env);
    const user = snapshot.users.find((item) => item.id === userId);
    if (!user) throw new Error(\\`微信用户 \\${userId} 不存在\\`);
    const oldLimit = Number((user.status as JsonObject).historyLimitBytes || DEFAULT_RETENTION_LIMIT_BYTES);
    const planned = snapshot.storagePlan.totalHistoryLimitBytes - oldLimit + limitBytes;
    if (planned > SAFE_ACCOUNT_HISTORY_BUDGET_BYTES) throw new Error("该设置会使本项目历史保留上限合计超过 4GB 安全预算，请降低其他用户额度后再试");
    return Response.json(await callUser(env, userId, "/retention", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limitMB }) }));
  }
  if (pathname === "/admin/api/users/update") {`, 'retention admin route');
s = s.replace('    if (url.pathname === "/setup") return Response.redirect(new URL("/admin", request.url).toString(), 308);', '    if (url.pathname === "/setup") return new Response("Not Found", { status: 404 });');
write('src/index.ts', s);

// DO allows larger pages for admin pagination
s = read('src/weixin-bot.ts');
s = s.replace('const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));', 'const limit = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));');
write('src/weixin-bot.ts', s);

// Admin UI direct, no runtime string injection
s = read('src/setup-page.ts');
s = s.replace('<span class="tag blue">v0.4</span>', '<span class="tag blue">v0.5.1</span>');
s = s.replace("var state={users:[],messages:[],section:'overview'};", "var state={users:[],messages:[],section:'overview',storagePlan:{},messageOffset:0,messageLimit:100,messageTotal:0};");
s = rep(s, "async function loadUsers(){var data=await api('/users');state.users=data.users||[];renderUsers();renderOverview();renderUserFilter()}", "async function loadUsers(){var data=await api('/users');state.users=data.users||[];state.storagePlan=data.storagePlan||{};renderUsers();renderOverview();renderUserFilter();renderRetentionSettings()}", 'admin load users');
s = re(s, /function renderOverview\(\)\{[\s\S]*?\}\nfunction renderUsers/, `function renderOverview(){var users=state.users;var connected=users.filter(function(u){return u.status&&u.status.connected}).length;var pending=users.reduce(function(s,u){return s+Number((u.status||{}).pendingInbound||0)},0);var messages=users.reduce(function(s,u){return s+Number((u.status||{}).messageCount||0)},0);var history=Number((state.storagePlan||{}).totalHistoryBytes||0);document.getElementById('stats').innerHTML='<div class="card"><div class="statLabel">微信用户</div><div class="statValue">'+users.length+'</div><div class="statHint">'+connected+' 个已绑定</div></div><div class="card"><div class="statLabel">待处理回复</div><div class="statValue">'+pending+'</div><div class="statHint">等待 ChatGPT 轮询处理</div></div><div class="card"><div class="statLabel">消息记录</div><div class="statValue">'+messages+'</div><div class="statHint">全部用户</div></div><div class="card"><div class="statLabel">历史数据</div><div class="statValue">'+fmtBytes(history)+'</div><div class="statHint">消息 + 附件</div></div>';var ou=document.getElementById('overviewUsers');ou.innerHTML=users.length?users.map(function(u){return'<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid #E5E7EB"><div><strong>'+esc(u.name)+'</strong><div class="muted">'+esc(u.id)+'</div></div><div>'+statusPill(u.status||{},u)+(u.isDefault?' <span class="tag blue">默认</span>':'')+'</div></div>'}).join(''):'<div class="empty">还没有微信用户</div>';var budget=Number((state.storagePlan||{}).safeBudgetBytes||0);var planned=Number((state.storagePlan||{}).totalHistoryLimitBytes||0);var pct=budget?Math.min(100,history/budget*100):0;document.getElementById('storageSummary').innerHTML='<div style="font-size:24px;font-weight:700">'+fmtBytes(history)+'</div><div class="muted" style="margin-top:4px">项目安全预算 '+fmtBytes(budget)+' · 配置上限合计 '+fmtBytes(planned)+'</div><div class="progress"><div class="progressBar" style="width:'+pct.toFixed(2)+'%"></div></div><div class="muted" style="margin-top:12px">每个用户达到自己的历史保留上限后，会自动删除最旧的已处理消息及附件并通过 ClawBot 通知。</div>'}
function renderUsers`, 'admin overview');
s = re(s, /function renderUsers\(\)\{[\s\S]*?\}\nfunction renderUserFilter/, `function renderUsers(){var el=document.getElementById('users');if(!state.users.length){el.innerHTML='<div class="card empty">还没有微信用户。<br><button class="btn primary" style="margin-top:12px" onclick="openAddUser()">添加第一个用户</button></div>';return}el.innerHTML=state.users.map(function(u){var st=u.status||{};var used=Number(st.historyBytes||0),limit=Number(st.historyLimitBytes||700*1024*1024),pct=limit?Math.min(100,used/limit*100):0;return'<article class="userCard"><div class="userHead"><div><div class="userName">'+esc(u.name)+'</div><div class="userId">'+esc(u.id)+'</div></div><div>'+statusPill(st,u)+(u.isDefault?' <span class="tag blue">默认</span>':'')+'</div></div><div class="detailGrid"><div><div class="detailKey">消息</div><div class="detailValue">'+Number(st.messageCount||0)+' 条</div></div><div><div class="detailKey">待处理</div><div class="detailValue">'+Number(st.pendingInbound||0)+' 条</div></div><div><div class="detailKey">历史数据</div><div class="detailValue">'+fmtBytes(used)+' / '+fmtBytes(limit)+'</div></div><div><div class="detailKey">媒体</div><div class="detailValue">'+fmtBytes(st.mediaBytes||0)+'</div></div></div><div class="progress"><div class="progressBar" style="width:'+pct.toFixed(2)+'%"></div></div><div class="actions"><button class="btn small primary" onclick="startBind(\\''+esc(u.id)+'\\',\\''+esc(u.name)+'\\')">'+(st.connected?'重新绑定':'扫码绑定')+'</button><button class="btn small" onclick="testSend(\\''+esc(u.id)+'\\')">发文本</button><button class="btn small" onclick="openMediaSend(\\''+esc(u.id)+'\\',\\''+esc(u.name)+'\\')">发媒体</button><button class="btn small" onclick="testPoll(\\''+esc(u.id)+'\\')">拉取回复</button></div><div class="actions"><button class="btn small" onclick="renameUser(\\''+esc(u.id)+'\\',\\''+esc(u.name)+'\\')">改名</button><button class="btn small" onclick="toggleUser(\\''+esc(u.id)+'\\','+(!u.enabled)+')">'+(u.enabled?'停用':'启用')+'</button>'+(!u.isDefault?'<button class="btn small" onclick="makeDefault(\\''+esc(u.id)+'\\')">设默认</button>':'')+'<button class="btn small" onclick="clearMessages(\\''+esc(u.id)+'\\')">清空消息</button><button class="btn small danger" onclick="deleteUser(\\''+esc(u.id)+'\\',\\''+esc(u.name)+'\\')">删除</button></div>'+(st.lastPollError?'<div class="notice warningNotice" style="margin-top:12px">最近轮询错误：'+esc(st.lastPollError)+'</div>':'')+'</article>'}).join('')}
function renderUserFilter`, 'admin users');
const retentionFns = `\nfunction renderRetentionSettings(){var el=document.getElementById('retentionSettings');if(!el)return;if(!state.users.length){el.innerHTML='<div class="empty">添加微信用户后可配置历史数据保留上限。</div>';return}el.innerHTML=state.users.map(function(u){var st=u.status||{};var limit=Math.round(Number(st.historyLimitBytes||700*1024*1024)/1024/1024);var used=Number(st.historyBytes||0);var pct=st.historyLimitBytes?Math.min(100,used/Number(st.historyLimitBytes)*100):0;return'<div class="settingRow"><div style="min-width:0;flex:1"><div class="settingLabel">'+esc(u.name)+' <span class="muted">('+esc(u.id)+')</span></div><div class="settingValue" style="text-align:left">已保留 '+fmtBytes(used)+' · SQLite 文件 '+fmtBytes(st.databaseBytes||0)+(st.retentionLastCleanupAt?' · 最近自动清理 '+esc(fmtTime(st.retentionLastCleanupAt)):'')+'</div><div class="progress" style="margin-top:8px"><div class="progressBar" style="width:'+pct.toFixed(2)+'%"></div></div></div><div style="width:min(280px,100%)"><div style="display:flex;gap:8px"><input id="retention-'+esc(u.id)+'" class="input" type="number" min="50" max="700" step="50" value="'+limit+'" /><button class="btn primary" onclick="saveRetention(\\''+esc(u.id)+'\\')">保存</button></div><div class="muted" style="margin-top:5px">50–700 MB / 用户，默认 700 MB</div></div></div>'}).join('')}\nasync function saveRetention(id){var input=document.getElementById('retention-'+id);var limit=Number(input&&input.value);if(!Number.isFinite(limit)||limit<50||limit>700){alert('请输入 50–700 MB');return}try{var data=await api('/retention',{userId:id,limitMB:limit});if(data.cleanup&&data.cleanup.pruned)alert('设置已保存，并已自动清理 '+Number(data.cleanup.deletedMessages||0)+' 条较早消息。');await refreshAll()}catch(e){alert(e.message)}}\n`;
s = rep(s, 'function renderUserFilter(){', retentionFns + 'function renderUserFilter(){', 'retention UI functions');
s = re(s, /<section class="section" id="section-settings">[\s\S]*?<\/section>/, `<section class="section" id="section-settings"><div class="pageTitle"><div><h1>设置</h1><p class="subtitle">运行参数、历史留存与存储安全预算。</p></div></div><div class="card" style="margin-bottom:16px"><div class="cardTitle"><h2>历史数据自动保留</h2><span class="tag blue">自动清理</span></div><div class="notice">默认每个微信用户保留 700 MB 交互历史，可设置 50–700 MB。达到上限后，系统自动删除最旧的已处理消息及其附件，清理至约 90%，完成后再通过 ClawBot 通知。尚未处理的微信消息不会被自动删除。</div><div id="retentionSettings" class="settingsList" style="margin-top:14px"></div></div><div class="card settingsList"><div class="settingRow"><div><div class="settingLabel">MCP 地址</div><div class="muted">ChatGPT / Apps 连接入口</div></div><div class="settingValue">/mcp</div></div><div class="settingRow"><div><div class="settingLabel">项目存储安全预算</div><div class="muted">本 Worker 的配置上限合计不得超过该预算，为 Cloudflare Free 账户其他 DO 留余量</div></div><div class="settingValue">4 GB</div></div><div class="settingRow"><div><div class="settingLabel">媒体单文件上限</div><div class="muted">Worker 内存与 MCP 传输安全边界</div></div><div class="settingValue">20 MB</div></div><div class="settingRow"><div><div class="settingLabel">文本分段</div><div class="muted">长消息自动分段并节流发送</div></div><div class="settingValue">约 1800 字 / 段</div></div><div class="settingRow"><div><div class="settingLabel">语音</div><div class="muted">入站保存原始音频；若微信给出转写则同步保存。SILK 暂不在 Worker 内转 WAV。</div></div><div class="settingValue">入站支持 · 出站暂不支持</div></div></div><div class="notice warningNotice" style="margin-top:14px">媒体按约 1MB 分片保存在 SQLite-backed Durable Object。自动清理与手工删除都会同步删除关联附件分片。</div></section>`, 'settings unified');
s = rep(s, '<div id="messages" class="messageList"><div class="empty">正在读取...</div></div>', '<div id="messages" class="messageList"><div class="empty">正在读取...</div></div><div id="messagePager" class="toolbar" style="justify-content:flex-end;margin-top:12px"></div>', 'pager markup');
s = re(s, /async function loadMessages\(\)\{[\s\S]*?\}\nfunction mediaHtml/, `async function loadMessages(reset){if(reset)state.messageOffset=0;try{var data=await api('/messages?limit='+state.messageLimit+'&offset='+state.messageOffset);state.messages=data.messages||[];state.messageTotal=Number(data.total||0);renderMessages();renderMessagePager()}catch(e){document.getElementById('messages').innerHTML='<div class="empty">错误：'+esc(e.message)+'</div>'}}\nfunction renderMessagePager(){var el=document.getElementById('messagePager');if(!el)return;var start=state.messageTotal?state.messageOffset+1:0;var end=Math.min(state.messageTotal,state.messageOffset+state.messages.length);el.innerHTML='<span class="muted">'+start+'–'+end+' / '+state.messageTotal+'</span><button class="btn small" '+(state.messageOffset<=0?'disabled':'')+' onclick="changeMessagePage(-1)">上一页</button><button class="btn small" '+(state.messageOffset+state.messageLimit>=state.messageTotal?'disabled':'')+' onclick="changeMessagePage(1)">下一页</button>'}\nfunction changeMessagePage(dir){state.messageOffset=Math.max(0,state.messageOffset+dir*state.messageLimit);loadMessages()}\nfunction mediaHtml`, 'pager logic');
s = s.replace("if(name==='messages')loadMessages()", "if(name==='messages')loadMessages(true)");
write('src/setup-page.ts', s);

// Package + permanent CI
const pkg = JSON.parse(read('package.json'));
pkg.version = '0.5.1';
pkg.scripts.test = 'node --test --experimental-strip-types tests/*.test.ts';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');
s = read('.github/workflows/check.yml');
s = s.replace('      - run: npm install\n', '      - run: npm ci\n');
s = s.replace('      - run: npm run check\n', '      - run: npm test\n      - run: npm run check\n');
write('.github/workflows/check.yml', s);

// wrangler uses unified entry
s = read('wrangler.jsonc');
s = s.replace('"main": "src/index-v05.ts"', '"main": "src/index.ts"');
write('wrangler.jsonc', s);

// Tests
fs.mkdirSync('tests', { recursive: true });
write('tests/core.test.ts', `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { MAX_RETENTION_LIMIT_BYTES, SAFE_ACCOUNT_HISTORY_BUDGET_BYTES, SEND_CHUNK_SIZE, isWithinSafeHistoryBudget, normalizeHttpsBaseUrl, normalizeProfileId, retentionTargetBytes, splitText } from "../src/core.ts";\n\ntest("splitText respects safe Weixin chunk size", () => { const input = "甲".repeat(SEND_CHUNK_SIZE * 2 + 17); const chunks = splitText(input); assert.ok(chunks.length >= 3); assert.ok(chunks.every((c) => c.length <= SEND_CHUNK_SIZE)); assert.equal(chunks.join(""), input); });\ntest("normalizeProfileId accepts aliases and rejects unsafe ids", () => { assert.equal(normalizeProfileId(" Wife_1 "), "wife_1"); assert.throws(() => normalizeProfileId("../wife")); });\ntest("normalizeHttpsBaseUrl enforces TLS", () => { assert.equal(normalizeHttpsBaseUrl("ilinkai.weixin.qq.com"), "https://ilinkai.weixin.qq.com"); assert.throws(() => normalizeHttpsBaseUrl("http://example.com")); });\ntest("retention target and project budget are conservative", () => { assert.equal(retentionTargetBytes(700), 630); assert.equal(MAX_RETENTION_LIMIT_BYTES, 700 * 1024 * 1024); assert.ok(isWithinSafeHistoryBudget([700*1024*1024,700*1024*1024])); assert.equal(isWithinSafeHistoryBudget([SAFE_ACCOUNT_HISTORY_BUDGET_BYTES,1]), false); });\n`);

// README refresh
s = read('README.md');
s = s.replace(/Current version: \*\*v0\.5\.0\*\*\./, 'Current version: **v0.5.1**.');
s = s.replace('## v0.5 features', '## v0.5.1 features');
s = s.replace('- 20 MiB per-media safety limit.', '- 20 MiB per-media safety limit.\n- Long text is split at about 1800 characters and rate-limited between chunks.\n- Stale Weixin context tokens trigger a safe refresh/retry path; unresolved sessions return an explicit re-engagement error.\n- Multi-recipient media delivery is serialized to reduce Worker peak memory.');
s = s.replace('- Configurable per-user retained interaction-history cap: **50–700 MiB**, default **700 MiB**.', '- Configurable per-user retained interaction-history cap: **50–700 MiB**, default **700 MiB**. The configured limits of this project are guarded by a conservative **4 GiB** aggregate safety budget.');
s = s.replace('Every push to `main` runs dependency audit, TypeScript checking, and `wrangler deploy --dry-run` through GitHub Actions before the version is treated as deployment-ready.', 'Every push to `main` uses `npm ci`, runs production dependency audit, unit tests, TypeScript checking, and `wrangler deploy --dry-run` through GitHub Actions before the version is treated as deployment-ready.');
write('README.md', s);

// Remove legacy wrapper implementation; retention is now part of primary files.
for (const p of ['src/index-v05.ts','src/weixin-bot-v05.ts']) if (fs.existsSync(p)) fs.rmSync(p);

console.log('v0.5.1 source upgrade applied');
