import { DurableObject } from "cloudflare:workers";
import {
  fetchLoginQr,
  ILINK_FIXED_BASE_URL,
  normalizeIlinkBaseUrl,
  notifyStart,
  pollLoginStatus,
  sendTextMessage,
} from "./ilink.js";
import type { Env, LoginSessionState, WeixinAccountState } from "./types.js";

const ACCOUNT_KEY = "account";
const LOGIN_KEY = "login";
const LOGIN_TTL_MS = 5 * 60_000;
const SEND_CHUNK_SIZE = 3500;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maskId(value?: string): string | null {
  if (!value) return null;
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function splitText(text: string, max = SEND_CHUNK_SIZE): string[] {
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

export class WeixinBotDO extends DurableObject<Env> {
  private async account(): Promise<WeixinAccountState | undefined> {
    return this.ctx.storage.get<WeixinAccountState>(ACCOUNT_KEY);
  }

  private async login(): Promise<LoginSessionState | undefined> {
    return this.ctx.storage.get<LoginSessionState>(LOGIN_KEY);
  }

  private async status() {
    const account = await this.account();
    const login = await this.login();
    return {
      connected: Boolean(account?.token && account?.userId),
      botId: maskId(account?.botId),
      userId: maskId(account?.userId),
      baseUrl: account?.baseUrl || null,
      boundAt: account?.boundAt || null,
      lastNotifyStartAt: account?.lastNotifyStartAt || null,
      lastNotifyStartError: account?.lastNotifyStartError || null,
      login: login
        ? {
            sessionId: login.sessionId,
            status: login.status,
            startedAt: new Date(login.startedAt).toISOString(),
            expired: Date.now() - login.startedAt > LOGIN_TTL_MS,
          }
        : null,
    };
  }

  private async startLogin() {
    const current = await this.account();
    const localTokens = current?.token ? [current.token] : [];
    const qr = await fetchLoginQr(this.env, localTokens);
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error("微信未返回有效二维码");

    const login: LoginSessionState = {
      sessionId: crypto.randomUUID(),
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
      currentBaseUrl: ILINK_FIXED_BASE_URL,
      status: "wait",
    };
    await this.ctx.storage.put(LOGIN_KEY, login);
    return {
      sessionId: login.sessionId,
      qrcodeUrl: login.qrcodeUrl,
      expiresAt: new Date(login.startedAt + LOGIN_TTL_MS).toISOString(),
      status: login.status,
    };
  }

  private async pollLogin(sessionId: string, verifyCode?: string) {
    const login = await this.login();
    if (!login || login.sessionId !== sessionId) throw new Error("登录会话不存在，请重新生成二维码");
    if (Date.now() - login.startedAt > LOGIN_TTL_MS) {
      await this.ctx.storage.delete(LOGIN_KEY);
      return { connected: false, status: "expired", message: "二维码已过期，请重新生成" };
    }

    if (verifyCode?.trim()) login.pendingVerifyCode = verifyCode.trim();
    const result = await pollLoginStatus(
      this.env,
      login.currentBaseUrl,
      login.qrcode,
      login.pendingVerifyCode,
    );
    login.status = result.status;

    if (result.status === "scaned_but_redirect") {
      if (!result.redirect_host) throw new Error("微信要求切换节点，但未返回 redirect_host");
      login.currentBaseUrl = normalizeIlinkBaseUrl(result.redirect_host);
      await this.ctx.storage.put(LOGIN_KEY, login);
      return { connected: false, status: result.status, message: "已扫码，正在切换微信节点并继续验证" };
    }

    if (result.status === "scaned" && login.pendingVerifyCode) {
      login.pendingVerifyCode = undefined;
    }

    if (result.status === "need_verifycode") {
      await this.ctx.storage.put(LOGIN_KEY, login);
      return {
        connected: false,
        status: result.status,
        needsVerifyCode: true,
        message: login.pendingVerifyCode ? "配对码不匹配，请重新输入微信显示的数字" : "请输入微信显示的配对数字",
      };
    }

    if (result.status === "verify_code_blocked") {
      login.pendingVerifyCode = undefined;
      await this.ctx.storage.put(LOGIN_KEY, login);
      return { connected: false, status: result.status, message: "配对码多次错误，请重新生成二维码后再试" };
    }

    if (result.status === "expired") {
      await this.ctx.storage.delete(LOGIN_KEY);
      return { connected: false, status: result.status, message: "二维码已过期，请重新生成" };
    }

    if (result.status === "binded_redirect") {
      const account = await this.account();
      await this.ctx.storage.delete(LOGIN_KEY);
      if (account?.token) {
        return { connected: true, status: result.status, alreadyConnected: true, message: "该 ClawBot 已绑定到当前 Worker" };
      }
      throw new Error("微信提示该 ClawBot 已绑定，但当前 Worker 没有本地凭证；请换一个 ClawBot 或解除原绑定后重试");
    }

    if (result.status === "confirmed") {
      if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id) {
        throw new Error("微信确认成功，但未返回完整 bot_token / bot_id / user_id");
      }
      const account: WeixinAccountState = {
        token: result.bot_token,
        botId: result.ilink_bot_id,
        userId: result.ilink_user_id,
        baseUrl: normalizeIlinkBaseUrl(result.baseurl || login.currentBaseUrl),
        boundAt: new Date().toISOString(),
      };
      await this.ctx.storage.put(ACCOUNT_KEY, account);
      await this.ctx.storage.delete(LOGIN_KEY);

      try {
        await notifyStart(this.env, account.baseUrl, account.token);
        account.lastNotifyStartAt = new Date().toISOString();
        account.lastNotifyStartError = undefined;
      } catch (error) {
        account.lastNotifyStartError = errorMessage(error);
      }
      await this.ctx.storage.put(ACCOUNT_KEY, account);

      return {
        connected: true,
        status: result.status,
        botId: maskId(account.botId),
        userId: maskId(account.userId),
        boundAt: account.boundAt,
        notifyStartWarning: account.lastNotifyStartError || null,
        message: "微信 ClawBot 已绑定到 Worker",
      };
    }

    await this.ctx.storage.put(LOGIN_KEY, login);
    return {
      connected: false,
      status: result.status,
      message: result.status === "scaned" ? "已扫码，请在微信中确认" : "等待扫码",
    };
  }

  private async send(text: string) {
    const account = await this.account();
    if (!account?.token || !account.userId) throw new Error("尚未绑定微信 ClawBot，请先打开 /setup 完成扫码绑定");
    const chunks = splitText(text);
    if (!chunks.length) throw new Error("消息内容不能为空");
    if (chunks.length > 20) throw new Error("消息过长；单次最多发送约 7 万字符");

    const messageIds: string[] = [];
    for (const chunk of chunks) {
      messageIds.push(await sendTextMessage(this.env, {
        baseUrl: account.baseUrl,
        token: account.token,
        toUserId: account.userId,
        text: chunk,
      }));
    }
    return {
      success: true,
      recipient: maskId(account.userId),
      chunks: chunks.length,
      messageIds,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/status") {
        return json(await this.status());
      }
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      if (url.pathname === "/login/start") return json(await this.startLogin());
      if (url.pathname === "/login/status") {
        const sessionId = String(body.sessionId || "").trim();
        if (!sessionId) throw new Error("缺少 sessionId");
        return json(await this.pollLogin(sessionId, typeof body.verifyCode === "string" ? body.verifyCode : undefined));
      }
      if (url.pathname === "/send") {
        const text = String(body.text || "");
        return json(await this.send(text));
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error("WeixinBotDO:", errorMessage(error));
      return json({ error: "weixin_error", message: errorMessage(error) }, 400);
    }
  }
}
