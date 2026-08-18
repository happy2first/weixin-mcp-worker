# weixin-mcp-worker

Cloudflare-native Remote MCP for Weixin ClawBot. Current version: **v0.5.0**.

## Architecture

```text
ChatGPT / scheduled task
        | Remote MCP /mcp
        v
Cloudflare Worker
        |
        +--> WeixinBotDO: user:zhenhua --> Weixin ClawBot --> Weixin A
        +--> WeixinBotDO: user:wife    --> Weixin ClawBot --> Weixin B
        +--> WeixinBotDO: __registry__ --> user registry
```

No VPS, OpenClaw, D1, KV, R2, Pages, Cloudflare Cron, or OpenAI API is required.

## Main URLs

```text
MCP:    https://weixin.mcp.example.com/mcp
Admin:  https://weixin.mcp.example.com/admin
Health: https://weixin.mcp.example.com/health
```

`/setup` is intentionally not exposed. `/admin` is the only management entry.

## v0.5 features

- Multiple bound Weixin recipients with administrator-defined aliases.
- Text send, on-demand/hourly inbound polling, and text reply.
- Inbound image, voice, file and video download/decryption from Weixin CDN.
- Media stored inside each user's SQLite-backed Durable Object; no R2 required.
- Media is split into approximately 1 MiB BLOB rows.
- 20 MiB per-media safety limit.
- Configurable per-user retained interaction-history cap: **50–700 MiB**, default **700 MiB**.
- When retained history exceeds the configured cap, the oldest processed messages and their attachments are deleted automatically until usage falls to about 90% of the cap.
- Pending inbound messages are protected from automatic deletion.
- Cleanup happens without confirmation; the bound ClawBot receives a summary after deletion.
- The admin UI also exposes the actual SQLite `databaseSize` for monitoring. Retention decisions use estimated live interaction payload rather than file size alone, because SQLite can reuse freed pages after deletion.
- Hard SQLite `SQLITE_FULL` errors still trigger a direct ClawBot warning where possible.
- `/admin` supports responsive desktop/mobile management, media preview/playback/download, media upload/send, manual history deletion, and automatic-retention settings.
- Outbound image, file and video use Weixin's official `getuploadurl` + AES-128-ECB CDN upload + `sendmessage` flow.
- Inbound voice is preserved in the format delivered by Weixin; Weixin-provided transcript text is retained. SILK is not transcoded to WAV inside Workers.
- Outbound voice is intentionally not exposed until an equivalent official send flow is validated.

## MCP tools

### `weixin_users`
List configured recipients and connection/storage status.

### `weixin_status`
Inspect multi-user connection, pending messages, media usage, retained-history usage and cleanup state without exposing raw credentials.

### `weixin_send`
Send text to the default recipient or selected configured aliases.

### `weixin_poll`
Pull pending inbound messages for all enabled users or selected recipients. Media messages include a routed `mediaRef` such as `zhenhua:media_...`.

### `weixin_media_get`
Read a `mediaRef`. Images and common audio formats are returned as MCP multimodal content. Other files/video are returned as binary resource content. Media larger than 8 MiB is not embedded into a tool result; use `/admin` to open/download it.

### `weixin_send_media`
Send `image`, `file`, or `video` to one or several configured recipients. Input can be raw base64 or an existing `sourceMediaRef` from this MCP.

### `weixin_reply`
Reply to the exact `messageRef` returned by `weixin_poll`; the Worker routes to the correct user and stored context token.

## Storage and retention

Each `user:<alias>` Durable Object contains:

```text
messages
media_objects
media_chunks
```

The v0.5 retention layer stores a small per-user retention configuration in the same Durable Object.

Default policy:

```text
retained-history cap: 700 MiB/user
cleanup target:        ~90% of cap
configurable range:    50–700 MiB/user
protected records:     inbound + pending
```

After successful send, media send, poll, or reply, the Durable Object checks retained-history usage. If usage exceeds the cap, it deletes the oldest eligible messages in batches; media objects and media chunks linked to those messages are deleted in the same transaction. After cleanup, it sends a direct ClawBot summary to that user.

Deleting a message manually also deletes its related media object and chunks. Clearing a user's history clears all message/media rows but keeps the Weixin binding. Deleting a user clears binding credentials, cursor, history, and media.

## Admin UI

`/admin` follows the responsive structure used by the companion personal-gateway prototype:

- desktop: fixed left navigation + sticky top status bar;
- tablet: compact side navigation;
- mobile: top bar + bottom primary navigation.

The Settings page exposes each user's retained-history limit, current retained payload, actual SQLite database size, and last automatic cleanup time.

The message view renders image previews, video playback, supported browser audio playback, and file/raw-voice download links.

## Cloudflare resources

Required:

1. One Worker.
2. One SQLite-backed Durable Object class/namespace `WeixinBotDO`.
3. Binding `WEIXIN_BOT`.
4. Cloudflare Access.
5. Optional custom domain.

`wrangler.jsonc` already declares the Durable Object export and binding. A deploy reconciles/provisions it.

## Cloudflare Access variables

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

1. Import `happy2first/weixin-mcp-worker` from GitHub into Workers.
2. Deploy with `npx wrangler deploy`.
3. Bind the custom domain and configure Cloudflare Access/variables.
4. Open `/admin`.
5. Add a recipient alias and scan the generated Weixin QR code.
6. Set a retained-history limit if the default 700 MiB is not desired.
7. Test text send, then image/file send.
8. Send media to ClawBot and press **拉取回复** to validate inbound download/decryption.
9. Connect ChatGPT to `/mcp`.

## Hourly asynchronous inbound task

```text
Every hour, call weixin_poll. For each pending message, inspect mediaRef with
weixin_media_get when needed, process the message using the relevant connected
tools, then call weixin_reply with the exact returned messageRef. If no pending
messages exist, do nothing.
```

This is asynchronous, not real-time push.

## Security

- Weixin bot tokens/context tokens are not committed or returned by admin/MCP APIs.
- Recipient aliases must be pre-created in `/admin`.
- Admin, media routes and MCP routes are protected by Cloudflare Access.
- Media URLs are internal admin routes, not public R2 URLs.
- Raw media is bounded and stored per-user in the same Durable Object as its message state.
- Automatic cleanup never deletes pending inbound messages.

## Protocol references

Implementation follows Tencent's current `Tencent/openclaw-weixin` protocol behavior for QR login, `getupdates`, Weixin CDN media download/decryption, `getuploadurl`, AES-128-ECB upload, and image/file/video `sendmessage` items.

This repository is independent and is not an official Tencent or Weixin product.

## License

MIT.

## CI

Every push to `main` runs dependency audit, TypeScript checking, and `wrangler deploy --dry-run` through GitHub Actions before the version is treated as deployment-ready.
