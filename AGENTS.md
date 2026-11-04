# AGENTS.md — duckai-cpa 项目指南（给未来的 agent / 协作者）

> 本文件是 **项目级** 指令。优先级：用户即时指令 > 本文件 > 全局 `~/.dsh/AGENTS.md`。
> 最后更新：2026-11-02（v2.19）。改代码前先读本文件相应章节。

## 1. 项目是什么

`duckai-cpa`：把 **duck.ai** 网页聊天协议封装成 **OpenAI 兼容网关**（CPA 风格），
附带 React 管理控制台。单进程 Node 24（ESM，原生 `node:http`），默认监听 `127.0.0.1:8787`。

- `/v1/*`：OpenAI 兼容（chat/completions、responses、images、models），**强制 Bearer API Key**；
- `/admin/api/*`：管理 API，**强制 admin token**；
- `/admin`：React（Vite + Tailwind + Radix/shadcn）构建产物，源码在 `webapp/`，构建到 `web/`。

## 2. 常用命令

```powershell
npm start                 # 启动网关（前台；agent 用后台 job 启动）
npm run dev               # 热重载
npm run build:web         # 构建管理后台 → web/（会改 index-*.js hash）
npm test                  # ★ 全量测试；只有它算数（见下方“测试铁律”）
node scripts/build-check.mjs
node scripts/page-check.mjs --admin-token <ADMIN> --api-key <KEY>   # 对真实网关
node scripts/smoke.js --mock --search
node scripts/live-check.mjs            # 真实上游（消耗匿名额度，先确认）
node scripts/proxy-live-check.mjs --with-proxy
```

**测试铁律**

- `npm test` = `node --test --test-isolation=none --test-concurrency=1 "tests/*.test.js"`。
  `--test-concurrency=1` 是必需的：`tests/web-*.test.js` 会把 jsdom 的 `document`/`fetch`
  装到 `globalThis`，并发跑文件会污染其他用例（曾导致 concurrency 用例随机失败）。
- 单跑某文件：`node --test --test-isolation=none tests/xxx.test.js`。
- jsdom 用例挂载真实构建产物：先 `npm run build:web`，否则测试读的是旧 `web/index.html` 指向的 bundle。
  测试里登录 token 的 localStorage key 是 `duckai_cpa_admin_token`。
- **测试必须离线（v2.42）**：`tests/helpers/no-external-network.js` 会全局拦截非 `127.0.0.1/localhost` 的
  `fetch`（抛 `ERR_TEST_EXTERNAL_NETWORK_BLOCKED` 并记录到 `blocked`），测试套件**不允许**访问真实
  `duck.ai` / `duckduckgo.com`。需要验证上游成功/失败路径时，用组件已有的 `fetchImpl` 参数注入 mock
  （如 `verifySubscriptionOnline({ fetchImpl })`、`detectSyncTransport({ fetchImpl })`），不要依赖真实网络可达性。

## 3. 目录地图

```
src/duck/            duck.ai 协议层（唯一允许直接访问上游的地方）
  challenge.js       x-vqd-hash-1 挑战（jsdom 执行 + 滚动挑战 lease/mutex）
  sse.js             SSE 解析（role/state 白名单；reasoning done.summaryText 不得当增量）
  index.js           DuckClient：chat/image/compact、strictProtocol、continuation 续传、durableStream
  models.js          静态模型目录 + capabilities（★ 模型列表真实来源见 docs/MODEL-CATALOG-SOURCE.md）
  identity.js        data/identity.json 持久身份（journeyId/指纹/deviceId/官方恢复码引用）
  identity-pool.js   匿名分身池 data/identity-pool.json（每身份 rps=1 队列、hash 路由、订阅绑定）
  sync-client.js     DuckDuckGo Sync 客户端（login/keys/devices/signup/account_info JWE）
  pairing.js         Sync 配对状态机（host/scanner、continuation 消息、恢复码交换）
  compact.js         压缩语义（白名单、pair/activation、markers、原生 /summarize）
  proxy.js           HTTP/HTTPS/SOCKS 代理（undici ProxyAgent / socks Agent）
src/openai/          OpenAI 兼容层（chat.js/responses.js/images.js/models.js/compact.js/errors.js）
src/admin/           管理 API（routes.js 总路由、sessions.js 连接测试会话、pairing.js、sync-devices.js、
                     identity-routes.js、identity-pool-routes.js、subscriptions.js、chat-summaries.js）
src/http/server.js   HTTP 路由/鉴权/CORS/SSE/静态资源；ctx 聚合处（baseContext）
src/index.js         启动装配（配置、身份池、Sync 服务、配对、订阅、server）
webapp/src/app/      React 控制台（pages/、components/、lib/）
web/                 构建产物（不要手改；由 build:web 生成）
tests/               node:test（321→353）；tests/helpers/ 有 mock DuckClient / mock Sync 服务
scripts/             build-check / page-check / smoke / live-check / proxy-live-check
docs/                见 §10 索引
data/                运行时数据（不入库；含敏感文件）
```

## 4. 数据文件与安全红线

| 文件 | 内容 | 规则 |
| --- | --- | --- |
| `data/config.json` | 运行时配置（含 adminToken、API keys、代理、队列） | 权限 0600，禁止打印 token |
| `data/identity.json` | 全局持久身份（journeyId/指纹/deviceId/durable 密钥） | **绝不轮换**（会漂移上游身份），除非用户明确要求 |
| `data/identity-pool.json` | 匿名分身池（每身份独立 journeyId/RSA/队列） | 原子写 0600；默认身份 `id_default` 不可删 |
| `data/pairing.json` | DuckDuckGo 官方恢复码（`source`: self/pairing/manual） | **最高敏感**；只增改不打印；删数据需用户确认 |
| `data/subscriptions.json` | 订阅实体（token 加密保存，接口只回脱敏） | 0600；响应不得含明文 token |
| `data/logs.json` | `{upstream:[], admin:[]}` 分离日志 | 错误里可放 `errorDetail`，不得放密钥 |
| `data/testsessions.json` | 连接测试会话与消息、summary 锚点 | 原子写；重试截断需 clamp anchor |

**绝对不要做的事**

1. 对用户真实 DuckDuckGo 账号做未经确认的写操作（删除设备/注销设备/覆盖恢复码）。
   历史事故：`page-check` 曾删掉用户手机设备（见 `docs/INCIDENT-2026-11-01-device-deletes.md`）。
   - `page-check` 默认 **不删真实设备**；真实删除需 `--allow-device-delete --delete-device-id=<id>`；
   - `POST /admin/api/sync/delete-data` 必须 `{confirm:true}`，前端需手输 `DELETE`；
   - 「改用手机账号」= `POST /admin/api/sync/pairing/adopt-account`，不要把 `overwriteAccount` 当默认。
2. 把 `data/`、`recon/`、`data/tmp/` 里的抓包/密钥提交或复制进文档。
3. 在日志/错题/文档里写完整恢复码、完整 API Key、完整订阅 token。

## 5. 硬性约定（现状即契约，允许 BREAKING）

- **不留兼容层**：破坏性变更直接改（用户明确要求）；旧接口删掉而不是保留 shim。
- **中文优先**：UI 文案、文档、汇报、错误提示都用中文。
- **严格协议**：`strictProtocol` 默认开；上游响应不符约定要立即 abort 并抛结构化错误，
  不做“猜着继续”。
- **上游串行**：全局 `upstream.rps=1 / maxConcurrent=1`，每身份队列 rps=1；排队超限/超时返回
  429 `queue_full`/`queue_timeout` + `Retry-After`。
- **身份稳定性**：`data/identity.json` 的 journeyId/fingerprint 不得漂移；池内身份轮换必须用户显式触发。
- **重试/重新生成**：会话历史截断到目标 user 消息后重发；错误消息可重试。
- **模型目录**：免费/付费分档；付费模型默认 `allowPaidModels=false` → 403 `model_requires_subscription`。
  **目录是内置静态表**（`src/duck/models.js`），duck.ai 无 `/models` 端点、无定时刷新；
  `/duckchat/v1/capabilities` 只在启动与手动刷新时读（仅 flags/实验）。
- **工具策略**（v2.22–v2.23）：只能开关上游支持的 tool（`web_search` / `image_generation`）；
  不可用 tool 默认**静默清理**（`config.models.tools.dropUnsupported=true`），设为 `false` 时才 400
  （`unsupported_tool` / `tool_not_supported` / `tool_disabled`）。OpenAI `tools[].function` 由 **client 工具桥**支持
  （v2.44，网关不执行、不接 MCP；见下）。模型配置页是**防抖自动保存**（无保存按钮）、
  每个参数可单独重置，底部「危险 / 高级操作」卡片放静默清理开关与「重置全部模型配置」。
- **压缩**：只对白名单模型自动压缩；触发按 pair / `activationTargetPairCount`（不按字符）；
  `gpt-6-luna` 等不自动压缩（会话上限时只能新会话，见 `docs/CONTEXT-TOKENS.md`）。
- **摘要 UI**：内联在触发点（`anchorIndex` 之后），不是消息流顶部。
- **JSON 持久化（v2.40）**：SQLite 为唯一列表/状态存储；不要再新增 JSON 快照。当前只保留 `data/config.json`（运行配置）、
  `data/identity.json`（全局身份密钥）、`data/pairing.json`（恢复码）。连接测试会话/压缩摘要/统计/managed keys 已分别写入
  `test_sessions`、`chat_summaries`、`meta.stats.*`、`meta.keys.managed`（旧 JSON 仅首启导入一次，随后可归档到 `data/legacy-json-archive/`）。
- **session id 展示（v2.40）**：连接测试 header/列表与会话历史详情/列表都展示完整 session id（可复制）；无 X-Session-Id 的 v1 请求历史 key 为 `auto:<hash>`。
- **Responses 生图（v2.40/v2.44）**：`/v1/responses` 只有图片时必须补 message item + output_text；下一轮 input 里的 `image_generation_call` 必须接受，并保留为真实 image part（v2.44 起不再转文本占位），JPEG 转 PNG ≤512px 后转发。
- **客户端工具桥（v2.44/v2.45）**：OpenAI `tools[].function` 重新支持，但**只做 client 模式**（Codex/DSH 本地执行，
  网关不执行、不接 MCP）。Completions 与 Responses 的 tools 形状由 `src/openai/tool-protocol.js` 自动归一化，
  输出分别映射为 `tool_calls` / `function_call`；下一轮接受 `role:"tool"` 与 `function_call_output`。
  协议注入必须放在**第一条 user 消息**（v2.45 稳定前缀，保证旧消息逐字节不变、上游 prefix cache 可命中；
  不要改回最后一条 user：下一轮协议消失会导致历史文本变化、cache miss）。配置 `tools.clientFunctionCalling.enabled`（默认 true）。
- **上下文前缀稳定（v2.45/v2.47）**：客户端工具协议固定在第一条 user；历史文本/工具调用/图片映射必须确定性序列化，
  跨轮不改写旧消息。压缩摘要（`chat_summaries`）和 context-guard 裁剪会改变前缀，启用后无法保证 cache 命中。
- **提示词注入可观测（v2.48）**：工具协议注入是上游临时消息，不写进会话历史的 messages；
  但 `history` 表新增 `injection_json`（`{injected,clientTools,protocolText,firstUserContent,upstreamMessageCount,chain}`），
  会话历史详情可查看完整协议与注入后的第一条 user；upstream 日志新增 `clientTools/protocolInjected/upstreamMessageCount/conversationChain`；
  `GET /admin/api/history/:id/upstream` 返回脱敏后的真实 upstream messages（图片 base64 替换为 `[image data ...]`）。
  手动 `/v1/compact` 现在会把 assistant.tool_calls / role:"tool" 编码成文本再摘要，不再丢工具轨迹。
- **服务端会话 / response chaining（v2.46/v2.47）**：
  - `/v1/responses`：支持官方 `previous_response_id`；`responses` 表保存 canonical conversation、
    **精确 upstream 前缀（duckMessages，含协议/图片）**、output items、toolsHash；下一轮只发新 input，
    能复用前缀时直接拼接，否则按 canonical 重建（tools/system 变化）。
  - `/v1/chat/completions`：默认 **stateless**（客户端回放完整历史）；需要服务端会话时必须显式：
    `config.conversations.mode='server'` 或请求头 `X-Conversation-Mode: server`，并带 `X-Session-Id`；
    只发新消息用 `X-Conversation-Delta: true`；历史前缀不匹配返回 409 `conversation_session_conflict`。
  - 精确前缀复用保证图片压缩只发生一次；图片链/工具链/文本链均真实验证通过。
- **图片上下文（v2.44）**：`image_generation_call` 回放不能退化成文本占位；必须转成真实 image part（挂到下一轮 user 消息）。
  上游图像输入只接受 PNG/WebP（JPEG 实测 400 sc22），`src/duck/image-convert.js`（jpeg-js + pngjs，纯 JS）统一转 PNG 并缩到 **512px**；
  `/v1/chat/completions` 的 `image_url` data URL、`/v1/responses` 的 `input_image` 同样支持。

- **消息组件统一（v2.37）**：「连接测试」与「会话历史」共用 `webapp/src/app/components/chat-message.tsx` 的
  `ChatMessageBubble`（+`ToolCallList`）：助手气泡/思考折叠/来源/图片/工具调用徽章一致；会话历史只读（不传 onRetry）。
  后端用 `src/openai/chat.js` 的 `normalizeToolCalls({toolCalls, approvals, images})` 统一生成 toolCalls，
  连接测试 assistantMessage 与 history messages_json 都保存该字段；`sessions.normalizeMessage` 必须保留 `toolCalls`。
- **定位开关（v2.36/v2.38）**：`config.tools.location`（默认 **false**）。关闭时初始请求必须发
  `canUseApproxLocation:false`（**不是 null**：null 会触发 LocationPrompt，匿名档易被判 418；与浏览器关闭设置的抓包一致），
  上游不再询问位置；开启时初始发 `null`、审批自动批准后发 `true` 并带位置。设置页「工具 → 允许定位」可改。
- **会话历史工具/图片（v2.36）**：`history` 的 messages_json 额外保存 `toolCalls`（WebSearch/LocationPrompt/GenerateImage，含结果）、
  `images`（base64+format，≤4 张/张≤6MB）、`reasoning`、`sources`；「会话历史」页渲染工具徽章、图片回放、思考折叠、来源链接。
  有图无 GenerateImage 帧时自动补工具记录。
- **工具续传（v2.35）**：天气/位置类问题由上游 `continuation` 帧挂起（LocationPrompt 审批）。**不要**给普通聊天加
  `metadata.toolChoice`（尤其 WebSearch）——会让流不可续传（409 `continuation-restart-required: incompatible`）。
  续传请求体必须按浏览器抓包：无 metadata/durableStream、`canUseApproxLocation:true`（同意定位后）、
  `currentAssistant.parts` 回放 reasoning part（含 encryptedText）、`responses:[{kind:"approval",approvalId,approved:true}]`、
  复用首次 `x-duckai-response-id` 与滚动挑战；仍失败则去掉 continuation/currentAssistant 重启一次。
- **图片格式（v2.35）**：duck.ai 实际返回 **JPEG**（帧内 format 可能缺失/错误）。`src/duck/image-format.js` 按魔数探测；
  `/v1/images/generations` 返回 `{b64_json,revised_prompt,format,mime_type}`；chat 的 `message.images` 用
  `{type:"image_url",image_url:{url:data URI},b64_json,...}`（OpenRouter/LobeChat 约定）；流式 `delta.images` 同构；
  Responses API 用官方 `image_generation_call.result`。
- **前端刷新按钮（v2.34）**：所有页面 header 右侧只放信息（QueueStatusChips：执行中/排队/RPS/均等），**不放按钮**；
  刷新/新建等操作必须放进对应卡片的 CardHeader 右侧。概览第一行是「自动刷新」控制条（可展开：关闭/5s/10s/30s/60s + 手动刷新，
  间隔存 localStorage）。新建页面时不要用 `PageHeader actions` 放按钮。
- **日志可追溯（v2.33）**：upstream 日志带 `sessionKey`（X-Session-Id / 测试会话 id）、`identityId/Label`、`requestId`；
  日志页「会话 / 身份」列可定位请求。每条 HTTP 请求只调用一次上游；若看到两条记录，用 `requestId` 区分是两个请求。
  `/v1/responses`（流式/非流式）也会写入会话历史（此前只有 chat/completions 记录）。
- **额度冷却（v2.32）**：上游 `ERR_USER_LIMIT`/`[LIMIT_ENTITY]`（free 每日额度）或 `ERR_ACCOUNT_LIMIT` 时，
  当前身份写入 `cooldownUntil`（取 `[FIXED_COST_WINDOW_USAGE]` windows `resetAt`，缺省 `pool.quotaCooldownMinutes`=1440）。
  冷却身份不参与路由，但**不提前解绑**已有会话；绑定会话只有收到请求时才按需改绑并持久化。
  全冷却 → 429 `all_identities_cooling`；到期自动恢复，管理页可手动「解除冷却」（`DELETE /identities/:id/cooldown`）。
- **SQLite（v2.31）**：身份池/绑定/订阅/日志/用量/会话历史已迁到 `data/duckai.db`（node:sqlite，WAL）；
  旧 JSON 仅首启导入，仍写快照但不作为读取来源。新增列表型数据请建表，不要再用整文件 JSON。
- **身份额度**：付费身份额度来自 `GET https://duck.ai/duckchat/v1/status` 的 `fixedCostWindowUsage.windows`；
  free/匿名没有该字段 → `supported:false`，页面不显示。接口 `GET /admin/api/identities/usage`（60s 缓存）。
- **会话历史**：`/v1/chat/completions` 与连接测试成功后写入 `history` 表；保留策略 `config.history.retentionDays`
  （默认 30 天，0=不清理），每 30 分钟清理；页面 `#/history` 只读展示。会话列表支持多选批量删除（`/test/sessions/bulk-delete`）。
- **双池路由（v2.30）**：`_candidates()` 付费池=订阅身份、free 池=未订阅身份（无则回退全部）；每个 sessionKey 只绑定一次，切到另一池的模型才改绑；`binding.tier` 记录所属池。付费池为空才 403。
- **绑定缓存 TTL**：`config.pool.bindingTtlDays`（默认 7，0=永不）；绑定含 `updatedAt`，启动/路由前/每 10 分钟清理；管理页「身份池 → 会话绑定缓存」可改。会话绑定表分页默认 5 行。
- **连接测试路由（v2.29）**：测试会话**创建时不绑定身份**，首个消息请求按 `paidModel` 路由后再回填；
  `selectIdentity({rebindPaid:true})` + `routeDetailed({rebindOnSubscriptionMismatch:true})` 允许把已绑定的 free 身份
  自动改绑到订阅身份。直接 `/v1/*` 客户端**不要**启用自动改绑（保持 403 语义）。
- **模型配置表格**：上下文/单条输入/输出三列已合并为「限制」一列三行；另有「推理等级」列（`reasoning_efforts`）。
- **提示词（v2.28）**：`prompts.source = duckai|custom|none`（默认 **duckai**）。duck.ai 本身**默认不注入系统提示词**，
  它的「Customize responses」只是拼一段英文指令（tone/length/clarify/昵称/角色）。生成器在 `src/duck/prompt.js`，
  角色措辞在 `src/duck/duckai-roles.json`（从 bundle 提取）。改文案要同步这三处与 `tests/prompt-generator.test.js`。
- **设置页保存**：header 不放按钮；每张卡片自带保存（只 PUT 自己的配置段）。**不要**再订阅 `/overview` 轮询做数据源，
  否则每 5 秒 `setLoading(true)` 会导致页面抖动（v2.28 已修）。
- **代理**：沙箱访问 duck.ai / sync.duckduckgo.com 需要 `http://127.0.0.1:10808`（配置见「代理」页）。
- **订阅登录（v2.26 坑）**：① Chrome 地址栏**粘贴** `javascript:` 会被剥离变成搜索 → 只能拖成书签或用 Console 脚本；
  ② duck.ai CSP `connect-src` 不含 duckduckgo.com → 浏览器内只能用同源 `/duckchat/v1/auth/token`；
  ③ Chrome Local Network Access 会拦公网→`127.0.0.1` 的 fetch → 脚本回退 `window.open` 打开管理台，
  hash 携带 `sessionId/token`，管理台同源 capture 后立即 `history.replaceState` 清除；
  ④ token 有效期约 4 小时（`expires_in=14400`），到期需重新捕获。
  ⑤ **自刷新（v2.27）**：duck.ai 响应会轮换 HttpOnly cookie `ddg_auth_refresh_token`（30 天）；
  把它粘贴到「订阅 → 自动续期」后，网关每 5 分钟巡检、到期前 30 分钟自动续期，
  并把新 token 同步到绑定该订阅的身份（`identity.auth` 是快照）。
  ⑥ 删除身份时若绑定了订阅 → 409 `identity_has_subscription`，必须先解绑（duck.ai 语义＝退出登录），
  或 `?force=true` 解绑后删。
- **订阅 token**：只存在 `data/subscriptions.json`（0600）。获取方式见
  `docs/SUBSCRIPTION-LOGIN.md`——`quack.duckduckgo.com/api/auth/v2/token` 依赖 DuckDuckGo 登录 cookie，
  Node 侧拿不到，必须由「已登录浏览器」通过登录会话 + 书签脚本回传
  （`/admin/api/subscriptions/login-session` + `/capture`，v2.25）。
- **日志保留**：`logging.maxEntries`（每类条数，10–20000）+ `logging.maxAgeDays`（0=不限）；
  `PUT /admin/api/logs/retention` 立即裁剪；下载走 `GET /admin/api/logs/download`。
- **Token 统计**：估算口径（字符/4），累计写入 `data/usage.json`（`/admin/api/usage`、
  overview `tokens`），按模型与「身份×模型」聚合；**清空日志不影响累计**。
- **page-check 危险点**：任何会 `identities/generate` 的检查必须在 finally 里 force DELETE，
  否则会撑爆真实身份池（2026-11-03 已修复并清理）。

## 6. 已知的坑（踩过、已验证，别再踩）

### 协议 / 上游

- **continuation 帧**：上游可能以 `{role:"continuation",action:"success",token,pendingActions}` 结束而不是
  `[DONE]`（工具审批：web-search / image-generation / user-location，或可续传流）。
  需自动批准 approval 并用 `{continuation:{token,responseId,responses},currentAssistant:{...}}` 重发；
  `responseId` 必须与首次请求一致；续传时去掉 `durableStream`；400 时回退
  `metadata.toolChoice={WebSearch:true}`。**重发前必须 release 挑战 lease**，否则死锁。
- **reasoning 重复**：reasoning `done` 帧的 `summaryText` 是全量文本，不能当增量追加。
- **匿名额度**：出口 IP 共享，418/429/403 频发；遇到不要狂重试，等窗口/换代理。
- **入口检测（ERR_BN_LIMIT）**：`x-vqd-hash-1.meta.stack` 必须指向当前部署的
  `https://duck.ai/dist/duckai-dist/entry.duckai.<hash>.js`；Node 本地 `file:///` 帧会被判
  "unsupported entrypoint"（429）。`x-fe-signals` 也不要发空 events。改 challenge 相关代码后
  跑 `tests/entrypoint-meta.test.js`，排障用 `DUCKAI_NATIVE_STACK=1`。
- **durableStream**：匿名 tier 可能拒绝 → 自动降级并标记；不要在 `/signup` body 漏
  `device_id/device_name/device_type` 或 `keys[].public_key.alg/use`（上游 400 校验）。

### Sync / 设备

- **双设备身份会重复**：全局 `identity.json` 与池 `id_default` 是两份记录；Sync 必须统一用
  `syncDevice()`（以池默认身份为准），否则 DuckDuckGo 出现两个 `DuckAI@main`。
- **登录即注册设备**：对当前设备 `logout` 后再次 `login` 会重新创建设备；删除自己后只读列表走缓存
  （`registered=false` 时不 login），否则“删不掉”。
- **配对方向**：网关是 `3party`、手机是 `ddg`；手机是 leader（给码方）。网关作为二维码展示方
  默认发送 `recovery_code_available`；`preferPeerAccount=true` 才改为索取对方码。
  手机有账号时会要用户确认，确认后才回码；等待期前端必须提示「请回手机点允许」。
- **账号合并语义**：配对完成 ≠ 同账号；`accountMerged=true` 才代表已采用对方账号，此时
  `accountConflict` 必须为 false；未采用时 `pendingAccount` 供「改用手机账号」一键切换。

### UI / 前端

- **Radix Select**：item 内容会镜像到 trigger；不要把多行复杂内容塞进 SelectItem，
  名称用 `SelectItemText` 包裹，触发器自己渲染单行文本。
- **组件导入**：Vite 构建不做类型检查，`<Icon />` 未 import 会在运行期崩溃（白屏/空 root），
  改完必须刷新页面或跑 jsdom 用例确认无 console 错误。
- **hash 路由**：`#/identity`=`默认身份`，`#/identities`=`身份池`，`#/subscriptions`=订阅；
  新增页面要改 `webapp/src/app/lib/hash-route.ts` + `App.tsx` + `components/sidebar.tsx`。
- **bundle 缓存**：改前端后 `npm run build:web`，确认 `web/index.html` 引用的 hash 与
  `/admin` 实际返回一致，再在浏览器硬刷新验证。

### 压缩

- 白名单 9 个模型；`gpt-6-luna` 不做自动压缩。
- 触发：`activationTargetPairCount`（>0）否则 `activePairs-covered>=4 && activePairs>=4`。
- 摘要结构：`coveredMessageCount / anchorIndex / anchorMessageId / trigger / savedChars / tokenThreshold`；
  编辑/清除走 `PATCH/DELETE /admin/api/test/sessions/:id/summary`。

## 7. 交付流程（必须照做）

1. **改代码 → 构建（如涉及 webapp）→ 重启网关（如涉及 src）**：
   - 后台 job 启动：`node src/index.js`；改完先 `job_kill` 旧 job 再起，避免端口占用/旧代码。
2. **跑验证矩阵**（不允许只看单测就宣布完成）：
   - `npm test` 全绿；
   - `npm run build:web` + `node scripts/build-check.mjs`；
   - `node scripts/page-check.mjs --admin-token <ADMIN> --api-key <KEY>`（真实网关 22/22；
     Sync 未配置时相关用例自动 SKIP）；
   - 涉及真实上游时 `scripts/live-check.mjs`（额度受限则记录 BLOCKED，不虚报）。
3. **实机验证**：浏览器操作**必须**通过 MCP `chrome-devtools`（用户明确要求；直接用浏览器
   调用会触发人工授权）。截图保存到 `docs/screenshots/` 并 `present`。
4. **更新文档**：对应 `docs/*.md` + `docs/ACCEPTANCE.md`（每版一节，写明证据/结果）；
   有 BLOCKED 的必须标明原因与复现命令。
5. **汇报**：中文、结论先行、区分「已验证 / 分析结论 / 待确认 / BLOCKED」；不要用未验证的结论
   冒充成功。

## 8. Agent Teams 协作

- 用 `team_task_create` 建任务（写 `write_scopes` 避免重叠），`send_message` 派给队友；
  队友 `inactive` 时消息会启动新一轮。
- 队友模型由用户统一配置为 `deepseek/deepseek-v4.1-flash`（与 Lead 一致）。`list_agents` 在
  inactive 时可能显示 `deepseek-v4.1-flash`、running 时显示 `deepseek/deepseek-v4.1-flash`，
  这是解析时机差异，不是配置错误。
- 曾出现「队友进程启动失败」，2026-11-03 已由用户更新模型选择后恢复：qa-verifier /
  duck-protocol / api-core 均已实测可正常执行任务（见 `docs/ACCEPTANCE.md` §2.16）。
  若再遇到启动失败：先重试一次，仍失败则由 Lead 自己完成并在汇报里说明。
- 文件写权限按 `write_scopes` 自律：`src/duck/**` 归协议、`src/**`（除 duck）归后端、
  `webapp/**`+`web/**` 归前端、`tests/**`+`scripts/**` 归 QA。
- 队友完成后 Lead 必须自己跑一遍全量验证与实机检查，再给用户最终答复。

## 9. 当前状态（v2.21）

- 已完成：压缩语义修正+内联摘要、思考去重、continuation（天气 502）修复、日志翻页、
  设备主设备标记与二级菜单（重命名/删除）、订阅实体化+订阅页、默认身份页重排、
  Sync This Device Only（`/sync/signup` 真实创建账号）、配对交互记录面板。
- v2.20 新增：
  - `/v1/models` 落地上表字段：`context_window_chars / context_window / max_input_tokens /
    max_input_chars / input_char_limit / max_output_tokens(estimated) / compaction_supported /
    compaction_trigger / compaction_threshold_tokens / activation_target_pair_count /
    session_limit_behavior`；
  - 超长输入错误映射修正：上游 429/`context_length_exceeded` → **HTTP 413 `context_length_exceeded`**
    （此前误报 502 `upstream_error`）；
  - 真实对话测量脚本：`scripts/limit-probe-gateway.mjs`（走网关连接测试链路）与
    `scripts/limit-probe.mjs`（直连协议层），实测单条输入上限 **约 19,500–19,600 字符**
    （中英文同一字符边界 → 证明按字符而非 token）；详见 `docs/CONTEXT-TOKENS.md`。
- 自动化：`npm test` 353/353、`build-check` 16/16、`page-check` 22/22、
  `smoke --mock` 9/9、`proxy-live-check --with-proxy` 11/11。
- 待用户确认：`context_window_chars` 采用 20,000（保守）还是 16,000（`inputCharLimit`）；
  非压缩模型到会话上限时是原样 409 还是自动新开会话。
- v2.21 新增：
  - **模型配置页**（`#/model-config`）+ `GET/PUT /admin/api/models/config`：按模型覆盖
    `context_window_chars / max_input_chars / max_output_tokens`，快捷预设（duck.ai 默认 / 实测上限 /
    自定义），保存到 `config.models.overrides` 并立即影响 `/v1/models`；
  - **客户端压缩**：`POST /v1/compact`；会话上限保持 **409 `conversation_limit_reached` + hint**，
    网关**不再**自动裁剪/压缩；
  - **入口检测修复**：`ERR_BN_LIMIT "unsupported entrypoint"` 的根因是 `x-vqd-hash-1.meta.stack`
    指向 Node 本地 `file:///` 帧；现在解析当前 entry bundle 并生成浏览器同形态 stack，
    `x-fe-signals` 也补了真实事件；排障开关 `DUCKAI_NATIVE_STACK=1` / `DUCKAI_EMPTY_SIGNALS=1`
    （见 docs/PROTOCOL-ERRORS.md §3.1.1）；
  - 新增单测：`tests/model-config.test.js`、`tests/compact-api.test.js`、`tests/entrypoint-meta.test.js`。

## 10. 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/ADMIN_API_V2.md` | 管理 API 全量契约（v2…v2.19，§ 编号对应版本） |
| `docs/API.md` | 对外 OpenAI 兼容 API + 前端行为 |
| `docs/PROTOCOL.md` / `PROTOCOL-ERRORS.md` | duck.ai 协议、错误码与网关映射 |
| `docs/COMPACTION-RESEARCH.md` / `COMPACT.md` | 压缩源码研究 + 网关实现 |
| `docs/MODEL-CATALOG-SOURCE.md` | 模型列表/参数的真实获取方式 |
| `docs/CONTEXT-TOKENS.md` | 每模型上下文/token 上限分析（待确认实现） |
| `docs/DUCKAI-FEATURE-MAP.md` | 全量 API/网页功能地图与缺口清单 |
| `docs/IDENTITY-*.md` / `PAIRING-IMPL.md` / `SYNC-DEVICES.md` | 身份/配对/Sync 设备 |
| `docs/PROXY.md` / `PROXY-IMPL.md` | 代理配置与实现 |
| `docs/INCIDENT-2026-11-01-device-deletes.md` | 设备误删事故复盘与恢复 |
| `docs/ACCEPTANCE.md` / `QA.md` | 版本验收记录 / 测试矩阵与限界 |
| `ARCHITECTURE.md` / `README.md` | 总体架构与上手说明 |
