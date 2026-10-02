import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import type { Env } from "./types.js";

export class EventError extends Error {
  code: number;
  reason: string;
  details?: Record<string, string>;
  constructor(code: number, reason: string) { super(reason); this.code = code; this.reason = reason; }
}
export const WEIXIN_MESSAGE_RECEIVED = {
  name: "weixin.message.received",
  description: "A new inbound WeChat message is available. Read it with weixin_poll(messageRefs), then use mediaRef and weixin_reply as needed.",
  delivery: ["webhook"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  payloadSchema: { type: "object", properties: { messageRef: { type: "string" }, mediaRefs: { type: "array", items: { type: "string" } } }, required: ["messageRef", "mediaRefs"], additionalProperties: false },
};
const invalid = (reason: string): never => { throw new EventError(-32602, reason); };
export function eventIdentityParams(raw: any) {
  if (!raw || raw.name !== "weixin.message.received" || raw.delivery?.mode !== "webhook") invalid("unsupported_event_or_delivery");
  const args = raw.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length > 0) invalid("invalid_arguments");
  if (typeof raw.delivery.url !== "string") invalid("invalid_callback_url");
  return { filters: "{}", url: raw.delivery.url };
}
export function signingKey(secret: string): Uint8Array {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) invalid("invalid_signing_secret");
  const bytes = Buffer.from(secret.slice(6), "base64");
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString("base64").replace(/=+$/, "") !== secret.slice(6).replace(/=+$/, "")) invalid("invalid_signing_secret");
  return new Uint8Array(bytes);
}
export async function signature(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", signingKey(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${Buffer.from(signed).toString("base64")}`;
}
export function equalText(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function callbackUrl(raw: string, env: Env): string {
  let url: URL;
  try { url = new URL(raw); } catch { return invalid("invalid_callback_url"); }
  // Workers fetch cannot pin DNS/TLS. Only explicitly configured, platform-owned
  // OpenAI hosts are allowed; never accept arbitrary subscriber-controlled hosts.
  const allowed = (env.EVENTS_CALLBACK_HOSTS ?? "connectors.api.openai.com").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const platformOwned = url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com") || url.hostname === "openai.com" || url.hostname.endsWith(".openai.com");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || !platformOwned || !allowed.includes(url.hostname)) {
    const error = new EventError(-32602, "callback_host_not_allowed");
    error.details = { callbackHost: url.hostname };
    throw error;
  }
  return url.href;
}
export const eventsEnabled = (env: Env) => env.EVENTS_ENABLED !== "false";
// owner is supplied exclusively by the outer verified Access JWT, never RPC params.
export function authorized(owner: string, env: Env) { return eventsEnabled(env) && typeof owner === "string" && owner.trim().length > 0; }
export function expiration(ttl: unknown, now: number): number {
  if (ttl !== undefined && ttl !== null && (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl <= 0)) invalid("invalid_ttl");
  // Finite leases only; null is a request, not an obligation to grant infinity.
  return now + Math.max(60_000, Math.min(typeof ttl === "number" ? ttl : 86_400_000, 7 * 86_400_000));
}
async function digest(value: string) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
}
export async function subscriptionId(owner: string, url: string, filters: string) {
  return `sub_${await digest(JSON.stringify([owner, url, "weixin.message.received", filters]))}`;
}
async function encryptionKey(env: Env) {
  if (!/^[a-fA-F0-9]{64}$/.test(env.EVENTS_ENCRYPTION_KEY || "")) throw new EventError(-32603, "missing_events_encryption_key");
  return crypto.subtle.importKey("raw", Buffer.from(env.EVENTS_ENCRYPTION_KEY!, "hex"), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(secret: string, ownerId: string, env: Env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ownerId) }, await encryptionKey(env), new TextEncoder().encode(secret));
  return `${Buffer.from(iv).toString("base64")}.${Buffer.from(bytes).toString("base64")}`;
}
async function unseal(value: string, ownerId: string, env: Env) {
  const [iv, bytes] = value.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64"), additionalData: new TextEncoder().encode(ownerId) }, await encryptionKey(env), Buffer.from(bytes, "base64")));
}
export async function signedPost(env: Env, sub: { id: string; url: string }, secrets: string[], id: string, body: string, fetcher: typeof fetch = fetch) {
  if (Buffer.byteLength(body) > 262144) throw new EventError(-32602, "payload_too_large");
  const timestamp = Math.floor(Date.now() / 1000);
  const signatures = await Promise.all(secrets.map(s => signature(s, id, timestamp, body)));
  const response = await fetcher(callbackUrl(sub.url, env), { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(10_000), headers: {
    "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": signatures.join(" "), "X-MCP-Subscription-Id": sub.id,
  } });
  return response;
}
type Subscription = { id: string; owner: string; url: string; filters: string; secret: string; old_secret: string | null; rotation_until: number; expires: number; verified_until: number; revision: string };
type Delivery = { sub_id: string; occurrence: string; event_id: string; body: string; attempts: number; retry_at: number; status: string };

export class WeixinEvents {
  private ticking = false;
  private mutations = new Map<string, symbol>();
  private ctx: DurableObjectState;
  private env: Env;
  constructor(ctx: DurableObjectState, env: Env) { this.ctx = ctx; this.env = env; }
  schema() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS event_subscriptions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, url TEXT NOT NULL, filters TEXT NOT NULL, secret TEXT NOT NULL, old_secret TEXT, rotation_until INTEGER NOT NULL, expires INTEGER NOT NULL, verified_until INTEGER NOT NULL, revision TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS event_deliveries (sub_id TEXT NOT NULL, occurrence TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(sub_id,occurrence))`);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_event_retry ON event_deliveries(status,retry_at)");
  }
  async request(method: string, owner: string, params: any) {
    this.schema();
    if (!authorized(owner, this.env)) throw new EventError(-32001, "events_access_denied");
    if (method === "events/list") return { events: [WEIXIN_MESSAGE_RECEIVED] };
    const identity = eventIdentityParams(params);
    const url = callbackUrl(identity.url, this.env);
    const id = await subscriptionId(owner, url, identity.filters);
    const mutation = Symbol();
    const sql = this.ctx.storage.sql;
    if (method === "events/unsubscribe") {
      this.mutations.delete(id);
      this.ctx.storage.transactionSync(() => {
        sql.exec("DELETE FROM event_subscriptions WHERE id=? AND owner=?", id, owner);
        sql.exec("DELETE FROM event_deliveries WHERE sub_id=?", id);
      });
      return {};
    }
    if (method !== "events/subscribe") invalid("unsupported_method");
    this.mutations.set(id, mutation);
    try {
    if (params.cursor !== undefined && params.cursor !== null) invalid("replay_not_supported");
    await encryptionKey(this.env);
    const secret = params.delivery.secret;
    signingKey(secret);
    const now = Date.now(), expires = expiration(params.ttlMs, now);
    const existing = sql.exec<Subscription>("SELECT * FROM event_subscriptions WHERE id=?", id).toArray()[0];
    const total = sql.exec<{ n: number }>("SELECT COUNT(*) n FROM event_subscriptions WHERE expires>?", now).toArray()[0].n;
    if (!existing && total >= 100) throw new EventError(-32001, "subscription_limit");
    const old = existing ? await unseal(existing.secret, id, this.env) : null;
    if (!existing || existing.expires <= now || existing.verified_until <= now || old !== secret) {
      const challenge = crypto.randomUUID();
      try {
        const response = await signedPost(this.env, { id, url }, [secret], `msg_verification_${crypto.randomUUID()}`, JSON.stringify({ type: "verification", challenge }));
        if (!response.ok) throw new EventError(-32015, "challenge_failed");
        // Bound the response body as well as the network request.
        const reader = response.body?.getReader(); let bytes = 0, result = "";
        if (!reader) throw new EventError(-32015, "challenge_failed");
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 4096) { await reader.cancel(); throw new EventError(-32015, "challenge_failed"); } result += new TextDecoder().decode(chunk.value); }
        if (!equalText(JSON.parse(result).challenge, challenge)) throw new EventError(-32015, "challenge_failed");
      } catch (error) {
        if (error instanceof EventError) throw error;
        throw new EventError(-32015, error instanceof Error && /timeout|abort/i.test(error.name) ? "timeout" : "challenge_failed");
      }
    }
    const encrypted = await seal(secret, id, this.env);
    const encryptedUrl = await seal(url, id, this.env);
    // A concurrent unsubscribe/renewal must not be undone by an in-flight challenge.
    const current = sql.exec<Subscription>("SELECT * FROM event_subscriptions WHERE id=?", id).toArray()[0];
    if (this.mutations.get(id) !== mutation || current?.revision !== existing?.revision) throw new EventError(-32015, "subscription_changed_retry");
    if (!authorized(owner, this.env)) throw new EventError(-32001, "events_access_denied");
    if (!current && sql.exec<{ n: number }>("SELECT COUNT(*) n FROM event_subscriptions WHERE expires>?", Date.now()).toArray()[0].n >= 100) throw new EventError(-32001, "subscription_limit");
    sql.exec(`INSERT INTO event_subscriptions VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,old_secret=excluded.old_secret,rotation_until=excluded.rotation_until,expires=excluded.expires,verified_until=excluded.verified_until,revision=excluded.revision`,
      id, owner, encryptedUrl, identity.filters, encrypted, old && old !== secret ? existing.secret : existing?.old_secret ?? null, old && old !== secret ? now + 300_000 : existing?.rotation_until ?? 0, expires, now + 300_000, crypto.randomUUID());
    return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
    } finally { if (this.mutations.get(id) === mutation) this.mutations.delete(id); }
  }
  // Called only through the internal registry DO binding. User DO keeps its
  // durable outbox until acknowledgement; retries use INSERT OR IGNORE.
  async enqueue(messageRef: string, mediaRefs: string[], timestamp: string): Promise<boolean> {
    this.schema();
    const sql = this.ctx.storage.sql, now = Date.now();
    const subs = sql.exec<Subscription>("SELECT * FROM event_subscriptions WHERE expires>?", now).toArray();
    if (!eventsEnabled(this.env) || !subs.length) return false;
    const eventId = `evt_${await digest(JSON.stringify(["weixin.message.received", messageRef]))}`;
    const body = JSON.stringify({ eventId, name: "weixin.message.received", timestamp, data: { messageRef, mediaRefs }, cursor: null });
    // Event ID is tied to the message, independent of retries and subscriptions.
    let accepted = false;
    this.ctx.storage.transactionSync(() => {
      for (const sub of subs) if (sql.exec("SELECT id FROM event_subscriptions WHERE id=? AND expires>?",sub.id,Date.now()).toArray().length) { accepted = true; sql.exec(`INSERT OR IGNORE INTO event_deliveries(sub_id,occurrence,event_id,body,retry_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM event_subscriptions WHERE id=? AND expires>?)`, sub.id, messageRef, eventId, body, now, sub.id, Date.now()); }
    });
    return accepted;
  }
  async tick() {
    this.schema();
    if (this.ticking || !eventsEnabled(this.env)) return;
    this.ticking = true;
    try {
      const sql = this.ctx.storage.sql, now = Date.now();
      sql.exec("DELETE FROM event_subscriptions WHERE expires<=?", now);
      sql.exec("UPDATE event_subscriptions SET old_secret=NULL WHERE rotation_until<=? AND old_secret IS NOT NULL", now);
      sql.exec("DELETE FROM event_deliveries WHERE NOT EXISTS (SELECT 1 FROM event_subscriptions s WHERE s.id=sub_id)");
      const pending = sql.exec<Delivery>("SELECT * FROM event_deliveries WHERE status='pending' AND retry_at<=? ORDER BY retry_at LIMIT 5", now).toArray();
      await Promise.all(pending.map(d => this.deliver(d)));
    } finally { this.ticking = false; }
  }
  private async deliver(d: Delivery) {
    const sql = this.ctx.storage.sql, now = Date.now();
    const sub = sql.exec<Subscription>("SELECT * FROM event_subscriptions WHERE id=? AND expires>?", d.sub_id, now).toArray()[0];
    if (!sub || !authorized(sub.owner, this.env)) return;
    // Persist recovery lease before I/O, including across DO restarts.
    sql.exec("UPDATE event_deliveries SET attempts=attempts+1,retry_at=? WHERE sub_id=? AND occurrence=?", now + 120_000, d.sub_id, d.occurrence);
    let status = 0;
    try {
      const secrets = [await unseal(sub.secret, sub.id, this.env)];
      if (sub.old_secret && sub.rotation_until > now) secrets.push(await unseal(sub.old_secret, sub.id, this.env));
      const url = await unseal(sub.url, sub.id, this.env);
      const current = sql.exec<Subscription>("SELECT * FROM event_subscriptions WHERE id=?", sub.id).toArray()[0];
      if (!current || current.revision !== sub.revision || current.expires <= Date.now() || !authorized(sub.owner, this.env)) return;
      const response = await signedPost(this.env, { id: sub.id, url }, secrets, d.event_id, d.body);
      status = response.status;
      await response.body?.cancel();
    } catch { /* No callback URL, response, secret or message content in logs. */ }
    const success = status >= 200 && status < 300;
    // All failures, including 410 and redirects, leave the subscription active.
    // The network layer never follows a redirect. Retry continues until expiry.
    sql.exec("UPDATE event_deliveries SET status=?,retry_at=? WHERE sub_id=? AND occurrence=?", success ? "sent" : "pending", Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(d.attempts, 6)) + Math.floor(Math.random() * 5000), d.sub_id, d.occurrence);
    if (!success) {
      let callbackHost: string | undefined;
      try { callbackHost = new URL(await unseal(sub.url, sub.id, this.env)).hostname; } catch {}
      console.warn({ method: "events/deliver", authorized: true, reason: status === 0 ? "delivery_failed" : status >= 300 && status < 400 ? "redirect_rejected" : "callback_rejected", ...(callbackHost ? { callbackHost } : {}) });
    }
  }
}
