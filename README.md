# weixin-mcp-worker

Cloudflare-native Remote MCP for Weixin ClawBot. Current version: **v0.5.1**.

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

No VPS, OpenClaw, D1, KV, R2, Pages, Cloudflare Cron, or OpenAI API is required for the current asynchronous design.

## URLs

```text
MCP:    /mcp
Admin:  /admin
Health: /health
```

`/setup` deliberately returns 404. `/admin` is the only management entry.

## v0.5.1 reliability hardening

- One primary Worker implementation and one primary Durable Object implementation; the old v0.5 wrapper/string-injection architecture has been removed.
- Version metadata is unified at v0.5.1 across package, MCP server, admin UI and Weixin bot agent.
- Long text is split at about **1800 characters** with a short delay between chunks.
- Stale Weixin `context_token` (`ret=-2`) uses a guarded recovery path: refresh via `getUpdates`, retry with a newer token when available, then one no-context retry; unresolved sessions return an explicit re-engagement error.
- Multi-recipient media delivery is serialized to reduce Worker peak memory.
- All dynamic iLink/CDN base URLs must use HTTPS.
- Message history has paged admin access rather than a fixed one-shot list.
- Unit tests cover text chunking, alias validation, HTTPS enforcement and retention-budget helpers.

## Messaging and media

- Multiple configured Weixin recipients with aliases and one optional default recipient.
- Text send, on-demand/hourly inbound polling and exact-message text reply.
- Inbound image, voice, file and video download/decryption from Weixin CDN.
- Media stored inside each user's SQLite-backed Durable Object, split into approximately 1 MiB BLOB rows.
- 20 MiB per-media safety limit.
- `weixin_media_get` embeds media up to 8 MiB in MCP results; larger files remain available in `/admin`.
- Outbound image, file and video use Weixin `getuploadurl` + AES-128-ECB CDN upload + `sendmessage`.
- Inbound voice preserves the format supplied by Weixin and retains Weixin-provided transcript text. SILK is not transcoded to WAV in Workers.
- Outbound voice is intentionally not exposed until an equivalent official send flow is validated.

## MCP tools

```text
weixin_users
weixin_status
weixin_send
weixin_send_media
weixin_poll
weixin_media_get
weixin_reply
```

Recipient IDs are aliases pre-created in `/admin`; callers cannot send to arbitrary Weixin IDs.

## Storage and automatic retention

Each `user:<alias>` Durable Object contains:

```text
messages
media_objects
media_chunks
retention.v1
```

Default retention policy:

```text
per-user cap:        700 MiB
configurable range:   50–700 MiB
cleanup target:       ~90% of configured cap
protected records:    inbound + pending
project safe budget:  4 GiB configured caps
```

After sends, media sends, polls and replies, the DO checks live retained-history usage. Above the configured cap it automatically removes the oldest processed messages and linked attachment chunks until it falls to about 90%. Pending inbound messages are never auto-deleted. Cleanup requires no confirmation; a ClawBot summary is sent after deletion.

Deleting a single message also deletes linked media. Clearing message history keeps the binding and retention preference. Deleting a user clears credentials, cursor, messages, media and the retention preference.

The 4 GiB project budget is intentionally below Cloudflare Free's account-level SQLite allowance so other Durable Objects retain headroom. `/admin` shows live retained payload, configured caps and actual SQLite `databaseSize` separately.

## Admin UI

`/admin` follows the responsive structure of the companion personal-gateway prototype:

- desktop: fixed left navigation + sticky top status bar;
- tablet: compact side navigation;
- mobile: top bar + bottom primary navigation.

It supports user CRUD, QR binding/verification, text/media test send, manual poll/reply, paged message history, media preview/playback/download, manual history deletion and per-user automatic-retention settings.

## Cloudflare resources

Required:

1. One Worker.
2. One SQLite-backed Durable Object class/namespace `WeixinBotDO`.
3. Binding `WEIXIN_BOT`.
4. Cloudflare Access.
5. Optional custom domain.

`wrangler.jsonc` declares the Durable Object export and binding. Deployment reconciles/provisions it.

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

1. Import `happy2first/weixin-mcp-worker` into Cloudflare Workers.
2. Deploy with `npx wrangler deploy`.
3. Bind the custom domain and configure Cloudflare Access/variables.
4. Open `/admin`.
5. Add a recipient alias and scan the generated Weixin QR code.
6. Adjust the retained-history cap if the default 700 MiB is not desired.
7. Test text send and text reply.
8. Test a small image inbound/outbound before larger files.
9. Connect ChatGPT to `/mcp`.

## Hourly asynchronous inbound task

```text
Every hour, call weixin_poll. For each pending message, inspect mediaRef with
weixin_media_get when needed, process it, then call weixin_reply with the exact
returned messageRef. If there are no pending messages, do nothing.
```

This is asynchronous, not real-time push.

## Security

- Bot/context tokens are not committed or returned by admin/MCP APIs.
- Recipient aliases must be pre-created in `/admin`.
- Admin, media and MCP routes are protected by Cloudflare Access.
- Media URLs are internal admin routes, not public object-storage URLs.
- Dynamic Weixin/iLink/CDN base URLs are HTTPS-only.
- Automatic cleanup never deletes pending inbound messages.

## CI

Every push to `main` runs production dependency audit, unit tests, TypeScript checking, and `wrangler deploy --dry-run` through GitHub Actions.

## License

MIT.
