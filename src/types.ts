import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
  WEIXIN_BOT: DurableObjectNamespace;
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  ILINK_CLIENT_VERSION?: string;
}

export interface WeixinAccountState {
  token: string;
  botId: string;
  userId: string;
  baseUrl: string;
  boundAt: string;
  /** Most recent conversation token received from the bound Weixin user. */
  contextToken?: string;
  lastInboundAt?: string;
  lastNotifyStartAt?: string;
  lastNotifyStartError?: string;
}

export interface WeixinSyncState {
  getUpdatesBuf: string;
  lastPollAt?: string;
  lastPollTimedOut?: boolean;
  lastPollReceived?: number;
  lastPollIgnored?: number;
  lastPollError?: string;
}

export type InboundStatus = "pending" | "replied";

export interface InboundMessage {
  messageRef: string;
  /** Internal de-duplication key; never returned by MCP tools. */
  sourceId: string;
  fromUserId: string;
  contextToken?: string;
  text: string;
  itemTypes: number[];
  receivedAt: string;
  createTimeMs?: number;
  status: InboundStatus;
  repliedAt?: string;
  replyMessageIds?: string[];
  lastReplyError?: string;
}

export type LoginStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface LoginSessionState {
  sessionId: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  currentBaseUrl: string;
  status: LoginStatus;
  pendingVerifyCode?: string;
}

export interface LoginQrResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface LoginPollResponse {
  status: LoginStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

export interface WeixinMessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string; playtime?: number };
  file_item?: { file_name?: string; len?: string };
  ref_msg?: { title?: string };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  /** Local marker set when the Worker intentionally aborts an idle long-poll. */
  timedOut?: boolean;
}
