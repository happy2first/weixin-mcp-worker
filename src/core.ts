export const VERSION = "0.5.1";
export const MIB = 1024 * 1024;
export const DEFAULT_RETENTION_LIMIT_BYTES = 700 * MIB;
export const MIN_RETENTION_LIMIT_BYTES = 50 * MIB;
export const MAX_RETENTION_LIMIT_BYTES = 700 * MIB;
export const RETENTION_TARGET_RATIO = 0.9;
export const SAFE_PROJECT_HISTORY_BUDGET_BYTES = 4 * 1024 * MIB;
export const SEND_CHUNK_SIZE = 1800;
export const MAX_SEND_CHUNKS = 40;
export const SEND_CHUNK_DELAY_MS = 300;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function splitText(text: string, max = SEND_CHUNK_SIZE): string[] {
  const source = text.trim();
  if (!source) return [];
  if (source.length <= max) return [source];
  const chunks: string[] = [];
  let rest = source;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
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

export function normalizeHttpsUrl(value: string): string {
  const raw = String(value || "").trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:") throw new Error("微信 iLink/CDN 地址必须使用 HTTPS");
  return url.toString().replace(/\/$/, "");
}

export const retentionTargetBytes = (limitBytes: number) => Math.floor(limitBytes * RETENTION_TARGET_RATIO);

export function projectBudgetWithinLimit(limits: number[]): boolean {
  return limits.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0) <= SAFE_PROJECT_HISTORY_BUDGET_BYTES;
}
