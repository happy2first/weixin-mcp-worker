import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { VERSION, normalizeHttpsUrl } from "./core.js";
import { aesEcbPaddedSize, encryptAesEcb, WEIXIN_CDN_BASE_URL } from "./media.js";
import type {
  Env,
  GetUpdatesResponse,
  GetUploadUrlResponse,
  LoginPollResponse,
  LoginQrResponse,
  SendableMediaKind,
  UploadedMediaInfo,
} from "./types.js";

export const ILINK_FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const DEFAULT_COMPAT_VERSION = "2.4.6";
const BOT_AGENT = `weixin-mcp-worker/${VERSION}`;
const INBOUND_POLL_TIMEOUT_MS = 8_000;

function normalizeBaseUrl(value?: string): string {
  return normalizeHttpsUrl(String(value || ILINK_FIXED_BASE_URL));
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
  return { channel_version: compatibilityVersion(env), bot_agent: BOT_AGENT };
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

async function fetchText(url: string, init: RequestInit, timeoutMs = 15_000): Promise<string> {
  const target = normalizeHttpsUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`Weixin API ${response.status}: ${text.slice(0, 500)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson<T>(env: Env, baseUrl: string, endpoint: string, body: unknown, token?: string, timeoutMs = 15_000): Promise<T> {
  const url = new URL(endpoint, `${normalizeBaseUrl(baseUrl)}/`).toString();
  const text = await fetchText(url, { method: "POST", headers: authHeaders(env, token), body: JSON.stringify(body) }, timeoutMs);
  return JSON.parse(text) as T;
}

async function getJson<T>(env: Env, baseUrl: string, endpoint: string, timeoutMs = 35_000): Promise<T> {
  const url = new URL(endpoint, `${normalizeBaseUrl(baseUrl)}/`).toString();
  const text = await fetchText(url, { method: "GET", headers: commonHeaders(env) }, timeoutMs);
  return JSON.parse(text) as T;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export async function fetchLoginQr(env: Env, localTokenList: string[] = []): Promise<LoginQrResponse> {
  return postJson<LoginQrResponse>(env, ILINK_FIXED_BASE_URL, "ilink/bot/get_bot_qrcode?bot_type=3", {
    local_token_list: localTokenList.slice(-10),
  }, undefined, 20_000);
}

export async function pollLoginStatus(env: Env, baseUrl: string, qrcode: string, verifyCode?: string): Promise<LoginPollResponse> {
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
  await postJson(env, baseUrl, "ilink/bot/msg/notifystart", { base_info: baseInfo(env) }, token, 10_000);
}

export async function getUpdates(env: Env, params: { baseUrl: string; token: string; getUpdatesBuf?: string }): Promise<GetUpdatesResponse> {
  try {
    return await postJson<GetUpdatesResponse>(env, params.baseUrl, "ilink/bot/getupdates", {
      get_updates_buf: params.getUpdatesBuf || "",
      base_info: baseInfo(env),
    }, params.token, INBOUND_POLL_TIMEOUT_MS);
  } catch (error) {
    if (isAbortError(error)) return { timedOut: true };
    throw error;
  }
}

export class WeixinSendError extends Error {
  constructor(public readonly ret: number, message: string) {
    super(message);
    this.name = "WeixinSendError";
  }
}

async function sendItem(env: Env, params: {
  baseUrl: string;
  token: string;
  toUserId: string;
  item: Record<string, unknown>;
  contextToken?: string;
}): Promise<string> {
  const clientId = `weixin-mcp-worker-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const response = await postJson<{ ret?: number; errmsg?: string }>(env, params.baseUrl, "ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: params.toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [params.item],
      ...(params.contextToken ? { context_token: params.contextToken } : {}),
    },
    base_info: baseInfo(env),
  }, params.token, 15_000);
  if (response.ret && response.ret !== 0) {
    throw new WeixinSendError(response.ret, `Weixin send failed: ret=${response.ret}, errmsg=${response.errmsg || "unknown"}`);
  }
  return clientId;
}

export async function sendTextMessage(env: Env, params: {
  baseUrl: string; token: string; toUserId: string; text: string; contextToken?: string;
}): Promise<string> {
  return sendItem(env, { ...params, item: { type: 1, text_item: { text: params.text } } });
}

export async function getUploadUrl(env: Env, params: {
  baseUrl: string; token: string; filekey: string; mediaType: number; toUserId: string;
  rawsize: number; rawfilemd5: string; filesize: number; aeskey: string;
}): Promise<GetUploadUrlResponse> {
  return postJson<GetUploadUrlResponse>(env, params.baseUrl, "ilink/bot/getuploadurl", {
    filekey: params.filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize: params.rawsize,
    rawfilemd5: params.rawfilemd5,
    filesize: params.filesize,
    no_need_thumb: true,
    aeskey: params.aeskey,
    base_info: baseInfo(env),
  }, params.token, 15_000);
}

function mediaTypeNumber(kind: SendableMediaKind): number {
  if (kind === "image") return 1;
  if (kind === "video") return 2;
  return 3;
}

export async function uploadMediaBuffer(env: Env, params: {
  baseUrl: string; token: string; toUserId: string; kind: SendableMediaKind; bytes: Uint8Array;
}): Promise<UploadedMediaInfo> {
  const rawsize = params.bytes.byteLength;
  const rawfilemd5 = createHash("md5").update(Buffer.from(params.bytes)).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString("hex");
  const aesKey = randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const upload = await getUploadUrl(env, {
    baseUrl: params.baseUrl,
    token: params.token,
    filekey,
    mediaType: mediaTypeNumber(params.kind),
    toUserId: params.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aesKeyHex,
  });
  const rawTarget = upload.upload_full_url?.trim()
    || (upload.upload_param ? `${WEIXIN_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}` : "");
  if (!rawTarget) throw new Error("微信 getUploadUrl 未返回上传地址");
  const target = normalizeHttpsUrl(rawTarget);
  const ciphertext = encryptAesEcb(params.bytes, aesKey);
  const response = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: ciphertext.slice().buffer as ArrayBuffer,
  });
  if (!response.ok) {
    const detail = response.headers.get("x-error-message") || await response.text().catch(() => "");
    throw new Error(`微信 CDN 上传失败：HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ""}`);
  }
  const downloadEncryptedQueryParam = response.headers.get("x-encrypted-param") || "";
  if (!downloadEncryptedQueryParam) throw new Error("微信 CDN 上传成功但缺少 x-encrypted-param");
  return { filekey, downloadEncryptedQueryParam, aesKeyHex, fileSize: rawsize, fileSizeCiphertext: filesize };
}

export async function sendUploadedMediaMessage(env: Env, params: {
  baseUrl: string; token: string; toUserId: string; kind: SendableMediaKind; uploaded: UploadedMediaInfo;
  fileName?: string; contextToken?: string;
}): Promise<string> {
  const media = {
    encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(params.uploaded.aesKeyHex).toString("base64"),
    encrypt_type: 1,
  };
  let item: Record<string, unknown>;
  if (params.kind === "image") item = { type: 2, image_item: { media, mid_size: params.uploaded.fileSizeCiphertext } };
  else if (params.kind === "video") item = { type: 5, video_item: { media, video_size: params.uploaded.fileSizeCiphertext } };
  else item = { type: 4, file_item: { media, file_name: params.fileName || "file.bin", len: String(params.uploaded.fileSize) } };
  return sendItem(env, {
    baseUrl: params.baseUrl,
    token: params.token,
    toUserId: params.toUserId,
    item,
    contextToken: params.contextToken,
  });
}

export const normalizeIlinkBaseUrl = normalizeBaseUrl;
