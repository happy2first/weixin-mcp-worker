import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export interface Env {
  WEIXIN_BOT: DurableObjectNamespace;
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  ILINK_CLIENT_VERSION?: string;
}

export interface WeixinUserProfile {
  id: string;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WeixinAccountState {
  token: string;
  botId: string;
  userId: string;
  baseUrl: string;
  boundAt: string;
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

export interface CDNMediaRef {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface WeixinMessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: {
    media?: CDNMediaRef;
    thumb_media?: CDNMediaRef;
    aeskey?: string;
    url?: string;
    mid_size?: number;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
    hd_size?: number;
  };
  voice_item?: {
    media?: CDNMediaRef;
    encode_type?: number;
    bits_per_sample?: number;
    sample_rate?: number;
    playtime?: number;
    text?: string;
  };
  file_item?: {
    media?: CDNMediaRef;
    file_name?: string;
    md5?: string;
    len?: string;
  };
  video_item?: {
    media?: CDNMediaRef;
    video_size?: number;
    play_length?: number;
    video_md5?: string;
    thumb_media?: CDNMediaRef;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
  };
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
  timedOut?: boolean;
}

export interface GetUploadUrlResponse {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

export type MessageDirection = "inbound" | "outbound";
export type MessageStatus = "pending" | "replied" | "sent" | "failed";
export type MessageKind = "text" | "image" | "voice" | "file" | "video" | "mixed" | "unknown";
export type SendableMediaKind = "image" | "file" | "video";

export interface StoredMediaDescriptor {
  mediaRef: string;
  kind: Extract<MessageKind, "image" | "voice" | "file" | "video">;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  itemIndex: number;
  createdAt: string;
}

export interface PublicMessageRecord {
  messageRef: string;
  direction: MessageDirection;
  kind: MessageKind;
  text: string;
  status: MessageStatus;
  createdAt: string;
  repliedAt?: string;
  replyTo?: string;
  metadata?: Record<string, unknown> & { media?: StoredMediaDescriptor[]; mediaErrors?: string[] };
  externalIds?: string[];
  error?: string;
}

export interface UploadedMediaInfo {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aesKeyHex: string;
  fileSize: number;
  fileSizeCiphertext: number;
}
