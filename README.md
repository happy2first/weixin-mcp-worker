# weixin-mcp-worker

Cloudflare-native Remote MCP for Weixin ClawBot.

Current version: **v0.2.0**.

## What it does

### ChatGPT -> Weixin

```text
ChatGPT / scheduled task
        |
        | weixin_send
        v
Cloudflare Worker
        v
SQLite-backed Durable Object
        v
ilinkai.weixin.qq.com
        v
Weixin ClawBot -> bound Weixin user
```

### Hourly asynchronous Weixin -> ChatGPT -> Weixin

```text
You reply in Weixin ClawBot
        v
Weixin iLink
        |
        | later: ChatGPT Task calls weixin_poll
        v
Worker + Durable Object
        |
        | cursor + context_token + pending message
        v
ChatGPT processes it
        |
        | weixin_reply(messageRef, text)
        v
Weixin ClawBot reply
```

This is **not real-time inbound push**. The Worker cannot wake ChatGPT. ChatGPT must call `weixin_poll`, for example once per hour from a scheduled task.

No VPS, OpenClaw, Docker, D1, KV, R2, Pages, Cloudflare Cron, or OpenAI API is required.

## MCP tools

### `weixin_status`

Checks binding and sync state. It reports fields such as:

```text
connected
pendingInbound
lastPollAt
lastPollReceived
lastPollTimedOut
hasContextToken
```

Raw `bot_token` and `context_token` are never returned.

### `weixin_send`

```json
{
  "text": "房地产监测结果……"
}
```

Sends only to the Weixin user who completed QR binding. There is no arbitrary recipient parameter. Long text is split automatically.

### `weixin_poll`

```json
{
  "limit": 20
}
```

One call:

1. reads the saved `get_updates_buf` cursor;
2. calls `ilink/bot/getupdates` once;
3. stores a new cursor when returned;
4. accepts only messages from the QR-bound Weixin user;
5. stores the message and its `context_token`;
6. returns messages still marked `pending`.

Example:

```json
{
  "success": true,
  "upstreamTimedOut": false,
  "received": 1,
  "ignored": 0,
  "pending": 1,
  "messages": [
    {
      "messageRef": "wxmsg_...",
      "receivedAt": "2026-08-18T01:17:00.000Z",
      "text": "和御景国际比较一下。",
      "itemTypes": [1],
      "status": "pending"
    }
  ]
}
```

If no message is queued, the Worker intentionally aborts the idle long-poll after about 8 seconds and returns `upstreamTimedOut: true`. The cursor is not advanced in that case.

### `weixin_reply`

```json
{
  "messageRef": "wxmsg_...",
  "text": "与御景国际相比……"
}
```

The Worker looks up the inbound message and automatically uses its sender ID and `context_token`. On success it marks the record `replied`.

Repeating `weixin_reply` for an already replied `messageRef` returns `alreadyReplied: true` and does not intentionally send a duplicate.

Pending messages are not marked handled merely because `weixin_poll` returned them. If a ChatGPT run fails before replying, the pending message is returned again on a later poll.

## Recommended ChatGPT Task

Example task instruction:

```text
Every hour, call weixin_poll. If there are pending Weixin messages, process each one using the relevant connected tools and context, then call weixin_reply with that message's messageRef and the final answer. If there are no pending messages, do nothing.
```

Expected delay with hourly polling is 0-60 minutes.

## Manual end-to-end test

After deployment open:

```text
https://YOUR_HOST/setup
```

The setup page supports four checks:

1. status;
2. QR binding;
3. proactive Worker -> Weixin send;
4. inbound pull and `messageRef` reply.

For the inbound test, send a reply in Weixin ClawBot, press **拉取微信回复**, then press **回复这条微信**. This verifies the same path that an hourly ChatGPT Task will use.

## Inbound storage

The SQLite-backed Durable Object stores:

```text
bot_token
ilink_bot_id
ilink_user_id
baseUrl
latest context_token
get_updates_buf cursor
pending/replied inbound messages
```

The lightweight v0.2 inbox uses one bounded Durable Object KV value on the SQLite backend:

- at most 300 retained inbound records;
- inbound normalized text is capped at 4,000 characters per message;
- pending messages are retained preferentially and old replied records are pruned first.

This keeps the simple personal-use inbox comfortably bounded. A future high-volume version should move inbound history into a real SQL table inside the same SQLite-backed Durable Object.

Inbound normalization currently provides:

- text: original text;
- transcribed voice: `[语音转文字] ...`;
- image: `[图片]`;
- file: `[文件] filename`;
- video: `[视频]`.

Media download/decryption is not implemented yet.

## Cloudflare resources

Required:

1. Worker `weixin-mcp-worker`;
2. SQLite-backed Durable Object class `WeixinBotDO`;
3. binding `WEIXIN_BOT`;
4. Cloudflare Access;
5. optional custom domain such as `weixin.mcp.happyfirst.top`.

`wrangler.jsonc` already declares the Durable Object:

```jsonc
"durable_objects": {
  "bindings": [
    {
      "name": "WEIXIN_BOT",
      "class_name": "WeixinBotDO"
    }
  ]
},
"exports": {
  "WeixinBotDO": {
    "type": "durable-object",
    "storage": "sqlite"
  }
}
```

With current Wrangler, first deployment reconciles the export and provisions the namespace. You do not copy a namespace ID into this repository.

## Deploy from GitHub

In Cloudflare Dashboard:

1. Workers & Pages -> create/import from GitHub;
2. select `happy2first/weixin-mcp-worker`;
3. production branch: `main`;
4. Worker name: `weixin-mcp-worker`;
5. deploy command: `npx wrangler deploy`;
6. no separate build command is required.

After deployment verify:

```text
Binding: WEIXIN_BOT
Class:   WeixinBotDO
Storage: SQLite
```

## Cloudflare Access variables

### `TEAM_DOMAIN`

```text
https://your-team.cloudflareaccess.com
```

Do not append `/cdn-cgi/access/certs`.

### `POLICY_AUD`

Set to the Access application's **Application Audience (AUD) Tag**.

### `ILINK_CLIENT_VERSION` (optional)

Default:

```text
2.4.6
```

## Bind ClawBot

Open:

```text
https://YOUR_HOST/setup
```

Then:

1. authenticate through Cloudflare Access;
2. generate QR code;
3. scan in Weixin and confirm;
4. enter the pairing number if Weixin asks;
5. wait for binding success;
6. run the proactive send test;
7. send a reply in ClawBot and run the inbound pull/reply test.

Rebinding clears the prior inbox and cursor.

## Remote MCP URL

```text
https://YOUR_HOST/mcp
```

For the intended custom domain:

```text
https://weixin.mcp.happyfirst.top/mcp
```

## Security

- Weixin credentials are not committed to GitHub.
- Credentials, cursor and conversation tokens stay in Durable Object storage.
- `weixin_send` cannot choose an arbitrary recipient.
- `weixin_poll` ignores senders other than the QR-bound user.
- `weixin_reply` refuses messages whose stored sender does not match the bound user.
- setup/admin/MCP routes are protected by Cloudflare Access JWT validation.

## Upstream references

Protocol behavior follows Tencent's current implementation:

- `https://github.com/Tencent/openclaw-weixin`

MCP packaging was inspired by:

- `https://github.com/bkmashiro/weixin-mcp`

This repository is independent and is not an official Tencent or Weixin product.

## Local check

```bash
npm install
npm run check
```

`npm run check` runs TypeScript checking and a Wrangler dry-run bundle.

## Current limitations

- no real-time Weixin -> ChatGPT push;
- no group chats;
- no arbitrary recipients;
- no inbound media download/decryption;
- no contact directory;
- no OpenAI API bridge;
- no OpenClaw dependency.

## License

MIT.
