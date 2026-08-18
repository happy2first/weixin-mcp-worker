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
  LoginSessionState,
  MessageKind,
  PublicMessageRecord,
  WeixinAccountState,
  WeixinMessage,
  WeixinMessageItem,
  WeixinSyncState,
  WeixinUserProfile,
} from "./types.js";

const ACCOUNT_KEY = "account";
const LOGIN_KEY = "login";
const SYNC_KEY = "sync";
const REGISTRY_KEY = "registry.users";
const LOGIN_TTL_MS = 5 * 60_000;
const SEND_CHUNK_SIZE = 3500;
const MAX_INBOUND_TEXT = 20_000;
const STORAGE_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

type MessageRow = {
  message_ref: string;
  source_id: string | null;
  direction: "inbound" | "outbound";
  kind: MessageKind;
  text: string | null;
  status: "pending" | "replied" | "sent" | "failed";
  context_token: string | null;
  from_user_id: string | null;
  created_at: string;
  replied_at: string | null;
  reply_to: string | null;
  metadata_json: string | null;
  external_ids_json: string | null;
  error: string | null;
};

type PollResult = {
  success: true;
  upstreamTimedOut: boolean;
  received: number;
  ignored: number;
  pending: number;
  messages: PublicMessageRecord[];
  lastPollAt: string;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStorageFullError(error: unknown): boolean {
  return /SQLITE_FULL|database or disk is full/i.test(errorMessage(error));
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
    default:
      return item.type == null ? "[未知消息]" : `[消息类型 ${item.type}]`;
  }
}

function messageText(message: WeixinMessage): string {
  const text = (message.item_list || []).map(itemText).filter(Boolean).join("\n").trim();
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
  return ["fallback", message.from_user_id || "", String(message.create_time_ms || 0), messageText(message)].join(":");
}

function messageKind(message: WeixinMessage): MessageKind {
  const types = [...new Set((message.item_list || []).map((item) => item.type).filter((v): v is number => typeof v === "number"))];
  if (types.length > 1) return "mixed";
  switch (types[0]) {
    case 1: return "text";
    case 2: return "image";
    case 3: return "voice";
    case 4: return "file";
    case 5: return "video";
    default: return "unknown";
  }
}

function safeMediaMetadata(message: WeixinMessage): Record<string, unknown> {
  const items = (message.item_list || []).map((item) => {
    if (item.type === 1) return { type: "text" };
    if (item.type === 2) return {
      type: "image",
      midSize: item.image_item?.mid_size ?? null,
      width: item.image_item?.thumb_width ?? null,
      height: item.image_item?.thumb_height ?? null,
      hasMedia: Boolean(item.image_item?.media?.encrypt_query_param || item.image_item?.media?.full_url),
    };
    if (item.type === 3) return {
      type: "voice",
      transcript: item.voice_item?.text || null,
      playtimeMs: item.voice_item?.playtime ?? null,
      sampleRate: item.voice_item?.sample_rate ?? null,
      hasMedia: Boolean(item.voice_item?.media?.encrypt_query_param || item.voice_item?.media?.full_url),
    };
    if (item.type === 4) return {
      type: "file",
      fileName: item.file_item?.file_name || null,
      length: item.file_item?.len || null,
      hasMedia: Boolean(item.file_item?.media?.encrypt_query_param || item.file_item?.media?.full_url),
    };
    if (item.type === 5) return {
      type: "video",
      videoSize: item.video_item?.video_size ?? null,
      playLength: item.video_item?.play_length ?? null,
      hasMedia: Boolean(item.video_item?.media?.encrypt_query_param || item.video_item?.media?.full_url),
    };
    return { type: item.type ?? "unknown" };
  });
  return { items };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function publicRow(row: MessageRow): PublicMessageRecord {
  return {
    messageRef: row.message_ref,
    direction: row.direction,
    kind: row.kind,
    text: row.text || "",
    status: row.status,
    createdAt: row.created_at,
    ...(row.replied_at ? { repliedAt: row.replied_at } : {}),
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    externalIds: parseJson<string[]>(row.external_ids_json, []),
    ...(row.error ? { error: row.error } : {}),
  };
}

function normalizeProfileId(value: unknown): string {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
    throw new Error("用户标识只能使用小写字母、数字、_、-，长度 1-32，且必须以字母或数字开头");
  }
  return id;
}

export class WeixinBotDO extends DurableObject<Env> {
  private pollInFlight?: Promise<PollResult>;
  private lastStorageAlertAt = 0;

  private ensureSchema() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      message_ref TEXT PRIMARY KEY,
      source_id TEXT UNIQUE,
      direction TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      status TEXT NOT NULL,
      context_token TEXT,
      from_user_id TEXT,
      created_at TEXT NOT NULL,
      replied_at TEXT,
      reply_to TEXT,
      metadata_json TEXT,
      external_ids_json TEXT,
      error TEXT
    )`);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(direction, status, created_at)");
  }

  private async account(): Promise<WeixinAccountState | undefined> {
    return this.ctx.storage.get<WeixinAccountState>(ACCOUNT_KEY);
  }

  private async alertStorageFull(error: unknown): Promise<void> {
    if (!isStorageFullError(error)) return;
    const now = Date.now();
    if (now - this.lastStorageAlertAt < STORAGE_ALERT_COOLDOWN_MS) return;
    this.lastStorageAlertAt = now;
    try {
      const account = await this.account();
      if (!account?.token || !account.userId) return;
      await sendTextMessage(this.env, {
        baseUrl: account.baseUrl,
        token: account.token,
        toUserId: account.userId,
        contextToken: account.contextToken,
        text: "微信 MCP 存储空间已满，新的历史记录或媒体文件可能无法保存。请打开 /admin 删除不需要的消息或媒体后再试。",
      });
    } catch (alertError) {
      console.error("WeixinBotDO storage alert failed:", errorMessage(alertError));
    }
  }

  private async login(): Promise<LoginSessionState | undefined> {
    return this.ctx.storage.get<LoginSessionState>(LOGIN_KEY);
  }

  private async syncState(): Promise<WeixinSyncState> {
    return (await this.ctx.storage.get<WeixinSyncState>(SYNC_KEY)) || { getUpdatesBuf: "" };
  }

  private async registryUsers(): Promise<WeixinUserProfile[]> {
    return (await this.ctx.storage.get<WeixinUserProfile[]>(REGISTRY_KEY)) || [];
  }

  private async registryList() {
    const users = await this.registryUsers();
    return { users: users.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
  }

  private async registryCreate(body: Record<string, unknown>) {
    const id = normalizeProfileId(body.id);
    const name = String(body.name || "").trim();
    if (!name || name.length > 40) throw new Error("显示名称不能为空且最多 40 个字符");
    const users = await this.registryUsers();
    if (users.some((user) => user.id === id)) throw new Error(`用户标识 ${id} 已存在`);
    const now = new Date().toISOString();
    const profile: WeixinUserProfile = {
      id,
      name,
      enabled: true,
      isDefault: users.length === 0 || Boolean(body.isDefault),
      createdAt: now,
      updatedAt: now,
    };
    if (profile.isDefault) users.forEach((user) => { user.isDefault = false; user.updatedAt = now; });
    users.push(profile);
    await this.ctx.storage.put(REGISTRY_KEY, users);
    return { success: true, user: profile };
  }

  private async registryUpdate(body: Record<string, unknown>) {
    const id = normalizeProfileId(body.id);
    const users = await this.registryUsers();
    const index = users.findIndex((user) => user.id === id);
    if (index < 0) throw new Error(`用户 ${id} 不存在`);
    const now = new Date().toISOString();
    const current = users[index];
    if (body.name !== undefined) {
      const name = String(body.name || "").trim();
      if (!name || name.length > 40) throw new Error("显示名称不能为空且最多 40 个字符");
      current.name = name;
    }
    if (body.enabled !== undefined) current.enabled = Boolean(body.enabled);
    if (body.isDefault === true) {
      users.forEach((user) => { user.isDefault = user.id === id; user.updatedAt = now; });
    }
    current.updatedAt = now;
    users[index] = current;
    await this.ctx.storage.put(REGISTRY_KEY, users);
    return { success: true, user: current };
  }

  private async registryRemove(body: Record<string, unknown>) {
    const id = normalizeProfileId(body.id);
    const users = await this.registryUsers();
    const target = users.find((user) => user.id === id);
    if (!target) throw new Error(`用户 ${id} 不存在`);
    let next = users.filter((user) => user.id !== id);
    if (target.isDefault && next.length > 0) {
      next = next.map((user, index) => ({ ...user, isDefault: index === 0, updatedAt: new Date().toISOString() }));
    }
    await this.ctx.storage.put(REGISTRY_KEY, next);
    return { success: true, removed: id };
  }

  private async status() {
    this.ensureSchema();
    const [account, login, sync] = await Promise.all([this.account(), this.login(), this.syncState()]);
    const counts = this.ctx.storage.sql.exec<{ total: number; pending: number }>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN direction='inbound' AND status='pending' THEN 1 ELSE 0 END) AS pending FROM messages",
    ).toArray()[0];
    return {
      connected: Boolean(account?.token && account?.userId),
      botId: maskId(account?.botId),
      userId: maskId(account?.userId),
      baseUrl: account?.baseUrl || null,
      boundAt: account?.boundAt || null,
      lastInboundAt: account?.lastInboundAt || null,
      hasContextToken: Boolean(account?.contextToken),
      messageCount: Number(counts?.total || 0),
      pendingInbound: Number(counts?.pending || 0),
      lastPollAt: sync.lastPollAt || null,
      lastPollReceived: sync.lastPollReceived ?? null,
      lastPollTimedOut: sync.lastPollTimedOut ?? null,
      lastPollError: sync.lastPollError || null,
      lastNotifyStartAt: account?.lastNotifyStartAt || null,
      lastNotifyStartError: account?.lastNotifyStartError || null,
      login: login ? {
        sessionId: login.sessionId,
        status: login.status,
        startedAt: new Date(login.startedAt).toISOString(),
        expired: Date.now() - login.startedAt > LOGIN_TTL_MS,
      } : null,
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
    const result = await pollLoginStatus(this.env, login.currentBaseUrl, login.qrcode, login.pendingVerifyCode);
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
      return { connected: false, status: result.status, needsVerifyCode: true, message: "请输入微信显示的配对数字" };
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
      if (account?.token) return { connected: true, status: result.status, alreadyConnected: true, message: "该 ClawBot 已绑定到当前用户" };
      throw new Error("微信提示该 ClawBot 已绑定，但当前用户没有本地凭证；请重新绑定");
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
      await this.ctx.storage.delete([LOGIN_KEY, SYNC_KEY]);
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
        message: "微信 ClawBot 已绑定",
      };
    }
    await this.ctx.storage.put(LOGIN_KEY, login);
    return { connected: false, status: result.status, message: result.status === "scaned" ? "已扫码，请在微信中确认" : "等待扫码" };
  }

  private insertHistory(row: MessageRow) {
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT INTO messages(message_ref,source_id,direction,kind,text,status,context_token,from_user_id,created_at,replied_at,reply_to,metadata_json,external_ids_json,error)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.message_ref, row.source_id, row.direction, row.kind, row.text, row.status,
      row.context_token, row.from_user_id, row.created_at, row.replied_at, row.reply_to,
      row.metadata_json, row.external_ids_json, row.error,
    );
  }

  private async send(text: string) {
    const account = await this.account();
    if (!account?.token || !account.userId) throw new Error("尚未绑定微信 ClawBot，请先在 /admin 完成扫码绑定");
    const chunks = splitText(text);
    if (!chunks.length) throw new Error("消息内容不能为空");
    if (chunks.length > 20) throw new Error("消息过长；单次最多发送约 7 万字符");
    const ref = `out_${crypto.randomUUID().replace(/-/g, "")}`;
    const messageIds: string[] = [];
    try {
      for (const chunk of chunks) {
        messageIds.push(await sendTextMessage(this.env, {
          baseUrl: account.baseUrl,
          token: account.token,
          toUserId: account.userId,
          text: chunk,
          contextToken: account.contextToken,
        }));
      }
      this.insertHistory({
        message_ref: ref, source_id: null, direction: "outbound", kind: "text", text,
        status: "sent", context_token: null, from_user_id: null, created_at: new Date().toISOString(),
        replied_at: null, reply_to: null, metadata_json: JSON.stringify({ chunks: chunks.length }),
        external_ids_json: JSON.stringify(messageIds), error: null,
      });
      return { success: true, messageRef: ref, recipient: maskId(account.userId), usedContextToken: Boolean(account.contextToken), chunks: chunks.length, messageIds };
    } catch (error) {
      this.insertHistory({
        message_ref: ref, source_id: null, direction: "outbound", kind: "text", text,
        status: "failed", context_token: null, from_user_id: null, created_at: new Date().toISOString(),
        replied_at: null, reply_to: null, metadata_json: JSON.stringify({ chunks: chunks.length }),
        external_ids_json: JSON.stringify(messageIds), error: errorMessage(error),
      });
      throw error;
    }
  }

  private pendingMessages(limit: number): PublicMessageRecord[] {
    this.ensureSchema();
    return this.ctx.storage.sql.exec<MessageRow>(
      "SELECT * FROM messages WHERE direction='inbound' AND status='pending' ORDER BY created_at ASC LIMIT ?",
      limit,
    ).toArray().map(publicRow);
  }

  private async performPoll(limit: number): Promise<PollResult> {
    const account = await this.account();
    if (!account?.token || !account.userId) throw new Error("尚未绑定微信 ClawBot，请先在 /admin 完成扫码绑定");
    this.ensureSchema();
    const sync = await this.syncState();
    const now = new Date().toISOString();
    try {
      const response = await getUpdates(this.env, { baseUrl: account.baseUrl, token: account.token, getUpdatesBuf: sync.getUpdatesBuf });
      if (response.timedOut) {
        sync.lastPollAt = now;
        sync.lastPollTimedOut = true;
        sync.lastPollReceived = 0;
        sync.lastPollIgnored = 0;
        sync.lastPollError = undefined;
        await this.ctx.storage.put(SYNC_KEY, sync);
      } else {
        const isApiError = (response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0);
        if (isApiError) throw new Error(`微信 getUpdates 失败：ret=${response.ret ?? 0}, errcode=${response.errcode ?? 0}, errmsg=${response.errmsg || "unknown"}`);
        let received = 0;
        let ignored = 0;
        for (const message of response.msgs || []) {
          if (message.message_type !== undefined && message.message_type !== 1) { ignored += 1; continue; }
          if (!message.from_user_id || message.from_user_id !== account.userId) { ignored += 1; continue; }
          const id = sourceId(message);
          const existing = this.ctx.storage.sql.exec<{ message_ref: string }>("SELECT message_ref FROM messages WHERE source_id=? LIMIT 1", id).toArray()[0];
          if (existing) continue;
          const createTimeMs = typeof message.create_time_ms === "number" && Number.isFinite(message.create_time_ms) ? message.create_time_ms : undefined;
          const messageRef = `wxmsg_${crypto.randomUUID().replace(/-/g, "")}`;
          this.insertHistory({
            message_ref: messageRef,
            source_id: id,
            direction: "inbound",
            kind: messageKind(message),
            text: messageText(message),
            status: "pending",
            context_token: message.context_token || null,
            from_user_id: message.from_user_id,
            created_at: createTimeMs ? new Date(createTimeMs).toISOString() : now,
            replied_at: null,
            reply_to: null,
            metadata_json: JSON.stringify(safeMediaMetadata(message)),
            external_ids_json: null,
            error: null,
          });
          received += 1;
          if (message.context_token) account.contextToken = message.context_token;
          account.lastInboundAt = now;
        }
        if (response.get_updates_buf) sync.getUpdatesBuf = response.get_updates_buf;
        sync.lastPollAt = now;
        sync.lastPollTimedOut = false;
        sync.lastPollReceived = received;
        sync.lastPollIgnored = ignored;
        sync.lastPollError = undefined;
        await this.ctx.storage.put({ [ACCOUNT_KEY]: account, [SYNC_KEY]: sync });
      }
    } catch (error) {
      sync.lastPollAt = now;
      sync.lastPollError = errorMessage(error);
      await this.ctx.storage.put(SYNC_KEY, sync);
      throw error;
    }
    const pending = this.pendingMessages(limit);
    const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE direction='inbound' AND status='pending'").toArray()[0];
    return {
      success: true,
      upstreamTimedOut: Boolean(sync.lastPollTimedOut),
      received: sync.lastPollReceived || 0,
      ignored: sync.lastPollIgnored || 0,
      pending: Number(count?.count || 0),
      messages: pending,
      lastPollAt: sync.lastPollAt || now,
    };
  }

  private async poll(limit: number): Promise<PollResult> {
    if (!this.pollInFlight) {
      this.pollInFlight = this.performPoll(limit).finally(() => { this.pollInFlight = undefined; });
    }
    return this.pollInFlight;
  }

  private async reply(messageRef: string, text: string) {
    const account = await this.account();
    if (!account?.token || !account.userId) throw new Error("尚未绑定微信 ClawBot，请先在 /admin 完成扫码绑定");
    this.ensureSchema();
    const row = this.ctx.storage.sql.exec<MessageRow>("SELECT * FROM messages WHERE message_ref=? LIMIT 1", messageRef).toArray()[0];
    if (!row || row.direction !== "inbound") throw new Error("找不到 messageRef；请先调用 weixin_poll 获取待处理消息");
    if (row.status === "replied") return { success: true, alreadyReplied: true, messageRef, repliedAt: row.replied_at };
    if (row.from_user_id !== account.userId) throw new Error("该消息不是来自当前绑定微信用户，拒绝回复");
    const chunks = splitText(text);
    if (!chunks.length) throw new Error("回复内容不能为空");
    if (chunks.length > 20) throw new Error("回复过长；单次最多发送约 7 万字符");
    const outboundRef = `out_${crypto.randomUUID().replace(/-/g, "")}`;
    const messageIds: string[] = [];
    try {
      for (const chunk of chunks) {
        messageIds.push(await sendTextMessage(this.env, {
          baseUrl: account.baseUrl,
          token: account.token,
          toUserId: row.from_user_id,
          text: chunk,
          contextToken: row.context_token || account.contextToken,
        }));
      }
      const repliedAt = new Date().toISOString();
      this.ctx.storage.sql.exec("UPDATE messages SET status='replied', replied_at=?, error=NULL WHERE message_ref=?", repliedAt, messageRef);
      this.insertHistory({
        message_ref: outboundRef, source_id: null, direction: "outbound", kind: "text", text,
        status: "sent", context_token: null, from_user_id: null, created_at: repliedAt,
        replied_at: null, reply_to: messageRef, metadata_json: JSON.stringify({ chunks: chunks.length }),
        external_ids_json: JSON.stringify(messageIds), error: null,
      });
      if (row.context_token) account.contextToken = row.context_token;
      await this.ctx.storage.put(ACCOUNT_KEY, account);
      return { success: true, alreadyReplied: false, messageRef, outboundMessageRef: outboundRef, chunks: chunks.length, messageIds, repliedAt };
    } catch (error) {
      this.ctx.storage.sql.exec("UPDATE messages SET error=? WHERE message_ref=?", errorMessage(error), messageRef);
      this.insertHistory({
        message_ref: outboundRef, source_id: null, direction: "outbound", kind: "text", text,
        status: "failed", context_token: null, from_user_id: null, created_at: new Date().toISOString(),
        replied_at: null, reply_to: messageRef, metadata_json: JSON.stringify({ chunks: chunks.length }),
        external_ids_json: JSON.stringify(messageIds), error: errorMessage(error),
      });
      throw error;
    }
  }

  private listMessages(limit: number, offset: number) {
    this.ensureSchema();
    const rows = this.ctx.storage.sql.exec<MessageRow>("SELECT * FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?", limit, offset).toArray();
    const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages").toArray()[0];
    return { total: Number(count?.count || 0), limit, offset, messages: rows.map(publicRow) };
  }

  private deleteMessage(messageRef: string) {
    this.ensureSchema();
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE message_ref=?", messageRef);
    return { success: true, deleted: messageRef };
  }

  private clearMessages() {
    this.ensureSchema();
    this.ctx.storage.sql.exec("DELETE FROM messages");
    return { success: true };
  }

  private async reset() {
    this.ensureSchema();
    await this.ctx.storage.delete([ACCOUNT_KEY, LOGIN_KEY, SYNC_KEY]);
    this.ctx.storage.sql.exec("DELETE FROM messages");
    return { success: true };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/registry/users") return json(await this.registryList());
      if (request.method === "GET" && url.pathname === "/status") return json(await this.status());
      if (request.method === "GET" && url.pathname === "/messages") {
        const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
        const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
        return json(this.listMessages(limit, offset));
      }
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;

      if (url.pathname === "/registry/create") return json(await this.registryCreate(body));
      if (url.pathname === "/registry/update") return json(await this.registryUpdate(body));
      if (url.pathname === "/registry/remove") return json(await this.registryRemove(body));
      if (url.pathname === "/login/start") return json(await this.startLogin());
      if (url.pathname === "/login/status") {
        const sessionId = String(body.sessionId || "").trim();
        if (!sessionId) throw new Error("缺少 sessionId");
        return json(await this.pollLogin(sessionId, typeof body.verifyCode === "string" ? body.verifyCode : undefined));
      }
      if (url.pathname === "/send") return json(await this.send(String(body.text || "")));
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
      if (url.pathname === "/messages/delete") return json(this.deleteMessage(String(body.messageRef || "").trim()));
      if (url.pathname === "/messages/clear") return json(this.clearMessages());
      if (url.pathname === "/reset") return json(await this.reset());
      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error("WeixinBotDO:", errorMessage(error));
      await this.alertStorageFull(error);
      return json({ error: "weixin_error", message: errorMessage(error) }, 400);
    }
  }
}
