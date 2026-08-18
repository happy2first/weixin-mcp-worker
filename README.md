# weixin-mcp-worker

Cloudflare-native Remote MCP for Weixin ClawBot.

Current version: **v0.3.0**.

## Architecture

```text
ChatGPT / scheduled task
        |
        | Remote MCP /mcp
        v
Cloudflare Worker
        |
        +--> WeixinBotDO: user:zhenhua --> Weixin ClawBot --> Weixin A
        |
        +--> WeixinBotDO: user:wife    --> Weixin ClawBot --> Weixin B
        |
        +--> WeixinBotDO: __registry__ --> user registry
```

No VPS, OpenClaw, Docker, D1, KV, Pages, Cloudflare Cron, or OpenAI API is required for text send and hourly asynchronous reply handling.

## Main URLs

After binding a custom domain:

```text
MCP:   https://weixin.mcp.example.com/mcp
Admin: https://weixin.mcp.example.com/admin
Health:https://weixin.mcp.example.com/health
```

`/setup` is retained only as a compatibility redirect to `/admin`.

## v0.3 features

- Multiple Weixin recipients in one Worker.
- Friendly user IDs and display names maintained in `/admin`.
- One default recipient; `weixin_send` can omit `recipients` and send to the default.
- Send to one or several configured recipients by ID.
- Each recipient has an independent Durable Object instance, bot token, cursor and context token.
- Hourly/on-demand inbound polling across all enabled users.
- `messageRef` includes routing information so `weixin_reply` automatically replies through the correct account.
- SQLite message history per user Durable Object.
- Stores both inbound text and outbound/reply text history.
- Admin UI can rename, enable/disable, set default, re-bind, delete users, delete individual messages and clear a user's history.
- Deleting a user clears that user's stored credentials, cursor and message history.
- Cloudflare Access protects `/admin`, `/admin/api/*`, `/mcp` and `/health`.

## MCP tools

### `weixin_users`

Lists configured recipients and binding status.

### `weixin_status`

Returns multi-user connection/sync status without exposing raw credentials.

### `weixin_send`

Send to the default user:

```json
{
  "text": "房地产监测结果……"
}
```

Send to selected users:

```json
{
  "recipients": ["zhenhua", "wife"],
  "text": "家庭提醒……"
}
```

Recipient IDs can only be IDs pre-created in `/admin`; arbitrary Weixin IDs cannot be supplied.

### `weixin_poll`

```json
{
  "limit": 20
}
```

By default polls all enabled users. It returns pending messages with a global `messageRef` such as:

```text
zhenhua:wxmsg_...
```

Optional recipient filter:

```json
{
  "limit": 20,
  "recipients": ["zhenhua"]
}
```

### `weixin_reply`

```json
{
  "messageRef": "zhenhua:wxmsg_...",
  "text": "回复内容……"
}
```

The Worker routes the reply to the correct Durable Object and uses the stored context token.

## Message history

Each user Durable Object uses SQLite storage for message history instead of one large KV array. Records include:

- direction: inbound/outbound
- kind: text/image/voice/file/video/mixed
- text or safe textual representation
- status
- timestamps
- reply relationship
- Weixin message IDs
- safe media metadata

Raw bot tokens and context tokens are never returned by the admin or MCP APIs.

## Multimedia boundary

Tencent's current Weixin protocol exposes inbound message item types for:

- text
- image
- voice
- file
- video

v0.3 records the type and safe metadata. If Weixin includes voice transcription text, that text is preserved in history.

v0.3 does **not** persist the binary image/file/audio/video payload in Durable Object storage. Large binary media should be stored in Cloudflare R2 in a later media-storage extension.

Tencent's current official `openclaw-weixin` implementation has outbound upload/send implementations for image, file and video. Outbound voice upload/send is not treated as supported by this project until an equivalent official implementation is available and validated.

## Cloudflare resources

Required for v0.3:

1. One Worker.
2. One SQLite-backed Durable Object namespace/class `WeixinBotDO`.
3. One binding named `WEIXIN_BOT`.
4. Cloudflare Access.
5. Optional custom domain.

The same Durable Object namespace contains multiple named objects:

```text
__registry__
user:zhenhua
user:wife
...
```

No extra Durable Object namespace is needed when more users are added.

`wrangler.jsonc` already declares the Durable Object binding and SQLite storage. The first `npx wrangler deploy` reconciles/provisions it.

## Deploy from GitHub

Cloudflare Dashboard:

1. Workers & Pages.
2. Import repository.
3. Select `happy2first/weixin-mcp-worker`.
4. Worker name: `weixin-mcp-worker`.
5. Production branch: `main`.
6. Deploy command: `npx wrangler deploy`.
7. No separate build command is required.

After deploy verify:

```text
Binding: WEIXIN_BOT
Class:   WeixinBotDO
Storage: SQLite
```

## Cloudflare Access variables

Set Worker variables:

```text
TEAM_DOMAIN=https://your-team.cloudflareaccess.com
POLICY_AUD=<Application Audience AUD Tag>
```

Do not append `/cdn-cgi/access/certs` to `TEAM_DOMAIN`.

Optional:

```text
ILINK_CLIENT_VERSION=2.4.6
```

## First-use flow

1. Deploy Worker.
2. Bind custom domain.
3. Configure Cloudflare Access and variables.
4. Open `/admin`.
5. Add the first recipient, e.g. ID `zhenhua`, display name `振华`.
6. Click scan/bind and scan with the corresponding Weixin account.
7. Run a test send.
8. Add another recipient if needed, e.g. `wife`.
9. Connect ChatGPT to `/mcp`.

## Hourly asynchronous inbound task

Suggested ChatGPT Task behavior:

```text
Every hour, call weixin_poll. If pending Weixin messages exist, process each one using the relevant connected tools and context, then call weixin_reply with the exact returned messageRef and the final answer. If there are no pending messages, do nothing.
```

This is not real-time push; expected scheduling delay is up to the task interval.

## Security

- No Weixin credentials are committed to GitHub.
- Each user token is stored only in that user's Durable Object.
- Recipient IDs are administrator-defined aliases, not arbitrary Weixin IDs.
- Admin and MCP routes require Cloudflare Access JWT validation.
- Deleting a configured user clears its local token, cursor and message history.

## References

- Tencent official channel: `https://github.com/Tencent/openclaw-weixin`
- Community MCP inspiration: `https://github.com/bkmashiro/weixin-mcp`

This repository is independent and is not an official Tencent or Weixin product.

## License

MIT.
