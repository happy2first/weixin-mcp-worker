import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv } from "node:crypto";
import type { MessageKind, WeixinMessageItem } from "./types.js";

export const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export const MEDIA_CHUNK_BYTES = 1024 * 1024;
export const MCP_EMBED_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_SOFT_QUOTA_BYTES = 750 * 1024 * 1024;

export type DownloadedMedia = {
  kind: Extract<MessageKind, "image" | "voice" | "file" | "video">;
  mimeType: string;
  fileName: string;
  bytes: Uint8Array;
  itemIndex: number;
};

function extMime(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}

function imageMime(buf: Uint8Array): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && Buffer.from(buf.subarray(0, 8)).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (buf.length >= 6) {
    const sig = Buffer.from(buf.subarray(0, 6)).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (buf.length >= 12 && Buffer.from(buf.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(buf.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return "image/jpeg";
}

function voiceMime(encodeType?: number): { mimeType: string; extension: string } {
  switch (encodeType) {
    case 5: return { mimeType: "audio/amr", extension: "amr" };
    case 6: return { mimeType: "audio/silk", extension: "silk" };
    case 7: return { mimeType: "audio/mpeg", extension: "mp3" };
    case 8: return { mimeType: "audio/ogg", extension: "ogg" };
    case 1: return { mimeType: "audio/L16", extension: "pcm" };
    default: return { mimeType: "application/octet-stream", extension: "bin" };
  }
}

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`微信媒体 AES key 格式无效：解码后 ${decoded.length} bytes`);
}

export function decryptAesEcb(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(key), null);
  decipher.setAutoPadding(true);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]));
}

export function encryptAesEcb(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(key), null);
  cipher.setAutoPadding(true);
  return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]));
}

export function aesEcbPaddedSize(size: number): number {
  return (Math.floor(size / 16) + 1) * 16;
}

function buildDownloadUrl(encryptQueryParam: string, fullUrl?: string): string {
  if (fullUrl?.trim()) return fullUrl.trim();
  if (!encryptQueryParam) throw new Error("微信媒体缺少 full_url / encrypt_query_param");
  return `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

async function fetchBounded(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`微信 CDN 下载失败：HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > MAX_MEDIA_BYTES) throw new Error(`媒体文件过大：${declared} bytes，当前上限 ${MAX_MEDIA_BYTES} bytes`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error(`媒体文件过大：${bytes.byteLength} bytes，当前上限 ${MAX_MEDIA_BYTES} bytes`);
  return bytes;
}

async function downloadMedia(ref: { encrypt_query_param?: string; aes_key?: string; full_url?: string }, aesKeyOverrideBase64?: string): Promise<Uint8Array> {
  const encrypted = await fetchBounded(buildDownloadUrl(ref.encrypt_query_param || "", ref.full_url));
  const aesKey = aesKeyOverrideBase64 || ref.aes_key;
  if (!aesKey) return encrypted;
  return decryptAesEcb(encrypted, parseAesKey(aesKey));
}

export async function downloadInboundMedia(item: WeixinMessageItem, itemIndex: number): Promise<DownloadedMedia | null> {
  if (item.type === 2) {
    const image = item.image_item;
    const ref = image?.media;
    if (!ref || (!ref.encrypt_query_param && !ref.full_url)) return null;
    const override = image?.aeskey ? Buffer.from(image.aeskey, "hex").toString("base64") : undefined;
    const bytes = await downloadMedia(ref, override);
    const mimeType = imageMime(bytes);
    const extension = mimeType === "image/png" ? "png" : mimeType === "image/gif" ? "gif" : mimeType === "image/webp" ? "webp" : "jpg";
    return { kind: "image", mimeType, fileName: `weixin-image-${item.msg_id || itemIndex}.${extension}`, bytes, itemIndex };
  }
  if (item.type === 3) {
    const voice = item.voice_item;
    const ref = voice?.media;
    if (!ref || (!ref.encrypt_query_param && !ref.full_url) || !ref.aes_key) return null;
    const bytes = await downloadMedia(ref);
    const format = voiceMime(voice?.encode_type);
    return { kind: "voice", mimeType: format.mimeType, fileName: `weixin-voice-${item.msg_id || itemIndex}.${format.extension}`, bytes, itemIndex };
  }
  if (item.type === 4) {
    const file = item.file_item;
    const ref = file?.media;
    if (!ref || (!ref.encrypt_query_param && !ref.full_url) || !ref.aes_key) return null;
    const bytes = await downloadMedia(ref);
    const fileName = file?.file_name?.trim() || `weixin-file-${item.msg_id || itemIndex}.bin`;
    return { kind: "file", mimeType: extMime(fileName), fileName, bytes, itemIndex };
  }
  if (item.type === 5) {
    const video = item.video_item;
    const ref = video?.media;
    if (!ref || (!ref.encrypt_query_param && !ref.full_url) || !ref.aes_key) return null;
    const bytes = await downloadMedia(ref);
    return { kind: "video", mimeType: "video/mp4", fileName: `weixin-video-${item.msg_id || itemIndex}.mp4`, bytes, itemIndex };
  }
  return null;
}

export function sanitizeFileName(value: string | undefined, fallback: string): string {
  const name = String(value || "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180);
  return name || fallback;
}
