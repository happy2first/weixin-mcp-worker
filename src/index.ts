import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import QRCode from "qrcode";
import { z } from "zod";
import { ADMIN_PAGE } from "./setup-page.js";
import type { Env, WeixinUserProfile } from "./types.js";
export { WeixinBotDO } from "./weixin-bot.js";

const VERSION = "0.3.0";
const REGISTRY_DO = "__registry__";

type JsonObject = Record<string, any>;

const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function must(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`缺少配置：${name}`);
  return text;
}

function normalizeProfileId(value: unknown): string {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw new Error(`无效微信用户标识：${id || "(空)"}`);
  return id;
}

async function verifyAccess(request: Request, env: Env) {
  const team = must(env.TEAM_DOMAIN, "TEAM_DOMAIN").replace(/\/$/, "");
  const aud = must(env.POLICY_AUD, "POLICY_AUD");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new Error("缺少 Cloudflare Access JWT");
  const JWKS = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
  return (await jwtVerify(token, JWKS, { issuer: team, audience: aud })).payload;
}

function stubByName(env: Env, name: string) {
  return env.WEIXIN_BOT.get(env.WEIXIN_BOT.idFromName(name));
}

async function callStub(stub: ReturnType<typeof stubByName>, path: string, init?: RequestInit): Promise<JsonObject> {
  const response = await stub.fetch(`https://weixin-bot.internal${path}`, init as any);
  const data = await response.json().catch(() => ({ error: "invalid_json", message: "Durable Object 返回了非 JSON 内容" })) as JsonObject;
  if (!response.ok) throw new Error(data.message || data.error || `Durable Object HTTP ${response.status}`);
  return data;
}

function callRegistry(env: Env, path: string, init?: RequestInit) {
  return callStub(stubByName(env, REGISTRY_DO), path, init);
}

function callUser(env: Env, userId: string, path: string, init?: RequestInit) {
  return callStub(stubByName(env, `user:${normalizeProfileId(userId)}`), path, init);
}

async function profiles(env: Env): Promise<WeixinUserProfile[]> {
  const data = await callRegistry(env, "/registry/users", { method: "GET" });
  return Array.isArray(data.users) ? data.users as WeixinUserProfile[] : [];
}

async function usersWithStatus(env: Env) {
  const list = await profiles(env);
  const statuses = await Promise.all(list.map(async (user) => {
    try {
      return { ...user, status: await callUser(env, user.id, "/status", { method: "GET" }) };
    } catch (error) {
      return { ...user, status: { connected: false, error: error instanceof Error ? error.message : String(error) } };
    }
  }));
  return { users: statuses };
}

async function resolveRecipients(env: Env, requested?: string[]): Promise<WeixinUserProfile[]> {
  const list = await profiles(env);
  const enabled = list.filter((user) => user.enabled);
  if (!enabled.length) throw new Error("尚未在 /admin 添加可用微信用户");
  if (requested?.length) {
    const unique = [...new Set(requested.map(normalizeProfileId))];
    return unique.map((id) => {
      const user = enabled.find((item) => item.id === id);
      if (!user) throw new Error(`微信用户 ${id} 不存在或已停用`);
      return user;
    });
  }
  const defaultUser = enabled.find((user) => user.isDefault);
  if (defaultUser) return [defaultUser];
  if (enabled.length === 1) return enabled;
  throw new Error("存在多个微信用户且未设置默认用户，请明确指定 recipients");
}

async function sendToRecipients(env: Env, text: string, requested?: string[]) {
  const targets = await resolveRecipients(env, requested);
  const results = await Promise.all(targets.map(async (user) => {
    try {
      const response = await callUser(env, user.id, "/send", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
      });
      return { user: { id: user.id, name: user.name }, success: true, ...response };
    } catch (error) {
      return { user: { id: user.id, name: user.name }, success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { success: results.every((item) => item.success), recipients: results };
}

async function pollRecipients(env: Env, limit: number, requested?: string[]) {
  const all = await profiles(env);
  const targets = requested?.length
    ? await resolveRecipients(env, requested)
    : all.filter((user) => user.enabled);
  if (!targets.length) return { success: true, pending: 0, messages: [], users: [] };
  const perUserLimit = Math.min(50, Math.max(1, limit));
  const results = await Promise.all(targets.map(async (user) => {
    try {
      const response = await callUser(env, user.id, "/poll", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: perUserLimit }),
      });
      const messages = (Array.isArray(response.messages) ? response.messages : []).map((message: JsonObject) => ({
        ...message,
        messageRef: `${user.id}:${message.messageRef}`,
        user: { id: user.id, name: user.name },
      }));
      return { user: { id: user.id, name: user.name }, success: true, ...response, messages };
    } catch (error) {
      return { user: { id: user.id, name: user.name }, success: false, pending: 0, messages: [], error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const messages: JsonObject[] = results.flatMap((item) => (item.messages || []) as JsonObject[])
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(0, limit);
  return {
    success: results.every((item) => item.success),
    pending: results.reduce((sum, item) => sum + Number(item.pending || 0), 0),
    messages,
    users: results.map(({ messages: _messages, ...rest }) => rest),
  };
}

function splitGlobalRef(globalRef: string): { userId: string; localRef: string } {
  const index = globalRef.indexOf(":");
  if (index <= 0) throw new Error("messageRef 格式无效，请使用 weixin_poll 返回的原值");
  return { userId: normalizeProfileId(globalRef.slice(0, index)), localRef: globalRef.slice(index + 1) };
}

async function replyByRef(env: Env, globalRef: string, text: string) {
  const { userId, localRef } = splitGlobalRef(globalRef);
  const list = await profiles(env);
  const user = list.find((item) => item.id === userId);
  if (!user) throw new Error(`messageRef 对应的微信用户 ${userId} 已不存在`);
  const response = await callUser(env, userId, "/reply", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageRef: localRef, text }),
  });
  return { ...response, messageRef: globalRef, user: { id: user.id, name: user.name } };
}

async function aggregateMessages(env: Env, limit: number) {
  const list = await profiles(env);
  const data = await Promise.all(list.map(async (user) => {
    try {
      const response = await callUser(env, user.id, `/messages?limit=${Math.min(200, limit)}&offset=0`, { method: "GET" });
      return {
        total: Number(response.total || 0),
        messages: (Array.isArray(response.messages) ? response.messages : []).map((message: JsonObject) => ({
          ...message,
          messageRef: `${user.id}:${message.messageRef}`,
          ...(message.replyTo ? { replyTo: `${user.id}:${message.replyTo}` } : {}),
          user: { id: user.id, name: user.name },
        })),
      };
    } catch {
      return { total: 0, messages: [] as JsonObject[] };
    }
  }));
  const messages = data.flatMap((item) => item.messages)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, limit);
  return { total: data.reduce((sum, item) => sum + item.total, 0), messages };
}

function createServer(env: Env) {
  const server = new McpServer({ name: "weixin-mcp-worker", version: VERSION });

  server.registerTool("weixin_users", {
    description: "列出在 /admin 中维护的微信收信用户、默认用户及绑定状态。",
    inputSchema: {},
  }, async () => result(await usersWithStatus(env)));

  server.registerTool("weixin_status", {
    description: "检查整个微信 MCP 的多用户绑定、待处理消息和最近轮询状态。不会返回 bot_token/context_token。",
    inputSchema: {},
  }, async () => result(await usersWithStatus(env)));

  server.registerTool("weixin_send", {
    description: "把文本发送给一个或多个已配置微信用户。recipients 使用 /admin 中定义的用户标识；省略时发送给默认用户。",
    inputSchema: {
      recipients: z.array(z.string().min(1).max(32)).min(1).max(10).optional().describe("收信用户标识数组，例如 ['zhenhua','wife']。省略则发默认用户。"),
      text: z.string().min(1).max(70_000).describe("要发送的文本内容。"),
    },
  }, async ({ recipients, text }) => result(await sendToRecipients(env, text, recipients)));

  server.registerTool("weixin_poll", {
    description: "按需拉取所有启用微信用户发给各自 ClawBot 的新消息，适合 ChatGPT 每小时任务调用。返回的 messageRef 已包含用户路由信息。",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().default(20),
      recipients: z.array(z.string().min(1).max(32)).min(1).max(10).optional().describe("可选：只轮询指定用户；省略则轮询所有启用用户。"),
    },
  }, async ({ limit, recipients }) => result(await pollRecipients(env, limit, recipients)));

  server.registerTool("weixin_reply", {
    description: "回复 weixin_poll 返回的具体微信消息。直接使用其 messageRef；Worker 会自动定位用户和 context_token。",
    inputSchema: {
      messageRef: z.string().min(3).max(180),
      text: z.string().min(1).max(70_000),
    },
  }, async ({ messageRef, text }) => result(await replyByRef(env, messageRef, text)));

  return server;
}

function accessDenied(error: unknown): Response {
  return Response.json({ error: "access_denied", message: error instanceof Error ? error.message : String(error) }, { status: 403 });
}

async function handleAdmin(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && pathname === "/admin/api/users") return Response.json(await usersWithStatus(env));
  if (request.method === "GET" && pathname === "/admin/api/messages") {
    const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100));
    return Response.json(await aggregateMessages(env, limit));
  }
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  if (pathname === "/admin/api/users/create") {
    return Response.json(await callRegistry(env, "/registry/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }
  if (pathname === "/admin/api/users/update") {
    return Response.json(await callRegistry(env, "/registry/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  }
  if (pathname === "/admin/api/users/delete") {
    const userId = normalizeProfileId(body.id);
    await callUser(env, userId, "/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return Response.json(await callRegistry(env, "/registry/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: userId }) }));
  }
  if (pathname === "/admin/api/login/start") {
    const userId = normalizeProfileId(body.userId);
    const data = await callUser(env, userId, "/login/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const qrSvg = await QRCode.toString(String(data.qrcodeUrl), { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 320 });
    return Response.json({ ...data, userId, qrSvg });
  }
  if (pathname === "/admin/api/login/status") {
    const userId = normalizeProfileId(body.userId);
    return Response.json(await callUser(env, userId, "/login/status", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: body.sessionId, verifyCode: body.verifyCode }),
    }));
  }
  if (pathname === "/admin/api/send") {
    const userId = normalizeProfileId(body.userId);
    return Response.json(await callUser(env, userId, "/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: body.text }) }));
  }
  if (pathname === "/admin/api/poll") {
    const userId = normalizeProfileId(body.userId);
    return Response.json(await callUser(env, userId, "/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: body.limit || 20 }) }));
  }
  if (pathname === "/admin/api/reply") {
    const userId = normalizeProfileId(body.userId);
    return Response.json(await callUser(env, userId, "/reply", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageRef: body.messageRef, text: body.text }),
    }));
  }
  if (pathname === "/admin/api/messages/delete") {
    const { userId, localRef } = splitGlobalRef(String(body.messageRef || ""));
    return Response.json(await callUser(env, userId, "/messages/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageRef: localRef }) }));
  }
  if (pathname === "/admin/api/messages/clear") {
    const userId = normalizeProfileId(body.userId);
    return Response.json(await callUser(env, userId, "/messages/clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.json({ ok: true, service: "weixin-mcp-worker", version: VERSION, mcp: "/mcp", admin: "/admin", health: "/health" });
    }
    if (url.pathname === "/setup") return Response.redirect(new URL("/admin", request.url).toString(), 308);
    if (url.pathname !== "/mcp" && url.pathname !== "/health" && url.pathname !== "/admin" && !url.pathname.startsWith("/admin/api/")) {
      return new Response("Not Found", { status: 404 });
    }

    let identity;
    try { identity = await verifyAccess(request, env); } catch (error) { return accessDenied(error); }

    if (url.pathname === "/admin") {
      return new Response(ADMIN_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
      });
    }
    if (url.pathname.startsWith("/admin/api/")) {
      try { return await handleAdmin(request, env, url.pathname); }
      catch (error) { return Response.json({ error: "admin_error", message: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
    }
    if (url.pathname === "/health") {
      try {
        return Response.json({ ok: true, service: "weixin-mcp-worker", version: VERSION, user: identity.email || identity.sub || "authenticated", weixin: await usersWithStatus(env) });
      } catch (error) {
        return Response.json({ ok: false, service: "weixin-mcp-worker", version: VERSION, error: error instanceof Error ? error.message : String(error) }, { status: 503 });
      }
    }
    return createMcpHandler(() => createServer(env), { route: "/mcp", responseMode: "json" })(request, env, ctx);
  },
};
