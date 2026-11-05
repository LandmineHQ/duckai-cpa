# DuckAI CPA v2 契约（重构差异说明）

> v2 目标：React + shadcn 控制台风格前台；后台请求与上游请求分离（日志分离）；RPS 队列；
> 强制 API Key；免费/付费模型区分；连接测试改为「会话式连续对话」；上游协议严格校验即时中断。
> 本文件是 v2 的唯一契约来源；与 `docs/ADMIN_API.md`（v1 基础）冲突时以本文件为准。
>
> **BREAKING（用户明确要求，不留兼容）**：v2 直接破坏性变更——
> - 删除 `auth.required` / `POST /admin/api/test`（单次测试）/ 旧扁平 `stats` 字段 / 旧 `web/index.html` 手写页面；
> - `/v1/*` 必须携带 API Key；`/admin/api/*` 必须携带 admin token；
> - 旧 data 文件（logs/stats/testsessions 结构）自动迁移或丢弃，不保证旧数据兼容；
> - 测试/文档同步按 v2 重写，不保留 v1 断言。

---

## 1. 鉴权（强制）

| 范围 | 规则 |
| --- | --- |
| `/v1/*` | **必须** `Authorization: Bearer <apiKey>`；无 key/错误 key → `401 {"error":{"message","type":"authentication_error","code":"invalid_api_key"}}` |
| `/admin/api/*` | **必须** admin token（`Authorization: Bearer <adminToken>`；GET 也允许 `?token=`）；不变 |
| `/healthz`、`/admin`(静态) | 公开 |

- 删除 `auth.required` 开关（配置中忽略；`GET/PUT /admin/api/config` 不再返回/接受 `auth.required`）。
- **首次启动自动创建默认 API Key**（label=`default`），完整 key 打印一次到启动日志，并写入 `data/keys.json`；
  后台「API Key」页可查看预览、创建、吊销。若 keys 为空则启动时自动重建。
- 所有示例（curl/SDK）都必须带 key。

## 2. 上游请求队列（RPS）

配置（`config/config.example.json`）：

```json
"upstream": {
  "rps": 1,              // 每秒最多开始的上游请求数，默认 1
  "maxConcurrent": 1,    // 同时执行上限，默认 1
  "queueLimit": 50,      // 排队上限，超过则 429
  "queueTimeoutMs": 300000
}
```

行为：
- 所有上游调用（`/v1/chat/completions`、`/v1/responses`、`/v1/images/generations`、`/admin/api/test*`）统一经过 **FIFO 队列**；
- 默认 `rps=1`：任意时刻最多 1 个上游请求执行，其余排队；两次上游请求开始间隔 ≥ 1000/rps ms；
- 队列满或等待超时 → `429`，错误 `code:"queue_full"` / `"queue_timeout"`，响应头 `Retry-After`；
- 配置实时生效（PUT config 后无需重启）；
- `/admin/api/overview` 增加：
  ```json
  "upstream": { "ok": true, "queue": { "waiting": 0, "inFlight": 0, "rps": 1, "maxConcurrent": 1, "limit": 50, "avgWaitMs": 0, "lastStartAt": 1793... } }
  ```
- 每个上游日志项增加 `queueWaitMs`。

## 3. 日志拆分（后台 API vs 上游请求）

存储：`data/logs.json`（v2 结构，旧数据自动丢弃/迁移）：
```json
{ "upstream": [ { id, ts, source: "v1"|"admin-test", endpoint, model, status, latencyMs, queueWaitMs, stream, error, rateLimited } ],
  "admin":    [ { id, ts, endpoint, method, status, latencyMs, error } ] }
```
`stats` 同样拆分：`stats.upstream`（requests/errors/avgLatencyMs/byModel/byEndpoint/rateLimitCount/lastErrorAt）
与 `stats.admin`（requests/errors/avgLatencyMs/byEndpoint/lastErrorAt）。

API：
- `GET /admin/api/logs?kind=upstream|admin&limit=50&offset=0` → `{ kind, total, items }`（kind 缺省 `upstream`）
- `DELETE /admin/api/logs?kind=upstream|admin` → `{ ok, kind }`
- `overview.stats` → `{ upstream: {...}, admin: {...} }`（不再有顶层扁平的 requests/errors/avgLatencyMs/byModel；旧字段可保留为 deprecated 但前台不使用）
- `overview.recent` 拆为 `recentUpstream` / `recentAdmin`（各 10 条）。

## 4. 模型：免费 / 付费区分

模型元数据统一为：
```json
{ "id": "claude-opus-5-5", "owned_by": "Anthropic", "paid": true, "tier": "pro",
  "available": false, "requires_subscription": true, "reasoning": true,
  "supported_reasoning_efforts": ["none","low","medium"], "tools": ["web_search","image_generation"],
  "display_name": "Claude Opus 5.5" }
```

- Free 可用（匿名可用）：`gpt-6-luna`、`gpt-5.4-mini`、`claude-haiku-4-5`、`mistral-small-2603`、`tinfoil/gpt-oss-120b`、`tinfoil/gemma4-31b`
- 付费（Plus/Pro 订阅）：`gpt-5.6-terra`、`gpt-5.6-sol`、`claude-sonnet-5-5`、`claude-opus-5-5`
- 配置 `duck.allowPaidModels` 默认 `false`：
  - `GET /v1/models` 仍列出全部模型；付费模型 `paid:true, available:false, requires_subscription:true`
  - 对 `paid:true && available:false` 的模型发起请求 → **403**
    `{"error":{"message":"Model <id> requires a Duck.ai subscription (Plus/Pro) and is disabled on this gateway.","type":"model_unavailable","code":"model_requires_subscription","param":"model"}}`
  - `allowPaidModels=true` 时允许请求上游（失败由上游错误映射，如 `ERR_ACCOUNT_LIMIT` → 403 `upstream_subscription_required`）
- 管理后台：模型列表/选择器显示 `免费` / `付费` 徽章；付费模型在未开启 allowPaidModels 时 **禁用**（🔒）并提示；设置页提供 allowPaidModels 开关（默认关）。

## 5. 会话式连接测试（替代单次测试）

### 5.1 数据结构

`data/testsessions.json`：
```json
{ "sessions": [ { "id": "sess_xxx", "title": "…", "model": "gpt-6-luna", "reasoningEffort": "none",
                  "webSearch": false, "imageGeneration": false, "createdAt": 1793, "updatedAt": 1793,
                  "messages": [ { "id": "msg_xxx", "role": "user"|"assistant", "content": "...",
                                  "reasoning": "", "sources": [], "images": [{"b64","format"}],
                                  "model": "gpt-6-luna", "ts": 1793, "latencyMs": 1234, "finishReason": "stop" } ] } ] }
```
- 最多 100 个会话（超出淘汰最旧）、每会话最多 200 条消息；原子写。
- `title` 为空时自动取首条用户消息前 30 字符。

### 5.2 REST

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /admin/api/test/sessions` | `{ items: [{ id, title, model, reasoningEffort, webSearch, imageGeneration, createdAt, updatedAt, messageCount }] }` |
| `POST /admin/api/test/sessions` | body `{title?, model?, reasoningEffort?, webSearch?, imageGeneration?}` → 201 `{ session }` |
| `PATCH /admin/api/test/sessions/:id` | body 同上字段 → `{ session }` |
| `DELETE /admin/api/test/sessions/:id` | `{ ok: true }` |
| `GET /admin/api/test/sessions/:id` | `{ session, messages: [...] }` |
| `POST /admin/api/test/sessions/:id/messages` | body `{ content, model?, reasoningEffort?, webSearch?, imageGeneration?, stream? }` → SSE（见下） |
| `POST /admin/api/test/sessions/:id/messages/:messageId/retry` | **重新生成某一轮**（`messageId` 必须是 assistant 消息）。body 可选覆盖 `{ model?, reasoningEffort?, webSearch?, imageGeneration? }`；服务端截断到该轮对应的 user 消息（删除该 assistant 及其后所有消息），重新调用上游并以同位置的新 assistant 消息替换；返回与 messages 相同的 SSE（`session` 事件额外带 `retryOf`）。错误 assistant 消息（如 429）同样可重试。 |
| ~~`POST /admin/api/test`~~ | **v2 已删除（404）**；会话式 UI 使用 sessions 接口 |

### 5.3 SSE 事件（session 对话）

```
data: {"type":"session","sessionId":"sess_x","userMessageId":"msg_u","assistantMessageId":"msg_a","retryOf":"msg_old"?}
data: {"type":"delta","text":"你"}
data: {"type":"reasoning","text":"..."}
data: {"type":"search","results":[{"title","url","snippet"}]}
data: {"type":"image","b64":"...","format":"jpeg"}
data: {"type":"done","message":{...完整 assistant 消息...},"latencyMs":1234,"queueWaitMs":12}
data: {"type":"error","message":"...","code":"...","status":429}
```
- assistant 消息字段：`{ id, role, content, reasoning, reasoningEncrypted, sources, images, model, ts, latencyMs, queueWaitMs, finishReason, error?, retriedFrom? }`。
- `reasoning`：上游提供明文推理时的文本；匿名档可能只有加密摘要，此时 `reasoning=""` 且 `reasoningEncrypted=true`（前端显示「推理已加密」提示）。
- 流中断/上游错误：`error` 事件后结束；会话中 assistant 消息记录 `error` 字段，可在 UI 直接点「重新生成/重试」。
- 多轮上下文：服务端按 session.messages 拼接（user/assistant 文本）传给 DuckClient，无需前端保存历史。
- 重试语义：截断到目标轮（保留其 user 提示），丢弃其后的消息；新回复成功后追加为新的 assistant 消息（与 duck.ai 的 retry 行为一致）。

### 5.4 重新生成（retry）实现细节（v2.1）

`POST /admin/api/test/sessions/:id/messages/:messageId/retry`（SSE，事件同 §5.3）：

- 校验顺序与错误码：
  - session 不存在 → `404 session_not_found`
  - `messageId` 不在该会话 → `404 message_not_found`
  - 目标消息不是 assistant → `409 message_not_assistant`
  - 历史中找不到目标 assistant 之前的 user 消息 → `400 invalid_history`
  - 同一会话已有流在进行（messages 或 retry）→ `409 session_busy`
- 服务端截断：找到目标 assistant 索引 `i` 及其前最近 user 索引 `u`，将 `session.messages` 置为 `slice(0, u+1)`；目标 assistant 及其后所有消息被删除（截断后历史保证 user/assistant 交替，失败/带 error 的 assistant 不会进入上游上下文）。
- 可选 body 覆盖 `model / reasoningEffort / webSearch / imageGeneration`，校验后写回会话配置，再走全局上游 RPS 队列重新生成。
- `session` 事件额外带 `retryOf=<原 assistant messageId>`；`done.message` 是新 assistant 消息，带 `retriedFrom=<原 assistant messageId>`、`reasoningEncrypted`、`queueWaitMs`。
- 失败语义与 messages 一致：首事件前失败 → HTTP JSON（429/502/403，并追加一条带 `error` 的 assistant 消息，带 `retriedFrom`，便于再次重试）；已开始 SSE 后失败 → `{"type":"error"}` 事件结束、无 `done`，同样追加带 `error` 的 assistant 消息。
- 同一会话同时只允许一个流；流结束（成功或失败）后自动释放 `session_busy` 锁。

## 6. 上游严格校验（任何环节不符预期立即中断）

`DuckClient` 默认 `strictProtocol: true`：
- 非 2xx / 内容类型不是 `text/event-stream`（chat 成功响应）→ 立即 `abort()` 上游并抛 `DuckError(code:"upstream_protocol_mismatch")`；
- 成功响应缺少滚动挑战头 `x-vqd-hash-1` → 立即中断（不继续消费）；
- `data: {json}` 解析失败、未知事件 role（白名单外）、`action:"error"`、缺少 `[DONE]` 结束标记、图片成功缺 `b64Image` → 中断并抛错；
- 已写出 HTTP 响应后再中断：SSE 发送 `error` 事件并结束（不伪造完成事件）；
- 新增错误码映射：
  - `upstream_protocol_mismatch` → 502
  - `upstream_no_image` → 502
  - `ERR_REFUSAL` / moderation → 403 `content_filter`
  - `ERR_ANOMALY`(如出现) → 429/403 `upstream_anomaly_check`
- 错误详情（事件片段、事件名、序号）写入 upstream 日志 `errorDetail` 字段（不存敏感内容）。
- 另外依据 duck.ai 源码错误处理清单补充映射（见 `docs/PROTOCOL-ERRORS.md`，duck-protocol 产出）。

## 7. 前端（React + shadcn）

- 源码：`webapp/`（Vite + React + TypeScript + Tailwind + shadcn/ui 风格组件，Radix 原语）
- 构建：`npm run build:web` → 输出到 `web/`（`base:"/admin/"`，服务端已按 `/admin` + `/admin/assets/*` 提供服务）
- 布局：**左侧控制台式侧边栏**（品牌、导航：概览/连接测试/设置/API Key/日志/示例；底部连接状态 + 主题切换）；右侧主内容区。
- 主题：沿用当前橙白配色（primary ≈ `#f97316`），支持浅色/深色/跟随系统。
- 页面：
  1. 概览：上游健康 + **队列状态**（执行中/排队/rps）+ 上游统计 + 后台统计 + 模型目录（免费/付费徽章）+ 最近上游/后台日志（Tabs）。
  2. 连接测试：**会话式连续对话**。左侧会话列表（新建/选择/删除），主区消息流，底部**单一输入框**（内含模型选择、reasoning 选择、联网/图片开关、发送/停止）；流式渲染；会话持久化。
  3. 设置：RPS + 队列上限、`allowPaidModels`、默认模型、超时、prompts（mode 默认 inline）、工具开关、日志级别；保存后实时生效/`restartRequired` 提示。
  4. API Key：强制鉴权说明 + 列表/创建（完整 key 仅一次）/吊销/使用统计。
  5. 日志：Tabs「上游请求 / 后台 API」，分页、错误高亮、清空、`queueWaitMs` 列。
  6. 示例：curl / Python SDK / Node SDK / Responses，全部带 API Key。
- 不引入外部 CDN；构建产物本地化；`web/` 由构建生成（不再手写）。

---

## 8. 验收补充（v2 新增）

1. 无 API Key 访问 `/v1/models`、`/v1/chat/completions` → 401；带 key → 正常。
2. 并发 3 个 `/v1/chat/completions`：上游实际串行（日志 `queueWaitMs` 递增、同时仅 1 个 inFlight）、总耗时 ≈ 3×单次。
3. `GET /admin/api/logs?kind=upstream` 与 `kind=admin` 内容互不混淆；清空互不影响。
4. 对 `claude-opus-5-5` 请求（默认配置）→ 403 `model_requires_subscription`；`/v1/models` 中 `paid:true, available:false`。
5. 会话：创建 → 连续发 3 条消息（含多轮上下文）→ 刷新后历史仍在 → 删除成功。
6. 上游异常注入（mock 未知事件/缺 `[DONE]`）→ 立即中断，502 `upstream_protocol_mismatch`，不输出完成事件。
7. React 后台：`npm run build:web` 成功，`/admin` 打开无控制台错误，六个页面工作，左侧控制台导航，免费/付费模型区分可见。
8. **重新生成**：对任意 assistant 消息（含 429 错误消息）点击「重新生成」→ 服务端截断该轮之后消息 → 重新请求上游 → SSE 流式替换该轮回复；上游 429 时用户可直接点重试（无需重新输入）。
9. **推理内容**：上游返回明文 reasoning 时，助手消息显示可折叠「推理过程」；仅加密摘要时显示「推理已加密（匿名档）」提示而不是空白折叠块。

---

## 9. v2.2：身份 / Sync & Backup / 订阅（Admin API）

完整契约见 [`docs/IDENTITY-SYNC.md`](./IDENTITY-SYNC.md) §2/§3（唯一契约来源）。本节只记录实际实现与契约的差异/补充。

### 9.1 依赖注入

- `src/index.js` 在 `DuckClient` 之前创建 identityStore（`src/duck/identity.js`，duck-protocol 实现）并调用 `await identity.init()`；
- `new DuckClient({ ...config.duck, identityStore, logger })`；
- `createServer({ config, store, duck, logger, identity })` 显式注入，QA/测试可用同签名注入 mock identityStore；
- identityStore 不可用（duck 层缺失/初始化失败）时服务照常启动，`/admin/api/identity|sync|subscription` 返回 **503 `identity_unavailable`**（契约外补充码，带 `hint`），其余 v2 功能不受影响。

### 9.2 端点清单

`GET /admin/api/identity`、`POST /identity/rotate`、`GET /identity/export`、`POST /identity/import`、`POST /identity/reveal`；
`GET /admin/api/sync`、`POST /sync/enable|disable|pairing-code|pair`、`GET|POST /sync/recovery-code`；
`GET /admin/api/subscription`、`POST /subscription/activate|verify`、`DELETE /admin/api/subscription`。
全部走 admin token 鉴权；方法与未知名端点分别返回 405/404。

### 9.3 实现差异 / 补充

- `GET /admin/api/identity` 的 `durableStream` 额外返回 `enabled`（= `config.identity.durableStream.enabled`）以及 duck 层健康状态 `configured/enabled/degraded/rejectedCount`（来自 `DuckClient.health().durableStream`；degraded=true 时附 `note` 提示）。**durableStream 默认开启**（duck-protocol 的公钥 JWK 带 `alg`/`use:"enc"`，上游已实测接受；可在设置/配置里关闭）。若上游仍返回 400 拒绝，duck 层自动降级为不带该字段重试一次，并记录非致命 `durable_stream_rejected`（warn 日志 + health 计数），`GET identity` 会显示 degraded。`identity.durableStream.enabled` 在 DuckClient 构造时读取，修改后需重启网关生效（配置会立即持久化）。
- `POST /identity/reveal` 需要 `{ field: "token"|"mainKey", confirm: true }`；缺少 confirm → 400 `confirmation_required`，field 非法 → 400 `invalid_field`（契约外补充码）。
- `GET /identity/export`：`Content-Disposition: attachment; filename="duckai-identity-<ISO 时间戳>.json"`，`Cache-Control: no-store`；body 为 `{version,exportedAt,identity}`（含私钥/token，仅下载附件）。
- `POST /identity/import`：接受 `{ identity }` 或直接 identity 对象；校验失败 → 400 `invalid_identity`。
- `GET /admin/api/sync`：`recoveryCode` 返回 `{present,preview}`；完整恢复码只在 `POST /sync/enable` 返回一次，之后可用 `GET /sync/recovery-code`（需 admin token）读取或重新导入。
- `POST /sync/pair`：本沙箱无法访问 duckduckgo.com，`identityStore.pair` 抛 `503 sync_transport_unavailable` 且**不修改本地状态**；错误体为 `{"error":{message,type:"sync_transport_unavailable",code,param,hint}}`（`hint` 为契约外补充字段，前端可直接展示）。
- `POST /sync/pairing-code` 响应包含 `code/url/channelId/publicKey/createdAt/expiresAt`（契约 §3.2 的 code/url/expiresAt 为必选，其余为补充）。
- 订阅：token 必须是三段 base64url JWT，否则 422 `token_invalid`；payload `exp` 过期 → 422 `token_expired`；在线 verify 失败不影响 HTTP 状态（仍 `200 {ok:true, subscription:{verified:false, verifyError}}`）；`DELETE` 清 token 回 free。**verified 语义（v2.2 修正）**：duck.ai 匿名 `/status` 不校验 Bearer token，`verified` 仅表示「token 本地解析通过 + 上游可达」，**不代表 token 有效**；`GET /admin/api/subscription` 与 `POST /subscription/activate|verify` 响应新增 `verifyScope:"reachability"` 与 `verifyNote`，真实档位以实际请求上游结果为准。
- 错误映射（IdentityError → HTTP）：400 `invalid_identity` / `invalid_recovery_code` / `invalid_pairing_code` / `unsupported_pairing_version`；422 `token_invalid` / `token_expired`；409 `identity_busy` / `sync_not_enabled`；503 `sync_transport_unavailable`（带 hint）或 `identity_unavailable`。
- `config.identity` 默认值 `{ enabled:true, durableStream:{enabled:true}, sync:{enabled:false}, deviceName:null }`，旧配置启动时自动补默认并持久化；`PUT /admin/api/config` 允许修改 `identity.enabled / identity.durableStream.enabled / identity.sync.enabled / identity.deviceName`；`GET /admin/api/config` 只返回这些开关/设备名，绝不返回 identity 私钥、sync mainKey 或订阅 token（这些只存在于 `data/identity.json`）。

---

## 10. v2.3：代理（Proxy）Admin API

完整契约见 [`docs/PROXY.md`](./PROXY.md) §1–§3（唯一契约来源）。本节记录实际实现/接入方式。

### 10.1 配置与脱敏

- `config.proxy` 默认值：
  ```json
  { "enabled": false, "type": "http", "host": "127.0.0.1", "port": 8080,
    "username": "", "password": "", "noProxy": ["127.0.0.1", "localhost"],
    "testUrl": "https://duck.ai/duckchat/v1/status",
    "ipCheckUrl": "https://api.ipify.org?format=json" }
  ```
  （`type ∈ http|https|socks4|socks5`；`port` 1–65535；`noProxy` ≤50 项去重；URL 必须 `http(s)://`。）
- 旧配置启动时自动补 `proxy` 段并持久化；`PUT /admin/api/config` 白名单为 `proxy.enabled/type/host/port/username/password/noProxy/testUrl/ipCheckUrl`。
- **密码语义**：`PUT` 省略 `password` = 保持原值；传 `""` = 清除；`GET /admin/api/config` 与 `GET /admin/api/proxy` 都**不回显 password**，只返回 `hasAuth: boolean`。

### 10.2 端点

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /admin/api/proxy` | `{ proxy: { enabled,type,host,port,hasAuth,username,noProxy,testUrl,ipCheckUrl,status:{active,mode,lastTestAt,lastTestOk,lastTestLatencyMs,lastTestStatus,exitIp,lastError,updatedAt} } }`（`active=false` 时 `mode:"direct"`；无 password） |
| `PUT /admin/api/proxy` | body 部分配置（深合并；password 省略=不变、`""`=清除）→ `{ ok:true, proxy:{...}, applied:true }`；**立即重建 dispatcher，无需重启**。校验失败 → `400 {"error":{type:"invalid_request_error",code:"invalid_proxy",param:"<field>",message}}` |
| `POST /admin/api/proxy/test` | body 可选覆盖（type/host/port/username/password/noProxy/testUrl/ipCheckUrl；不改保存值，用临时 dispatcher）→ **始终 200**：`{ ok,mode,target,status,latencyMs,exitIp,ipError,testedAt,error,code,bypassNoProxy? }`；连接失败 `code ∈ proxy_connect_failed|proxy_timeout|proxy_tls_failed`；**非法覆盖字段也返回 200** `{ok:false,code:"invalid_proxy",invalidField}`（前端只处理一种形态）；结果写入 `status.last*` |
| `GET /healthz` | 新增 `proxy:{ enabled,mode,active,lastTestOk,lastTestLatencyMs,exitIp }`（无密码/用户名明文以外的敏感信息） |

- `proxyManager` 未注入（duck-protocol `src/duck/proxy.js` 缺失/初始化失败）时：三组代理端点返回 `502 {"error":{type:"proxy_unavailable",code:"proxy_unavailable"}}`，其余 v2 功能不受影响（按直连）。
- `PUT /admin/api/proxy` 校验失败 vs 应用失败：均映射为 400 `invalid_proxy`（带 `param` 指明字段）；不会破坏已保存配置（配置仅在应用成功后写入 `data/config.json`）。

### 10.3 生效范围与启动接线

- `src/index.js` 先 `createProxyManager({ config: config.proxy, logger })`，再创建 identityStore（传入 `sync: { fetchImpl: proxy.getFetch() }`，使 sync transport 探测/订阅 verify 走代理），最后 `new DuckClient({ ...config.duck, proxyManager: proxy })`（DuckClient 自动用于首页版本/status/chat/capabilities/auth verify）；
- `createServer({ config, store, duck, logger, identity, proxy })` 显式注入；`server.proxy` 可用于断言；
- identity 与 proxy 相互独立：任一初始化失败只降级对应功能，不阻塞启动；代理关闭（`enabled=false`）时行为与 v2.2 完全一致（直连）。
- 启用代理后 `GET /admin/api/sync` 的 `transport` 预计变为 `available`（代理可访问 duckduckgo.com）；但跨设备配对握手仍未实现，`POST /admin/api/sync/pair` 在 transport 可用时返回 `501 sync_handshake_unimplemented`（不再是 503）。

### 10.4 联调记录（本机 10808）

- `POST /admin/api/proxy/test`（overrides `{type:"http",host:"127.0.0.1",port:10808}`）：`ok:true, status:200, latencyMs≈7.4s, exitIp:"203.0.113.10", ipError:null`；
- 同一端点的 SOCKS5 覆盖：`ok:true, status:200, latencyMs≈1.4s, exitIp:"203.0.113.10"`；
- `PUT /admin/api/proxy {enabled:true,type:"http",host:"127.0.0.1",port:10808}` 后：`GET /healthz.proxy = {enabled:true,mode:"http",active:true,...}`，`GET /admin/api/sync.transport = "available"`（此前 `blocked`）；
- 代理不可达（如 port 9）：`POST /proxy/test` 仍 200，`{ok:false, code:"proxy_connect_failed", error:"fetch failed"}`，`status.lastTestOk=false` 且 `lastError` 记录；
- 非法 PUT（type/port/host/noProxy/testUrl/ipCheckUrl/未知字段/非布尔 enabled）→ 400 `invalid_proxy`（`param` 指明字段），且不修改已保存配置；
- 重启后 proxy 配置持久化（`data/config.json` 含密码，接口仅 `hasAuth`）。

---

## 11. v2.4：身份池（Identity Pool）/ 会话路由 / 上下文守卫

完整契约见 [`docs/IDENTITY-POOL.md`](./IDENTITY-POOL.md) §1–§7；本节记录后端实现与联调口径。

### 11.1 配置

```json
"pool": { "enabled": true, "maxIdentities": 20, "strategy": "hash",
          "queueLimit": 50, "queueTimeoutMs": 300000, "runtimeIdleMs": 600000 },
"context": { "maxInputChars": 12000, "maxMessages": 40, "onLimit": "trim" }
```

- `pool.enabled=false` 时不创建池：`/admin/api/identities*` 全部返回 `503 identity_pool_unavailable`，`/v1/*` 回落到全局单 DuckClient（v2.3 行为）。
- `strategy ∈ hash|least-loaded`；`onLimit ∈ trim|error`。旧配置启动时自动补 `pool/context` 并持久化；`PUT /admin/api/config` 白名单见 `ADMIN_EDITABLE_PATHS`。
- 内部把 `runtimeIdleMs` 作为 duck-protocol 的 `idleTimeoutMs` 传入（对外键名保持契约）。

### 11.2 启动接线

`createIdentityPool({ dataDir, config, logger, proxyManager })`（duck-protocol `src/duck/identity-pool.js`）→ `createServer({ identities })`；identity/proxy/pool 相互独立，任一失败只降级对应能力。启动日志打印池摘要（`total/enabled/subscribed/activeId/bindings/strategy`，不含任何私钥/token）。关闭时依次 `proxy.close()`、`identities.close()`。

### 11.3 Admin API（§5 全量）

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /admin/api/identities` | `{ pool:{total,enabled,subscribed,activeId,bindingCount,maxIdentities}, items:[identitySummary] }`（无 salt/密钥/token） |
| `POST /admin/api/identities` | `{ label?, import? }` → 201 `{ identity }`（import 走 `importIdentity`） |
| `POST /admin/api/identities/generate` | `{ count=1, labelPrefix="分身", subscribed=false }` → `{ items:[identitySummary] }`（1–20） |
| `GET/PATCH/DELETE /admin/api/identities/:id` | 详情/`{label,enabled,subscribed}`/删除；删除被绑定或 active 身份默认 409 `identity_in_use`，`?force=true` 强制并清理绑定 |
| `POST /admin/api/identities/:id/activate` | 设 activeId → `{ ok, pool }` |
| `POST /admin/api/identities/:id/rotate` | `{ scope?: journey\|device\|all }` → `{ ok, identity }` |
| `GET /admin/api/identities/:id/export` | 附件下载 `duckai-pool-identity-<id>-<ts>.json`（含完整私钥/token，仅此接口） |
| `POST/DELETE /admin/api/identities/:id/subscription` | POST `{token}` → `{ ok, identity, subscription }`；DELETE 解除回 free |
| `GET /admin/api/identities/bindings?limit=&offset=&sessionKey=` | `{ items:[{sessionKey,identityId,createdAt,updatedAt}], total }`（limit 上限 500） |
| `POST /admin/api/identities/bindings` | `{ sessionKey, identityId }` 手工绑定 |
| `DELETE /admin/api/identities/bindings/:sessionKey` | 解绑（下次重新路由） |
| `GET /admin/api/identities/routing` | `{ strategy, saltPresent, perIdentity:[{id,label,waiting,inFlight,requests,rps}], totals }` |
| `PATCH /admin/api/identities/router` | `{ strategy:"hash"\|"least-loaded", salt? }`（salt 只影响新绑定） |

- 错误映射：400 `invalid_identity`/`invalid_request`；404 `identity_not_found`；409 `identity_in_use`/`pool_full`；403 `model_requires_subscription`；503 `no_identity_available`/`identity_unavailable`/`identity_pool_unavailable`；429 `queue_full`/`queue_timeout`（带 Retry-After）。
- `/healthz` 新增 `identityPool:{total,enabled,subscribed,busy}`；`/admin/api/overview` 新增 `identities:{pool,items:[...]}`（items 含每身份 `queue:{waiting,inFlight,rps}`）。
- upstream 日志条目新增 `identityId`/`identityLabel`（v1 与 admin-test 会话均记录）。

### 11.4 /v1 路由与测试会话

- sessionKey 优先级：`X-Session-Id` 请求头 → body `session_id`/`sessionId`/`conversation_id`/`conversationId`（含 `metadata.*`）；测试会话用 `session.id`（`sess_xxx`）。
- 有 sessionKey：`identities.routeDetailed(sessionKey,{paidModel})` 命中/新建绑定并**永久固定**；响应头返回 `X-Duckai-Identity-Id`/`X-Duckai-Identity-Label`（SSE 已 flush 时仅日志可见）。
- 无 sessionKey：单轮 least-loaded 路由且**不写绑定**（v2.3 行为）。
- 付费模型：`allowPaidModels=false` 仍按 v2.3 在模型解析阶段 403 `model_requires_subscription`；`allowPaidModels=true` 时只路由 `subscribed` 身份，无候选或绑定身份未订阅 → 403；免费模型不限制。
- 每个身份独立运行时（独立 journeyId/challenge/代理共享）与独立队列（rps=1、maxConcurrent=1）；不同身份并行。`queueWaitMs` 写入 upstream 日志与会话消息。
- 测试会话创建即绑定身份，`session.identityId`/`identityLabel` 在列表、详情与 SSE done 中透出。

### 11.5 上下文守卫（§7）

- 发送前总是按 `context.maxInputChars/maxMessages` 裁剪：保留 system 指令 + **最近**消息（从最新向前累计），至少保留 1 条；`ctx.log.contextTrimmed=true`。
- `/v1/chat/completions` 与 `/v1/responses` 非流式响应附加顶层 `context_trimmed:true`（裁剪时）；测试会话 assistant 消息新增 `contextTrimmed:true`，会话 summary 也有 `contextTrimmed`。
- 上游 `ERR_CONVERSATION_LIMIT`（映射 409 `conversation_limit_reached`）/`ERR_INPUT_LIMIT`（映射 413 `input_limit_reached`）且 `onLimit="trim"` → 以更激进预算（默认一半）重新裁剪并**重试一次**；仍失败按映射返回。`onLimit="error"` 不重试直接 409/413。
- 不实现真正的摘要生成（需要额外模型/额度）：裁剪仅保证可用性，长对话质量由上游 compaction 与用户新开会话决定。

---

## 12. v2.5：并发 / 队列语义（后端确认）

- **每个身份独立队列**：`rps=1`、`maxConcurrent=1`（池内 `IdentityQueue`）；不同身份**并行**，同一身份的并发请求排队（`queueWaitMs`）。
- **绝不双重排队**：命中身份路由时，`ctx.callUpstream` 只调用 `identities.run(identityId, fn)`，**不再进入**全局 `queue`；只有无身份（未注入池 / 无路由）时才使用全局 `queue`（v2.3 行为）。
- `/v1/chat/completions|responses|images` 带 `X-Session-Id`（或 body `session_id`/`conversation_id`）时按 session→identity 路由；无 sessionKey 单轮 least-loaded 不写绑定。
- 测试会话 `POST /admin/api/test/sessions/:id/messages|retry`：命中 `session.identityId` 对应运行时，走该身份队列；不同会话可同时流式。
- **会话锁仅限同会话**：`sessions.beginStream(sessionId)` 是 per-session 集合；同会话并发 → `409 {"error":{"code":"session_busy","type":"invalid_request_error"}}` + `Retry-After: 1` + `X-Duckai-Retriable: true`；不同会话互不影响。
- 响应头：命中身份时 `X-Duckai-Identity-Id`/`X-Duckai-Identity-Label`；有排队等待时（非零）附加 `X-Duckai-Queue-Wait: <ms>`（JSON 与 SSE 响应均适用，向后兼容）。
- SSE：测试会话 `done` 事件顶层带 `identityId/identityLabel/queueWaitMs`，且 `done.message` 也含 `identityId/identityLabel/queueWaitMs/contextTrimmed`；`/v1` upstream 日志带 `identityId/identityLabel/queueWaitMs`。
- 验证（mock，单条上游延迟 300ms）：不同身份两会话并行 ≈336ms、同身份串行 ≈2000ms；`/v1` 不同 X-Session-Id 并行 ≈328ms、同身份 ≈2008ms；同会话并发 409。真实 10808 代理下两会话不同身份各 200（A 7485ms/B 3309ms，均带 identityId/queueWaitMs，未串行）。

---

## 13. v2.5：扫码配对（PairingHost）Admin API

契约：`docs/PAIRING-IMPL.md` §2–§4；host 由 duck-protocol `src/duck/pairing.js` 提供，api-core 只在 Admin 层持有单例并注入 `createServer({ pairing })`。

### 13.1 端点

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /admin/api/sync/pairing` | 启动真实 Sync 频道（`PairingHost.start()`：`PUT sync.duckduckgo.com/sync/v2/exchange/<uuid>`）。成功 → `{ ok:true, channelId, pairingCode, url, qrUrl, expiresAt, state:"waiting", createdAt, accountAvailable, pairing:{...} }`；已有活动会话 → 409 `pairing_in_progress`；sync 未启用 → 400 `sync_not_enabled`；出网失败（network/timeout）→ 503 `sync_transport_unavailable` + hint；其他启动失败 → 502 `pairing_start_failed`（`detail=PairingError.code`）。**必须 start 成功后才展示二维码**。 |
| `GET /admin/api/sync/pairing` | `{ pairing: host.status() }`；无会话 → `{ pairing: null }`。status 字段：`state(waiting\|hello\|exchange\|completed\|failed\|timeout)`、`substate(joiner_awaiting\|awaiting_confirmation\|null)`、`channelId`、`peerChannelId`、`peerName/peerKind/peerUserId`、`recoveryUserId`、`recoveryCodeReceived`、`accountConflict`、`lastSeq`、`messages:[{dir,type,at,seq?,httpStatus?}]`（不含 payload）、`endReason/endDetail`、`completedAs`、`httpStatus`、`startedAt/expiresAt/expiresInMs`、`qrUrl`、`pairingCode`、`accountAvailable`、`syncBase`。**status 永不返回恢复码明文**（落盘只在 onCompleted 内部完成）。 |
| `DELETE /admin/api/sync/pairing` | `host.stop('aborted')` → `{ ok:true, pairing:status }`（无会话 → `pairing:null`）；前端关闭弹窗时必须调用。 |
| `GET /admin/api/sync/official-recovery-code` | `{ officialRecoveryCode:{configured,hasCode,updatedAt,preview,length} }`（**不返回明文/完整 code**）。 |
| `PUT/POST /admin/api/sync/official-recovery-code` | body `{ code }`（或 `recoveryCode`）→ 保存到 `data/pairing.json`（0600，原子写）；返回脱敏状态。**只接受真实 DuckDuckGo 恢复码**，本地 v2.2 扩展 recoveryCode 不可用于官方 App。 |
| `DELETE /admin/api/sync/official-recovery-code` | 清除（之后配对 exchange 阶段会返回 `recovery_code_unavailable`）。 |

- `createServer({ pairing })` 显式注入；pairing 服务缺失 → 端点 503 `pairing_unavailable`。
- `src/index.js` 启动时创建 `PairingStore`（`data/pairing.json`）+ `PairingService`（懒创建 `PairingHost`、单例、`account.getRecoveryCode()` 读该 store、共享 `proxyManager`）；pairing 成功不自动改 `identity.sync`。
- **joiner 模式自动落盘官方恢复码**：手机（leader）走 `recovery_code_response`、host 以 `completedAs:"joiner"` 完成时，`PairingService` 从 `onCompleted(status)` 取 `status.recoveryCode`（兼容 `recovery_code`/`recovery.code`/`payload.recoveryCode`）并原子写入 `data/pairing.json.officialRecoveryCode`；随后 `GET /sync/pairing` 的 `accountAvailable=true`，`GET /sync/official-recovery-code` 变为 `configured:true/hasCode:true/length/preview/updatedAt`（不回显明文），`account.getRecoveryCode()` 返回该码供后续 host 角色 `recovery_code_request` 回 response。解析失败/无 code 不落盘；`POST /sync/pairing` 在 store 无码时仍允许启动（joiner 模式）。
- **恢复码冲突策略**：`status.accountConflict===true` 表示本地已有不同的官方码；默认**不覆盖**已有 `officialRecoveryCode`（warn 日志），仅当 `config.sync.pairing.overwriteAccount=true`（`PUT /admin/api/config` 白名单 `sync.pairing.overwriteAccount`）时覆盖。`status.completedAs==='host'` 时不保存 host 自己的码。
- **pairing 状态字段**：`GET /sync/pairing` 额外返回 `substate`、`recoveryCodeReceived`、`recoveryUserId`、`accountConflict`；`status` 永不包含 `recoveryCode` 明文（仅 `onCompleted` 内部落盘）。
- Proxy 未启用时 host 无法访问 `sync.duckduckgo.com` → POST 返回 503 + hint「enable the outbound proxy in the Proxy page」。
- 真实联调：代理 10808 下 `POST /sync/pairing` **200/934ms**，返回真实 `channelId`（UUIDv4）与可扫码 `code2` URL；`GET` state=waiting、`expiresInMs`；`DELETE` 停止。官方 App 完整账号加入仍需真实 DDG 恢复码（host 已实现频道注册/hello/exchange，缺失恢复码时如实返回 unavailable）。

---

## 14. v2.8：设备名称 / DuckDuckGo Sync 设备注册 / 轮换语义

### 14.1 设备名称（统一）

- 默认 `DuckCPA@<4hex>`（如 `DuckCPA@xxxx`）：首次启动由 `sync-devices.ensureDeviceName()` 生成并持久化到 `data/identity.json` 的 `deviceName`，同时回写 `config.identity.deviceName`；重启/rotate 后保持。
- **旧默认名迁移**：`identity.deviceName` 为空或匹配旧默认（`/^DuckAI CPA/`，含 `DuckAI CPA @ <host>`）时自动重新生成 `DuckCPA@xxxx` 并同时持久化 identity + config；其他自定义名不受影响。
- `deviceName` 在 `GET /admin/api/identity`、`GET /admin/api/sync`、`register-device` 统一使用。
- 自定义：`PUT /admin/api/config { identity: { deviceName: "MyCPA@custom" } }`，立即持久化并用于 `/admin/api/identity`、`/admin/api/sync`、`register-device`；`PUT deviceName:null` 会重新生成 DuckCPA@xxxx。
- `device_id` 始终使用稳定 `identity.deviceId`（同一设备注册不会产生重复条目）。
- 直接 `createServer({ identity, syncDevices })`（不走 index）时，`GET /admin/api/identity` 与 `GET /admin/api/sync` 会懒调用 `ensureDeviceName()` 规范化名称；`register-device` 也会先确保名称。

### 14.2 Sync 服务端设备端点

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /admin/api/sync/register-device` | 用已保存的官方 DuckDuckGo 恢复码 login + `registerDevice({deviceId:identity.deviceId,name:deviceName,type:"browser"})`。成功 200：`{ok:true, serverDevice:{id,name,type,credential_id,jwt_iat,current:true}, devices:[...], server:{...}}`；未配置官方码 → 400 `recovery_code_not_configured`；代理/网络不可用 → 503 `sync_transport_unavailable` + hint；登录/注册失败 → 401 `sync_unauthorized` / 502 `sync_login_failed` / 502 `sync_register_failed`；无效 device → 400 `invalid_device`。 |
| `GET /admin/api/sync/server-devices` | `{ devices:[{id,name,type,credential_id,jwt_iat,current}], currentDeviceId, total, server:{...} }`；本机条目 `current:true` 且 `name` 为 `DuckCPA@xxxx`/自定义名；服务端加密的 `name/type` 不回显（`null`），不返回 token/info 密文。 |
| `DELETE /admin/api/sync/server-devices/:id` | 注销指定设备（`POST /logout-device`），成功 `{ok:true,deletedId,devices}`；删除当前设备 → 400 `invalid_device` + hint。 |
| `GET /admin/api/sync` | 新增 `sync.server = {registered,userId,deviceId,deviceName,serverDeviceId,registeredAt,lastLoginAt,devices,lastError}`（本机设备列表缓存在 `identity.sync.server`，重启保留，可再次 GET 刷新）。 |

- `createServer({ syncDevices })` 显式注入；缺失时设备端点 503 `sync_transport_unavailable`（hint 提示检查 sync-client/代理）。
- **token 复用**：login 成功的 token 仅保存在进程内（不写 identity.json），后续 `register-device/server-devices/delete` 在 token 有效时直接复用，避免每次 GET 都 `/login`；重启后首次操作才重新 login。`GET /sync/server-devices` 优先返回 `identity.sync.server.devices` 缓存（无 live session 时不再触发 login）。
- **418 反滥用限流**：DuckDuckGo Sync 对 `/login` 返回 418 时映射为 **429 `sync_rate_limited`**（`Retry-After` + hint「DuckDuckGo Sync 限流，请稍后重试」），并进入 **2 分钟进程内 cooldown**；cooldown 内设备操作直接 429、不再请求上游。register-device 失败同样返回 429。
- 服务使用 duck-protocol `src/duck/sync-client.js`（懒加载）；`identity.sync.server` 由 api-core 通过 identity 原子写持久化（包含 devices；duck 的 setSyncServer 只存子集）。

### 14.3 joiner 后自动注册

- Pairing joiner 完成并落盘官方恢复码后，`PairingService.onCompleted` 触发 `syncDevices.autoRegister()`：login + registerDevice + 持久化 `identity.sync.server`。**失败只写 warn / `server.lastError`，不影响 pairing completed 状态**；成功后可 `GET /admin/api/sync.server.registered=true`。
- 初始化/手动 `POST register-device` 均先 `ensureDeviceName()`，保证任何路径注册的都是规范名。

### 14.4 轮换语义（identityLost）

- `POST /admin/api/identity/rotate` 与 `POST /admin/api/identities/:id/rotate` 响应新增：`identityLost:true`、`note:"轮换会丢弃当前 journeyId/durableStream 密钥，旧身份无法恢复"`；scope `journey|device|all` 均如此（仍默认执行轮换，不改既有行为）。前端据此二次确认。

---

## 15. v2.9：每身份设备名 / 设备槽位（拖拽保存）/ 默认身份保护

### 15.1 每身份设备名

- `id_default` 默认 **`DuckAI@main`**；其他身份 `DuckCPA@<4hex>`（`create/generate` 时写入各自 identity 记录并持久化）。旧默认名（`DuckAI CPA …`、空）启动迁移：默认身份 → `DuckAI@main`，普通身份 → `DuckCPA@<4hex>`；自定义名保留。
- 全局 `identity.deviceName` 作为**默认身份**名称来源；主 identity 仍由 `sync-devices.ensureDeviceName()` 维护（v2.9 起默认 `DuckAI@main`，旧 DuckCPA@xxxx 自动迁移；自定义名保留）。
- `GET /admin/api/identities` 的 items 含 `deviceId`/`deviceName`；`PATCH /admin/api/identities/:id {deviceName}` 支持自定义（1–100 字符，`pool.setDeviceName`），响应 `{identity}`。
- `DELETE /admin/api/identities/:id`：目标为默认身份（`pool.getDefaultIdentityId()`，通常 `id_default`）→ **409 `default_identity_protected`** + hint「默认身份用于获取手机配对 key」，`?force=true` 同样拒绝；其他身份保持原逻辑（绑定/active→409 identity_in_use，force 可删）。

### 15.2 设备槽位 API

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /admin/api/sync/device-slots` | `{ defaultIdentityId, identityIds, slots:[{identityId,deviceId,deviceName,type:"browser",serverDeviceId,registered,matchedIdentityId}], serverDevices:[{id,name,type,credential_id,jwt_iat,matchedIdentityId}], server:{registered,userId,deviceId,deviceName,...} }`；从未保存时 `identityIds=[defaultIdentityId]`；`registered = serverDevices 中存在 id===deviceId`。 |
| `PUT /admin/api/sync/device-slots` | body `{ identityIds:[...] }`（也兼容直接数组）；校验：数组、去重、所有 id 存在且 `enabled=true`，**必须包含默认身份 id**（v2.10 起；缺省 → 400 `invalid_identity`，§16.3），空数组/缺默认身份均拒绝。增量：未注册的选中身份 → `syncClient.registerDevices([{deviceId,deviceName,type:"browser"}])`（无批量方法时逐个 registerDevice）；已注册但不在新列表 → `logoutDevices([deviceId])`（无批量时逐个 logoutDevice）；成功后持久化 `identity.sync.slots=identityIds`（主 identity 原子写，重启保留）。返回 `{ok,defaultIdentityId,identityIds,slots,serverDevices,server,orphans}`（同 GET）。 |

- 错误：body 非数组/未知 id/禁用身份/重复 → 400 `invalid_identity`；未注入服务 → 503；Sync 418 → 429 `sync_rate_limited`（`hint`+`retryAfterMs`+`Retry-After`，2 分钟进程内 cooldown）；其他登录/注册失败 502/503 沿用 §14。
- `matchedIdentityId` 优先按 server device `id===identity.deviceId` 匹配；其次按解密 `name===identity.deviceName`。
- `GET/POST /admin/api/sync/server-devices` 优先使用 `syncClient.listDevicesDetailed()`：name/type 为解密后的可读值（Android 手机/Chrome），无法解密 → `null`（不返回 JWE/info 原文）；返回项含 `matchedIdentityId`。`POST /admin/api/sync/register-device` 保留（兼容单设备/默认身份）。
- 真实设备槽位顺序：`[id_default, 分身1]` → `DuckAI@main` + `DuckCPA@xxxx` 两台；`[id_default]` → 分身设备被注销；手机 My Devices 名称与槽位一致。
- **真实联调结果（2026-11-01，官方码 + 10808）**：`GET device-slots` 解密出 `Android 手机`（手机，ddg）/Chrome/Edge 等；`PUT [id_default, 分身1]` **200**，两台设备注册成功（`DuckAI@main` + `DuckCPA@xxxx`，均 `matchedIdentityId` 映射正确、serverDeviceId=identity.deviceId）；`PUT [id_default]` **200** 后分身设备注销；`DELETE id_default` 与 `?force=true` 都 **409 default_identity_protected**。
- 真实服务 `PATCH /devices` 只允许更新**当前 login 的 device_id**：duck-protocol `syncClient.registerDevices()` 内部为每个设备单独 login+PATCH（Admin 不感知，直接调用即可）；`forbidden_device` 401 目前表示“用错 token 尝试更新非当前设备”，不要当设备上限映射。

---

## 16. v2.10：设备槽异常处理（删除/禁用保护 + 孤儿自愈）

### 16.1 DELETE /admin/api/identities/:id（在设备槽时）

- 默认身份（`pool.getDefaultIdentityId()`，通常 `id_default`）**优先级最高**：即使 `?force=true` → 409 `default_identity_protected`。
- 非默认身份且 id 在 `identity.sync.slots`（或 serverDevices 的 matchedIdentityId 指向它）：
  - 无 force → **409 `identity_in_device_slots`**，`error.hint="该身份在 DuckDuckGo 设备列表中，请先在设备列表移除后再删除（或使用 ?force=true）"`，并附 **`error.identityId`/`error.deviceName`**；状态不变。
  - `?force=true` → 先 `syncClient.logoutDevices([identity.deviceId])`（失败只 warn/记录 lastError，**不阻塞删除**）→ 从 `identity.sync.slots` 移除并持久化 → `pool.delete(id,{force:true})` → 响应 `{ok:true,id,removedDevice:true}`。
- 删除成功后（无论是否原在 slots）都会执行一次**防御性 slots 清理**，去掉该 id 的所有残留引用。

### 16.2 PATCH /admin/api/identities/:id（禁用保护）

- body `{enabled:false}` 且身份在 slots：
  - 无 force → **409 `identity_in_device_slots`**（同上 `identityId/deviceName/hint`），状态不变；
  - `?force=true` 或 body `{force:true}` → 先注销该设备并移出 slots（失败仅 warn），再 `update(id,{enabled:false})`，响应 `{identity,removedDevice:true}`。
- 其他 PATCH 字段（label/deviceName/subscribed）不受影响。默认身份当前允许被禁用；但默认身份必须保留在 slots 的校验见 §16.3（PUT 不含默认身份会被拒绝）。

### 16.3 GET /admin/api/sync/device-slots（自愈）

- 返回新增 `orphans:[{identityId,deviceId,deviceName,reason:"missing"|"disabled"}]`，并**过滤掉**这些孤儿槽位（`identityIds/slots` 只含有效身份）。
- `?reconcile=true`：对 reason=disabled（有 deviceId）的孤儿执行 best-effort `logoutDevices([deviceId])`，清理 `identity.sync.slots`（持久化），然后重新分类；响应额外带 `reconciled:{loggedOut:[{identityId,deviceId}],cleaned:[identityId]}`。`reason=missing` 的孤儿无 deviceId 可注销，仅清理槽位引用。
- 不自动 reconcile（默认只过滤+返回 orphans），避免误删；由前端显式触发。**`PUT /admin/api/sync/device-slots?reconcile=true` 也触发同一清理**（body 可为空，忽略 identityIds），返回过滤后的 `identityIds/slots`（便于“清理”按钮用 PUT）。
- `PUT /api/sync/device-slots {identityIds}`：数组、去重；包含不存在/禁用身份 → 400 `invalid_identity`；**必须包含默认身份 id**，否则 400 `invalid_identity`（`param:"identityIds"` + hint「默认身份不可从设备列表移除」）。若 `identity.sync.slots` 中已有孤儿/已不存在身份，PUT 会**自愈式丢弃**这些 ghost 槽位（不因 `pool.get` 失败返回 404），随后保存合法列表。

### 16.4 错误码汇总

| 场景 | HTTP | code |
| --- | --- | --- |
| 删除/禁用 identity 在设备槽 | 409 | `identity_in_device_slots`（error.identityId/deviceName/hint） |
| force 删除默认身份 | 409 | `default_identity_protected`（优先于 slots 检查） |
| PUT slots 含未知/禁用/缺默认身份 | 400 | `invalid_identity` |
| Sync 418 反滥用 | 429 | `sync_rate_limited`（hint+retryAfterMs+Retry-After，2 分钟 cooldown） |
| sync-client 未就绪/代理不可用 | 503 | `sync_transport_unavailable` |
| 登录/注册失败 | 502 | `sync_login_failed` / `sync_register_failed` |
| 官方码缺失 | 400 | `recovery_code_not_configured` |

### 16.5 真实联调（2026-11-01，官方码 + 10808）

- 分身 `id_xxxxxxxx`（`DuckCPA@xxxx`）加入 slots（`PUT [id_default, id_xxxxxxxx]` → 200）；
- `DELETE /admin/api/identities/id_xxxxxxxx` → **409**，`error` 顶层 `{code:"identity_in_device_slots", identityId:"id_xxxxxxxx", deviceName:"DuckCPA@xxxx", hint}`，身份未变；
- `DELETE ...?force=true` → **200 `{ok:true,id:"id_xxxxxxxx",removedDevice:true}`**，随后 `GET device-slots` → `identityIds:["id_default"]`、`orphans:[]`，该身份已删除；
- `DELETE /admin/api/identities/id_default?force=true` → **409 `default_identity_protected`**（优先）。

---

## 17. v2.11：上下文压缩（Compact）+ 模型能力元数据

### 17.1 配置

```json
"context": { "maxInputChars":12000, "maxMessages":40, "onLimit":"trim",
  "compact": { "enabled":true, "triggerChars":12000, "keepRecentMessages":6,
               "maxSummaryChars":4000, "model":null } }
```

- 触发条件：历史消息字符数（含 system）> `compact.triggerChars`，或上游 `ERR_CONVERSATION_LIMIT`；`keepRecentMessages` 条最近消息不压缩；`maxSummaryChars` 传给 duck summarizer；`model:null` 用会话/请求模型。
- `PUT /admin/api/config` 白名单含 `context.compact.*`，即时生效（每次请求读 config；无需重启）。`enabled=false` 时退回仅裁剪。
- 摘要 API 使用 duck-protocol `summaryMessages`（原生 `/duckchat/v1/summarize`）；失败**回退**现有裁剪并 warn（日志 `context compaction failed; falling back to trim`）。

### 17.2 摘要结构与会话字段

```json
"summary": { "text":"...", "version":1, "coveredMessageCount":12,
             "coveredPairCount":6, "model":"gpt-6-luna", "updatedAt":1793 }
```

- 测试会话持久化在 `session.summary`（`data/testsessions.json`，重启保留），`GET /admin/api/test/sessions` 列表与详情均透出；`contextTrimmed` 语义保留。
- 构造请求时：摘要作为**初始上下文**并入 system prompt（`[对话摘要]\n...\n[/对话摘要]`；`prompts.mode=inline` 时随系统指令内联，`system` 模式为 system 消息），仅发送最近 `keepRecentMessages` 条 + 当前消息，旧历史不再发送。
- 自动压缩后：SSE `done`（及 assistant message）带 `compacted:true`、`summaryChars`、`coveredMessageCount`（`done.summary` 含完整 summary）；普通 JSON 响应顶层同样带 `compacted/summary_chars/covered_message_count/summary`。
- 上游 `ERR_CONVERSATION_LIMIT` 时优先尝试 compact 后重试一次；compact 失败再用既有的 aggressive trim 重试。
- 手动：`POST /admin/api/test/sessions/:id/compact`（body 可选 `{force?:true}`，实际总是对旧历史重新摘要；不存在 404 `session_not_found`；无旧历史 400 `nothing_to_compact`）→ `{ok:true, summary, summaryChars, coveredMessageCount, session}`。
- `/v1/chat/completions` 带 `X-Session-Id`：使用 `data/chat-summaries.json` 中该 sessionKey 的 summary（自动超阈值时会更新）；请求构造同上并发最近消息；响应顶层带 `compacted/summary_chars/covered_message_count/summary`。无 sessionKey 仍 stateless 裁剪。
- 摘要失败：仅 warn/`ctx.log.compactError`，继续按 `context.maxInputChars/maxMessages` 裁剪并正常响应（不返回 compacted 字段）。

### 17.3 模型能力元数据

`GET /v1/models` 与 `/admin/api/models` 每项新增（字段一致，除 OpenAI 列表额外 `object/owned_by`）：

| 字段 | 说明 |
| --- | --- |
| `context_window` / `max_input_tokens` | 估算 token（`contextWindowChars / 3`，标估算语义） |
| `context_window_chars` / `max_input_chars` | 上游 `inputCharLimit`（默认 16000） |
| `max_output_tokens` | 目录值或默认 4096 |
| `max_output_tokens_estimated` | 是否为估算值 |
| `capabilities` | `{webSearch,imageGeneration,reasoningEfforts,tier,contextWindowChars,maxInputChars,maxOutputTokens,maxOutputTokensEstimated}` |

- 示例 gpt-6-luna：`context_window_chars=16000`、`max_input_tokens≈5333`、`max_output_tokens=4096`、`capabilities.webSearch=true`、`imageGeneration=true`、`reasoningEfforts=['none','low']`、`tier='free'`。
- 所有 token 字段均为估算（非上游精确 usage），文档明确标 estimated。

---

## 18. v2.11：官方恢复码明文查看 + 下载

> ⚠️ 官方 DuckDuckGo 恢复码等同账号密钥：拿到即可登录/同步该账号。只在 admin token 保护的端点返回明文；下载后请妥善保管，勿分享/提交到仓库。

### 18.1 `GET /admin/api/sync/official-recovery-code`

```json
{ "officialRecoveryCode": {
    "configured": true, "hasCode": true,
    "code": "<完整 base64url 官方恢复码>",
    "length": 191, "source": "pairing", "updatedAt": 1793,
    "preview": "eyJy…abcd"
} }
```

- `source:"pairing"` = 手机 joiner 配对自动落盘；`source:"manual"` = `PUT/POST` 手动保存；旧版 `data/pairing.json` 无 source 时按 `pairing` 推断。
- 未配置 → `{configured:false,hasCode:false,code:null,length:0,source:null,...}`。
- **仅此端点与 download 端点返回明文**；`GET /admin/api/sync`、pairing status、server-devices、device-slots、错误响应/日志均不含完整 code（`recoveryCode` 仍为 `{present,preview}` 摘要）。

### 18.2 `GET /admin/api/sync/official-recovery-code/download`

- 响应 `Content-Type: text/plain; charset=utf-8`、`Cache-Control: no-store`，`Content-Disposition: attachment; filename="duckduckgo-official-recovery-code-<ISO ts>.txt"`，body 为完整 code + 末尾换行（`HEAD` 支持）。
- 未配置 → **404 `recovery_code_not_configured`**（hint 提示先扫码/手动保存）。
- 需要 admin token（与其它 `/admin/api/*` 一致，缺失/错误 401）。

### 18.3 前端建议

- 身份页「官方恢复码」卡片：`<code>` 全量可复制（等宽字体、长按选择）、「复制」「下载」按钮；配对 joiner 完成后自动刷新（`GET pairing` 返回 completed 后重新拉取 code）；未配置显示「完成手机扫码或手动粘贴」。
- 页面需明确警示「等同账号密钥，请妥善保管」。

---

## 19. v2.12：compact 触发语义修正（模型白名单 + pair + 服务端提示）

### 19.1 自动压缩触发规则

1. **模型白名单**（`compactionSupported`）：`claude-haiku-4-5`/`claude-haiku-5-5`、`claude-sonnet-4-6`/`claude-sonnet-5-5`、`claude-opus-4-8`/`claude-opus-5-5`、`gpt-5.4-mini`、`gpt-5.6-terra`、`gpt-5.6-sol`。**gpt-6-luna 等非白名单模型绝不自动压缩**（仅手动 compact）。
2. **按 pair 触发**：`activePairs = floor(messages.length / 2)`，`coveredPairCount` 来自已有 summary：
   - 模型提供 `activationTargetPairCount > 0` → `activePairs >= activationTargetPairCount`；
   - 否则 fallback：`activePairs - coveredPairCount >= 4 && activePairs >= 4`。
3. **字符阈值仅安全兜底**：`context.compact.triggerChars` 默认 **200000**（可调大/禁用=0 不检查），不再作为主触发。
4. 触发后由 duck `summarizeMessages`（原生 `/summarize`）生成摘要；`trigger` 记录 `"tokens" | "manual" | "limit" | "chars"`。
5. 手动 `POST /admin/api/test/sessions/:id/compact` 对**任意模型**可用，`trigger:"manual"`，不受白名单/阈值限制。

### 19.2 summary / pendingCompaction 字段

```json
"summary": { "text":"...", "version":2, "coveredMessageCount":14, "coveredPairCount":7,
             "anchorId":"msg_...", "baseCompactionId":null, "trigger":"tokens",
             "savedChars":4200, "tokenThreshold":900, "model":"gpt-5.4-mini", "updatedAt":1793 }
"pendingCompaction": { "baseCoveredPairCount":0, "targetPairCount":7, "thresholdTokens":900,
                       "trigger":"tokens", "updatedAt":1793 }
"summaryInvalid": false
```

- `GET /admin/api/test/sessions` 列表与详情透出 `summary/pendingCompaction/summaryInvalid`；SSE `done` 与 assistant message 透出 `pendingCompaction/summaryInvalid`，并带 `compacted/coveredPairCount/compactTrigger`。
- 服务端 DONE 标记解析：
  - `[SUMMARY_REFRESH_HINT:{...}]`（兼容 URL 编码 JSON）→ `pendingCompaction`；
  - `[SUMMARY_INVALID]` → `summaryInvalid:true`；
  - `[LIMIT_CONVERSATION]`/`ERR_CONVERSATION_LIMIT` → 先 compact 重试一次，失败再 aggressive trim。
  - 标记从可见正文中剥离，不展示给用户。
- 手动 compact/自动摘要成功/编辑 summary 后清空 `pendingCompaction` 与 `summaryInvalid`。

### 19.3 summary 编辑 / 清除

| 方法 & 路径 | 说明 |
| --- | --- |
| `PATCH /admin/api/test/sessions/:id/summary` | body `{text, version?, coveredPairCount?, coveredMessageCount?, anchorId?, savedChars?, tokenThreshold?}`；`text` 非空、≤20000；`trigger` 固定 `manual`；清空 pending/invalid；返回 `{ok,summary,session}`。 |
| `DELETE /admin/api/test/sessions/:id/summary` | 清除压缩：`summary=null`、`pendingCompaction=null`、`summaryInvalid=false`，恢复全量消息；返回 `{ok,cleared:true,summary:null,session}`。 |
| `GET /admin/api/test/sessions/:id` | 含 `summary/pendingCompaction/summaryInvalid`。 |

### 19.4 模型能力 API 新增字段

`GET /v1/models` 与 `/admin/api/models` 一致：
`compaction_supported`（bool）、`activation_target_pair_count`（int，未知 0）、`input_char_limit`（chars）、`context_window_chars`；`capabilities` 内同步 `compactionSupported/activationTargetPairCount/inputCharLimit`。
- gpt-6-luna：`compaction_supported:false`、`activation_target_pair_count:0`、`input_char_limit:16000`。
- gpt-5.4-mini：`compaction_supported:true`、`activation_target_pair_count:0`（无激活值时 fallback 4 pairs）、`input_char_limit:16000`。











---

## 21. v2.15 订阅池（一个订阅绑定多个身份）

订阅以前是 identity 的内嵌 token（`identity.auth`），只能给一个身份用。v2.15 起订阅是一等实体，
存放在 `data/subscriptions.json`（0600），身份通过 `subscriptionId` 引用，因此**一个订阅可以绑定多个身份/设备**。

### 21.1 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/subscriptions` | 列表；每项含 `bindingCount`、`boundIdentities`（不含明文 token） |
| POST | `/admin/api/subscriptions` | `{token, label?}` → `201 {subscription}`；同一 token 重复 → `200 {duplicate:true}` |
| PATCH | `/admin/api/subscriptions/:id` | `{label}` 改名 |
| DELETE | `/admin/api/subscriptions/:id` | 删除订阅；自动解绑所有引用身份 → `{unbound:n}` |
| POST | `/admin/api/subscriptions/:id/verify` | 重新解析 token，刷新 tier/到期/verified（失败 422 `token_invalid`） |
| POST | `/admin/api/identities/:id/subscription` | `{subscriptionId}` 绑定实体；`{token}` 仍兼容旧行为（自动建实体） |
| DELETE | `/admin/api/identities/:id/subscription` | 解绑（订阅实体保留） |

### 21.2 订阅对象（响应形状）

```json
{
  "id": "sub_1a2b3c4d",
  "label": "我的 Plus",
  "email": "user@example.com",
  "tier": "plus",
  "paid": true,
  "entitlements": ["chat"],
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "expired": false,
  "verified": true,
  "verifyError": null,
  "maskedToken": "eyJhbGci…abcdef",
  "tokenHashPrefix": "6f2c1d9a0b3e",
  "bindingCount": 2,
  "boundIdentities": [{ "id": "id_default", "label": "默认身份", "deviceName": "DuckAI@main" }]
}
```

身份列表（`GET /admin/api/identities`）新增字段：`subscriptionId`、`subscriptionLabel`、`subscriptionTier`、
`subscriptionExpiresAt`；`subscribed` 仍表示「付费模型可路由到该身份」。

### 21.3 安全

- 明文 token 只存在于 `data/subscriptions.json`（0600），HTTP 响应只返回脱敏预览与 hash 前缀；
- 删除订阅不会删除身份，只会解绑并让该身份回退 free；
- 付费模型路由仍由 `allowPaidModels` + `subscribed` 控制，与订阅实体绑定无关。

### 21.4 配对状态（v2.15 修复）

`GET /admin/api/sync/pairing` 的 `pairing` 新增：
- `accountMerged`：配对成功后两端已在同一账号（此时 `accountConflict` 恒为 `false`，前端显示成功而不是冲突）；
- `pendingAccount`：本次握手收到但尚未采用的手机账号（`{userId, peerName, receivedAt}`，不含明文码）；
- `currentAccountUserId`：网关当前恢复码所属账号。
- `POST /admin/api/sync/pairing/adopt-account`：显式采用 `pendingAccount`（把网关切到手机账号）。

### 21.5 设备列表主设备

`GET /admin/api/sync/server-devices` 新增 `primaryDeviceId`，每台设备新增 `primary:boolean`
（= 本网关/默认身份注册的设备），前端显示「主设备（本机）」徽章。

---

## 22. v2.16 默认身份页 / Sync & Backup 重设计

### 22.1 标签页
- 「身份」标签页更名为 **默认身份**（路由 `#/identity` 不变，仅标题/导航文案变化）；
- 该页只针对默认身份（`id_default`）；其余身份在「身份池」管理；
- 页内原「DuckDuckGo 订阅」卡片已移除，订阅统一在「订阅」标签页管理。

### 22.2 布局
- `匿名身份`、`Sync & Backup`、`DuckDuckGo 设备列表` 三张卡片在 `xl` 及以上各占**整行**（`xl:col-span-2`）。

### 22.3 Sync 模式（对应 DuckDuckGo 应用内 Sync & Backup / Sync only）
| 模式 | 行为 |
| --- | --- |
| `backup`（默认） | 恢复码加密保存到本机 `data/pairing.json`，重启后仍可同步 |
| `syncOnly` | 仅设备间同步，**恢复码只保存在内存**，重启后需重新配对 |

- `POST /admin/api/sync/mode` `{mode:"backup"|"syncOnly"}`；`GET /admin/api/sync` 的 `sync.mode` 返回当前值；
- 配对服务在 `syncOnly` 下不落盘恢复码（日志 `[pairing] Sync-only mode: recovery code kept in memory only`）。

### 22.4 删除 Sync & Backup 数据
`POST /admin/api/sync/delete-data` `{confirm:true}`（缺失 confirm → 400）等价于 DuckDuckGo 应用内
「Delete Sync & Backup data」：

1. 注销本账号下所有网关注册设备（`/logout-device`，逐台 best-effort）；
2. 清除本机保存的官方恢复码（`pairingStore.clearRecoveryCode()`）；
3. 清空 `identity.sync.server` 缓存与设备槽位，`registered=false`；
4. **保留**匿名身份（journeyId / 指纹 / 私钥）与 API Key，只是不再同步。

响应：`{ok:true, deletedDevices:[...], clearedRecoveryCode:boolean, sync}`。
前端为二次确认弹窗：需在输入框手输 `DELETE` 才可执行（`data-testid=sync-delete-data-dialog`）。

---

## 23. v2.17 更正：Sync With Another Device / Sync This Device Only

> 更正 v2.16 的误解：duck.ai 源码中的 "Sync This Device Only" **不是**「只同步不备份」。
> 它是同步设置向导里的第二个选项，等价于 `signUpForPairing()` → `POST /sync/signup`：
> **为当前设备单独创建一个 DuckDuckGo Sync 备份账号，恢复码由本设备保留**。
> 相对的选项是 "Sync With Another Device"（即现有的扫码配对）。

### 23.1 源码依据（bundle）

| 文案 key | 值 |
| --- | --- |
| `DUCKCHAT_SYNC_NEARBY_TITLE` | "Sync with a nearby device." |
| `DUCKCHAT_SYNC_SETUP_THIS_DEVICE_ONLY` | "Sync This Device Only" |
| `DUCKCHAT_SYNC_SETUP_CONNECTING` | "Connecting"（该按钮 loading 文案） |

账号创建路径：`signUpForPairing()` → 生成 `user_id`/AES secret → `POST /sync/signup`
body `{user_id, hashed_password, credential_id:"3party", keys:[{kid,purpose:"ai_chats",encrypted_with:"3party",encrypted_private_key,public_key}], scope:"ai_chats"}` →
返回 `{token}`，`secret` 作为恢复码交给本设备。

### 23.2 后端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/api/sync/create-own-account` | 「Sync This Device Only」：创建独立账号、保存恢复码（`source:"self"`）、注册 `DuckAI@main`；已存在账号时需 `{confirm:true}`，否则 400 `sync_account_exists` |

- `SyncClient.signup()`：生成 RSA-3072 `ai_chats` key（PKCS#8 DER → JWE，kid `3party`），调用 `/signup`；无 token 时回退 `/login`。
- `GET /admin/api/sync` 新增 `sync.accountSource`：`self`（本机独立账号）/ `pairing`（配对加入）/ `manual`（手动恢复码）/ `null`。
- v2.16 中那个「仅同步（syncOnly）」开关已从 UI 移除（语义错误）；后端 `mode` 字段仅作兼容。
- 「删除 Sync & Backup 数据」保留（`POST /sync/delete-data`，需 `confirm:true`）。

### 23.3 前端

Sync & Backup 卡片底部改为与 duck.ai 一致的「同步方式」区（`data-testid=sync-account-section`）：

- 左侧 **Sync With Another Device** → 生成配对码（现有配对流程）；
- 右侧 **Sync This Device Only** → 「创建本机账号」按钮 + 确认弹窗（替换当前同步账号，不影响匿名身份/API Key/订阅）；
- 上方显示「当前账号：未配置 / 本机独立备份账号 / 已通过配对加入其他设备的账号 / 手动导入的官方恢复码」。

自动化：`npm test` **351/351**（新增 `sync-signup`、`sync-own-account-api`）；`page-check` 在未配置恢复码时自动 SKIP 两个 Sync 依赖用例（22/22）。

### 23.4 修复记录（live 验证）

| 报错 | 原因 | 修复 |
| --- | --- | --- |
| `Invalid $ARG->device_id. Length must be between 8 and 64 chars, was 0.` | duck.ai `PV()` 会在 `/signup` body 里展开 `{device_id, device_name: JWE, device_type: JWE}`，我们最初只发了 keys | signup body 增加 device triple（name/type 用 `scopedPassword`、kid=`3party` 加密） |
| `Invalid $ARG->keys->[0]->public_key->alg. Length must be between 3 and 50 chars, was 0.` | 浏览器 `crypto.subtle.exportKey('jwk')` 会自动带 `alg:"RSA-OAEP-256"`；Node 的 JWK 导出没有 | `public_key` 补 `alg:"RSA-OAEP-256"`、`use:"enc"`、`key_ops:["encrypt"]` |
| `accountSource` 显示 `pairing`/`manual` | `PairingStore` 载入时只保留 manual/pairing，`setRecoveryCode` 也只保留 pairing | 载入与写入都保留 `self`（`Sync This Device Only`） |

**真实结果**（2026-11-02 10:44 EDT）：

```json
{"ok":true,"mode":"own-account","userId":"4f0be20c-37b2-4825-a59f-0ca4a107f080",
 "deviceName":"DuckAI@main","recoveryCodeStored":true,"registered":true}
```

`GET /admin/api/sync` → `accountSource:"self"`、`registered:true`、`server.userId:"4f0be20c…"`；
账号内设备：`8885c837… DuckAI@main (browser, primary:true)`；恢复码已保存（`source:self`，可查看/下载/二维码）。

---

## 24. v2.18 配对日志 / 设备列表按钮化 / 重命名与删除 / 重复设备修复

### 24.1 配对失败原因排查（日志）

2026-11-02 16:04–16:05 两次扫码的真实序列：

```
1) 16:04:21 channel created → hello → out recovery_code_request
   peer has an account; waiting (joiner)
   16:04:32 requesting recovery code (attempt 1)
   16:05:02 session ended {"reason":"timeout","detail":"idle"}     ← 第一次失败：手机未在会话有效期内置入确认
2) 16:05:10 channel created → hello → out recovery_code_request
   16:05:18 recovery_code_response → persisted → completed(joiner) ← 第二次成功
```

第一次超时的原因是**手机端未完成「允许/确认」**，网关 `request` 后等待 30s 无响应即 idle 超时。
（同一时段还有 `account.getRecoveryCode failed`：当时网关尚未配置账号，属预期的“无账号”分支。）

### 24.2 二维码右侧的实时交互记录

配对面板改为两栏：左侧二维码，右侧「配对交互记录」（`data-testid=pairing-message-log`）：
逐条显示 `手机→网关 / 网关→手机` 的消息类型、HTTP 状态与时间，并在底部给出当前阶段提示；
失败时可立刻看出是「手机没回包 / 回包超时 / 协议冲突 / 429」。

### 24.3 设备列表：去掉拖拽，只保留按钮

「DuckDuckGo 设备列表」左右两栏移除了全部 drag & drop：
左栏每行「加入」按钮、右栏每行「移除」按钮，改完点「保存」生效。

### 24.4 设备二级菜单（对齐 DuckDuckGo My Devices）

每行设备改为「⋮」二级菜单（`aria-label="设备操作 <name>"`）：

- **重命名设备**：弹窗修改名称 → `PATCH /admin/api/identities/:id {deviceName}`；
- **从设备列表移除 / 从 DuckDuckGo 删除设备**：沿用注销逻辑（当前设备需 `?force=true`，前端已处理）。

「身份池」表格的设备名列也新增了铅笔图标按钮（`aria-label="重命名设备 <name>"`），点击即可重命名。

### 24.5 重复 DuckAI@main 的根因与修复

DuckDuckGo 手机上出现两个 `DuckAI@main`：

- 根因：网关存在**两份设备身份**——全局 `data/identity.json`（deviceId `8885c837…`）与身份池默认身份
  （deviceId `ad9c87a3…`）。Sync 登录用前者、设备槽注册用后者，于是账号里出现两台同名设备。
- 修复：`syncDevice()` 统一以**身份池默认身份**为准（登录 / 注册 / 当前设备判定 / 删除全部复用），
  并清理了历史遗留的重复设备（已注销 `8885c837…`）。
- 同时修复 `DELETE current device` 判定（原先按全局身份判断，导致“删除当前设备”返回 200）。

实测当前账号（`0a60c83c…`）：`Android 手机 (phone)` + `DuckAI@main (browser, primary)`，各一台。

自动化：`npm test` **351/351**、`build-check` **16/16**、`page-check` **22/22**。

## 25. 模型配置（v2.21）

### 25.1 `GET /admin/api/models/config`

返回每个模型的 duck.ai 默认值、当前覆盖值与生效值（供「模型配置」页面使用）：

```json
{
  "object": "model_config",
  "limits": {
    "context_window_chars": { "min": 256, "max": 200000, "step": 100 },
    "max_input_chars": { "min": 64, "max": 200000, "step": 100 },
    "max_output_tokens": { "min": 16, "max": 131072, "step": 1 }
  },
  "defaults": { "context_window_chars": 20000, "max_input_chars": 19500, "max_output_tokens": 4096, "session_limit_behavior": "new_chat" },
  "items": [
    {
      "id": "gpt-6-luna",
      "name": "GPT-6 Luna",
      "tier": "free",
      "paid": false,
      "compaction_supported": false,
      "session_limit_behavior": "new_chat",
      "defaults": { "context_window_chars": 20000, "max_input_chars": 19500, "input_char_limit": 16000, "max_output_tokens": 4096, "max_output_tokens_estimated": true },
      "override": null,
      "effective": { "context_window_chars": 20000, "max_input_chars": 19500, "max_input_tokens": 6500, "max_output_tokens": 4096, "max_output_tokens_estimated": true, "session_limit_behavior": "new_chat" }
    }
  ]
}
```

### 25.2 `PUT /admin/api/models/config`

整体替换 `config.models.overrides`（`null` 表示恢复默认）：

```json
{
  "overrides": {
    "gpt-6-luna": { "context_window_chars": 32000, "max_input_chars": 30000, "max_output_tokens": 8192 },
    "gpt-5.4-mini": null
  }
}
```

校验（`validateModelOverrides`，`src/openai/models.js`）：

| 情况 | 行为 |
| --- | --- |
| 未知模型 id | **400** `invalid_model_override` |
| 已知字段越界（context 256–200000 / input 64–200000 / output 16–131072） | **400** `invalid_model_override` |
| `session_limit_behavior` 非白名单值 | **400** `invalid_model_override` |
| 同时给出 `context_window_chars` 与 `max_input_chars`，且 input > context | **400** `invalid_model_override` |
| 未知字段（如 `{foo:1}`） | **忽略**（不报错，不落盘） |
| 只给 `max_input_chars`（不给 context） | 接受；不与默认 context(20000) 做关系校验 |
| 空对象 `{}` | 接受，等效于恢复默认 |
| `null` | 恢复该模型默认 |

保存后立即影响 `/v1/models` 与 `/admin/api/models`，无需重启。
存储位置：`data/config.json` → `models.overrides`。
覆盖 `max_output_tokens` 时会把 `max_output_tokens_estimated` 置为 `false`（用户显式设定）。

### 25.3 会话上限与客户端压缩（行为变更）

- 上游 `[LIMIT_CONVERSATION]` / `ERR_CONVERSATION_LIMIT` → 网关返回 **HTTP 409
  `conversation_limit_reached`**（不再自动裁剪重试），并在错误体附 `hint`：
  “请新建会话；或由客户端先调用 `POST /v1/compact` …”。
- 压缩由调用方显式发起：`POST /v1/compact`（见 `docs/API.md` §3.x）。

## 26. 模型工具策略与目录刷新（v2.22–v2.23）

### 26.1 工具策略结构（`config.models.tools`，v2.23）

```json
{
  "models": {
    "tools": {
      "dropUnsupported": true,
      "perModel": { "gpt-6-luna": { "image_generation": false } }
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `dropUnsupported` | **true（默认）= 静默清理**：请求里不可用的 tool 直接丢弃，请求继续（记录到日志 `droppedTools`）；**false = 关闭静默清理**：返回 400 |
| `perModel.<modelId>.<tool>` | 每模型工具开关；只能关闭**上游支持**的 tool（`web_search` / `image_generation`） |

> v2.22 的 `strictUnsupported` 已废弃（语义相反）；PUT 传入会返回 400 并提示改用 `dropUnsupported`。

### 26.2 不可用工具的分类与错误码（仅 dropUnsupported=false 时报错）

| 场景 | reason | HTTP | error.code |
| --- | --- | --- | --- |
| 非网关支持的类型（如 OpenAI `function`） | `unsupported_type` | 400 | `unsupported_tool` |
| 模型不支持该 tool | `model_not_supported` | 400 | `tool_not_supported` |
| 模型配置里被关闭 | `admin_disabled` | 400 | `tool_not_supported` |
| 服务端全局关闭（`config.tools.*`） | `server_disabled` | 400 | `tool_disabled` |

默认（静默清理）下的丢弃结果会写入上游日志条目的 `droppedTools: [{tool, reason}]`。

### 26.3 `GET /admin/api/models/config` 新增字段

每个 item 增加：

```json
{
  "tools": [
    { "name": "web_search", "supported": true, "enabled": true },
    { "name": "image_generation", "supported": false, "enabled": false }
  ],
  "tools_supported": ["web_search"],
  "tools_enabled": ["web_search"],
  "tools_disabled": []
}
```

顶层增加 `drop_unsupported_tool`（布尔，true=静默清理）与 `tool_names`（`["web_search","image_generation"]`）。
**前端只对 `supported:true` 的 tool 渲染开关**，不支持的不显示操作按钮（仅列出名称）。

### 26.4 `PUT /admin/api/models/config` 支持 `tools`

```json
{ "tools": { "dropUnsupported": false, "perModel": { "gpt-6-luna": { "image_generation": false } } } }
```

校验：未知模型、未知 tool、非布尔值、给不支持的模型开启 tool → 400 `invalid_model_override`。
前端保存时只写入 `false`（关闭）覆盖，避免把全量默认值写进配置。

### 26.5 `/v1/models` 的 `tools` 语义变更（BREAKING，v2.22）

- `tools`：**生效**工具（上游支持 ∩ 未被关闭）；
- `tools_supported`：上游支持的全部工具；
- `tools_disabled`：被管理员关闭的工具。

### 26.6 `POST /admin/api/models/config/reset`（v2.23，危险操作）

把模型配置**全部**重置为默认值：`models.overrides = {}`、`models.tools = { dropUnsupported: true, perModel: {} }`。
返回重置后的 `modelConfigPayload`（含 `ok: true`）。前端「模型配置 → 危险 / 高级操作」卡片使用，需二次确认。

### 26.7 `POST /admin/api/models/refresh`

刷新上游能力快照（**不改变模型目录**）：

```json
{
  "ok": true,
  "catalogSource": "static",
  "catalogNote": "模型元数据为内置静态目录（src/duck/models.js），随网关版本更新；duck.ai 没有 /models 端点，/capabilities 只含 flags/实验。",
  "modelCount": 10,
  "capabilities": { "assignments": {}, "experimentEnrollments": [], "experimentStateResets": [] },
  "upstreamVersion": "serp_20261102_162644_ET-...",
  "challengeOk": true,
  "latencyMs": 265,
  "probedAt": 1793686819000
}
```

### 26.8 模型目录的来源与频率（重要）

- 模型列表**不是**从 duck.ai API 拉取的：`src/duck/models.js` 是**内置静态表**，
  随网关版本发布；进程启动时构建一次，**没有定时刷新**。
- duck.ai 侧没有 `/duckchat/v1/models` 端点；`GET /duckchat/v1/capabilities` 只返回
  flags/实验（`assignments/experimentEnrollments/experimentStateResets`），不含模型元数据
  （见 `docs/MODEL-CATALOG-SOURCE.md`）。
- 网关仅在两种时机访问该端点：启动 `init()` 一次、以及 `POST /admin/api/models/refresh`
  （或 health probe）按需一次。**不存在后台轮询**。

### 26.9 前端交互（v2.23）

- **无保存按钮**：所有改动（参数、工具开关、静默清理开关）**防抖 700ms 自动保存**，页头显示
  「修改后自动保存 / 保存中… / 已自动保存 · 时间 / 保存失败」；
- **每个参数行有单独重置按钮**（仅在该字段被覆盖时可点），点一下恢复该字段默认值；
- **「刷新上游能力」按钮**位于「模型覆盖配置」卡片 header 右侧；
- **「危险 / 高级操作」卡片**（页面最底部）：静默清理开关（默认开启）+ 「重置全部模型配置」
  （二次确认后调用 `POST /admin/api/models/config/reset`）。

## 27. 日志下载 / 保留策略 / Token 统计（v2.24）

### 27.1 `GET /admin/api/logs/download?kind=upstream|admin&format=jsonl|csv|json`

附件下载当前缓冲区内的全部日志（受保留策略约束，最多 20,000 条）。

| format | Content-Type | 说明 |
| --- | --- | --- |
| `jsonl`（默认） | `application/x-ndjson` | 一行一条 JSON |
| `csv` | `text/csv` | 固定列；上游日志含 `prompt_tokens/completion_tokens/total_tokens` |
| `json` | `application/json` | `{ kind, exportedAt, total, items[] }` |

响应头：`Content-Disposition: attachment; filename="duckai-cpa-<kind>-logs-<ts>.<ext>"`、`X-Log-Count`。

### 27.2 `GET|PUT /admin/api/logs/retention`

```json
{ "maxEntries": 500, "maxAgeDays": 7, "upstreamCount": 64, "adminCount": 208 }
```

- `maxEntries`：**每类日志**最大条数（10–20000），超出丢最旧；
- `maxAgeDays`：最大保留天数（0–365，**0 = 不按时间淘汰**）；
- `PUT { maxEntries?, maxAgeDays? }`：立即按新策略裁剪一次并写入 `data/config.json` 的
  `logging.maxEntries / logging.maxAgeDays`；响应含 `pruned`（本次清理条数）。
- 非法值 → 400 `invalid_log_retention`。

### 27.3 `GET /admin/api/usage?model=&identityId=`

token 消耗累计（**持久化在 `data/usage.json`，清空日志不影响**）：

```json
{
  "total": { "requests": 3, "prompt_tokens": 13, "completion_tokens": 40, "total_tokens": 53 },
  "byModel": [{ "model": "gpt-6-luna", "requests": 3, "prompt_tokens": 13, "completion_tokens": 40, "total_tokens": 53 }],
  "byIdentity": [
    {
      "identityId": "id_7e9beb2c",
      "identityLabel": "页面槽位 9",
      "requests": 1, "prompt_tokens": 5, "completion_tokens": 24, "total_tokens": 29,
      "byModel": [{ "model": "gpt-6-luna", "requests": 1, "prompt_tokens": 5, "completion_tokens": 24, "total_tokens": 29 }]
    }
  ],
  "filter": { "model": null, "identityId": null },
  "estimated": true,
  "estimation": "chars/4",
  "updatedAt": 1793695513000
}
```

- token 数**全部为估算**（字符数 / 4）；上游若返回 `usage` 会在响应 `usage.upstream` 中透出，但统计仍用估算口径；
- 每个上游日志条目也带 `tokens: { prompt, completion, total, estimated }`；
- `/admin/api/overview` 同步返回 `tokens`（同上结构）与 `logRetention`。

### 27.4 前端（v2.24）

- **日志页**：「下载日志」下拉（上游/面板 × JSONL/CSV/JSON）与「清空日志」按钮移入
  **「请求日志」卡片 header 右侧、Tabs 左边**；页头只保留「刷新」。
- **日志页底部危险卡片**：「最大存储条数」「最大保留天数」+「保存并清理」，保存后立即裁剪并刷新列表。
- **概览页**：新增「Token 消耗总览」卡片 —— 总/输入/输出 tokens + 请求数，模型筛选下拉，
  「按模型」表与「按身份 × 模型」下钻表。

## 28. 订阅「免复制 JWT」登录（v2.25）

源码分析见 `docs/SUBSCRIPTION-LOGIN.md`。核心：订阅 token 依赖 DuckDuckGo 登录 cookie，
Node 侧拿不到；网关用一次性会话 + 书签脚本让已登录浏览器代取 token。

### 28.1 `POST /admin/api/subscriptions/login-session`（admin）

请求 `{ origin? }`（缺省用请求 Host）。响应：

```json
{
  "ok": true,
  "sessionId": "<48 hex>",
  "status": "waiting",
  "createdAt": 1793699000000,
  "expiresAt": 1793699300000,
  "ttlMs": 300000,
  "captureUrl": "http://127.0.0.1:8787/admin/api/subscriptions/capture",
  "relayUrl": "http://127.0.0.1:8787/admin/#/subscriptions?login=<id>",
  "tokenEndpoint": "https://quack.duckduckgo.com/api/auth/v2/token?grant_type=refresh_token&client_id=fb417741-...",
  "bookmarklet": "javascript:...",
  "consoleScript": "(async()=>{...})()",
  "steps": ["..."]
}
```

### 28.2 `GET|DELETE /admin/api/subscriptions/login-session/:id`（admin）

- GET → `{ status: waiting|completed|failed|expired|cancelled, remainingMs, result?, error? }`；
- DELETE → 取消（已完成的会话不会被改写）。

### 28.3 `POST /admin/api/subscriptions/capture`（**public + CORS**）

书签脚本调用，无需 admin token：

```json
{ "sessionId": "<id>", "token": "<access_token>" }
```

- 成功 → 200 `{ ok, duplicate, subscription }`（**不返回明文 token**），会话变 `completed`；
- 会话不存在/过期 → 404 `login_session_not_found`；
- 会话非 waiting（重复提交）→ 409 `login_session_not_pending`；
- token 非法 → 422 `token_invalid`，会话变 `failed`；
- CORS：仅允许 `https://duck.ai` / `https://duckduckgo.com` / `null` / 本机来源，
  不回 `Access-Control-Allow-Credentials`。

### 28.4 安全与限制

| 项 | 说明 |
| --- | --- |
| TTL | 会话 5 分钟；进程内 Map，重启失效 |
| 一次性 | 提交成功后状态变 completed，再次提交 409 |
| 明文 token | 只在服务端与 `data/subscriptions.json`（0600）；接口仅回脱敏视图 |
| 续期 | web 路径只给 access token（JWT，实测 4 小时），过期后需重新点一次书签 |
| 浏览器限制 | Chrome 粘贴 `javascript:` 到地址栏会被剥离 → 必须拖拽书签或用 Console 脚本；公网页面 fetch `127.0.0.1` 受 Local Network Access 限制 → 脚本回退用 `window.open` 打开管理台（hash 携带 token，管理台同源提交后立即清除） |

## 29. 订阅自动续期（v2.27）

### 29.1 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/api/subscriptions/:id/refresh-token` | body `{ refreshToken }`，保存 `ddg_auth_refresh_token`（三段式 JWT） |
| DELETE | `/admin/api/subscriptions/:id/refresh-token` | 关闭自动续期 |
| POST | `/admin/api/subscriptions/:id/refresh?force=true|false` | 立即用 refresh token 换新 access token；`force=false` 且未临近过期时返回 `refreshed:false` |

响应统一为 `{ ok, subscription }`（refresh 端点额外带 `refreshed/rotatedRefreshToken/reason`）。

### 29.2 字段

`GET /admin/api/subscriptions` 的每项新增：

```json
{ "autoRefresh": true, "refreshCount": 3, "refreshedAt": 1793725069348, "refreshError": null }
```

> `refreshToken` 明文只存在服务端 `data/subscriptions.json`（0600），任何接口都不返回。

### 29.3 后台巡检

网关启动后每 5 分钟巡检一次：对 `expiresAt` 在 30 分钟内（或已过期）且保存了 refresh token 的订阅自动续期，
并把新 token 同步到绑定了该订阅的所有身份（`identity.auth` 是快照）。日志：`[subscriptions] access token refreshed`。

### 29.4 删除绑定订阅的身份（v2.27）

`DELETE /admin/api/identities/:id` 在该身份 `subscriptionId` 非空时返回 **409** `identity_has_subscription`：

```json
{ "error": { "code": "identity_has_subscription", "subscriptionId": "sub_x", "subscriptionTier": "pro",
  "hint": "该身份绑定了订阅：请先解绑订阅（相当于在 duck.ai 退出登录）后再删除，或使用 ?force=true 强制解绑并删除" } }
```

`?force=true` 会先解绑（保留订阅实体）再删除。前端「身份池」删除对话框据此提示「解绑订阅并删除」。
## 30. duck.ai 提示词生成器 + 设置页拆分保存（v2.28）

### 30.1 源码依据

duck.ai 的「Customize responses」（模块 66400）把用户选择的定制项拼成一段英文指令，随消息发给模型：
**默认不注入任何系统提示词**；拼接顺序为
`assistantRole → userRole → Refer to me as X. → Refer to yourself as Y. → tone → length → shouldSeekClarity → additionalInstructions`，
最后 `join(" ")`。

本仓库按同一顺序、同一文案实现生成器：`src/duck/prompt.js`，角色措辞从当前 bundle 提取到 `src/duck/duckai-roles.json`
（24 个 assistant role + 6 个 user role，`version` 记录来源）。

### 30.2 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/prompts/duckai` | 选项目录：`tones`(7) / `lengths`(3) / `assistant_roles`(24) / `user_roles`(6) / `clarify_prompt` / 昵称模板 |
| POST | `/admin/api/prompts/duckai/preview` | body `{ customization }` → `{ customization(归一化), prompt, length }` |

### 30.3 配置

```jsonc
prompts: {
  mode: "inline" | "system",        // 注入方式（保持原有语义）
  source: "duckai" | "custom" | "none",  // 提示词来源；缺省时：有自定义提示词→custom，否则 duckai
  defaultSystemPrompt: "",          // source=custom 时使用
  duckai: { tone, length, assistantRole, userRole, shouldSeekClarity, userName, assistantName, additionalInstructions },
  defaults: {}                      // 按模型追加（原有）
}
```

`composeSystemPrompt()` 改为调用 `resolveConfiguredPrompt(config)`：
`duckai` → 生成器文本、`custom` → `defaultSystemPrompt`、`none` → 空。请求级 system/developer 指令仍会追加在后面。

### 30.4 设置页拆分保存（v2.28）

- 设置页 header **不再有按钮**（只显示标题/描述）；
- 4 张卡片各自携带「保存」按钮：队列 / 提示词 / 工具 / 日志，分别 PUT `/admin/api/config` 的
  `upstream` / `prompts` / `tools` / `logging` 段；
- 移除每 5 秒触发的页面重载：设置页不再订阅 `/overview` 轮询（这是此前「抖动」的根因——
  `overviewModels` 每次轮询产生新数组 → `load` 依赖变化 → `setLoading(true)` 闪烁）；
- 默认模型 / 请求超时 / 允许付费模型移到「模型配置」页的「默认模型与超时」卡片（防抖自动保存）。
## 31. 连接测试的身份路由（v2.29）

### 31.1 变更前的问题

`POST /admin/api/test/sessions` 创建会话时就调用 `routeDetailed(sessionId, { paidModel: false })` 绑定身份；
之后发消息即使请求付费模型，绑定也已经是 free 身份 → 403 `model_requires_subscription`。

### 31.2 现在的行为（BREAKING）

1. **创建会话不绑定身份**：`POST /admin/api/test/sessions` 返回的 `session.identityId/identityLabel` 为 `null`；
2. **首次消息请求时路由**：`POST .../messages` 先 `resolveModel()`，按模型是否付费（`isPaidModel`）传 `paidModel` 给
   `ctx.selectIdentity({ sessionKey, paidModel, rebindPaid: true })`；
3. **自动改绑**：`identity-pool.routeDetailed(..., { rebindOnSubscriptionMismatch: true })` 发现已绑定身份不满足付费模型要求时，
   选择订阅身份并把 `sessionKey → identityId` 绑定改过去（返回 `rebound: true` / `reboundFrom`），不再 403；
4. **请求后回填**：路由结果写入 `session.identityId/identityLabel`，SSE `done` 事件带 `identityId/identityLabel`，
   前端在收到 `done` 后更新会话列表与当前会话的身份徽章。

> 直接调用 `/v1/*` 的客户端行为不变：仍遵循「会话已绑定 free 身份 → 付费模型 403」，
> 只有后台连接测试（和手动 compact）启用自动改绑。

### 31.3 实测（真实上游）

| 步骤 | 结果 |
| --- | --- |
| 创建会话 | 201，`identityId=null` |
| 直接发付费模型 `claude-opus-5-5` | 200，助手消息 `model=claude-opus-5-5`，会话身份回填为 `id_default`（pro） |
| 免费模型会话后再发付费模型 | 自动改绑成功（`rebound`），200 |
## 32. 双池路由与会话绑定缓存（v2.30）

### 32.1 双池语义

| 池 | 候选身份 | 说明 |
| --- | --- | --- |
| 付费池 | `enabled && subscribed` | 付费模型只能路由到订阅身份 |
| free 池 | 优先 `enabled && !subscribed`，若池内没有未订阅身份则回退全部 | 免费流量不占用订阅身份额度 |

路由流程（每次请求）：

1. 先按模型判断需要的池：`paidModel = isPaidModel(resolved.id)`；
2. 读取 sessionKey 绑定：
   - 无绑定 → 从目标池选一个身份并**绑定一次**（`binding.tier = paid|free`）；
   - 有绑定且同池 → **直接复用**（刷新 `updatedAt` 滑动 TTL），`rebound:false`；
   - 有绑定但池不匹配（免费会话切付费模型 / 付费会话切回免费模型且存在 free 身份）→ **改绑一次**，
     返回 `rebound:true` + `reboundFrom`。

> v2.30 起 `/v1/*` 也遵循此语义：不再因「已绑定 free 身份 + 付费模型」直接 403，而是改绑到订阅身份；
> 只有**付费池为空**时才返回 403 `model_requires_subscription`。

### 32.2 会话绑定 = 缓存（TTL）

- 绑定结构：`{ identityId, createdAt, updatedAt, tier }`；
- `config.pool.bindingTtlDays`（默认 **7**，范围 0–365，0 = 永不过期）：超过该天数**未被使用**的绑定会被自动移除，
  下次请求重新路由；
- 清理时机：启动时、每次路由前（轻量）、以及后台每 **10 分钟**定时巡检；
- 管理 API：
  - `GET /admin/api/identities/settings` → `{ bindingTtlDays, bindingsTotal, strategy }`
  - `PUT /admin/api/identities/settings` ← `{ bindingTtlDays: 0..365 }`（写回 `config.pool.bindingTtlDays` 并持久化）
  - `GET /admin/api/identities/bindings?limit=&offset=` 的每项新增 `tier` 字段；
- 管理页：「身份池」→「会话绑定缓存」卡片修改天数，保存后立即生效。

### 32.3 管理页分页

「身份池 → 会话绑定」表格分页，**默认每页 5 行**；筛选框变化时回到第 1 页。
## 33. SQLite 存储、身份额度和会话历史（v2.31）

### 33.1 存储迁移

列表型数据改为 **SQLite**（Node 24 内置 `node:sqlite`，文件 `data/duckai.db`，WAL 模式）：

| 表 | 用途 | 原文件（首次启动自动导入，之后不再写回） |
| --- | --- | --- |
| `identities` | 身份池身份（整条记录 JSON + 常用列） | `data/identity-pool.json` |
| `bindings` | sessionKey → 身份绑定（含 `tier=paid|free`、`updated_at`） | 同上（bindings 部分） |
| `pool_meta` | salt / activeId / 路由策略 | 同上 |
| `subscriptions` | 订阅实体（token 等仍只在服务端） | `data/subscriptions.json` |
| `logs` | 上游 / 后台日志（按 kind 分离，支持条数/天数裁剪） | `data/logs.json` |
| `usage_events` | token 用量明细（按模型/身份聚合） | `data/usage.json` |
| `history` | 会话历史（只读展示） | 新增 |

`data/identity-pool.json` 等旧文件仍会写一份快照用于人工查看/回滚；读取以 SQLite 为准。

### 33.2 身份额度（付费身份）

源码依据：duck.ai「Settings → Usage」读取的是 `GET /duckchat/v1/status` 响应里的
`fixedCostWindowUsage.windows`（窗口 id：`six_hours` / `day` / `iso_week` / `month`，字段
`percentUsed` / `resetAt` / `isBlocked` / `isBypassable`）。**匿名/free 身份该字段缺失**，所以 free 身份不显示额度。

`GET /admin/api/identities/usage`（60 秒缓存，`?refresh=1` 强制刷新）：

```json
{ "ok": true, "items": [
  { "identityId": "id_default", "supported": true,
    "windows": [{ "id": "day", "label": "每日限额", "percentUsed": 35.2, "resetAt": "2026-11-04T00:00:00.000Z" }] },
  { "identityId": "id_xxx", "supported": false, "reason": "free_identity", "windows": [] }
] }
```

身份池表格在「订阅」列下方渲染进度条（每日/每周），free 身份不显示。

### 33.3 会话历史

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/history?limit=&identityId=` | 按身份分组（组内按 `updatedAt` 倒序） |
| GET | `/admin/api/history/:id` | 单条详情：system prompt + 消息（role/content/ts） |
| DELETE | `/admin/api/history/:id` | 删除单条记录 |

记录时机：`/v1/chat/completions` 成功（流式/非流式）与后台连接测试成功时，把「最终发送给上游的消息 + 助手回复」
按 `(identityId, sessionKey)` 合并写入；没有 sessionKey 时用消息前两条的 hash 生成。

保留策略：`config.history.retentionDays`（默认 **30**，0=不清理，范围 0–3650）；网关每 30 分钟清理一次
「超过该天数未更新」的会话；管理页「会话历史 → 保留策略」可改。

### 33.4 连接测试批量删除

`POST /admin/api/test/sessions/bulk-delete` ← `{ ids: string[] }` → `{ deleted, missing, deletedCount }`；
前端会话列表支持复选框、全选和批量删除对话框。
## 34. 额度冷却（身份临时禁用，v2.32）

### 34.1 触发

上游返回 `ERR_USER_LIMIT`（`[LIMIT_ENTITY]`，free 身份每日额度）或 `ERR_ACCOUNT_LIMIT`（`[LIMIT_ACCOUNT]`）时，
网关给**当前路由身份**写冷却：

```
cooldownUntil = windows(isBlocked).resetAt ?? 最近未来 resetAt ?? now + pool.quotaCooldownMinutes
cooldownScope = entity | account
```

配置：`config.pool.quotaCooldownMinutes`（默认 **1440** 分钟，仅在上游未给 resetAt 时兜底）。

### 34.2 路由行为

- 冷却身份**不参与**新请求/新会话的路由（`_candidates` 排除）；
- **已存在的会话绑定不会被提前解绑**；
- 若某个绑定到冷却身份的会话**收到请求**，该请求按需改绑到同池的其他可用身份并**持久化**新绑定；
- 如果该会话在额度恢复前都没有被调用，则恢复后仍使用原身份；
- 所有可用身份都在冷却 → `429 all_identities_cooling`，带 `retryAfterMs`（最近恢复时间）。

### 34.3 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/api/identities` | 每项新增 `cooling` / `cooldownUntil` / `cooldownReason` / `cooldownScope` |
| DELETE | `/admin/api/identities/:id/cooldown` | 手动解除冷却 → `{ok, identityId, cleared, previousUntil}` |

管理页「身份池」：冷却身份显示红色「额度冷却」徽章与「额度冷却至 …」时间，操作列提供「解除冷却」。
## 35. 日志可追溯与会话历史补全（v2.33）

### 35.1 日志字段

`GET /admin/api/logs?kind=upstream` 的每项新增（并在「日志 → 请求日志」表格显示为「会话 / 身份」列）：

| 字段 | 说明 |
| --- | --- |
| `sessionKey` | 会话标识：`/v1/*` 取 `X-Session-Id`（或 body 的 session_id / conversation_id）；连接测试取测试会话 id |
| `identityId` / `identityLabel` | 该请求实际路由到的身份 |
| `requestId` | 网关请求 id（同 `X-Request-Id` 响应头），用于判断「一次请求是否真的被调用了两次」 |

### 35.2 一次 HTTP 请求 = 一次上游调用

`/v1/chat/completions` 与 `/v1/responses` 每条 HTTP 请求只会调用一次 upstream（`ctx.callUpstream` 唯一调用点），
日志按「请求结束」记录一次。若日志里出现两条相同 endpoint 的记录，它们是**两个不同的 HTTP 请求**（用 `requestId` 区分）。

### 35.3 `/v1/responses` 写入会话历史

此前只有 `/v1/chat/completions` 记录历史；v2.33 起 `/v1/responses`（流式与非流式）也会写入 `history` 表，
按 `(identityId, sessionKey)` 合并，可在「会话历史」页查看。
## 37. 定位开关与会话历史工具记录（v2.36）

### 37.1 tools.location（默认 false）

| 路径 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tools.location` | boolean | **false** | 是否允许上游使用「大致位置」（user-location / LocationPrompt） |

- 对应 duck.ai 的「Use Approximate Location」设置与请求体 `canUseApproxLocation`；
- 关闭时：初始请求发送 `canUseApproxLocation: false`（与浏览器关闭设置一致，不再触发 LocationPrompt）；若上游仍发起 LocationPrompt 审批，
  网关以 `approved:false` + `canUseApproxLocation:false` 拒绝（与浏览器「请勿使用」等价），
  模型会改用不含定位的回答（例如反问城市），不会报 502；
- 开启时：初始发送 `null`（允许上游询问），审批自动批准后 `canUseApproxLocation:true` 并携带位置继续；
- 管理页「设置 → 工具」新增开关（`data-testid="settings-tool-location"`），保存走 `PUT /admin/api/config`。

### 37.2 会话历史记录工具调用与图片

`history` 表的 `messages_json` 现在除 `role/content/ts` 外还保存：

| 字段 | 说明 |
| --- | --- |
| `toolCalls[]` | `{name, callId?, args?, result?}`，含 `WebSearch`、`LocationPrompt`（已批准/已拒绝）、`GenerateImage` |
| `images[]` | `{b64, format, model?}`，最多 4 张，单张 ≤ 6MB base64 |
| `reasoning` | 思考过程（≤20000 字符） |
| `sources[]` | 搜索来源 `{url, title?}`（≤20 条） |

「会话历史」页据此渲染：工具调用徽章（位置调用 / 图片生成 / 联网搜索，可展开参数与结果）、
生成图片（data URI 直接回放）、思考过程折叠块、来源链接。
有生成图片但上游没有给 GenerateImage 工具帧时，网关会自动补一条「图片生成」记录。
## 38. 网关级 function calling 与 MCP 工具（v2.39，**v2.42 已移除**）

> v2.42 删除旧 functionCalling/MCP；v2.44 以 **client 模式工具桥** 重新支持 `tools[].function`（`tools.clientFunctionCalling.enabled`，默认 true），两种协议自动转换；仍不提供 MCP/auto 执行。保留内置工具 `tools.webSearch` / `tools.imageGeneration` / `tools.location`。
## 39. 会话存储统一到 SQLite 与 session id 展示（v2.40）

### 39.1 存储

| 数据 | SQLite 表 | 旧 JSON（仅首启导入，不再写入） |
| --- | --- | --- |
| 连接测试会话 | `test_sessions(id, updated_at, data_json)` | `testsessions.json` |
| 压缩摘要 | `chat_summaries(session_key, updated_at, data_json)` | `chat-summaries.json` |
| 运行统计 | `meta`（`stats.upstream` / `stats.admin`） | `stats.json` |
| managed API keys | `meta`（`keys.managed`） | `keys.json` |
| 身份池/绑定/订阅/日志/用量/历史 | identities/bindings/subscriptions/logs/usage_events/history | identity-pool.json / subscriptions.json / logs.json / usage.json |

仍保留的 JSON：`data/config.json`（运行配置）、`data/identity.json`（全局身份密钥）、`data/pairing.json`（恢复码，最高敏感）。

### 39.2 session id 展示

- 连接测试：选中会话 header 与左侧列表都展示完整 `sess_xxx`，可一键复制（`data-testid=active-session-id`）；
- 会话历史：详情 header 与列表项展示 `sessionKey`（`history-session-id`）；直接 `/v1/*` 未带 `X-Session-Id` 的请求为 `auto:<hash>`。

### 39.3 `/v1/responses` 生图兼容

- 输出：只有图片时补 `message` item + `output_text`（避免客户端显示空消息）；`image_generation_call.result` 仍是 base64。
- 输入：下一轮 input 里的 `image_generation_call` item 会被接受并转成 assistant 占位文本（`[image_generation_call] 已生成图片（base64 已省略）`），不再 400。
## 40. 客户端工具桥与图片输入（v2.44）

### 40.1 客户端工具配置

| 路径 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tools.clientFunctionCalling.enabled` | boolean | true | 是否接受 OpenAI `tools[].function`（Completions/Responses 自动转换；仅 client 模式） |

### 40.2 协议行为

- 两种 tools 形状自动归一化，无需维护工具白名单；
- Chat：`message.tool_calls` + `finish_reason:"tool_calls"`；Responses：`function_call` output item；
- 回传：chat `role:"tool"`；responses `function_call_output`；
- 流式：chat `delta.tool_calls`；responses `response.function_call_arguments.delta/done`；
- 网关不执行工具、不接 MCP；`/v1/responses` 的 `image_generation_call` 回放保留真实图片；
- **稳定前缀**：工具协议注入第一条 user（不是最后一条），保证历史消息逐字节不变、上游 prefix cache 可复用；
  压缩摘要/context-guard 裁剪会改变前缀。

### 40.3 图片处理

- 上游仅接受 PNG/WebP；JPEG 会返回 400 `ERR_BAD_REQUEST`（sc22）；
- 网关统一转 PNG 并缩到 512px（`src/duck/image-convert.js`，jpeg-js/pngjs 纯 JS）；
- 图片上下文通过真实 image part 回传，不再使用文本占位。
## 41. 服务端会话 / response chaining（v2.47）

### 41.1 配置

| 路径 | 默认 | 说明 |
| --- | --- | --- |
| `responses.enabled` | true | Responses `previous_response_id` 存储 |
| `responses.retentionDays` | 7 | response 记录保留天数（0=不过期） |
| `conversations.mode` | stateless | Chat Completions 服务端会话模式：`stateless` / `auto` / `server` |
| `conversations.retentionDays` | 7 | 会话状态保留天数 |

### 41.2 Chat Completions 服务端会话

- 显式开启：config `conversations.mode=server`，或请求头 `X-Conversation-Mode: server`；
- 身份/会话标识：`X-Session-Id`（或 body `session_id` / `conversation_id`）；
- 只发新消息：`X-Conversation-Delta: true`；
- 历史前缀不一致：409 `conversation_session_conflict`；
- 响应头返回 `X-Session-Id`；
- 默认 stateless，避免影响已有客户端。

### 41.3 存储与一致性

- `responses` 表：response 链（canonical + 精确 upstream 前缀 + output + toolsHash）；
- `conversation_state` 表：Chat Completions 会话（同结构）；
- 精确前缀复用：旧消息逐字节不变；工具协议/图片压缩只处理一次；
- 工具列表或 system prompt 变化时按 canonical 重建（cache miss 可接受）。
## 42. 提示词注入可观测与上游调试视图（v2.48）

### 42.1 会话历史注入元数据

`GET /admin/api/history/:id` 的 `item.injection`：

```json
{
  "injected": true,
  "clientTools": ["read_file"],
  "protocolText": "[工具调用协议]…",
  "firstUserContent": "原始用户问题\n\n[工具调用协议]…",
  "upstreamMessageCount": 3,
  "chain": "prefix-reuse",
  "at": 1790000000000
}
```

- 注入文本只保存在 `history.injection_json`，不污染 `messages_json`；
- 历史详情页会显示完整 `protocolText` / `firstUserContent`（可折叠）。

### 42.2 上游请求调试视图

`GET /admin/api/history/:id/upstream`：

```json
{
  "ok": true,
  "sessionKey": "sess_xxx",
  "source": "conversation_state | response | null",
  "updatedAt": 1790000000000,
  "messageCount": 3,
  "injection": { ... },
  "messages": [ /* 真实 upstream messages，已脱敏 */ ]
}
```

- 图片 data URL 替换为 `[image data image/png, N chars]`；字符串超过 20000 字符截断；
- 仅本地管理 API（admin token）可访问，用于排查注入/图片/工具历史。

### 42.3 日志字段

upstream 日志新增：`clientTools`、`protocolInjected`、`upstreamMessageCount`、`conversationChain`。

### 42.4 手动压缩

`POST /v1/compact` 会把 `assistant.tool_calls` 编码为 `[tool_call] …`、`role:"tool"` 编码为 `[tool_result] …` 后再摘要，
不再丢失工具轨迹；图片以 `[图片 xN]` 标记。
## 43. PDF 上下文溢出（v2.49）

### 43.1 配置

| 路径 | 默认 | 说明 |
| --- | --- | --- |
| `context.pdfSpill.enabled` | true | 启用自动 PDF 溢出（替代自动摘要压缩） |
| `context.pdfSpill.inputCharLimit` | 20000 | 超过该字符数才移动历史到 PDF |
| `context.pdfSpill.maxPages` | 15 | 单 context PDF 页数上限（Free 实测 15） |

### 43.1.1 双 PDF 与会话复用

- `client-tools.pdf`：客户端工具说明，1 页；
- `conversation-context.pdf`：历史上下文，≤15 页；
- 同一会话（session id / previous_response_id / 首条 user 哈希）复用 `context_pdfs` 中的 context PDF，不每轮生成；
- 手动 `/v1/compact` 也会生成新的 context PDF，并在响应中返回 `context_pdf` 元数据。

### 43.2 行为

- 计算本次文本字符（含 system / 工具协议）；≤ 阈值不处理；
- 超过阈值：历史消息 → PDF（250 行/页），当前 user 保留文本 + `file` part；
- 图片嵌入 PDF；PDF 文本/图片计入 token 估算；
- 超过 15 页：413 `context_pdf_capacity_exceeded`（不静默截断）；
- 手动 `/v1/compact` 不受影响，仍是摘要压缩。

### 43.3 依赖

`pdf-lib` + `@pdf-lib/fontkit`（PDF 生成/图片嵌入）、`gpt-tokenizer`（token 估算）；
CJK 字体默认 Windows `simhei.ttf`，可用 `DUCKAI_PDF_FONT` 覆盖。

---

## 44. 会话 canonical 状态 + Codex 手动压缩 PDF（v2.51）

### 44.1 稳定 session

- 解析优先级：`X-Session-Id` → `conversation_id/session_id` → `prompt_cache_key` → `previous_response_id` → 首条 user 稳定哈希。
- Codex 手动压缩会话通常没有 X-Session-Id，**使用 `prompt_cache_key` UUID 作为 session key**；同一会话压缩后不换 key。
- canonical 会话状态持久化在 SQLite `conversation_state`：
  `session_key / model / mode / system_prompt / canonical_json / upstream_json / tools_hash
   / compression_json / context_pdf_scope / compacted_at / updated_at / expires_at`。
  - `canonical_json`：当前压缩后的 OpenAI 级对话（旧对话不再保留）；
  - `upstream_json`：发给 duck 的精确前缀（含 PDF file parts，供 prefix cache 复用）；
  - `compression_json`：`{trigger:'manual', summaryHash, summaryChars, summaryText, coveredMessageCount, hotMessageCount, contextPdf:{filename,pages,bytes}, contextPdfScope, reused, createdAt}`。

### 44.2 Codex 手动压缩 marker（chat + responses 双链路）

Marker 文本（role=user，位于旧历史之后、新 user 之前）：
`Another language model started to solve this problem and produced a summary of its thinking process.`

处理（v2.57 真正压缩）：
1. `before` = marker 之前的旧 user/assistant 消息；`summary` = marker 摘要消息；
2. **只把 summary 写入 conversation-context.pdf**（不含旧对话；≤15 页，超限 413 `context_pdf_capacity_exceeded`），写入 `context_pdfs`（scope = session，覆盖旧完整上下文 PDF）；
3. `hot = marker 之后的消息（含当前 user）`；摘要只进 PDF，不再作为普通 user 文本；upstream 只发送 hot + PDF file parts；
4. 有 client tools 时同时生成/附带 **client-tools.pdf**；
5. canonical 更新为 hot（+ assistant），历史记录使用压缩后视图：旧 user / marker 摘要都不在 `messages` 文本中；`files[].text` 保存 PDF 文本（context PDF 为摘要文本，≤200k），供前端 chip 弹窗查看；
6. 同一 session + 相同 `summaryHash` 直接复用已有 context PDF（`compression.reused=true`），不重复生成；只有新的摘要 hash / 新压缩才更新；
7. `/v1/responses` 使用 canonical/previous_response_id 链时同样检测 marker；后续轮次复用已持久化的 PDF（不得每轮重建）。

### 44.3 日志与可观测

- `ctx.log.manualCompaction = true`，`ctx.log.compression = {trigger,summaryHash,coveredMessageCount,contextPdf,reused}`；
- 历史 `injection_json` 增加 `compression`，前端可显示「已压缩 · 覆盖 N 条 · 复用/新建 PDF」；
- `history` 的 user 消息 `files` 保留 `{filename,mimeType,pages,bytes,textChars,text}`（text ≤200k；context PDF 只含摘要文本，client-tools PDF 含协议全文）。

---

## 45. 真正压缩 vs 自动溢出（v2.57）

| 路径 | context PDF 内容 | hot/text |
| --- | --- | --- |
| **自动溢出**（文本 > `context.pdfSpill.inputCharLimit`，默认 20000） | **完整旧上下文**（保持现状，用于绕过字符限制） | 当前 user 保留文本 + PDF file parts |
| **Codex 手动 marker** | **仅摘要**（marker 摘要文本；覆盖旧同 session scope PDF） | marker 之后消息（含当前 user）；旧对话与摘要都不进文本 |
| **`POST /v1/compact`** | **仅 `summary.text`**（覆盖旧同 session scope PDF） | 返回 `summary` + `kept_messages`，客户端用摘要/最近消息继续 |

- 摘要 PDF 的 scope 固定为 session（`pdfScopeKey({kind:'chat',sessionKey})`），不带 messages 哈希，保证同一 session 覆盖旧完整上下文 PDF。
- `/v1/compact` 生成摘要 PDF 后同步持久化 `conversation_state`：
  `mode='compact'`、`canonical`=kept_messages、`compression={trigger:'compact',summaryHash,summaryChars,summaryText,coveredMessageCount,hotMessageCount,contextPdf,contextPdfScope,reused,createdAt}`、`context_pdf_scope`、`compacted_at`；后续请求可复用摘要 PDF。
- 手动 marker / `/v1/compact` 的 `conversation-context.pdf` **不再包含旧对话全文**；历史 chip 的 `files[].text` 保存摘要文本（不是旧完整上下文）。
- auto spill 逻辑不变（完整上下文 PDF）；`context_pdf_capacity_exceeded` 仍为 413。
