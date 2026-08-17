import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import QRCode from "qrcode";
import { z } from "zod";
import { SETUP_PAGE } from "./setup-page.js";
import type { Env } from "./types.js";
export { WeixinBotDO } from "./weixin-bot.js";

const VERSION = "0.1.0";
const PRIMARY_BOT = "primary";

type JsonObject = Record<string, any>;

const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

function must(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`缺少配置：${name}`);
  return text;
}

async function verifyAccess(request: Request, env: Env) {
  const team = must(env.TEAM_DOMAIN, "TEAM_DOMAIN").replace(/\/$/, "");
  const aud = must(env.POLICY_AUD, "POLICY_AUD");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new Error("缺少 Cloudflare Access JWT");
  const JWKS = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
  return (await jwtVerify(token, JWKS, { issuer: team, audience: aud })).payload;
}

function botStub(env: Env) {
  const id = env.WEIXIN_BOT.idFromName(PRIMARY_BOT);
  return env.WEIXIN_BOT.get(id);
}

async function callBot(env: Env, path: string, init?: RequestInit): Promise<JsonObject> {
  const response = await botStub(env).fetch(`https://weixin-bot.internal${path}`, init as any);
  const data = await response.json().catch(() => ({
    error: "invalid_json",
    message: "Durable Object 返回了非 JSON 内容",
  })) as JsonObject;
  if (!response.ok) throw new Error(data.message || data.error || `Durable Object HTTP ${response.status}`);
  return data;
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "weixin-mcp-worker",
    version: VERSION,
  });

  server.registerTool(
    "weixin_status",
    {
      description: "检查微信 ClawBot 是否已绑定，以及 Worker → 微信发送通道的状态。不会返回 bot_token 等敏感凭证。",
      inputSchema: {},
    },
    async () => result(await callBot(env, "/status", { method: "GET" })),
  );

  server.registerTool(
    "weixin_send",
    {
      description: "把文本消息发送到已绑定此 Worker 的微信本人。适合把 ChatGPT 定时任务、监测报告和摘要推送到微信。长文本会自动分段发送。",
      inputSchema: {
        text: z.string().min(1).max(70_000).describe("要发送到绑定微信的文本内容。"),
      },
    },
    async ({ text }) => result(await callBot(env, "/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })),
  );

  return server;
}

function accessDenied(error: unknown): Response {
  return Response.json({
    error: "access_denied",
    message: error instanceof Error ? error.message : String(error),
  }, { status: 403 });
}

async function handleAdmin(request: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname === "/admin/api/status" && request.method === "GET") {
    return Response.json(await callBot(env, "/status", { method: "GET" }));
  }

  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  if (pathname === "/admin/api/login/start") {
    const data = await callBot(env, "/login/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const qrSvg = await QRCode.toString(String(data.qrcodeUrl), {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
    });
    return Response.json({ ...data, qrSvg });
  }

  if (pathname === "/admin/api/login/status") {
    return Response.json(await callBot(env, "/login/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: body.sessionId,
        verifyCode: body.verifyCode,
      }),
    }));
  }

  if (pathname === "/admin/api/send") {
    return Response.json(await callBot(env, "/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body.text }),
    }));
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.json({
        ok: true,
        service: "weixin-mcp-worker",
        version: VERSION,
        mcp: "/mcp",
        setup: "/setup",
        health: "/health",
      });
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/health" && url.pathname !== "/setup" && !url.pathname.startsWith("/admin/api/")) {
      return new Response("Not Found", { status: 404 });
    }

    let identity;
    try {
      identity = await verifyAccess(request, env);
    } catch (error) {
      return accessDenied(error);
    }

    if (url.pathname === "/setup") {
      return new Response(SETUP_PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }

    if (url.pathname.startsWith("/admin/api/")) {
      try {
        return await handleAdmin(request, env, url.pathname);
      } catch (error) {
        return Response.json({
          error: "admin_error",
          message: error instanceof Error ? error.message : String(error),
        }, { status: 400 });
      }
    }

    if (url.pathname === "/health") {
      try {
        return Response.json({
          ok: true,
          service: "weixin-mcp-worker",
          version: VERSION,
          user: identity.email || identity.sub || "authenticated",
          weixin: await callBot(env, "/status", { method: "GET" }),
        });
      } catch (error) {
        return Response.json({
          ok: false,
          service: "weixin-mcp-worker",
          version: VERSION,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 503 });
      }
    }

    return createMcpHandler(() => createServer(env), {
      route: "/mcp",
      responseMode: "json",
    })(request, env, ctx);
  },
};
