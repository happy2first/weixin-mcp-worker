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
  lastNotifyStartAt?: string;
  lastNotifyStartError?: string;
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
