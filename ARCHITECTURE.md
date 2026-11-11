# DuckAI CPA — 项目架构与协作规范

> 本项目里的 **CPA** 指「类似 CPA2API 的网页版 AI → OpenAI 兼容 API 网关」：
> 把 **duck.ai** 的网页聊天能力包装成标准 OpenAI 接口，供 SDK / 客户端直接调用。
> 目标不是爬虫，而是**协议适配层**：会话管理、反爬挑战求解、SSE 解析、参数映射、工具映射、后台管理。

> ## ⚠️ v2 重构（2026-11-01，BREAKING）
> 用户要求大版本重构、**不保留兼容**。v2 契约唯一来源：**[`docs/ADMIN_API_V2.md`](docs/ADMIN_API_V2.md)**。要点：
> 1. `/v1/*` **强制 API Key**（启动自动生成 default key）；`/admin/api/*` 强制 admin token；
> 2. 所有上游调用统一 **RPS 队列**（`config.upstream.rps`，默认 1 = 同时仅 1 个上游请求，其余排队）；
> 3. 日志/统计按 **上游请求 vs 后台 API** 拆分；`GET/DELETE /admin/api/logs?kind=`；
> 4. 模型区分 **免费 / 付费**（付费默认 403 `model_requires_subscription`，`duck.allowPaidModels` 控制）；
> 5. 连接测试改为**会话式连续对话**（`/admin/api/test/sessions`，旧单次测试删除）；
> 6. 上游**严格校验**：任何环节不符预期立即中断（`upstream_protocol_mismatch` 等），不继续后续步骤；
> 7. 管理后台用 **React + shadcn** 重构（`webapp/` → `npm run build:web` → `web/`），左侧控制台风格；
> 8. 本文件 §1–§8 为 v1 设计背景，v2 冲突处以 `docs/ADMIN_API_V2.md` 为准。
>
> ## v2.2（稳定身份 / Sync & Backup / 订阅）
> - 身份持久化到 data/identity.json：journeyId(32hex)、deviceId、stable conversationId、RSA-OAEP-256 密钥对与指纹；**重启不漂移**。
> - durableStream 默认开启（上游接受本实现 JWK；被 400 时自动降级并计数）。
> - 控制页 #/identity：匿名身份 / Sync & Backup（本地密钥、恢复码、v2 配对码；当前环境 duckduckgo.com 不可达时 503 提示）/ DuckDuckGo 订阅（粘贴 token 激活、tier/email/exp、注销）。
> - 契约见 docs/IDENTITY-SYNC.md，源码分析见 docs/IDENTITY-RESEARCH.md。

---

## 1. 交付目标（验收口径）

一个可运行的 Node.js 服务（默认 `http://127.0.0.1:8787`），提供：

| 能力 | 接口 | 说明 |
| --- | --- | --- |
| 模型列表 | `GET /v1/models` | 暴露 duck.ai 模型目录（OpenAI 格式） |
| 对话补全 | `POST /v1/chat/completions` | 支持 `stream:true/false`，真实打到 duck.ai |
| Responses API | `POST /v1/responses` | OpenAI Responses 协议，含流式事件 `response.*` |
| 图片生成 | `POST /v1/images/generations` | 走 duck.ai 图片生成能力，返回 `b64_json`（可选 `url` 用 data URL） |
| 思考强度 | 参数 `reasoning_effort` | none/minimal/low/medium/high → duck.ai `reasoningEffort` |
| 自定义 prompt | `instructions` / system / developer 消息 + 网关默认提示词 | 组合后发送到 duck.ai |
| 联网搜索 | `tools:[{"type":"web_search"}]`（Responses）/ `web_search:true`（chat） | 触发 duck.ai WebSearch，返回 `url_citation` 注解 |
| 管理后台 | `/admin` | 连接测试、配置、API Key、请求日志、用量统计 |
| 健康检查 | `GET /healthz` | 上游挑战状态、版本信息 |

**验收标准**：本机 `node src/index.js` 启动后，用 `curl` 或 OpenAI SDK 能完成：
1. `GET /v1/models` 返回 `gpt-6-luna` 等模型；
2. 非流式 + 流式对话均返回真实模型输出；
3. `reasoning_effort:"low"` 被上游接受并体现在请求体；
4. 带 `web_search` 的响应包含搜索来源（citations）；
5. `/v1/images/generations` 返回 base64 图片；
6. `/admin` 页面可打开并展示统计；
7. `npm test` 通过（单元 + mock 集成），`npm run smoke` 可选真实上游冒烟。

---

## 2. 上游协议（已侦察结论，2026-11-01）

Base URL：`https://duck.ai`，全部同源、无登录（匿名 `public` 档位）。

### 2.1 关键端点

- `GET /duckchat/v1/capabilities` → `{accessLevel, flags, experimentEnrollments}`
- `GET /duckchat/v1/status` → `{status:"0", ...}`
- `GET /duckchat/v1/auth/token` → `{}`（匿名无需 token）
- `POST /duckchat/v1/chat` → **SSE** 流式回复（核心）
- `GET /country.json` → `{country:"DE"}` 等

### 2.2 反爬挑战 `x-vqd-hash-1`（核心难点）

流程（已验证）：
1. `GET /duckchat/v1/status`，请求头带：
   - `x-vqd-accept: 1`
   - `x-vqd-hash-1: initial`
   - `x-fe-version: <data-version-tag>-<data-version-sha>`（从首页 HTML 的 `<html data-version-tag=... data-version-sha=...>` 读取）
   - （可选）`x-fe-signals: base64(JSON{start,events:[],end})`
2. 响应头 `x-vqd-hash-1` 返回 **base64 编码的混淆 JS 函数**。
3. 在**仿真 duck.ai 页面**（`#jsa` iframe，见 §2.2 第 9 条）内执行该 JS（原始页面把它注入 `#jsa` iframe 执行），得到对象：
   `{server_hashes:[...], client_hashes:[...strings...], signals:{}, meta:{v:"4",challenge_id,timestamp,debug}}`
4. 对每个 `client_hashes` 字符串做 `SHA-256(UTF-8)` 再 base64；再补 `meta.origin="https://duck.ai"`、
   `meta.stack`（Error 栈前 5 帧文本）、`meta.duration`（毫秒字符串）。
5. `btoa(JSON.stringify(结果))` 即下一次请求的 `x-vqd-hash-1` 值。
6. **滚动使用**：每个 `/duckchat/v1/chat` 响应头都会下发新挑战；下一次请求必须优先使用这个新挑战（已实测：
   连续多轮对话 / 搜索 / 图片全程复用滚动挑战均 200）。若某次请求前没有"上一响应挑战"，才回退到步骤 1 重新获取。
7. 首个请求的挑战来自步骤 1；`/chat` 直接 `initial` 会 418 `ERR_CHALLENGE`。
8. 请求头必须带 `x-duckai-client-tools: {"version":1,"capabilities":[]}`（JSON 字符串），否则带 `durableStream` 会 400、
   不带会 418。加上后实测 200。
9. **v2.62 关键（2026-11-06）**：挑战每次随机抽一组环境探针 suite，上游在真实 chat 阶段**精确校验**
   `client_hashes`；其中 page-state suite（`#jsa` iframe 的 sandbox + srcdoc CSP meta、`window.top.__DDG_BE_VERSION__`
   / `__DDG_FE_CHAT_HASH__`）与 layout suite（`offsetWidth/getBoundingClientRect/scrollHeight > 0`）在扁平 jsdom
   顶层 window 中必然算错 → 418 `ERR_CHALLENGE`（表现为「偶现」）。因此求解器必须：构造 `#jsa` sandbox iframe
   （srcdoc 带 CSP meta）、注入 `__DDG_BE_VERSION__`/`__DDG_FE_CHAT_HASH__`（取首页 `data-version-tag`/`data-version-sha`）、
   为布局指标提供 shim，并**在 iframe realm 内 eval** 挑战表达式。详见 `docs/X-VQD-HASH-1-DEEP-ANALYSIS.md`。
   `meta.stack` 当前部署下未严格校验（真实 Chrome 页面即使带 `file:///` 帧也 200），历史 §3.1.1 结论保留。
   排障开关 `DUCKAI_LEGACY_JSA_ENV=1` 可切回旧环境对照（生产禁用）。
10. 遇到 418/429 时：重新 GET /status 取新挑战 + 指数退避重试（2–3 次，带随机抖动）。
11. 拟人化限流（humanize，防止触发风控）：全局上游请求串行（并发 1）；每请求前随机延迟（默认 400–1500ms）、
    最小请求间隔 1000ms；失败重试指数退避 1s/2s/4s + 抖动（最多 3 次）；429 冷却 60s；journey-id 每会话固定、
    response-id 每请求随机；配置见 `duck.humanize`。

已捕获失败形态：`418 {"action":"error","type":"ERR_CHALLENGE",...}`。

> 实现建议：优先用 `jsdom` 构造 iframe 环境执行挑战 JS（`node:vm` + 手写 DOM shim 为备选）。
> 挑战 JS 里会读取 `navigator.userAgent / webdriver`、`document.*`、`window.top` 等；
> `navigator.userAgent` 必须与请求头 UA 一致。

### 2.3 `POST /duckchat/v1/chat` 请求

Headers（已验证必需/建议）：
```
accept: text/event-stream
content-type: application/json
origin: https://duck.ai
referer: https://duck.ai/
user-agent: <Chrome UA，与挑战环境一致>
x-fe-version: serp_YYYYMMDD_HHMMSS_XX-<sha>
x-fe-signals: base64(JSON{start,events:[],end})
x-vqd-hash-1: <已求解>
x-duckai-response-id: <uuid v4>
x-ddg-journey-id: <32 hex>
x-duckai-continuation: resubmit-context
x-duckai-tool-approval: web-search
x-duckai-consent-purposes: user-location,image-generation,web-search
x-duckai-client-tools: {"version":1,"capabilities":[]}
```

Body（实测）：
```json
{
  "model": "gpt-6-luna",
  "messages": [
    {"role": "user", "content": [{"type": "text", "text": "..."}]}
  ],
  "canUseTools": true,
  "reasoningEffort": "none",
  "canUseApproxLocation": null,
  "canDelegateImageGeneration": null,
  "canUseWebSearch": null,
  "canUploadFiles": null,
  "canShowGreeting": false,
  "durableStream": null
}
```
说明：
- `durableStream`（端到端加密续传）可省略/置 null，先用普通 SSE 验证。
- 多轮历史：`messages` 交替 user/assistant；assistant 消息形如
  `{"role":"assistant","content":"","parts":[{"type":"text","text":"..."}]}`。
- **自定义 prompt（已实测 2026-11-01）**：上游**不接受** `{"role":"system"|"developer"}` → `400 ERR_BAD_REQUEST`。
  网关必须 inline：把 system/developer/instructions 文本拼进首条 user 消息（如 `[系统指令] ...\n\n[用户] ...`），
  `DuckClient` 默认 `systemPromptMode:"prefix"`。
- 早期抓包中的 `canUseApproxLocation` / `canDelegateImageGeneration` / `canUseWebSearch` / `canUploadFiles` 四个 null 字段，
  在当前版本**带上会 400**，不要发送；`x-duckai-client-tools: {"version":1,"capabilities":[]}` 头才是必需项。
- 联网：`canUseTools:true` + body `metadata.toolChoice:{"WebSearch":true}` + 头部 `x-duckai-tool-approval: web-search`、
  consent headers，模型自主调用 WebSearch（详见 docs/PROTOCOL.md §4.3）。
- 图片：`metadata.toolChoice:{"GenerateImage":true}` + 模型 supportedTools 含 `GenerateImage`；
  SSE `ui-component(generate-image, data.status=success).data.b64Image` 是最终图（详见 §4.4）。

### 2.4 `POST /duckchat/v1/chat` 响应（SSE）

已实测文本增量格式：
```
data: {"id":"msg_...","action":"success","created":1793514943982,
       "model":"gpt-6-luna","role":"assistant","message":"光"}

data: [DONE]
```
伪事件（客户端忽略）：`data: [PING]`（保活）、`data: [CHAT_TITLE:标题]`（会话标题）。

已实测的其它事件（完整样例见 `recon/TEAM-NOTES.md`）：
- `tool-invocation`：`state:"call"`（含 `toolName`、`toolCallId`、`toolArguments` JSON 字符串）、
  `state:"result"`（含 `result` 文本，WebSearch 时带 `data.citations[]`）
- `ui-component`：`name:"generate-image"`（state placement/data，最终图 `data.status==="success"` 的 `b64Image`）、
  `search-results`、权限提示、`greeting`、`writing-block`
- `role:"source"`：联网搜索的展示来源 `{url,title,site}`
- `role:"assistant"` 正文中内联 `<citation src="N"></citation>` 引用标记
- 推理/思考事件（reasoning effort 非 none 时，待协议组补全）
- 错误：`{"action":"error","type":"ERR_...","status":...}`

### 2.6 工具触发（实测）

- 联网搜索：请求体 `"metadata":{"toolChoice":{"WebSearch":true}}`
- 图片生成：请求体 `"metadata":{"toolChoice":{"GenerateImage":true}}`（走同一个 `/chat`；
  SSE 最终取 `ui-component generate-image` 且 `data.status==="success"`，字段：
  `b64Image`(jpeg base64)、`format`、`width`、`height`、`imageModelDisplayName`；`image-partial` 事件可丢弃）
- 请求头保持 `x-duckai-tool-approval: web-search`、
  `x-duckai-consent-purposes: user-location,image-generation,web-search`

### 2.7 自定义 prompt（duck.ai「自定义回复」）

浏览器本地设置（tone/length/角色/昵称/附加指令≤500字），本轮抓包未在请求体发现独立字段。
网关策略：OpenAI `instructions`/system/developer → 合并为 system 消息前置；若上游拒绝 system 角色，
降级为拼进首条 user 文本（`promptMode: "system" | "inline"` 可配置）。协议层 负责实测并记录结论。

### 2.5 模型目录（来自官网 bundle，Free 可用）

| 上游 model | 展示名 | 类型 | reasoningEffort | 工具 |
| --- | --- | --- | --- | --- |
| `gpt-6-luna` | GPT-6 Luna | reasoning | none, low | WebSearch, GenerateImage, ... |
| `gpt-5.4-mini` | GPT-5.4 mini | reasoning | none, low, medium | 同上 |
| `claude-haiku-4-5` | Claude Haiku 4.5 | reasoning | none, low | WebSearch 等 |
| `claude-haiku-5-5` | Claude Haiku 5.5 | reasoning | none, low | WebSearch 等（Internal） |
| `mistral-small-2603` | Mistral Small 4 | general | - | - |
| `tinfoil/gpt-oss-120b` | gpt-oss 120B | reasoning | low | WebSearch 等（加密） |
| `tinfoil/gemma4-31b` | Gemma 4 31B | reasoning | none, low | WebSearch 等（加密） |
| `gpt-5.6-terra` | GPT-5.6 Terra | reasoning | none, low, medium | 全工具（Plus/Pro） |
| `gpt-5.6-sol` | GPT-5.6 Sol | reasoning | none, low, medium | 全工具（Pro） |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | reasoning | none, low | 全工具（Plus/Pro） |
| `claude-opus-5-5` | Claude Opus 5.5 | reasoning | none, low, medium | 全工具（Pro） |

网关对外模型 ID 规则：`duck-<model>` 与上游原名均可（例如 `duck-gpt-6-luna` 或 `gpt-6-luna`）。
默认模型：`gpt-6-luna`。

---

## 3. 仓库结构与归属（写作用域，避免冲突）

```
duckai-cpa/
├─ ARCHITECTURE.md          [验收执行者]
├─ README.md                [管理后台]
├─ package.json             [验收执行者]（依赖变更需 验收执行者 同意）
├─ config/config.example.json [验收执行者]
├─ src/
│  ├─ index.js              [网关后端]   进程入口：加载配置、启动 HTTP
│  ├─ config.js             [网关后端]   配置读取/校验/热更新（JSON 文件 + env）
│  ├─ store.js              [网关后端]   JSON 原子持久化（配置、密钥、日志、统计）
│  ├─ logger.js             [网关后端]
│  ├─ http/server.js        [网关后端]   路由、鉴权、CORS、静态资源、SSE 转发
│  ├─ openai/models.js      [网关后端]
│  ├─ openai/chat.js        [网关后端]   /v1/chat/completions
│  ├─ openai/responses.js   [网关后端]   /v1/responses
│  ├─ openai/images.js      [网关后端]   /v1/images/generations
│  ├─ openai/errors.js      [网关后端]
│  ├─ admin/routes.js       [网关后端]   /admin/api/*（配置、密钥、测试、日志、统计）
│  ├─ duck/index.js         [协议层]  DuckClient（会话/挑战/chat/images/models）
│  ├─ duck/challenge.js     [协议层]  x-vqd-hash-1 求解器
│  ├─ duck/sse.js           [协议层]  SSE 解析 + 事件归一化
│  └─ duck/models.js        [协议层]  模型目录数据（以上表为准）
├─ web/                     [管理后台] 管理后台静态页面（无构建步骤，原生 JS/CSS）
├─ docs/
│  ├─ PROTOCOL.md           [协议层] 上游协议实测文档
│  └─ API.md                [管理后台] 对外 API 文档（OpenAI 兼容说明 + 示例）
├─ tests/                   [qa]           node:test 单测 + mock 集成测试
├─ scripts/                 [qa]           smoke.js（真实上游冒烟）、mint-key.js 等
├─ Dockerfile               [管理后台]
├─ docker-compose.yml       [管理后台]
└─ data/                    运行时数据（config.json、logs、stats；已 gitignore）
```

---

## 4. DuckClient 接口契约（`src/duck/index.js`，由 协议层 实现）

```js
export class DuckClient {
  constructor(config)           // { baseUrl, userAgent, timeoutMs, warmup, models }
  async init()                  // 抓首页版本号、预热挑战、读 capabilities
  getModelCatalog()             // 静态目录（OpenAI 可选列表）
  async chat(params, handlers)  // 见下
  async imageGeneration(params) // 见下
  async health()                // { ok, upstreamStatus, challengeOk, version }
}

// params: {
//   model: string,
//   messages: [{ role: 'system'|'user'|'assistant', content: string }],  // OpenAI 归一化后的纯文本
//   reasoningEffort?: 'none'|'minimal'|'low'|'medium'|'high',
//   webSearch?: boolean,          // 触发联网搜索
//   imageGeneration?: boolean,    // 允许模型生成图片
//   conversationId?: string,      // 可选，多轮延续
//   signal?: AbortSignal,
//   extraHeaders?: object
// }
// handlers: {
//   onTextDelta(text),            // 正文增量
//   onReasoningDelta(text),       // 推理增量（若上游提供）
//   onSearchResults(results),     // [{title,url,snippet,...}]
//   onImage({ b64, format, modelDisplayName }),
//   onToolCall({name,args}), onToolResult({name,result}),
//   onUsage({inputTokens?,outputTokens?}),
//   onError(err)
// }
// handlers 额外支持 onEvent(evt)（归一化事件原样）、onTitle(title)
// return: {
//   content,                     // 原始正文（含 <citation src="N"></citation> 内联标记）
//   cleanContent,                // 去掉 citation 标记的正文
//   markdown,                    // citation 标记替换为 [N](url)
//   reasoning, sources:[], citations:[], images:[],
//   toolCalls:[{name,callId,args}], toolResults:[{name,callId,result,data}],
//   finishReason: 'stop'|'incomplete', rawEvents:[],
//   model, reasoningEffort, reasoningEffortRequested, conversationId, title, usage
// }
```

`imageGeneration(params)` → `{ images:[{b64, format}], modelDisplayName }`。

**约定**：`duck` 层不做 OpenAI 语义；只做上游协议 + 归一化事件。错误统一抛 `DuckError{status,type,retriable,message}`。
`DuckError` 额外带 `body`（上游原始错误体片段）、`code`（上游 overrideCode/type）、`requestId`、`retryAfterMs`/`retryAt`（429），
供 API 层映射 OpenAI 错误与 `Retry-After`。

---

## 5. OpenAI 兼容层规约

### 5.1 `POST /v1/chat/completions`
- `model`：接受 `gpt-6-luna` / `duck-gpt-6-luna` / 别名；未知模型返回 400。
- `messages`：支持 system/developer/user/assistant；内容可为字符串或 `[{type:"text"}]`；忽略图片/文件（可 400 提示）。
- `reasoning_effort`：`none|minimal|low|medium|high` → 上游 `reasoningEffort`；缺省 `none`。
- `stream:true` → `text/event-stream`，chunk 形如 OpenAI：
  `data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":...,"choices":[{"index":0,"delta":{"content":"..."},"finish_reason":null}]}`
  最后 `data: {...,"choices":[{"delta":{},"finish_reason":"stop"}]}` + `data: [DONE]`。
- 非流式 → `chat.completion` 对象，含 `usage`（估算 token）、`choices[0].message.content`。
- 联网搜索：`tools:[{"type":"web_search"}]` 或顶层 `web_search:true`；
  搜索来源写入 `choices[0].message.annotations`（`{type:"url_citation",url_citation:{url,title}}`）与 `sources` 扩展字段。
- 图片：`tools:[{"type":"image_generation"}]` 时允许生成，结果写入 `message.images:[{b64_json,format}]`。
- 错误：OpenAI 风格 `{"error":{"message","type","code","param"}}`；HTTP 4xx/5xx。

### 5.2 `POST /v1/responses`
- 入参：`model`、`input`（string 或消息数组）、`instructions`、`reasoning:{effort}`、`tools:[web_search|image_generation]`、`stream`、`metadata`、`store:false`。
- 非流式：`{id,object:"response",created_at,status:"completed",model,output:[...],output_text,usage,annotations}`。
  - 文本项：`{type:"message",role:"assistant",content:[{type:"output_text",text,annotations:[url_citation...]}]}`
  - 图片项：`{type:"image_generation_call",status:"completed",result:"<base64>"}`（或按官方字段）
  - 搜索：文本 `annotations` 中 `type:"url_citation"`。
- 流式事件（按官方顺序）：`response.created`、`response.in_progress`、
  `response.output_item.added`、`response.content_part.added`、`response.output_text.delta`、
  `response.output_text.done`、`response.content_part.done`、`response.output_item.done`、`response.completed`；
  以及 `response.reasoning_summary_text.delta`（如上游有推理）、`response.image_generation_call.*`。
  事件均带 `sequence_number`。

### 5.3 `GET /v1/models`
OpenAI `{"object":"list","data":[{id,object:"model",created,owned_by,created_by,context_window?,reasoning:bool}]}`。

### 5.4 `POST /v1/images/generations`
入参 `{model?, prompt, n:1, size?, response_format:"b64_json"|"url"}`；
返回 `{created, data:[{b64_json}|{url:"data:image/...;base64,..."}]}`。

### 5.5 鉴权
- 默认本地无需鉴权（`auth.required=false`）。
- 若开启：`Authorization: Bearer <apiKey>`，Key 存 `data/config.json`，后台可增删。
- 管理接口 `/admin/api/*` 始终需要 admin token（默认从 config 读，首次启动生成并打印）。

---

## 6. 配置（`config/config.example.json`）

```json
{
  "server": { "host": "127.0.0.1", "port": 8787, "cors": true },
  "auth": { "required": false, "apiKeys": ["sk-duck-..."], "adminToken": "..." },
  "duck": {
    "baseUrl": "https://duck.ai",
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    "defaultModel": "gpt-6-luna",
    "timeoutMs": 120000,
    "warmup": true,
    "systemPromptMode": "prefix",
    "challenge": { "engine": "jsdom", "versionTtlMs": 1800000, "challengeTtlMs": 90000 },
    "humanize": {
      "enabled": true,
      "concurrency": 1,
      "minIntervalMs": 1000,
      "minDelayMs": 400,
      "maxDelayMs": 1500,
      "maxRetries": 3,
      "retryBaseDelayMs": 1000,
      "rateLimitCooldownMs": 60000,
      "rateLimitWaitMs": 5000
    }
  },
  "prompts": { "defaultSystemPrompt": "", "defaults": {} },
  "logging": { "level": "info", "maxEntries": 500 },
  "models": { "aliases": { "gpt-6": "gpt-6-luna" } },
  "tools": { "webSearch": true, "imageGeneration": true }
}
```

---

## 7. 管理后台（`/admin`）

单页、无构建。模块：
1. **概览**：上游健康、挑战状态、模型数、请求量、错误率、最近请求。
2. **连接测试**：输入 prompt / 模型 / 推理档位 / 是否联网，实时显示 SSE 结果。
3. **配置**：编辑并保存运行配置（写 `data/config.json`），可重置。
4. **API Key**：创建/吊销，显示使用统计。
5. **日志**：最近请求（时间、endpoint、model、耗时、状态、上游错误），可清空。
6. **演示**：展示 `curl` 与 OpenAI Python/JS SDK 调用示例（带 copy 按钮）。

鉴权：`?token=<adminToken>` 或 `Authorization: Bearer <adminToken>` 访问 `/admin/api/*`；静态页公开但 API 需 token。

---

## 8. 协作规则

1. **只写自己作用域内的文件**；跨域修改先在共享任务里说明，由 验收执行者 协调。
2. 所有测试/脚本输出不要污染仓库根目录；临时文件放 `data/tmp/` 或 `tests/fixtures/`。
3. 网络只访问 `https://duck.ai`（及本地 127.0.0.1）；不得抓取其它站点。
4. 提交前自测：`node --check`、`npm test`（若已有）、手动 curl 验证。
5. 与协议相关的结论先写进 `docs/PROTOCOL.md`（协议层 负责），API 层依赖该文档而非猜测。
6. 任何上游反爬参数变化，先在 `docs/PROTOCOL.md` 记录「现象 + 修复」，再改代码。
7. 敏感信息（cookie/session）只存 `data/`，不写日志、不提交。
