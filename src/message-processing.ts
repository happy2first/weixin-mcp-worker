export function claimMessages(ctx: DurableObjectState, refs: string[]) {
  const sql = ctx.storage.sql, now = Date.now(), token = crypto.randomUUID();
  const messages: any[] = [];
  ctx.storage.transactionSync(() => {
    for (const ref of [...new Set(refs)]) {
      const row = sql.exec<any>("SELECT * FROM messages WHERE message_ref=? AND direction='inbound' AND status='pending'", ref).toArray()[0];
      if (!row) continue;
      const lease = sql.exec<any>("SELECT * FROM message_processing WHERE message_ref=?", ref).toArray()[0];
      if (lease?.lease_until > now || lease?.reply_state === "sending" || lease?.reply_state === "uncertain" || lease?.reply_state === "done") continue;
      sql.exec("INSERT INTO message_processing(message_ref,token,lease_until,reply_state) VALUES(?,?,?,'idle') ON CONFLICT(message_ref) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until", ref, token, now + 600_000);
      messages.push(row);
    }
  });
  return { messages, processingToken: token };
}
export function beginReply(ctx: DurableObjectState, ref: string, token?: string) {
  const sql = ctx.storage.sql;
  ctx.storage.transactionSync(() => {
    const lease = sql.exec<any>("SELECT * FROM message_processing WHERE message_ref=?", ref).toArray()[0];
    if (lease?.reply_state === "sending" || lease?.reply_state === "uncertain" || lease?.reply_state === "done") throw new Error("reply_delivery_uncertain_or_in_progress: inspect history before manual recovery");
    if (lease?.lease_until > Date.now() && lease.token !== token) throw new Error("message_processing_lease_conflict");
    if (token && lease?.token !== token) throw new Error("message_processing_token_invalid");
    sql.exec("INSERT INTO message_processing(message_ref,token,lease_until,reply_state) VALUES(?,?,0,'sending') ON CONFLICT(message_ref) DO UPDATE SET reply_state='sending'", ref, token || "");
  });
}
