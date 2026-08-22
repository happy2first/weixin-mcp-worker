# weixin-mcp-worker

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/Protocol-MCP-blue)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

把微信 ClawBot 的收发能力部署成一个 Cloudflare 原生 Remote MCP：不需要 VPS，不需要长期运行本地电脑，也不需要 OpenClaw。

当前版本：**v0.5.3**

> [!IMPORTANT]
> 本项目连接的是微信 **ClawBot（智能体机器人）**，不是以你的个人微信号向任意联系人发消息。请先在最新版微信中确认自己可以使用 ClawBot。

> [!WARNING]
> 本项目仍处于实验阶段。**文本发送、轮询接收和文本回复是当前主要可用链路；图片、文件、视频的收发仍存在兼容性和稳定性问题，不建议用于关键业务。** 已知问题包括部分 Cloudflare Workers `node:crypto` 兼容差异、微信 CDN 上传/加解密失败、图片质量或格式异常，以及不同 MCP 客户端传递附件的方式不一致。语音发送尚未开放。

## 能做什么

- 通过 Remote MCP 发送微信文本；
- 按需或由定时任务轮询 ClawBot 收到的消息；
- 使用 `messageRef` 精确回复某条消息；
- 管理多个 ClawBot 用户别名，并设置默认接收人；
- 在 `/admin` 完成用户管理、扫码绑定、测试和历史记录管理；
- 使用 SQLite-backed Durable Objects 保存凭证、游标、消息和媒体；
- 实验性支持图片、文件和视频的收发。

## 架构

```text
ChatGPT / 其他 Remote MCP 客户端
                │  HTTPS /mcp
                ▼
        Cloudflare Access
                │  JWT
                ▼
       Cloudflare Worker
                │
                ├─ WeixinBotDO: __registry__
                ├─ WeixinBotDO: user:<alias-a>
                └─ WeixinBotDO: user:<alias-b>
                           │
                           ▼
                    微信 ClawBot / iLink
```

本项目当前不需要 D1、KV、R2、Pages、Cloudflare Cron 或 OpenAI API。消息接收采用异步轮询，并非实时推送。

## 快速部署（Cloudflare 控制台）

下面的步骤适合不使用本地命令行的用户。

### 0. 准备

你需要：

1. 一个 Cloudflare 账号；
2. 一个 GitHub 账号；
3. 最新版微信，并已开通或可创建微信 ClawBot；
4. 可选：一个已接入 Cloudflare 的自定义域名。

建议先 Fork 本仓库。这样后续可以自行审查代码、接收上游更新，并把 Cloudflare 部署绑定到自己的仓库。

### 1. 从 GitHub 创建 Worker

1. 在 Cloudflare Dashboard 打开 **Workers & Pages**（新版界面可能显示为 **Compute / Workers**）；
2. 选择 **Create application / Create Worker**；
3. 选择 **Import a repository / Connect to Git**；
4. 授权 Cloudflare 访问你的 Fork，并选择 `weixin-mcp-worker`；
5. 项目根目录保持 `/`；
6. 安装命令使用 `npm ci`；
7. 构建检查可使用 `npm run check`；
8. 部署命令使用 `npx wrangler deploy`；
9. 保存并执行第一次部署。

`wrangler.jsonc` 已声明以下关键配置，一般不要在控制台重复创建：

```jsonc
{
  "main": "src/chatgpt-file-bridge.ts",
  "keep_vars": true,
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      { "name": "WEIXIN_BOT", "class_name": "WeixinBotDO" }
    ]
  },
  "exports": {
    "WeixinBotDO": { "type": "durable-object", "storage": "sqlite" }
  }
}
```

首次部署后，请在 Worker 的 **Bindings** 中确认存在 `WEIXIN_BOT`。它必须指向 SQLite-backed Durable Object 类 `WeixinBotDO`。不要再创建同名 KV、D1 或普通变量。

### 2. 绑定访问域名

你可以直接使用 `*.workers.dev`，也可以在 Worker 的 **Settings → Domains & Routes** 中添加自定义域名，例如：

```text
weixin.example.com
```

自定义域名更便于配置 Cloudflare Access，也更适合作为长期 MCP 地址。以下示例假设使用 `https://weixin.example.com`。

### 3. 创建 Cloudflare Access 应用

本项目不会自行签发登录令牌，而是校验 Cloudflare Access 注入的 JWT。

1. 打开 **Cloudflare Zero Trust**；
2. 进入 **Access → Applications**；
3. 新增 **Self-hosted application**；
4. Application domain 填入你的 Worker 域名；
5. 添加只允许你本人或指定账号访问的策略；
6. 保存应用；
7. 在应用详情中复制 **Application Audience (AUD) Tag**；
8. 记下 Zero Trust 团队域名，例如 `your-team.cloudflareaccess.com`。

如果你希望 `/admin`、`/health` 和 `/mcp` 使用同一套身份验证，最简单的方式是让 Access 应用覆盖整个 Worker 主机名。

### 4. 新增 Worker 变量

进入 Worker 的 **Settings → Variables and Secrets**，新增：

| 变量 | 必填 | 示例 | 说明 |
|---|---:|---|---|
| `TEAM_DOMAIN` | 是 | `https://your-team.cloudflareaccess.com` | Zero Trust 团队域名根地址 |
| `POLICY_AUD` | 是 | `012345...abcdef` | Access 应用的 Audience (AUD) Tag |
| `ILINK_CLIENT_VERSION` | 否 | `2.4.6` | 微信 iLink 兼容版本，通常保持默认 |

注意：

- `TEAM_DOMAIN` 必须包含 `https://`；
- **不要**在 `TEAM_DOMAIN` 后追加 `/cdn-cgi/access/certs`，代码会自动拼接；
- `POLICY_AUD` 不是 Application ID，也不是 Access policy ID；
- 修改变量后重新部署或等待配置生效；
- `wrangler.jsonc` 已设置 `"keep_vars": true`，从 GitHub 重新部署时会保留控制台变量；
- 不要把真实变量写入仓库，`.dev.vars` 和 `.env*` 已被忽略。

### 5. 验证 Worker 与 Access

依次访问：

```text
https://weixin.example.com/
https://weixin.example.com/health
https://weixin.example.com/admin
```

- `/` 返回服务名称和版本，主要用于确认 Worker 已上线；
- `/health` 会先触发 Cloudflare Access 登录，成功后显示 Worker 与绑定状态；
- `/admin` 是唯一的管理入口；`/setup` 会固定返回 404。

如果 `/health` 返回 `Expected 200 OK from the JSON Web Key Set HTTP response`，通常是 `TEAM_DOMAIN` 填错，尤其是误填了证书完整路径。若返回 audience 相关错误，请重新核对 `POLICY_AUD` 是否来自当前这一个 Access 应用。

### 6. 在 `/admin` 绑定微信 ClawBot

1. 打开 `/admin`；
2. 新增用户，设置简短、稳定的英文别名，例如 `me`；
3. 如果只有一个用户，建议设为默认用户；
4. 点击扫码绑定，使用微信扫描二维码并确认；
5. 等待页面显示已连接；若二维码过期，重新生成；
6. 先发送一条短文本测试；
7. 从微信向 ClawBot 发一条文本，再执行轮询并尝试回复；
8. 文本链路确认正常后，再用小尺寸 JPEG/PNG 测试媒体，不要一开始就上传大文件。

凭证保存在各用户对应的 Durable Object 中，不应出现在 GitHub 仓库或 Worker 变量里。

### 7. 连接 Remote MCP 客户端

把下面的地址添加到支持 Remote MCP 的客户端：

```text
https://weixin.example.com/mcp
```

客户端需要能够完成 Cloudflare Access 的浏览器登录，并在后续请求中携带 Access 身份。首次连接后，建议按顺序测试：

1. `weixin_status`；
2. `weixin_users`；
3. `weixin_send` 发送短文本；
4. `weixin_poll` 拉取文本；
5. `weixin_reply` 回复指定消息；
6. 最后再试验 `weixin_send_media` 和 `weixin_media_get`。

不同客户端对“对话附件”的参数封装并不一致。本项目为 ChatGPT 附件增加了 `file` 桥接；如果客户端没有提供兼容的远程下载对象，图片或文件发送可能失败。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `weixin_users` | 列出已配置用户、默认用户、绑定和存储状态 |
| `weixin_status` | 查看服务、绑定、历史存储和轮询状态 |
| `weixin_send` | 向一个或多个已配置用户发送文本 |
| `weixin_send_media` | 实验性发送图片、文件或视频 |
| `weixin_poll` | 拉取各用户发给 ClawBot 的新消息 |
| `weixin_media_get` | 读取轮询结果中的媒体引用 |
| `weixin_reply` | 使用精确 `messageRef` 回复消息 |

调用方不能向任意微信 ID 发消息；收件人必须先在 `/admin` 中创建别名。

## 定时轮询示例

可在支持定时任务的 MCP 客户端中使用类似指令：

```text
每小时调用 weixin_poll。对每一条 pending 消息进行处理；如需查看媒体，
使用返回的 mediaRef 调用 weixin_media_get；回复时将原样返回的
messageRef 传给 weixin_reply。没有新消息时不发送任何内容。
```

这是一种异步方案。Worker 不会在微信消息到达时主动唤醒 ChatGPT。

## 存储与保留策略

每个 `user:<alias>` Durable Object 保存：

```text
messages
media_objects
media_chunks
retention.v1
```

默认策略：

- 每用户历史上限：700 MiB；
- 可配置范围：50–700 MiB；
- 超限后清理到约 90%；
- `inbound + pending` 消息不会被自动删除；
- 项目所有用户的配置上限合计不得超过 4 GiB；
- 单个媒体当前安全上限为 20 MiB；
- 超过 8 MiB 的媒体不会直接内嵌进 MCP 结果，可从 `/admin` 下载。

## 已知问题与限制

- 图片、文件、视频的上传、加密和 CDN 发送仍可能失败；
- Cloudflare Workers 的 `node:crypto` 兼容行为可能与标准 Node.js 不完全一致；
- 某些图片可能出现模糊、格式识别失败或缩略图异常；
- 不同 MCP 客户端传递附件的字段格式不同，当前主要适配 ChatGPT 的文件参数；
- 入站语音保留微信给出的 SILK/AMR 等格式，Worker 不转码；
- 出站语音未开放；
- 消息接收依赖轮询，不是实时 webhook；
- 微信 ClawBot / iLink 并不是承诺长期稳定的公开接口，协议变化可能导致功能失效。

欢迎通过 Issue 提交可复现信息：Worker 版本、媒体类型和大小、MIME、错误文本、是否为入站或出站。**请务必删除 token、`context_token`、Access JWT、微信用户 ID 和私人文件内容。**

## 本地开发（可选）

```bash
npm ci
cp .dev.vars.example .dev.vars
npm test
npm run typecheck
npm run dev
```

部署：

```bash
npm run check
npm run deploy
```

## 安全提示

- 使用 Cloudflare Access 保护 `/admin`、`/health`、媒体路由和 `/mcp`；
- 仅允许本人或明确授权的账号访问；
- 不要提交 `.dev.vars`、`.env`、JWT、bot token、`context_token` 或扫码信息；
- 不要在 Issue 中粘贴完整 Worker 日志，先清理身份与消息内容；
- 建议先 Fork、审查代码并在自己的 Cloudflare 账号中部署；
- 本项目尚未完成独立安全审计，不应作为高敏感或关键业务通信链路。

## 致谢与声明

本项目在协议理解和能力设计上参考并受益于：

- [bkmashiro/weixin-mcp](https://github.com/bkmashiro/weixin-mcp)：社区版微信 ClawBot MCP 项目；
- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)：腾讯维护的 OpenClaw 微信通道及 iLink 协议资料；
- [Model Context Protocol](https://modelcontextprotocol.io/) 与 [Cloudflare Workers](https://workers.cloudflare.com/) 生态。

感谢上述项目及贡献者。本仓库针对无 VPS、Remote MCP、Cloudflare Workers、Durable Objects 和多用户管理场景进行了重新适配与扩展。

本项目是独立的社区项目，与微信、腾讯、Cloudflare、OpenAI 或上述项目维护者不存在官方隶属或背书关系。“微信”“Weixin”“WeChat”“ClawBot”等名称及商标归其各自权利人所有。

## License

[MIT](LICENSE) © 2026 happy2first

