import {
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

type StorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  transactionSync<T>(closure: () => T): T;
  sql: {
    exec<T extends Record<string, string | number | ArrayBuffer | null>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
    databaseSize: number;
  };
};

function clampLimitBytes(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_RETENTION_LIMIT_BYTES;
  return Math.min(MAX_RETENTION_LIMIT_BYTES, Math.max(MIN_RETENTION_LIMIT_BYTES, Math.trunc(numeric)));
}

export async function loadRetention(storage: StorageLike): Promise<RetentionState> {
  const stored = await storage.get<RetentionState>(RETENTION_KEY);
  return { ...(stored || {}), limitBytes: clampLimitBytes(stored?.limitBytes) };
}

export function historyUsage(storage: StorageLike): RetentionUsage {
  const messageRow = storage.sql.exec<{ bytes: number }>(`
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

export async function retentionStatus(storage: StorageLike) {
  const retention = await loadRetention(storage);
  const usage = historyUsage(storage);
  return { retention, usage, targetBytes: retentionTargetBytes(retention.limitBytes) };
}

function deleteBatch(storage: StorageLike, refs: string[]) {
  if (!refs.length) return;
  const placeholders = refs.map(() => "?").join(",");
  storage.transactionSync(() => {
    storage.sql.exec(`DELETE FROM media_chunks WHERE media_ref IN (SELECT media_ref FROM media_objects WHERE message_ref IN (${placeholders}))`, ...refs);
    storage.sql.exec(`DELETE FROM media_objects WHERE message_ref IN (${placeholders})`, ...refs);
    storage.sql.exec(`DELETE FROM messages WHERE message_ref IN (${placeholders})`, ...refs);
  });
}

export async function enforceRetention(
  storage: StorageLike,
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
    const rows = storage.sql.exec<CleanupRow>(`
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

export async function setRetentionLimit(
  storage: StorageLike,
  limitMB: unknown,
  notify?: (summary: RetentionCleanupSummary) => Promise<void>,
) {
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

export async function clearRetentionState(storage: StorageLike): Promise<void> {
  await storage.delete(RETENTION_KEY);
}
