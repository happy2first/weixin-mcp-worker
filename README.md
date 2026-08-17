# weixin-mcp-worker

A Cloudflare-native Remote MCP server that sends ChatGPT / MCP output to the Weixin ClawBot bound by the owner.

This project is designed for the first-stage, one-way path:

```text
ChatGPT / scheduled task
        |
        | MCP: weixin_send
        v
Cloudflare Worker
        |
        v
SQLite-backed Durable Object
        |
        | HTTPS
        v
ilinkai.weixin.qq.com
        |
        v
Weixin ClawBot -> your Weixin
```

It does **not** require a VPS, OpenClaw, Docker, or a permanently running computer.

> Status: v0.1.0. The initial version intentionally focuses on **ChatGPT -> Weixin**. It does not make inbound Weixin messages trigger ChatGPT.

## Features

- Remote MCP endpoint at `/mcp`
- `weixin_status`: check whether a ClawBot is bound
- `weixin_send`: send text to the Weixin user who bound this Worker
- Browser setup page at `/setup`
- QR-code binding, including current iLink redirect / pairing-code states
- Long text is split into multiple Weixin messages automatically
- ClawBot credentials are stored in a SQLite-backed Cloudflare Durable Object, not in GitHub or Worker source
- Cloudflare Access JWT validation for `/mcp`, `/health`, `/setup`, and setup APIs
- The MCP tool deliberately does **not** accept an arbitrary recipient; v0.1 sends only to the Weixin user that completed the QR binding

## Upstream / protocol references

The Weixin iLink behavior is implemented from the currently published Tencent `Tencent/openclaw-weixin` channel implementation, while the idea of exposing the channel as MCP was inspired by `bkmashiro/weixin-mcp`.

- Tencent OpenClaw Weixin: https://github.com/Tencent/openclaw-weixin
- Community weixin-mcp: https://github.com/bkmashiro/weixin-mcp

This repository is an independent project and is not an official Tencent or Weixin product.

## Cloudflare resources

Only these resources are required for v0.1:

1. One Cloudflare Worker
2. One SQLite-backed Durable Object namespace, declared as `WeixinBotDO`
3. One Durable Object binding, exposed to the Worker as `WEIXIN_BOT`
4. Cloudflare Access in front of the Worker
5. Optional custom domain such as `weixin.mcp.example.com`

D1, KV, R2, Pages, Queues, Workflows, and Cron Triggers are not required.

## Important: you do not manually create the Durable Object namespace

The repository already contains this in `wrangler.jsonc`:

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

With current Wrangler, the first `wrangler deploy` reconciles the `exports` declaration and provisions the SQLite-backed Durable Object namespace automatically. There is no namespace ID to copy into this repository.

Cloudflare reference: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/

## Deploy from GitHub in the Cloudflare dashboard

### 1. Import the repository

In Cloudflare Dashboard:

1. Open **Workers & Pages**.
2. Choose **Create application** / **Import a repository** (wording may vary slightly by dashboard revision).
3. Select this GitHub repository.
4. Keep the Worker name as `weixin-mcp-worker`, matching `wrangler.jsonc`.
5. Production branch: `main`.
6. Deploy command: `npx wrangler deploy`.
7. No separate build command is required; Wrangler bundles the TypeScript and npm dependencies.
8. Deploy.

During the first deployment, look for a Wrangler message similar to:

```text
Durable Object exports reconciliation:
  Created: WeixinBotDO
```

That confirms Cloudflare provisioned the Durable Object namespace.

### 2. Verify the Durable Object binding

After deployment, open the Worker settings / bindings page and verify that the Worker has:

```text
Binding:    WEIXIN_BOT
Class:      WeixinBotDO
Storage:    SQLite
```

You may also see the namespace under Cloudflare's Durable Objects / Data Studio views. You do not need to edit the namespace manually.

### 3. Add the custom domain

In the Worker's **Settings -> Domains & Routes** area, add your desired custom domain, for example:

```text
weixin.mcp.example.com
```

Wait until the custom domain is active before doing the QR binding.

## Protect the Worker with Cloudflare Access

The Worker uses Cloudflare Access JWT validation for every sensitive route.

Create or reuse a Cloudflare Access self-hosted application that protects the host, for example:

```text
weixin.mcp.example.com/*
```

Then configure these Worker variables:

### `TEAM_DOMAIN`

Set this to the Cloudflare Access team origin only:

```text
https://your-team.cloudflareaccess.com
```

Do **not** append:

```text
/cdn-cgi/access/certs
```

The Worker appends that path itself when it retrieves the Access JWKS.

### `POLICY_AUD`

Set this to the **Application Audience (AUD) Tag** of the Access application protecting this Worker.

### `ILINK_CLIENT_VERSION` (optional)

Default:

```text
2.4.6
```

This is kept as a variable so it can be updated if Tencent changes the compatibility version expected by iLink without restructuring the Worker. Normally leave it unset initially.

The example file `.dev.vars.example` contains the same variables but no secrets.

## Bind your Weixin ClawBot

Once the Worker, custom domain, Access policy, and variables are ready:

1. Open:

   ```text
   https://weixin.mcp.example.com/setup
   ```

2. Complete Cloudflare Access authentication.
3. Click **生成新的二维码**.
4. Scan the QR code with Weixin and confirm the ClawBot connection.
5. If Weixin displays a numeric pairing code, enter it on the setup page.
6. Wait until the page reports **绑定成功**.
7. Use **发到我的微信** on the same page to run the first end-to-end send test.

The Durable Object stores:

```text
bot_token
ilink_bot_id
ilink_user_id
baseUrl
binding timestamp
```

The setup/status API only returns masked identifiers and never exposes the stored `bot_token`.

## Connect ChatGPT

Use this Remote MCP URL:

```text
https://weixin.mcp.example.com/mcp
```

After the MCP connection is established, the server exposes two tools.

### `weixin_status`

No arguments.

Example intent:

```text
检查我的微信 MCP 是否已经绑定。
```

### `weixin_send`

Input:

```json
{
  "text": "要发送到微信的内容"
}
```

Example intent:

```text
把这份房地产监测结果通过微信发给我。
```

For scheduled tasks, the task can generate its report first and then call `weixin_send` with the final text.

## HTTP routes

| Route | Worker-side auth | Purpose |
|---|---|---|
| `/` | No JWT validation in Worker code | Basic service metadata |
| `/health` | Cloudflare Access JWT | Worker + Weixin binding health |
| `/setup` | Cloudflare Access JWT | Browser QR binding / send-test UI |
| `/admin/api/*` | Cloudflare Access JWT | Setup-page backend |
| `/mcp` | Cloudflare Access JWT | Remote MCP endpoint |

If the Access application protects the whole hostname, Cloudflare can still require Access authentication before `/` reaches the Worker.

## Security design

- No Weixin credential is committed to GitHub.
- `bot_token` is written only to Durable Object storage after QR confirmation.
- The MCP server does not expose the raw token.
- `weixin_send` is bound-recipient only. A model cannot choose another Weixin user ID in v0.1.
- The setup APIs are behind the same Access validation as MCP.
- The project never needs your personal Weixin password.

Treat access to the Durable Object and the Access application as sensitive: anyone who can invoke the protected send route can cause a message to be sent from the bound ClawBot channel.

## Local development

Copy the example variables:

```bash
cp .dev.vars.example .dev.vars
```

Install and run:

```bash
npm install
npm run dev
```

Type-check and dry-run bundle:

```bash
npm run check
```

Do not commit `.dev.vars`.

## Current limitations

v0.1 deliberately does not implement:

- Weixin -> ChatGPT push or polling
- group chats
- arbitrary recipients
- images, files, voice, or video
- contact directory
- inbound message history
- OpenAI API calls
- OpenClaw

These can be added later without replacing the Durable Object account store.

## Troubleshooting

### `/health` says `缺少 Cloudflare Access JWT`

The request reached the Worker without a valid Access assertion. Check that the hostname is covered by the Access application and that the client is going through the expected Cloudflare Access / OAuth flow.

### `/health` says `Expected 200 OK from the JSON Web Key Set HTTP response`

Check `TEAM_DOMAIN`. It must look like:

```text
https://your-team.cloudflareaccess.com
```

not the JWKS URL itself.

### QR code generates but never confirms

Check Worker logs and the response from the `/admin/api/login/status` request. Current code handles node redirect and pairing-code states exposed by the Tencent implementation. If Tencent changes the iLink login state machine, compare against the latest `Tencent/openclaw-weixin` implementation.

### Binding succeeds but test send fails

Open `/health` and Worker logs. Confirm the saved `baseUrl` is present and the iLink API is returning an authenticated response. If the upstream begins requiring a fresh conversation context token for proactive sends, v0.1 will need to add an inbound sync step.

## License

MIT. See `LICENSE`.
