import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { normalizeHttpsUrl } from "./core.js";
import type { MessageKind, WeixinMessageItem } from "./types.js";

export const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export const MEDIA_CHUNK_BYTES = 1024 * 1024;
export const MCP_EMBED_MAX_BYTES = 8 * 1024 * 1024;

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

function detectImageMime(buf: Uint8Array): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && Buffer.from(buf.subarray(0, 8)).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (buf.length >= 6) {
    const sig = Buffer.from(buf.subarray(0, 6)).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (buf.length >= 12 && Buffer.from(buf.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(buf.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return null;
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

/**
 * Weixin currently emits AES-128 media keys in three shapes depending on the field/version:
 * 1) raw 32-char hex (notably image_item.aeskey)
 * 2) base64(raw 16 bytes)
 * 3) base64(32 ASCII hex chars)
 *
 * All are normalized to the exact 16-byte AES key used by AES-128-ECB.
 */
export function decodeAes128Key(value: string): Buffer {
  const text = String(value || "").trim();
  if (!text) throw new Error("微信媒体 AES key 为空");

  if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, "hex");

  const decoded = Buffer.from(text, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const ascii = decoded.toString("ascii");
    if (/^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, "hex");
  }

  throw new Error(`微信媒体 AES key 格式无效：base64 解码后 ${decoded.length} bytes`);
}

export function decryptAesEcb(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.byteLength !== 16) throw new Error(`AES-128 key 必须为 16 bytes，实际 ${key.byteLength}`);
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(key), null);
  decipher.setAutoPadding(true);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]));
}

export function encryptAesEcb(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.byteLength !== 16) throw new Error(`AES-128 key 必须为 16 bytes，实际 ${key.byteLength}`);
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(key), null);
  cipher.setAutoPadding(true);
  return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]));
}

export const aesEcbPaddedSize = (size: number) => (Math.floor(size / 16) + 1) * 16;

function buildDownloadUrl(encryptQueryParam: string, fullUrl?: string): string {
  if (fullUrl?.trim()) return normalizeHttpsUrl(fullUrl.trim());
  if (!encryptQueryParam) throw new Error("微信媒体缺少 full_url / encrypt_query_param");
  return `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

async function fetchBounded(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(normalizeHttpsUrl(url), { signal: controller.signal });
    if (!response.ok) throw new Error(`微信 CDN 下载失败：HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") || "0");
    if (declared > MAX_MEDIA_BYTES) throw new Error(`媒体文件过大：${declared} bytes，当前上限 ${MAX_MEDIA_BYTES} bytes`);
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const output = new Uint8Array(MAX_MEDIA_BYTES);
    let offset = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (offset + value.byteLength > MAX_MEDIA_BYTES) {
          await reader.cancel("media too large").catch(() => undefined);
          throw new Error(`媒体文件过大：超过当前 ${MAX_MEDIA_BYTES} bytes 上限`);
        }
        output.set(value, offset);
        offset += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    return output.subarray(0, offset);
  } finally {
    clearTimeout(timer);
  }
}

async function downloadMedia(
  ref: { encrypt_query_param?: string; aes_key?: string; full_url?: string },
  aesKeyOverride?: string,
): Promise<{ bytes: Uint8Array; decrypted: boolean }> {
  const encrypted = await fetchBounded(buildDownloadUrl(ref.encrypt_query_param || "", ref.full_url));
  const aesKey = String(aesKeyOverride || ref.aes_key || "").trim();
  if (!aesKey) return { bytes: encrypted, decrypted: false };
  return { bytes: decryptAesEcb(encrypted, decodeAes128Key(aesKey)), decrypted: true };
}

async function downloadInboundImage(item: WeixinMessageItem, itemIndex: number): Promise<DownloadedMedia | null> {
  const image = item.image_item;
  if (!image) return null;
  const errors: string[] = [];

  const candidates: Array<{
    label: string;
    ref?: { encrypt_query_param?: string; aes_key?: string; full_url?: string };
    keyOverride?: string;
  }> = [
    { label: "media", ref: image.media, keyOverride: image.aeskey },
    { label: "thumb_media", ref: image.thumb_media },
  ];

  for (const candidate of candidates) {
    if (!candidate.ref || (!candidate.ref.encrypt_query_param && !candidate.ref.full_url)) continue;
    try {
      const downloaded = await downloadMedia(candidate.ref, candidate.keyOverride);
      const mimeType = detectImageMime(downloaded.bytes);
      if (!mimeType) {
        if (!downloaded.decrypted) throw new Error("缺少可用 AES key，CDN 内容看起来仍为密文");
        throw new Error("AES-128-ECB 解密完成，但结果不是受支持的 JPEG/PNG/GIF/WebP 图片");
      }
      const extension = mimeType === "image/png" ? "png" : mimeType === "image/gif" ? "gif" : mimeType === "image/webp" ? "webp" : "jpg";
      return { kind: "image", mimeType, fileName: `weixin-image-${item.msg_id || itemIndex}.${extension}`, bytes: downloaded.bytes, itemIndex };
    } catch (error) {
      errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (image.url?.trim()) {
    try {
      const bytes = await fetchBounded(image.url.trim());
      const mimeType = detectImageMime(bytes);
      if (!mimeType) throw new Error("直链内容不是受支持的 JPEG/PNG/GIF/WebP 图片");
      const extension = mimeType === "image/png" ? "png" : mimeType === "image/gif" ? "gif" : mimeType === "image/webp" ? "webp" : "jpg";
      return { kind: "image", mimeType, fileName: `weixin-image-${item.msg_id || itemIndex}.${extension}`, bytes, itemIndex };
    } catch (error) {
      errors.push(`url: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errors.length) throw new Error(`微信图片下载/解密失败（AES-128-ECB，不使用 IV）：${errors.join("；")}`);
  return null;
}

export async function downloadInboundMedia(item: WeixinMessageItem, itemIndex: number): Promise<DownloadedMedia | null> {
  if (item.type === 2) return downloadInboundImage(item, itemIndex);

  if (item.type === 3) {
    const voice = item.voice_item;
    const ref = voice?.media;
    if (!ref || (!ref.encrypt_query_param && !ref.full_url) || !ref.aes_key) return null;
    const { bytes } = await downloadMedia(ref);
    const format = voiceMime(voice?.encode_type);
    return { kind: "voice", mimeType: format.mimeType, fileName: `weixin-voice-${item.msg_id || itemIndex}.${format.extension}`, bytes, itemIndex };
  }

  if (item.type === 4) {
    const file = item.file_item;
    const ref = file?.media;
    if (!ref || (!ref.encrypt_query_param && !ref.full_url) || !ref.aes_key) return null;
    const { bytes } = await downloadMedia(ref);
    const fileName = file?.file_name?.trim() || `weixin-file-${item.msg_id || itemIndex}.bin`;
    return { kind: "file", mimeType: extMime(fileName), fileName, bytes, itemIndex };
  }

  if (item.type === 5) {
    const video = item.video_item;
    const ref = video?.media;
    if (!ref || (!ref.encrypt_query_param && !ref.full_url) || !ref.aes_key) return null;
    const { bytes } = await downloadMedia(ref);
    return { kind: "video", mimeType: "video/mp4", fileName: `weixin-video-${item.msg_id || itemIndex}.mp4`, bytes, itemIndex };
  }

  return null;
}

export function sanitizeFileName(value: string | undefined, fallback: string): string {
  const name = String(value || "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180);
  return name || fallback;
}
