# 微信 MCP Events 部署与切换

本版本参照 task-mcp-worker 的 MCP 2.0 扩展路由、callback challenge、Standard Webhooks 签名、AES-GCM 存储及续订实现。区别：复用已验证的 Access JWT sub；默认启用；默认精确允许 connectors.api.openai.com；所有失败（包括 410、4xx 和重定向）均保留订阅，持续退避重试至订阅到期或所属身份主动退订。

## 架构与配置

- 仍使用原 WEIXIN_BOT namespace、registry DO 与各用户 DO；自动创建 SQLite 表，无新增 DO 绑定或凭证授权体系。
- Worker Cron 每分钟调用启用用户的原 iLink getUpdates 接口。微信上游没有变成 webhook；变化的是 ChatGPT 不再按小时唤醒。通常延迟为一分钟间隔加上游长轮询耗时，不能承诺即时到达。收消息 Cron 会消耗 Worker/DO 配额，可在 Cloudflare 控制台调整间隔。
- 收消息时，消息与事件 outbox 原子落库；媒体完成后标记可推送。outbox 经 registry 持久化接受后才标记 emitted。崩溃/内部调用失败可恢复；重复 ingest 不重复生成投递。上游暂时不可用时，已经就绪的 outbox 仍会尝试提交。
- registry 将事件逐订阅持久化，固定 eventId 基于全局 messageRef 计算。重试不改变 eventId 或正文；每次重试重新生成时间戳与签名。投递开始前写入恢复租约，DO 重启后继续重试。
- 接收新事件只负责唤醒：内容为 messageRef、mediaRefs，不含正文、context_token、上游身份、媒体密钥。读取工具仍能返回正文和媒体，原消息回复能力保留。
- `EVENTS_ENCRYPTION_KEY` 必须为 64 位十六进制，通过 Cloudflare **Secret** 配置。示例值或真实密钥均不可提交。callback URL 和 webhook secret 使用 AES-256-GCM 加密，订阅 ID 作为 AAD；旧签名密钥轮换宽限 5 分钟。更换加密密钥前须退订并重建订阅；不能直接更换后期待旧密文仍能解密。
- `EVENTS_ENABLED` 不配置默认开启；仅字面值 `false` 关闭发现/投递和新增收消息 Cron。旧手动读取/回复不受关闭事件开关影响。
- `EVENTS_CALLBACK_HOSTS` 不配置默认 `connectors.api.openai.com`；配置值整体覆盖，逗号分隔，精确主机匹配。仅接受 OpenAI/ChatGPT 所有的 HTTPS 主机，不允许任意站点、IP、用户信息、非 443 端口、fragment 或通配符，任何请求均 `redirect: manual`。重定向响应不跟随、按失败重试。
- 不新增 `EVENTS_ALLOWED_PRINCIPALS`。订阅 owner 只从外层完成 issuer/audience/签名验证的 JWT sub 得到；忽略 RPC 参数中的 owner。不同 sub 即使 URL 和参数相同也得到不同订阅 ID；只能退订或续订自己的记录。现有 Access 对已连接工具的权限语义保持不变。
- 日志选择方法、授权状态、允许的错误原因及 callback 主机；不复制异常原文、完整 URL、签名密钥或消息正文。

## MCP 协议

`server/discover` 在启用且有有效 sub 时声明 `capabilities.events={}`，保留 SDK 已有工具发现与传输。事件方法经同一 `/mcp` 和 Access 验证。

- `events/list`：返回 `weixin.message.received`，`delivery=["webhook"]`，参数为空对象。
- `events/subscribe`：`name="weixin.message.received"`、`arguments={}`、`delivery={mode:"webhook",url,secret}`；secret 为 `whsec_` 加 base64 编码的 24–64 字节密钥。
- `events/unsubscribe`：相同 name/arguments/delivery.url，签名 secret 可省略；幂等删除本身份订阅和投递记录。
- 订阅首次建立、验证缓存超过 5 分钟、过期或签名密钥更换时，向 callback 发送签名 `{type:"verification",challenge}`，必须收到 2xx JSON `{challenge:<相同值>}`。超时 10 秒，响应上限 4 KiB。
- 续订通过相同 URL 和参数再次 subscribe，沿用 ID。`ttlMs` 默认 24 小时，授予 1 分钟至 7 天的有限租期；返回 `refreshBefore`。长期运行由客户端在租期前持续续订，并非无限期限。
- 不支持 cursor 历史回放；非空 cursor 拒绝。事件投递失败不会删除或禁用订阅，只有到期或所属 sub 主动退订停止。

签名使用 `webhook-id`、`webhook-timestamp`、`webhook-signature`，HMAC-SHA256 覆盖 `id.timestamp.正文原始字节`；规格参考 https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md 。

## 处理和重复保护

1. 收到事件后调用 `weixin_poll({messageRefs:[事件.data.messageRef]})`。这个分支只读落库消息，不再等待上游。SQLite 事务原子领取，默认 10 分钟处理租约，返回每条消息的 processingToken。重复事件在租约内或已回复时返回空数组，必须静默。
2. 需要媒体时调用现有 `weixin_media_get({mediaRef})`。
3. 用原 messageRef 调用 `weixin_reply({messageRef,text,processingToken})`。已回复的消息直接返回 alreadyReplied；进行中发送写入持久化 journal，重复调用不会再次发送。无引用的 `weixin_poll` 仍使用旧上游读取路径，但也领取返回消息并返回 processingToken，供回退轮询使用。
4. 处理进程在回复前失败时，租约到期可重新领取。不确定的发送（网络断开可能发生在上游接受后、或部分分段发送成功）记录 sending/uncertain 状态，拒绝盲目重发，需检查微信实际收到的内容和历史后恢复。这是避免重复回复的保守选择，不能承诺跨微信上游的 exactly-once。多消息处理仍遵守用户原有授权范围。

## 部署

保留原 Access、用户绑定与历史数据。在 Cloudflare 控制台为当前 Worker 添加 `EVENTS_ENCRYPTION_KEY` Secret；值可在本机用 `openssl rand -hex 32` 生成。不要把值发到聊天或写入仓库。

```sh
npm ci
npm run check
npx wrangler secret put EVENTS_ENCRYPTION_KEY
npm run deploy
```

`wrangler.jsonc` 保留 keep_vars=true、现有入口 file bridge/DO exports，并增加每分钟 Cron。同步 ChatGPT 微信插件工具与事件发现，使 messageRefs/processingToken 新参数可用。若通过 Git 集成构建，仍须提前在生产 Worker 中设置 Secret。

本地 `npm run check` 包含安全/持久化测试、类型检查与 dry-run。Miniflare/workerd 测试运行真实生产入口，使用合成 JWT 和模拟的微信/OpenAI 网络对端，覆盖文本及文件收取、事件、读取、媒体解密、原消息回复及重复调用。**本地运行时通过不等于真实微信生产验收通过。**

## 生产验收与停用轮询门槛

1. 保持原每小时“微信消息处理”任务启用。确认真实 `server/discover` 与 `events/list` 出现新事件；确认正确 JWT 能订阅，另一 sub 不能管理其记录。
2. 在 ChatGPT 新建无独立 schedule 的事件任务，监听已连接微信 `weixin.message.received`，完成真实 callback challenge，并确认客户端续订。
3. 从微信用户向 ClawBot 发送一条唯一测试文本及一个媒体附件。记录全局 messageRef/eventId 和触发时间；验证事件内容只有引用，ChatGPT 读取文本和媒体后通过 weixin_reply 回复原消息。
4. 对同一 eventId 验证重复事件，记录领取为空或 alreadyReplied 且微信没有第二条回复。重复读取/回复工具测试只能验证服务端防重复；真实回调重投测试仍需要在验收环境控制回调返回失败以触发同 ID 重试，不得误称工具重复测试等于全链路重投验收。
5. 验证回调失败/410/连续失败后订阅仍存在，续订后仍能收到后续新消息；无消息时保持静默。
6. 所有真实测试均通过，才停用原小时任务 `6a97f57133288191afe36870fb04e1b1`。原始恢复配置见 [hourly-poller-recovery.json](./hourly-poller-recovery.json)，当前记录 `cutoverCompleted=false`。不能在尚未验收时据本地测试停用。

事件任务提示词：

> 收到 weixin.message.received 后，调用已连接微信的 weixin_poll，messageRefs=[事件.data.messageRef]。返回空消息则静默。对普通、明确、低风险且无需额外授权的信息处理并回复；需要媒体时先读取对应 mediaRef。回复使用原 messageRef 和读取结果的 processingToken。高风险或需要重要承诺/不可逆操作时通知用户确认，不自行执行。重复事件不得重复处理或回复；若发生 reply_delivery_uncertain_or_in_progress，不盲目重发，报告需要核查。无新消息不通知。任何单次或连续失败均不得自行停用、暂停、删除订阅；记录本次失败后保留订阅并继续处理后续事件，及时续订，除非用户明确要求停止。

## 恢复

发生上线问题时，将 `EVENTS_ENABLED=false`，并重新启用恢复 JSON 所指小时任务。保留所有订阅/消息/投递表和 Secret；重新启用事件后仍需确认租约有效、必要时续订。不删除微信用户或清空历史；sending/uncertain 记录需核查微信侧结果再决定人工处理，不能为“恢复”盲目清除。
