import { Buffer } from "node:buffer";
import worker, { WeixinBotDO } from "./main.js";
import { MAX_MEDIA_BYTES } from "./media-v051.js";

export { WeixinBotDO };

type JsonObject = Record<string, any>;

type ChatGptFileParam = {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
};

const FILE_PARAM_NAME = "file";
const FILE_PARAM_META_KEY = "openai/fileParams";

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withFileParam(tool: JsonObject) {
  if (tool.name !== "weixin_send_media") return tool;
  const inputSchema: JsonObject = isJsonObject(tool.inputSchema) ? { ...tool.inputSchema } : { type: "object" };
  const properties = isJsonObject(inputSchema.properties) ? { ...inputSchema.properties } : {};
  properties[FILE_PARAM_NAME] = {
    type: "object",
    description: "ChatGPT current-conversation attachment. Use this for a file/image/video uploaded in the chat.",
    properties: {
      download_url: { type: "string", format: "uri" },
      file_id: { type: "string" },
      mime_type: { type: "string" },
      file_name: { type: "string" },
    },
    required: ["download_url", "file_id"],
    additionalProperties: false,
  };
  return {
    ...tool,
    description: "发送图片、文件或视频。ChatGPT 当前会话附件使用 file；微信历史媒体使用 sourceMediaRef；仍兼容 dataBase64。不发送语音。",
    inputSchema: { ...inputSchema, properties },
    _meta: {
      ...(isJsonObject(tool._meta) ? tool._meta : {}),
      [FILE_PARAM_META_KEY]: [FILE_PARAM_NAME],
    },
  };
}

function rewriteToolsListPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(rewriteToolsListPayload);
  if (!isJsonObject(payload) || !isJsonObject(payload.result) || !Array.isArray(payload.result.tools)) return payload;
  return {
    ...payload,
    result: {
      ...payload.result,
      tools: payload.result.tools.map((tool: unknown) => isJsonObject(tool) ? withFileParam(tool) : tool),
    },
  };
}

function parseFileParam(value: unknown): ChatGptFileParam {
  if (!isJsonObject(value)) throw new Error("file 参数不是 ChatGPT 文件对象；请重新选择附件后再发送");
  const downloadUrl = String(value.download_url || "").trim();
  const fileId = String(value.file_id || "").trim();
  if (!downloadUrl || !fileId) throw new Error("file 缺少 download_url 或 file_id；请重新选择附件后再发送");
  return {
    download_url: downloadUrl,
    file_id: fileId,
    mime_type: String(value.mime_type || "").trim() || undefined,
    file_name: String(value.file_name || "").trim() || undefined,
  };
}

async function downloadChatGptFile(file: ChatGptFileParam) {
  const url = new URL(file.download_url);
  if (url.protocol !== "https:") throw new Error("ChatGPT 文件 download_url 必须使用 HTTPS");
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`读取 ChatGPT 文件失败：HTTP ${response.status}`);

  const declaredSize = Number(response.headers.get("content-length") || "0");
  if (Number.isFinite(declaredSize) && declaredSize > MAX_MEDIA_BYTES) {
    throw new Error(`媒体超过 ${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)}MB 上限`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw new Error("ChatGPT 文件为空");
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error(`媒体超过 ${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)}MB 上限`);

  return {
    bytes,
    mimeType: file.mime_type || response.headers.get("content-type") || "application/octet-stream",
    fileName: file.file_name || "",
  };
}

async function rewriteToolCallPayload(payload: unknown): Promise<unknown> {
  if (!isJsonObject(payload) || payload.method !== "tools/call" || !isJsonObject(payload.params)) return payload;
  if (payload.params.name !== "weixin_send_media") return payload;
  const args = isJsonObject(payload.params.arguments) ? { ...payload.params.arguments } : {};
  if (!(FILE_PARAM_NAME in args) || args[FILE_PARAM_NAME] == null) return payload;
  if (String(args.dataBase64 || "").trim() || String(args.sourceMediaRef || "").trim()) {
    throw new Error("file、dataBase64 和 sourceMediaRef 必须且只能提供一个");
  }

  const file = parseFileParam(args[FILE_PARAM_NAME]);
  const downloaded = await downloadChatGptFile(file);
  delete args[FILE_PARAM_NAME];
  args.dataBase64 = Buffer.from(downloaded.bytes).toString("base64");
  if (!String(args.mimeType || "").trim()) args.mimeType = downloaded.mimeType;
  if (!String(args.fileName || "").trim() && downloaded.fileName) args.fileName = downloaded.fileName;

  return {
    ...payload,
    params: {
      ...payload.params,
      arguments: args,
    },
  };
}

function jsonResponse(payload: unknown, original: Response) {
  const headers = new Headers(original.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(payload), {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

function invalidParamsResponse(id: unknown, error: unknown) {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32602,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

function requestHeadersWithoutBodyLength(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return headers;
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp" || request.method !== "POST") return worker.fetch(request, env, ctx);

    const bodyText = await request.text();
    const headers = requestHeadersWithoutBodyLength(request);
    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return worker.fetch(new Request(request.url, { method: request.method, headers, body: bodyText }), env, ctx);
    }

    let forwardedPayload = payload;
    try {
      forwardedPayload = await rewriteToolCallPayload(payload);
    } catch (error) {
      return invalidParamsResponse(isJsonObject(payload) ? payload.id : null, error);
    }

    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(forwardedPayload),
    });
    const response = await worker.fetch(forwarded, env, ctx);

    if (!isJsonObject(payload) || payload.method !== "tools/list" || !response.ok) return response;
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) return response;
    const responsePayload = await response.clone().json().catch(() => null);
    if (responsePayload == null) return response;
    return jsonResponse(rewriteToolsListPayload(responsePayload), response);
  },
};
