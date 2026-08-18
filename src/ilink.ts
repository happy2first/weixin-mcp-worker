import type {
  Env,
  GetUpdatesResponse,
  LoginPollResponse,
  LoginQrResponse,
} from "./types.js";

export const ILINK_FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const DEFAULT_COMPAT_VERSION = "2.4.6";
const BOT_AGENT = "weixin-mcp-worker/0.2.0";
const INBOUND_POLL_TIMEOUT_MS = 8_000;

function normalizeBaseUrl(value?: string): string {
  const raw = String(value || ILINK_FIXED_BASE_URL).trim().replace(/\/$/, "");
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function compatibilityVersion(env: Env): string {
  return String(env.ILINK_CLIENT_VERSION || DEFAULT_COMPAT_VERSION).trim() || DEFAULT_COMPAT_VERSION;
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => Number.parseInt(p, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin(): string {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return btoa(String(values[0]));
}

function baseInfo(env: Env) {
  return {
    channel_version: compatibilityVersion(env),
    bot_agent: BOT_AGENT,
  };
}

function commonHeaders(env: Env): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(buildClientVersion(compatibilityVersion(env))),
  };
}

function authHeaders(env: Env, token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(env),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

async function fetchText(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Weixin API ${response.status}: ${text.slice(0, 500)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson<T>(
  env: Env,
  baseUrl: string,
  endpoint: string,
  body: unknown,
  token?: string,
  timeoutMs = 15_000,
): Promise<T> {
  const url = new URL(endpoint, `${normalizeBaseUrl(baseUrl)}/`).toString();
  const text = await fetchText(url, {
    method: "POST",
    headers: authHeaders(env, token),
    body: JSON.stringify(body),
  }, timeoutMs);
  return JSON.parse(text) as T;
}

async function getJson<T>(
  env: Env,
  baseUrl: string,
  endpoint: string,
  timeoutMs = 35_000,
): Promise<T> {
  const url = new URL(endpoint, `${normalizeBaseUrl(baseUrl)}/`).toString();
  const text = await fetchText(url, {
    method: "GET",
    headers: commonHeaders(env),
  }, timeoutMs);
  return JSON.parse(text) as T;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export async function fetchLoginQr(env: Env, localTokenList: string[] = []): Promise<LoginQrResponse> {
  return postJson<LoginQrResponse>(
    env,
    ILINK_FIXED_BASE_URL,
    "ilink/bot/get_bot_qrcode?bot_type=3",
    { local_token_list: localTokenList.slice(-10) },
    undefined,
    20_000,
  );
}

export async function pollLoginStatus(
  env: Env,
  baseUrl: string,
  qrcode: string,
  verifyCode?: string,
): Promise<LoginPollResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode?.trim()) endpoint += `&verify_code=${encodeURIComponent(verifyCode.trim())}`;
  try {
    return await getJson<LoginPollResponse>(env, baseUrl, endpoint, 35_000);
  } catch (error) {
    if (isAbortError(error)) return { status: "wait" };
    throw error;
  }
}

export async function notifyStart(env: Env, baseUrl: string, token: string): Promise<void> {
  await postJson(
    env,
    baseUrl,
    "ilink/bot/msg/notifystart",
    { base_info: baseInfo(env) },
    token,
    10_000,
  );
}

/**
 * Pull one iLink update batch. This is intentionally not a permanent monitor:
 * ChatGPT can call it from a scheduled task (for example once per hour).
 * When there are no queued messages, the Worker aborts the idle long-poll after
 * a short timeout and reports timedOut=true without advancing the cursor.
 */
export async function getUpdates(
  env: Env,
  params: {
    baseUrl: string;
    token: string;
    getUpdatesBuf?: string;
  },
): Promise<GetUpdatesResponse> {
  try {
    return await postJson<GetUpdatesResponse>(
      env,
      params.baseUrl,
      "ilink/bot/getupdates",
      {
        get_updates_buf: params.getUpdatesBuf || "",
        base_info: baseInfo(env),
      },
      params.token,
      INBOUND_POLL_TIMEOUT_MS,
    );
  } catch (error) {
    if (isAbortError(error)) return { timedOut: true };
    throw error;
  }
}

export async function sendTextMessage(
  env: Env,
  params: {
    baseUrl: string;
    token: string;
    toUserId: string;
    text: string;
    contextToken?: string;
  },
): Promise<string> {
  const clientId = `weixin-mcp-worker-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const payload = {
    msg: {
      from_user_id: "",
      to_user_id: params.toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: params.text } }],
      ...(params.contextToken ? { context_token: params.contextToken } : {}),
    },
    base_info: baseInfo(env),
  };

  const response = await postJson<{ ret?: number; errmsg?: string }>(
    env,
    params.baseUrl,
    "ilink/bot/sendmessage",
    payload,
    params.token,
    15_000,
  );
  if (response.ret && response.ret !== 0) {
    throw new Error(`Weixin send failed: ret=${response.ret}, errmsg=${response.errmsg || "unknown"}`);
  }
  return clientId;
}

export function normalizeIlinkBaseUrl(value?: string): string {
  return normalizeBaseUrl(value);
}
