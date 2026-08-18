import { DurableObject } from "cloudflare:workers";
import {
  fetchLoginQr,
  getUpdates,
  ILINK_FIXED_BASE_URL,
  normalizeIlinkBaseUrl,
  notifyStart,
  pollLoginStatus,
  sendTextMessage,
} from "./ilink.js";
import type {
  Env,
  InboundMessage,
  LoginSessionState,
  WeixinAccountState,
  WeixinMessage,
  WeixinMessageItem,
  WeixinSyncState,
} from "./types.js";

const ACCOUNT_KEY = "account";
const LOGIN_KEY = "login";
const SYNC_KEY = "sync";
const INBOX_KEY = "inbox";
const LOGIN_TTL_MS = 5 * 60_000;
const SEND_CHUNK_SIZE = 3500;
const MAX_INBOX_MESSAGES = 500;
const MAX_INBOUND_TEXT = 20_000;

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

function itemText(item: WeixinMessageItem): string {
  switch (item.type) {
    case 1:
      return item.text_item?.text?.trim() || "";
    case 2:
      return "[图片]";
    case 3:
      return item.voice_item?.text?.trim()
        ? `[语音转文字] ${item.voice_item.text.trim()}`
        : "[语音消息]";
    case 4:
      return item.file_item?.file_name ? `[文件] ${item.file_item.file_name}` : "[文件]";
    case 5:
      return "[视频]";
    case 11:
      return "[工具调用开始]";
    case 12:
      return "[工具调用结果]";
    default:
      return item.type == null ? "[未知消息]" : `[消息类型 ${item.type}]`;
  }
}

function messageText(message: WeixinMessage): string {
  const text = (message.item_list || [])
    .map(itemText)
    .filter(Boolean)
    .join("\n")
    .trim();
  const normalized = text || "[无文本内容]";
  return normalized.length > MAX_INBOUND_TEXT
    ? `${normalized.slice(0, MAX_INBOUND_TEXT)}\n[内容已截断]`
    : normalized;
}

function sourceId(message: WeixinMessage): string {
  if (message.client_id) return `client:${message.client_id}`;
  if (message.message_id != null) return `message:${String(message.message_id)}`;
  const itemId = message.item_list?.find((item) => item.msg_id)?.msg_id;
  if (itemId) return `item:${itemId}`;
  return [
    "fallback",
    message.from_user_id || "",
    String(message.create_time_ms || 0),
    messageText(message),
  ].join(":");
}

function publicMessage(message: InboundMessage) {
  return {
    messageRef: message.messageRef,
    receivedAt: message.receivedAt,
    text: message.text,
    itemTypes: message.itemTypes,
    status: message.status,
  };
}

function pruneInbox(messages: InboundMessage[]): InboundMessage[] {
  if (messages.length <= MAX_INBOX_MESSAGES) return messages;
  const pending = messages.filter((message) => message.status === "pending");
  const replied = messages.filter((message) => message.status === "replied");
  const keepReplied = Math.max(0, MAX_INBOX_MESSAGES - pending.length);
  return [...replied.slice(-keepReplied), ...pending].slice(-MAX_INBOX_MESSAGES);
}

type PollResult = {
  success: true;
  upstreamTimedOut: boolean;
  received: number;
  ignored: number;
  pending: number;
  messages: ReturnType<typeof publicMessage>[];
  lastPollAt: string;
};

export class WeixinBotDO extends DurableObject<Env> {
  private pollInFlight?: Promise<PollResult>;

  private async account(): Promise<WeixinAccountState | undefined> {
    return this.ctx.storage.get<WeixinAccountState>(ACCOUNT_KEY);
  }

  private async login(): Promise<LoginSessionState | undefined> {
    return this.ctx.storage.get<LoginSessionState>(LOGIN_KEY);
  }

  private async syncState(): Promise<WeixinSyncState> {
    return (await this.ctx.storage.get<WeixinSyncState>(SYNC_KEY)) || { getUpdatesBuf: "" };
  }

  private async inbox(): Promise<InboundMessage[]> {
    return (await this.ctx.storage.get<InboundMessage[]>(INBOX_KEY)) || [];
  }

  private async status() {
    const [account, login, sync, inbox] = await Promise.all([
      this.account(),
      this.login(),
      this.syncState(),
      this.inbox(),
    ]);
    return {
      connected: Boolean(account?.token && account?.userId),
      botId: maskId(account?.botId),
      userId: maskId(account?.userId),
      baseUrl: account?.baseUrl || null,
      boundAt: account?.boundAt || null,
      lastInboundAt: account?.lastInboundAt || null,
      hasContextToken: Boolean(account?.contextToken),
      pendingInbound: inbox.filter((message) => message.status === "pending").length,
      lastPollAt: sync.lastPollAt || null,
      lastPollReceived: sync.lastPollReceived ?? null,
      lastPollTimedOut: sync.lastPollTimedOut ?? null,
      lastPollError: sync.lastPollError || null,
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

    if (result.status === "scaned" && login.pendingVerifyCode) login.pendingVerifyCode = undefined;

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
      await this.ctx.storage.delete([LOGIN_KEY, SYNC_KEY, INBOX_KEY]);

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
        contextToken: account.contextToken,
      }));
    }
    return {
      success: true,
      recipient: maskId(account.userId),
      usedContextToken: Boolean(account.contextToken),
      chunks: chunks.length,
      messageIds,
    };
  }

  private async performPoll(limit: number): Promise<PollResult> {
    const account = await this.account();
    if (!account?.token || !account.userId) throw new Error("尚未绑定微信 ClawBot，请先打开 /setup 完成扫码绑定");

    const sync = await this.syncState();
    let inbox = await this.inbox();
    const now = new Date().toISOString();

    try {
      const response = await getUpdates(this.env, {
        baseUrl: account.baseUrl,
        token: account.token,
        getUpdatesBuf: sync.getUpdatesBuf,
      });

      if (response.timedOut) {
        sync.lastPollAt = now;
        sync.lastPollTimedOut = true;
        sync.lastPollReceived = 0;
        sync.lastPollIgnored = 0;
        sync.lastPollError = undefined;
        await this.ctx.storage.put(SYNC_KEY, sync);
      } else {
        const isApiError =
          (response.ret !== undefined && response.ret !== 0) ||
          (response.errcode !== undefined && response.errcode !== 0);
        if (isApiError) {
          throw new Error(`微信 getUpdates 失败：ret=${response.ret ?? 0}, errcode=${response.errcode ?? 0}, errmsg=${response.errmsg || "unknown"}`);
        }

        let received = 0;
        let ignored = 0;
        const known = new Set(inbox.map((message) => message.sourceId));

        for (const message of response.msgs || []) {
          // This Worker is intentionally owner-only. Ignore bot echoes and any sender
          // other than the Weixin user that performed the QR binding.
          if (message.message_type !== undefined && message.message_type !== 1) {
            ignored += 1;
            continue;
          }
          if (!message.from_user_id || message.from_user_id !== account.userId) {
            ignored += 1;
            continue;
          }

          const id = sourceId(message);
          if (known.has(id)) continue;
          known.add(id);

          const inbound: InboundMessage = {
            messageRef: `wxmsg_${crypto.randomUUID().replace(/-/g, "")}`,
            sourceId: id,
            fromUserId: message.from_user_id,
            contextToken: message.context_token,
            text: messageText(message),
            itemTypes: (message.item_list || []).map((item) => item.type).filter((type): type is number => typeof type === "number"),
            receivedAt: message.create_time_ms
              ? new Date(message.create_time_ms).toISOString()
              : now,
            createTimeMs: message.create_time_ms,
            status: "pending",
          };
          inbox.push(inbound);
          received += 1;

          if (message.context_token) account.contextToken = message.context_token;
          account.lastInboundAt = now;
        }

        inbox = pruneInbox(inbox);
        if (response.get_updates_buf) sync.getUpdatesBuf = response.get_updates_buf;
        sync.lastPollAt = now;
        sync.lastPollTimedOut = false;
        sync.lastPollReceived = received;
        sync.lastPollIgnored = ignored;
        sync.lastPollError = undefined;

        await this.ctx.storage.put({
          [ACCOUNT_KEY]: account,
          [SYNC_KEY]: sync,
          [INBOX_KEY]: inbox,
        });
      }
    } catch (error) {
      sync.lastPollAt = now;
      sync.lastPollError = errorMessage(error);
      await this.ctx.storage.put(SYNC_KEY, sync);
      throw error;
    }

    const pending = inbox.filter((message) => message.status === "pending");
    return {
      success: true,
      upstreamTimedOut: Boolean(sync.lastPollTimedOut),
      received: sync.lastPollReceived || 0,
      ignored: sync.lastPollIgnored || 0,
      pending: pending.length,
      messages: pending.slice(0, limit).map(publicMessage),
      lastPollAt: sync.lastPollAt || now,
    };
  }

  private async poll(limit: number): Promise<PollResult> {
    if (!this.pollInFlight) {
      this.pollInFlight = this.performPoll(limit).finally(() => {
        this.pollInFlight = undefined;
      });
    }
    return this.pollInFlight;
  }

  private async reply(messageRef: string, text: string) {
    const account = await this.account();
    if (!account?.token || !account.userId) throw new Error("尚未绑定微信 ClawBot，请先打开 /setup 完成扫码绑定");

    const chunks = splitText(text);
    if (!chunks.length) throw new Error("回复内容不能为空");
    if (chunks.length > 20) throw new Error("回复过长；单次最多发送约 7 万字符");

    const inbox = await this.inbox();
    const index = inbox.findIndex((message) => message.messageRef === messageRef);
    if (index < 0) throw new Error("找不到 messageRef；请先调用 weixin_poll 获取待处理消息");
    const message = inbox[index];

    if (message.status === "replied") {
      return {
        success: true,
        alreadyReplied: true,
        messageRef,
        repliedAt: message.repliedAt,
        messageIds: message.replyMessageIds || [],
      };
    }

    if (message.fromUserId !== account.userId) throw new Error("该消息不是来自当前绑定微信用户，拒绝回复");

    const messageIds: string[] = [];
    try {
      for (const chunk of chunks) {
        messageIds.push(await sendTextMessage(this.env, {
          baseUrl: account.baseUrl,
          token: account.token,
          toUserId: message.fromUserId,
          text: chunk,
          contextToken: message.contextToken || account.contextToken,
        }));
      }
    } catch (error) {
      message.lastReplyError = errorMessage(error);
      inbox[index] = message;
      await this.ctx.storage.put(INBOX_KEY, inbox);
      throw error;
    }

    message.status = "replied";
    message.repliedAt = new Date().toISOString();
    message.replyMessageIds = messageIds;
    message.lastReplyError = undefined;
    inbox[index] = message;
    if (message.contextToken) account.contextToken = message.contextToken;

    await this.ctx.storage.put({
      [ACCOUNT_KEY]: account,
      [INBOX_KEY]: inbox,
    });

    return {
      success: true,
      alreadyReplied: false,
      messageRef,
      chunks: chunks.length,
      messageIds,
      repliedAt: message.repliedAt,
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
        return json(await this.send(String(body.text || "")));
      }
      if (url.pathname === "/poll") {
        const requested = Number(body.limit || 20);
        const limit = Number.isFinite(requested) ? Math.min(50, Math.max(1, Math.trunc(requested))) : 20;
        return json(await this.poll(limit));
      }
      if (url.pathname === "/reply") {
        const messageRef = String(body.messageRef || "").trim();
        if (!messageRef) throw new Error("缺少 messageRef");
        return json(await this.reply(messageRef, String(body.text || "")));
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error("WeixinBotDO:", errorMessage(error));
      return json({ error: "weixin_error", message: errorMessage(error) }, 400);
    }
  }
}
