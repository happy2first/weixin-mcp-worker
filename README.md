# weixin-mcp-worker

Cloudflare-native Remote MCP for Weixin ClawBot.

Current version: **v0.2.0**.

It is designed for two practical paths without a VPS or OpenClaw:

```text
A. ChatGPT -> Weixin

ChatGPT / scheduled task
        |
        | MCP: weixin_send
        v
Cloudflare Worker
        v
SQLite-backed Durable Object
        v
ilinkai.weixin.qq.com
        v
Weixin ClawBot -> bound Weixin user
```

```text
B. Hourly asynchronous Weixin -> ChatGPT -> Weixin

You reply in Weixin ClawBot
        v
Weixin iLink keeps the message
        |
        | later: ChatGPT scheduled task calls weixin_poll
        v
Cloudflare Worker + Durable Object
        |
        | stores cursor, context_token and inbound message
        v
ChatGPT processes the message
        |
        | MCP: weixin_reply(messageRef, text)
        v
Weixin ClawBot reply
```

This is **not real-time inbound push**. The Worker does not call or wake ChatGPT. ChatGPT must call `weixin_poll`, for example from an hourly scheduled task.

## Features

- Remote MCP endpoint at `/mcp`
- `weixin_status`: binding and inbound-sync status
- `weixin_send`: proactively send text to the bound Weixin user
- `weixin_poll`: pull one iLink update batch and return pending inbound messages
- `weixin_reply`: reply to a specific inbound message by `messageRef`
- Browser setup page at `/setup`
- QR-code binding including redirect / pairing-code states
- Long outbound text is split into multiple Weixin messages
- Inbound `get_updates_buf` cursor is persisted in Durable Object storage
- Inbound `context_token` is persisted and automatically used for replies
- Pending/replied message state is persisted in Durable Object storage
- Duplicate inbound messages are suppressed by source message identifiers
- `weixin_reply` is idempotent for already-replied `messageRef` values
- Cloudflare Access JWT validation for `/mcp`, `/health`, `/setup`, and setup APIs
- Owner-only design: inbound messages from users other than the QR-bound user are ignored
- Credentials are stored in Durable Object storage, not GitHub or Worker source

## Upstream / protocol references

The iLink protocol behavior follows Tencent's current `Tencent/openclaw-weixin` implementation. The idea of exposing the channel through MCP was inspired by `bkmashiro/weixin-mcp`.

- Tencent: `https://github.com/Tencent/openclaw-weixin`
- Community MCP: `https://github.com/bkmashiro/weixin-mcp`

This repository is an independent project and is not an official Tencent or Weixin product.

## Cloudflare resources

Required:

1. One Cloudflare Worker
2. One SQLite-backed Durable Object namespace exported as `WeixinBotDO`
3. Durable Object binding `WEIXIN_BOT`
4. Cloudflare Access in front of the Worker
5. Optional custom domain such as `weixin.mcp.example.com`

Not required:

- VPS
- OpenClaw
- Docker
- D1
- KV
- R2
- Pages
- Queues
- Cron Triggers
- OpenAI API

The hourly inbound check is expected to be initiated by ChatGPT Tasks through `weixin_poll`, so the Worker itself does not need a Cloudflare Cron Trigger.

## Durable Object configuration

`wrangler.jsonc` already declares the binding and SQLite-backed Durable Object:

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

With current Wrangler, the first `wrangler deploy` reconciles the export and provisions the namespace. There is no namespace ID to put in this repository.

## Deploy from GitHub in Cloudflare

1. Open **Workers & Pages**.
2. Create/import an application from GitHub.
3. Select this repository.
4. Worker name: `weixin-mcp-worker`.
5. Production branch: `main`.
6. Deploy command: `npx wrangler deploy`.
7. No separate build command is required.
8. Deploy.

After deployment verify the binding:

```text
Binding: WEIXIN_BOT
Class:   WeixinBotDO
Storage: SQLite
```

## Custom domain

Bind the Worker to a hostname such as:

```text
weixin.mcp.example.com
```

For the intended deployment this can be:

```text
weixin.mcp.happyfirst.top
```

## Cloudflare Access

Protect the hostname with a Cloudflare Access self-hosted application.

Set Worker variables:

### `TEAM_DOMAIN`

Example:

```text
https://your-team.cloudflareaccess.com
```

Do not append `/cdn-cgi/access/certs`; the Worker appends it.

### `POLICY_AUD`

Use the Access application's **Application Audience (AUD) Tag**.

### `ILINK_CLIENT_VERSION` (optional)

Default:

```text
2.4.6
```

Leave it unset initially unless Tencent's current iLink compatibility version requires an update.

## Bind Weixin ClawBot

After deployment, custom-domain setup, Access setup and variables:

1. Open `https://weixin.mcp.example.com/setup`.
2. Authenticate through Cloudflare Access.
3. Click **生成新的二维码**.
4. Scan in Weixin and confirm the ClawBot connection.
5. Enter a numeric pairing code if Weixin requests one.
6. Wait for **绑定成功**.
7. Use **发到我的微信** for the first end-to-end send test.

Stored in Durable Object storage after binding:

```text
bot_token
ilink_bot_id
ilink_user_id
baseUrl
binding timestamp
latest context_token (after inbound messages are polled)
get_updates_buf cursor
inbound pending/replied messages
```

The MCP/status APIs never expose the raw `bot_token` or `context_token`.

## MCP URL

```text
https://weixin.mcp.example.com/mcp
```

## MCP tools

### `weixin_status`

No arguments.

Returns binding status plus fields such as:

```text
pendingInbound
lastPollAt
lastPollReceived
lastPollTimedOut
hasContextToken
```

### `weixin_send`

Input:

```json
{
  "text": "房地产监测结果……"
}
```

This always sends to the Weixin user who completed QR binding. There is no arbitrary recipient parameter.

### `weixin_poll`

Input:

```json
{
  "limit": 20
}
```

Behavior:

1. Reads the saved `get_updates_buf` cursor from the Durable Object.
2. Calls `ilink/bot/getupdates` once.
3. Stores a new cursor when returned.
4. Accepts only direct user messages from the QR-bound user.
5. Stores each new inbound message and its `context_token`.
6. Returns messages whose status is still `pending`.

Example response shape:

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

If no queued message is available, the Worker intentionally aborts the idle iLink long-poll after about 8 seconds and returns `upstreamTimedOut: true`. This is normal and does not advance the cursor.

### `weixin_reply`

Input:

```json
{
  "messageRef": "wxmsg_...",
  "text": "与御景国际相比……"
}
```

The Worker looks up the stored inbound message and automatically uses its sender ID and `context_token`. After a successful reply the message is marked `replied`.

Calling `weixin_reply` again with the same already-replied `messageRef` returns `alreadyReplied: true` and does not send a duplicate.

## Recommended ChatGPT hourly task pattern

Example task intent:

```text
Every hour, call weixin_poll. If there are pending Weixin messages, process each one using the relevant connected tools and context, then call weixin_reply with that message's messageRef and the final answer. If there are no pending messages, do nothing.
```

Example flow:

```text
09:00 ChatGPT real-estate task
      -> weixin_send(report)

09:17 You reply in Weixin ClawBot:
      "和御景国际比较一下"

10:00 Hourly ChatGPT task
      -> weixin_poll()
      -> receives messageRef + text
      -> performs analysis
      -> weixin_reply(messageRef, answer)

10:00+ Weixin receives the answer
```

Expected latency is 0-60 minutes when the polling task runs hourly.

## Inbound message handling

v0.2 focuses on text-oriented AI workflows.

Inbound normalization currently returns:

- text: original text
- voice with transcription: `[语音转文字] ...`
- image: `[图片]`
- file: `[文件] filename`
- video: `[视频]`

It does not yet download or decrypt inbound media.

Up to 500 inbound message records are retained in the Durable Object. Pending messages are preferentially retained; old replied records are pruned first.

## Security design

- No Weixin credential is committed to GitHub.
- `bot_token`, `context_token` and cursor stay in Durable Object storage.
- `weixin_send` has no arbitrary recipient parameter.
- `weixin_poll` ignores inbound users other than the QR-bound user.
- `weixin_reply` refuses to reply to a stored message whose sender does not match the bound user.
- `/setup`, admin APIs and MCP are protected by Cloudflare Access JWT validation.
- Rebinding clears the old inbox and cursor so messages from a prior ClawBot binding do not leak into the new binding.

## HTTP routes

| Route | Auth | Purpose |
|---|---|---|
| `/` | no Worker JWT check | basic metadata |
| `/health` | Cloudflare Access JWT | Worker / binding / sync health |
| `/setup` | Cloudflare Access JWT | QR binding and send-test UI |
| `/admin/api/*` | Cloudflare Access JWT | setup UI backend |
| `/mcp` | Cloudflare Access JWT | Remote MCP |

## Local checks

```bash
npm install
npm run check
```

`npm run check` runs TypeScript type checking and a Wrangler dry-run deployment bundle.

## Current limitations

- No real-time Weixin -> ChatGPT push
- No OpenAI API bridge
- No group chats
- No arbitrary recipients
- No image/file/video outbound MCP tools yet
- No inbound media download/decryption
- No contact directory
- No full-text message archive beyond the bounded DO inbox

## License

MIT.
