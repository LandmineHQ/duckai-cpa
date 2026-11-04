# Duck.ai 上游协议实测文档

> 维护者：`duck-protocol`（`src/duck/**` 的唯一所有者）。
> 本文件是 `src/duck/*` 的事实依据；任何上游反爬参数变化，先在这里记录「现象 + 修复」，再改代码。
> 实测环境：Node.js 24 + `jsdom@29`，匿名 `public` 档位（无登录、无 cookie），出口为普通数据中心 IP。
> 最近一次全量实测：**2026-11-01**（下文所有 HTTP 状态、字段、样例来自真实上游，非猜测）。

---

## 1. 概览

| 项目 | 值 |
| --- | --- |
| Base URL | `https://duck.ai`（全部同源，无独立 API host） |
| 认证 | 匿名无需 token；`GET /duckchat/v1/auth/token` 对匿名返回 `{}` |
| 入口页版本 | `<html data-version-tag="serp_20261030_223718_ET" data-version-sha="61e4601227ece8af7a1ad4d69b79aafd35f91fae">` → `x-fe-version: serp_20261030_223718_ET-61e4601227ece8af7a1ad4d69b79aafd35f91fae` |
| 核心端点 | `POST /duckchat/v1/chat`（SSE，文本/搜索/图片共用） |
| 反爬 | `x-vqd-hash-1` 挑战：先 `GET /duckchat/v1/status` 取混淆 JS，在类浏览器环境求解，**滚动更新** |
| 限流 | 匿名档位有额度；短时间高频请求 → `418 ERR_BN_LIMIT` / `429 ERR_RATE_LIMIT` |

### 1.1 关键端点

| 端点 | 方法 | 用途 | 备注 |
| --- | --- | --- | --- |
| `/` | GET | 取页面版本号 | 正则 `data-version-tag` + `data-version-sha` |
| `/duckchat/v1/status` | GET | **取挑战** | 需 `x-vqd-accept: 1` + `x-vqd-hash-1: initial`；响应头带挑战 JS |
| `/duckchat/v1/chat` | POST | 对话/搜索/图片 | SSE 流；响应头带下一个挑战 |
| `/duckchat/v1/capabilities` | GET | 访问档位/实验 | `{"accessLevel":"public","flags":{...},"experimentEnrollments":[...]}` |
| `/duckchat/v1/auth/token` | GET | 匿名 token | 匿名返回 `{}` |
| `/country.json` | GET | 地区 | `{"country":"DE"}` 等（用于 `canUseApproxLocation`） |

匿名实测响应样例：

```http
GET /duckchat/v1/status
200 {"status":"0","secondaryStatus":"0","statusV2":0,"grant":null}
x-vqd-hash-1: KGFzeW5jIGZ1bmN0aW9uKCl7...     (base64 挑战 JS)

GET /duckchat/v1/capabilities
200 {"accessLevel":"public",
     "flags":{"image-generation-model":{"value":"c","version":"1_1","expiresAt":"2027-01-20T00:00:00Z"}},
     "experimentEnrollments":["image-generation-model"],
     "experimentStateResets":["duckai-framework-browser-profile-aa","image-generation-model"]}

GET /duckchat/v1/auth/token
200 {}
```

> `capabilities.flags["image-generation-model"].value` 在多次请求间会变化（观测到 `a` / `b` / `c`），
> 推测是实验分桶，别当作稳定常量。
> `/duckchat/v1/capabilities` 的响应头**也可能**带 `x-vqd-hash-1` 滚动挑战；实现里会把它作为待求解挑战吸收，
> 避免挑战链错位（`health().challenge.externalChallenges` 计数）。

---

## 2. 反爬挑战 `x-vqd-hash-1`（最核心）

### 2.1 流程

```
GET /                                   ─ 取 x-fe-version
  ↓
GET /duckchat/v1/status                 ─ 请求头 x-vqd-accept:1, x-vqd-hash-1:initial,
  │                                       x-fe-version, x-fe-signals
  ↓  响应头 x-vqd-hash-1 = base64(混淆 async IIFE 源码)
jsdom 在 https://duck.ai/ 源内执行该 JS   ─ 得到 {server_hashes, client_hashes, signals, meta}
  ↓
浏览器后处理：client_hashes 逐个 SHA-256(UTF-8)→base64；
meta 补 origin / stack / duration；btoa(JSON.stringify(...))
  ↓
POST /duckchat/v1/chat  请求头 x-vqd-hash-1: <已求解>
  ↓  响应头 x-vqd-hash-1 = 下一个挑战（滚动，必须保存求解给下一次请求用）
```

### 2.2 `GET /duckchat/v1/status` 实测

请求头（全部必需）：

```
user-agent: <Chrome UA>
accept: application/json
accept-language: en-US,en;q=0.9
origin: https://duck.ai
referer: https://duck.ai/
x-vqd-accept: 1
x-vqd-hash-1: initial
x-fe-version: serp_20261030_223718_ET-61e4601227ece8af7a1ad4d69b79aafd35f91fae
x-fe-signals: base64({"start":<ms>,"events":[],"end":<ms+37>})
cookie: <可选，匿名首次为空>
```

响应：`HTTP/1.1 200`，body `{"status":"0","secondaryStatus":"0","statusV2":0,"grant":null}`，
响应头 `x-vqd-hash-1: KGFzeW5jIGZ1bmN0aW9uKCl7...`（base64，长度约 6200–7700）。

> 同样的 `/status` 请求在限流额度耗尽时返回 `429`，**且不再下发挑战头**。

### 2.3 挑战 JS 载荷

base64 解码后是一个 **表达式**（async IIFE），与站点注入 iframe 的形态一致：

```js
(async function(){ ... return {'server_hashes':[...], 'client_hashes':_0x..., 'signals':{}, 'meta':{'v':'4','challenge_id':...,'timestamp':...,'debug':...}}; })()
```

在执行环境（`navigator.userAgent`、`document`、`window.top`、`location.origin` 可用）中 await 后得到：

```json
{
  "server_hashes": ["p3XIq650Ij1qqZcg+ZHCQicNiMfBXsCf4J2ucjoUCB8=", "S9oT4aEtt83sotu7r6X1h4Fb0hc8X58d3IlKRU5h/9g=", "TA8g9TaCSkZxZVzMqaZB+R8+t5Bv4GoJicL4nIy8oTQ="],
  "client_hashes": ["<navigator.userAgent>", "<环境测量值>", "<环境测量值>"],
  "signals": {},
  "meta": { "v": "4", "challenge_id": "<hash>q7klm", "timestamp": "1793515876578", "debug": "<2 字节>" }
}
```

- `client_hashes` 原始值是**环境指纹**：第 1 项是 `navigator.userAgent`，另外两项来自 DOM 测量
  （`offsetWidth/scrollHeight/getBoundingClientRect`、`iframe.contentWindow` 等，见 `recon/jsa-solver-pretty.txt`）。
- `debug` 是环境校验结果的紧凑编码（1–3 个字节），实测不同取值不影响上游放行。
- 挑战 JS 内部会用 `atob/btoa`、`TextEncoder`、`crypto.subtle.digest` 等浏览器 API 做自检；jsdom 均可用。

### 2.4 后处理（必须与浏览器字节一致）

浏览器实现（`recon/jsa-solver-pretty.txt` 第 39–56 行）：

```js
btoa(JSON.stringify({
  ...result,
  client_hashes: await Promise.all(result.client_hashes.map(async (s) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return btoa(new Uint8Array(digest).reduce((acc, b) => acc + String.fromCharCode(b), ""));
  })),
  meta: { ...result.meta, origin: (window.top || window).location.origin,
          stack: first5Frames(new Error()), duration: String(Date.now() - startedAt) }
}))
```

要点：
1. 每个 `client_hashes` 字符串：`SHA-256(UTF-8)` → 标准 base64（带 `=` 填充）。
2. `meta.origin` = `https://duck.ai`（页面 origin，不是 iframe 的 `about:blank`）。
3. `meta.stack` = `Error().stack` 前 5 帧（去掉首行 `Error`），`\n` 连接；不足 5 帧不加省略后缀。
   **v2.21 关键**：上游用该字段验证请求来自 duck.ai 官方入口 bundle —— 帧必须指向当前部署的
   `https://duck.ai/dist/duckai-dist/entry.duckai.<hash>.js`（hash 从 homepage HTML 解析），
   不能出现 Node 的 `file:///` 或 `node:internal` 帧，否则触发 429 `ERR_BN_LIMIT`
   （"unsupported entrypoint"）。见 `docs/PROTOCOL-ERRORS.md` §3.1.1。
4. `meta.duration` = 从 `atob()` 开始到后处理完成的毫秒数字符串。
5. 输出 `btoa(JSON.stringify(payload))` → `x-vqd-hash-1` 请求头的值（实测约 1.1–1.6KB）。

### 2.5 滚动更新（**必须实现**）

- 每个 `/duckchat/v1/*` 响应都会在**响应头** `x-vqd-hash-1` 下发下一个挑战（base64 JS，仍需执行 + 后处理）。
- 下一次请求必须携带上一响应的求解值。
- **反例（实测）**：每次请求前都重新 `GET /status` 拿新挑战、不消费响应里的滚动挑战，会**隔次** `418 ERR_CHALLENGE`。
  正确做法：首个挑战来自 `/status`，之后全部来自上一个响应头。
- 挑战有时效性：求解后应尽快使用（实现里超过 90s 的已求解值会丢弃重取）。
- `418/429/5xx` 响应**不带**新挑战头 → 丢弃当前挑战状态，重新 `GET /status` 再求解。

### 2.6 jsdom 执行要点（本项目实现）

```js
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'https://duck.ai/',
  resources: { userAgent: UA },   // ← jsdom 29 必须放 resources.userAgent，top-level userAgent 会被忽略！
  pretendToBeVisual: true,
  runScripts: 'outside-only'      // 提供 window.eval + 浏览器形状的 window/navigator/document
});
const result = await dom.window.eval(decodedSource);  // 解码后的表达式直接 eval
```

- `navigator.userAgent` 必须与请求头 `user-agent` 一致（挑战指纹里含 UA；请求头与求解环境不一致容易被判为 bot）。
- 不需要真的创建 iframe / `__jsaCallbacks`：`window.eval` 与站点 `parent.__jsaCallbacks[n](null, <payload>)` 等价
  （两者都在 `https://duck.ai/` 源内执行表达式）。若要更贴近浏览器，也可创建同源 iframe 注入 `<script>`，
  实测在本环境用 iframe 执行时 jsdom 跨 realm Promise 交接不稳定，`window.eval` 更可靠。
- 每次求解新建一个 JSDOM 实例（避免全局污染），耗时约 40–500ms。
- 环境变量 `globalThis.atob/btoa`、`TextEncoder`、`crypto.subtle` 在 jsdom window 中均可用。

### 2.7 严格校验规则（v2，`strictProtocol: true` 默认开启）

网关对「非预期上游行为」不再静默降级，而是**立即 abort 上游请求并抛错**；已收到的内容会附在
`DuckError.partial` 里，便于 API 层发 `error` 事件后结束。规则如下（完整映射见 `docs/PROTOCOL-ERRORS.md`）：

| 校验点 | 触发条件 | 错误码 / HTTP |
| --- | --- | --- |
| 成功响应头 | `content-type` 不含 `text/event-stream` | `upstream_protocol_mismatch` / 502 |
| 成功响应头 | 缺少滚动挑战头 `x-vqd-hash-1` | `upstream_protocol_mismatch` / 502 |
| SSE 帧 | JSON 解析失败（且不是已知伪事件） | `upstream_protocol_mismatch` / 502 |
| SSE 帧 | `role` 不在白名单（见 §4.7.1） | `upstream_protocol_mismatch` / 502 |
| SSE 帧 | `action:"error"` 或 `type:"ERR_*"` | 按 `ERR_*` 映射（如 429/403/502） |
| 流结束 | 未收到 `[DONE]` | `upstream_protocol_mismatch` / 502 |
| 工具帧 | `tool-invocation` 缺 `toolCallId` 或同时缺 `result`/`data` | `upstream_protocol_mismatch` / 502 |
| 图片 | `generate-image` 成功帧缺 `b64Image` / 图片模式结束无成功图片 | `upstream_no_image` / 502 |
| 内容安全 | 流内 `role:"refusal"` | `content_filter` / 403 |
| 额度 | `[DONE]` 行内 `[LIMIT_*]` 标记 | 对应额度错误（429/403） |

不可重试错误（`upstream_protocol_mismatch` / `upstream_no_image` / `content_filter` / `bad_request` 等）不会进入
`DuckClient` 的重试循环；418/429 等**传输层**错误仍按 §5.1 退避重试。

> `strictProtocol:false` 仅用于协议调试：未知 role 会被忽略、缺 `[DONE]` 时以 `finishReason:"incomplete"` 结束。
> 生产环境不要关闭。

### 2.8 稳定身份（v2.2，详见 `docs/IDENTITY-RESEARCH.md`）

duck.ai 的匿名识别不靠 cookie，而是 4 套标识叠加；网关必须把它们**持久化到 `data/identity.json`**，否则重启即漂移：

| 标识 | 上游载体 | 浏览器 | 网关（v2.2） |
| --- | --- | --- | --- |
| journey id | `x-ddg-journey-id: <32 hex>`（`crypto.getRandomValues` 生成，内存态） | 每次加载变化 | 持久化，每次请求复用 |
| durable stream 身份 | body `durableStream:{messageId(uuid/请求), conversationId(稳定), publicKey(RSA-OAEP-256 JWK)}` | 本地 RSA 密钥对，只发公钥 | 持久化 RSA-2048 密钥对 + conversationId；**默认关闭**，拒绝后自动降级 |
| Sync 密钥 | `mainKey`(32B) + `encryptedPrivateKey`(compact JWE `alg=dir/enc=A256GCM/kid=streams`) + `scopedPasswordSeed` | localStorage/IndexedDB + 配对码 | 本地生成/导入导出/配对码/恢复码；真实 sync 传输在本沙箱不可达（503） |
| 订阅 | `Authorization: Bearer <JWT>`；payload `api/email/exp/entitlements`，`product:"Duck.ai"` + `plus/pro` 定档 | 登录态 | token 持久化/在线验证；匿名无 token |

- `durableStream.publicKey` 是 **JWK**（带 `alg:"RSA-OAEP-256"`、`ext:true`、`key_ops:["encrypt"]`、`use:"enc"`），
  不是 base64url SPKI；`conversationId` 必须稳定。
- 实测：不携带 durableStream 的 chat 200；携带（本实现形状）的 chat **也 200**（2026-11-02），
  Lead 侧另一种形状曾 400 → 因此实现默认关闭 + 400 自动降级一次（见 `docs/IDENTITY-RESEARCH.md` §3.4）。
- 订阅 token 是 base64url 三段 JWT（62 字符旧 v1 token 被上游拒绝，`ERR_AUTH_V1_TOKEN`）。

---

## 3. `POST /duckchat/v1/chat` 请求

### 3.1 请求头（实测必需）

| 头 | 值 | 说明 |
| --- | --- | --- |
| `user-agent` | 真实 Chrome UA | 必须与求解环境一致 |
| `accept` | `text/event-stream` | |
| `content-type` | `application/json` | |
| `accept-language` | `en-US,en;q=0.9` | 建议 |
| `origin` / `referer` | `https://duck.ai` / `https://duck.ai/` | |
| `x-fe-version` | 首页 version-tag + "-" + version-sha | 版本更新后需重新抓 |
| `x-fe-signals` | `base64({"start":ms,"events":[],"end":ms+37})` | 每次请求新生成 |
| `x-vqd-hash-1` | 已求解挑战 | 见 §2 |
| `x-duckai-response-id` | uuid v4 | **每请求随机** |
| `x-ddg-journey-id` | 32 位 hex | **每会话固定** |
| `x-duckai-continuation` | `resubmit-context` | |
| `x-duckai-tool-approval` | `web-search` | 浏览器始终携带 |
| `x-duckai-consent-purposes` | `user-location,image-generation,web-search` | |
| `x-duckai-client-tools` | `{"version":1,"capabilities":[]}` | **关键头**：缺失时带 `durableStream`/部分扩展字段会 400，不带则 418 |

浏览器 bundle 中还会按条件携带以下头（网关当前不发送，记录备查）：

| 头 | 触发条件 | 说明 |
| --- | --- | --- |
| `x-duckai-chat-model` | 语音听写等场景 | 复用当前聊天模型 |
| `x-duckai-image-model-variant` | 图片模型实验分桶 | `imageModelVariant` 本地设置 |
| `x-duckai-bonus-id` | 有 bonus 窗口时 | 营销 bonus 标识（带 `expiresAt`） |
| `x-duckai-bypass-fixed-cost-windows` | 用户选择了绕过额度窗口 | 额度绕过开关 |

> **踩坑记录**：`x-duckai-client-tools` 是最后一个被发现的必需头。没有它时，
> 浏览器抓包得到的完整 body（含 `durableStream`、`canUseWebSearch` 等）返回 `400 ERR_BAD_REQUEST`，
> 精简 body 则返回 `418`。

### 3.2 最小可用 body（实测 200）

```json
{
  "model": "gpt-6-luna",
  "messages": [{ "role": "user", "content": [{ "type": "text", "text": "用一句话说明为什么天空是蓝色的。" }] }],
  "canUseTools": true,
  "reasoningEffort": "none",
  "canShowGreeting": false
}
```

### 3.3 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 上游模型名，见 §6 |
| `messages` | array | user: `{role:"user", content:[{type:"text",text}]}`；assistant 历史: `{role:"assistant", content:"", parts:[{type:"text",text}]}` |
| `canUseTools` | bool | 建议恒 `true`（与浏览器一致）；配合 `metadata.toolChoice` 触发工具 |
| `reasoningEffort` | string | `none/minimal/low/medium/high`，超出模型支持范围会被上游拒绝或忽略，见 §6 |
| `canShowGreeting` | bool | 普通对话 `false`；图片生成实测用 `true` |
| `metadata.toolChoice` | object | 工具开关，如 `{"WebSearch":true}` / `{"GenerateImage":true}` |
| `durableStream` | object \| null | v2.2 稳定身份：`{"messageId":"<uuid/请求>","conversationId":"<稳定 uuid>","publicKey":<RSA-OAEP-256 JWK>}`；匿名档可能 400，`DuckClient` 默认不发、被拒后自动降级（§2.8） |
| `canUseApproxLocation` / `canDelegateImageGeneration` / `canUseWebSearch` / `canUploadFiles` | null | ARCHITECTURE 早期抓包里出现过；实测当前版本带上会 400（`ERR_BAD_REQUEST`），**不要发送** |

### 3.4 角色支持（实测）

- `role:"system"` **不被接受**：`400 {"action":"error","status":400,"type":"ERR_BAD_REQUEST"}`。
- 自定义 prompt 必须 **inline**：把 system/developer/instructions 文案拼进首条 user 消息，
  例如 `[系统指令]\n...\n\n[用户]\n...`（`DuckClient` 默认 `systemPromptMode: 'prefix'`，可配 `'system'` 做实验）。
- `400` 属于参数错误，**不应重试**；只有 `418/429/5xx` 适合退避重试。

### 3.5 多轮历史

```json
"messages": [
  {"role":"user","content":[{"type":"text","text":"我叫小明，请记住。"}]},
  {"role":"assistant","content":"","parts":[{"type":"text","text":"好的，小明。"}]},
  {"role":"user","content":[{"type":"text","text":"我叫什么名字？"}]}
]
```

实测 200，模型能正确回忆上下文。duck.ai 是**无状态**的（每轮把完整历史重新发），不存在服务端会话 id。

---

## 4. `POST /duckchat/v1/chat` 响应（SSE）

### 4.1 线格式

- 每个事件一行 `data: <payload>`，事件之间空行分隔（客户端按行解析即可）。
- 伪事件：`data: [DONE]`、`data: [PING]`（保活）、`data: [CHAT_TITLE:<标题>]`（首条，可忽略）。
- 正文字符串是**逐 token 增量**，需要拼接。
- 正常结束以 `data: [DONE]` 收尾。

### 4.2 文本对话（实测样例）

```
data: {"id":"msg_...","action":"success","created":1793514943982,"model":"gpt-6-luna","role":"assistant","message":"光"}

data: {"id":"msg_...","action":"success","created":1793514943983,"model":"gpt-6-luna","role":"assistant","message":"阳光"}

data: [DONE]
```

### 4.3 联网搜索（`metadata.toolChoice:{"WebSearch":true}`）

事件序列（真实抓包）：

```
data: {"role":"tool-invocation","state":"call","toolName":"WebSearch","toolCallId":"call_xxx",
       "toolArguments":"{\"query\":\"New York City weather November 1 2026 temperature\",\"allowedDomains\":[\"open-web\"]}"}

data: {"role":"tool-invocation","state":"result","toolCallId":"call_xxx",
       "result":"WebSearch completed. The result was used to generate the answer, but no longer included in the LLM context.",
       "data":{"version":1,"markerFormat":"<citation src=\"N\"></citation>","urls":[...],
               "citations":[{"id":1,"url":"https://...","title":"...","domain":"...","root_domain":"...",
                             "site_name":"...","published":null,"chunkIds":["..."]}, ...]}}

data: {"role":"assistant",...,"message":"<citation src=\"4\"></citation>"}   ← 正文内联引用标记，逐片段流式到达

data: {"role":"source","source":{"url":"https://...","title":"...","site":"AccuWeather"},"toolCallId":"call_xxx"}

data: [DONE]
```

- 完整来源列表取 `tool-invocation(state=result).data.citations`（比 `source` 事件完整）。
- 正文里 `<citation src="1,3"></citation>`（可能多 id 逗号分隔）需由网关解析成 OpenAI `url_citation` 注解，
  流式输出前若要干净文本，删除标记即可。
- `data.urls` 是 URL 数组，可作 `citations` 缺失时的兜底。

**2026-11-01 实测（本机 DuckClient 真实上游，问题「2026年11月1日纽约今天天气如何？」）**：

```
# 事件类型序列
title → tool-call(WebSearch) → tool-result(citations=5) → assistant×29 → source×2 → done

# tool-call
{"role":"tool-invocation","state":"call","toolName":"WebSearch","toolCallId":"call_...",
 "toolArguments":"{\"query\":\"New York City weather November 1 2026 forecast\",\"allowedDomains\":[\"open-web\"]}"}

# tool-result.data.citations[0]
{"id":1,"url":"https://www.accuweather.com/en/us/new-york/10021/november-weather/349727",
 "title":"New York, NY Monthly Weather | AccuWeather","domain":"www.accuweather.com",
 "root_domain":"accuweather.com","site_name":"AccuWeather","published":null,
 "chunkIds":["c1","c2","c3","c4","c5","c6","c7","c8","c9","c10","c11","c12","c13","c14","c15","c16"]}

# 正文增量（注意 citation 标记是**逐片段**到达的，不能按单个 delta 直接正则替换）
"纽约" "今天" "预计" "阴" "天" "，" "最高" "约" "16" "°C" "、" "最低" "约" "7" "°C" "，" "基本" "无" "雨" "。" "<" "citation" " src" "=\"" "5" "\"></" "citation" ">"
```

> ⚠️ 关键细节：内联标记 `<citation src="5"></citation>` 会被拆成 `"<"`, `"citation"`, `" src"`, `"=\""`, `"5"`, `"\"></"`, `"citation"`, `">"` 等
> 多个文本增量。若要边流边清理，必须做跨 delta 缓冲；`DuckClient` 的做法是**先拼接完整文本**，
> 再统一 `stripCitationMarkers()` / `citationsToMarkdown()`。
>
> 另：`source` 事件数量（本次 2 个）可能少于 `data.citations`（5 条），映射 OpenAI annotations 应以 `citations` 为准。

### 4.4 图片生成（`metadata.toolChoice:{"GenerateImage":true}`）

事件序列（真实抓包）：

```
data: {"role":"ui-component","state":"placement","name":"generate-image","id":"...","toolCallId":"call_...","toolName":"GenerateImage"}

data: {"role":"tool-invocation","state":"call","toolName":"GenerateImage","toolCallId":"call_...",
       "toolArguments":"{\"imageGenPrompt\":\"...\",\"imageToUse\":\"none\"}"}

data: {"role":"ui-component","state":"data","name":"generate-image","data":{"type":"image-title","title":"绘制..."}}

data: [PING] ...

data: {"role":"ui-component","state":"data","name":"generate-image",
       "data":{"type":"image-partial","status":"partial","b64Image":"/9j/...","width":1024,"height":1024,"format":"jpeg"}}   ← 预览，丢弃

data: {"role":"tool-invocation","state":"result","result":"Image generated successfully."}

data: {"role":"ui-component","state":"data","name":"generate-image",
       "data":{"status":"success","b64Image":"<base64 jpeg>","width":1024,"height":1024,"format":"jpeg",
               "generationDurationMs":9072,"moderationToken":"...","imageModelDisplayName":"GPT Image 2"}}   ← 最终图，取这个

data: [DONE]
```

- 一次响应可能 ~200KB（`image-partial` + 最终图两份 base64），网关只保留 `data.status === "success"` 的那份。
- 图片是 `jpeg`，`imageModelDisplayName` 形如 `GPT Image 2`（与 `model` 字段无关）。
- 触发条件：模型 `supportedTools` 含 `GenerateImage`（`gpt-6-luna` / `gpt-5.4-mini` / `gpt-5.6-*` / `claude-opus-5-5` 等）。

**2026-11-01 实测（本机 DuckClient `imageGeneration({prompt:"画一只戴墨镜的卡通鸭子，简洁插画风格"})`）**：

```
耗时报文：总耗时 30.5s（其中 data.generationDurationMs=11502）
事件序列：title → ui-component(placement) → tool-call(GenerateImage) → ui-component(data/image-title)
          → ping×3 → ui-component(data/image-partial) → ping×2 → tool-result → ui-component(data/success) → done

image-title:  {"type":"image-title","title":"Drawing a duck in sunglasses"}      ← 注意标题是英文
image-partial:{"type":"image-partial","status":"partial","b64Image":"<len=129292>","width":1024,"height":1024,"format":"jpeg"}
success:      {"status":"success","b64Image":"<len=125396>","width":1024,"height":1024,"format":"jpeg",
               "generationDurationMs":11502,"moderationToken":"v1.1796109258....","imageModelDisplayName":"GPT Image 2"}
```

- 最终图 base64 长度 ~125K 字符 → 解码 94KB JPEG；**实际像素 1254×1254**，与 `data.width/height=1024` 不一致，
  说明这两个字段不可信，不要据此计算尺寸/校验。
- `image-partial` 的 base64 甚至比最终图更大（129K vs 125K），务必丢弃。
- 同一次响应只有一个 `GenerateImage` tool-call；`tool-result` 事件的 `toolName` 字段**缺失**（只有 `toolCallId`），
  需要从前面 `tool-call` 事件的 `toolCallId → toolName` 反查（`DuckClient` 已做）。

### 4.5 推理事件

`reasoningEffort` 非 `none` 时，部分模型会先流式输出推理内容。bundle 中的理论形态（`state` 状态机）：

```json
{"role":"reasoning","state":"part-start","id":"r1","partIndex":0,"text":""}
{"role":"reasoning","state":"text-delta","id":"r1","partIndex":0,"text":"用户问的是"}
{"role":"reasoning","state":"text-done","id":"r1","partIndex":0}
{"role":"reasoning","state":"done","id":"r1","summaryText":["推理摘要..."],"encryptedText":"...","sourceUpstreamId":"...","sourceModelId":"...","redacted":false}
```

**2026-11-02 真实抓包（本机 DuckClient，`gpt-6-luna` + `reasoningEffort:"low"`，Free 匿名）**：

```
事件类型序列：title → reasoning → text×3 → done

{"id":"rs_061030b6...","action":"success","created":1793523127671,"model":"gpt-6-luna",
 "role":"reasoning","state":"done",
 "summaryText":[],
 "encryptedText":"gAAAAABq5v23...<JWE 密文, 数 KB>",
 "sourceUpstreamId":"u10","sourceModelId":"gpt-6-luna"}
```

- 关键结论：**Free/匿名档位的推理内容以 `encryptedText`（JWE 密文）下发，`summaryText` 为空数组**，
  因此网关侧 `reasoning` 文本长度为 0（`DuckClient` 返回 `reasoning:""`，`reasoningEncrypted:true`）；
  只有浏览器端持有密钥才能解密展示。付费/内部档位是否会下发明文 `summaryText`/`text-delta` 待验证。
- `src/duck/sse.js` 对 reasoning 帧归一化为 `{type:'reasoning', state, text, encrypted, summaryTextAvailable, ...}`；
  `onReasoningDelta(text, state)` 对新状态也会回调（text 可能为空）。
- 旧版本可能用 `reasoning-progress` 等 role；`rawEvents` 保留原始帧，便于快速适配。
- `encryptedText` 不进入日志（`redactSnippet` 只用于错误片段；`rawEvents` 仅返回给调用方）。

### 4.6 错误事件

流内错误（少见）与 4xx/5xx 响应体同构：

```json
{"action":"error","status":418,"type":"ERR_CHALLENGE","overrideCode":"f741","cd":{...}}
```

`DuckClient` 严格模式会在流内遇到该帧时立即中断上游并抛 `DuckError`（`code`/`status`/`retriable`/
`eventIndex` 按 `docs/PROTOCOL-ERRORS.md` §9 映射，已收内容在 `error.partial`）。

### 4.7 v2 事件扩展（bundle 逆向，2026-11-02）

除 §4.2–§4.6 外，上游还会发送以下帧（识别到即按契约处理，未知 role 在严格模式下会中断）：

#### 4.7.1 role 白名单

`assistant`（或无 role 但有 `message`）、`reasoning`、`tool-invocation`、`source`、`generated-image`、
`partial-image`、`ui-component`、`refusal`、`image-validated`、`continuation`、`skill-references`。

#### 4.7.2 图片的新形态

```json
{"role":"generated-image","id":"img1","result":"<base64>","width":1024,"height":1024,"format":"jpeg","moderationToken":"..."}
{"role":"partial-image","id":"img1","result":"<base64 预览>","width":1024,"height":1024,"format":"jpeg"}
```

- `generated-image` 的 `result`（不是 `b64Image`）是最终图；`partial-image` 是预览，必须丢弃。
- 老形态（§4.4 的 `ui-component generate-image`）仍然存在；`DuckClient` 两种都识别。

#### 4.7.3 拒答 / 审核

```json
{"role":"refusal","detectedBy":"api"}
{"role":"image-validated","tokens":[{"messageIndex":0,"kind":"assistant-part","partIndex":0,"moderationToken":"..."}]}
```

`refusal` 表示模型拒答，流正常结束但语义上是失败 → 网关映射 `403 content_filter`（带 `partial`）。

#### 4.7.4 continuation（客户端工具 / 授权续传）

```json
{"role":"continuation","action":"success","token":"<opaque>",
 "pendingActions":[{"kind":"approval","toolCallId":"c1","toolName":"WebSearch","purpose":"web-search","approvalId":"a1"}],
 "replayPolicy":"continuation-only"}
```

网关请求固定带 `x-duckai-continuation: resubmit-context` 且预置 consent，故正常不会触发授权弹窗；
若收到则记录到 `chat().continuations` 并继续消费。HTTP 409 的续传失效见 `docs/PROTOCOL-ERRORS.md` §7。

#### 4.7.5 `[DONE]` 行内软错误标记

`[DONE]` 之后可能追加 `[LIMIT_ACCOUNT]` / `[LIMIT_ENTITY]` / `[LIMIT_CONVERSATION]` /
`[LIMIT_IMAGE_GENERATIONS]`（HTTP 仍 200，语义是额度错误）、`[STOP_REASON:max_tokens]`（映射
`finish_reason:"length"`）、`[FIXED_COST_WINDOW_USAGE:...]`、`[SUMMARY_REFRESH_HINT:...]`、
`[SUMMARY_INVALID]`、`[ADS:...]`、`[WARN_CONVERSATION_LIMIT:n]`。`src/duck/sse.js parseDoneFrame()`
已全部解析，详见 `docs/PROTOCOL-ERRORS.md` §1.2。

---

## 5. 错误码 / 限流

| HTTP | type | 触发原因 | 处理 |
| --- | --- | --- | --- |
| 418 | `ERR_CHALLENGE` | 挑战缺失/失效/未按滚动链使用/求解值被拒 | 丢弃挑战 → `GET /status` 重新求解 → 退避重试 |
| 418 | `ERR_BN_LIMIT` | 「unsupported entrypoint」匿名入口/风控软限流（短时间内反复请求时出现；实测丢弃挑战后重取 `/status` 重试通常能通过） | 同上；计入 `health().stats.limitHits418` |
| 429 | `ERR_RATE_LIMIT` | 匿名额度耗尽（body 形如 `{"action":"error","status":429,"type":"ERR_RATE_LIMIT","r":"<request-id>"}`），连 `/status` 也 429 | 指数退避 1s/2s/4s + 抖动，最多 3 次；记录 `retryAt`；`Retry-After` 头优先 |
| 400 | `ERR_BAD_REQUEST` | body 结构/字段错误（如 `role:"system"`、多余的 null 扩展字段、非法 `metadata`） | **不重试**，直接 `DuckError(type="bad_request")` |
| 5xx | — | 上游临时故障 | 退避重试 |

### 5.1 匿名限流实测

- 短时间内（约 10 分钟内数十次请求）真实对话后，`/chat` 先出现 `429 ERR_RATE_LIMIT`，随后 `GET /status` 也 429
  （无挑战头，body 为 JSON 错误）。
- 冷却窗口内即使挑战求解正确也会被拒；**必须退避等待**。

**2026-11-01 完整观测（一次额度耗尽过程）**：

```
[1] 正常阶段：text 200 (req=1) → multi-turn 200 (req=2) → web-search 200 (req=3)，全部 0 重试
[2] 软限流阶段：下一次 chat 连续 4 次 418，每次都是「丢弃挑战 → GET /status 重新求解」后仍 418：
    418 {"action":"error","status":418,"type":"ERR_CHALLENGE","overrideCode":"dd89",
         "cd":{"q":"","cc":"duckchat","s":"index","iadb":"1","r":"inc","e":0,"er":null,"gk":"d4cddabcf4caa22ad92fab40844c786","i":"3",...}}
[3] 硬限流阶段：紧接着 GET /status 也 429，且无挑战头：
    429 {"action":"error","status":429,"type":"ERR_RATE_LIMIT","r":"c6d8b851-d1a8-4514-9280-7d0695367d29"}
    → 冷却后（>1 分钟）GET /status 恢复 200
[4] 另一种 418 形态（同日更早出现，多在额度紧张时）：
    418 {"action":"error","message":"You appear to be using an unsupported entrypoint, please use https://duck.ai/ instead",
         "overrideCode":"8e04","status":418,"suppressErrorImpression":1,"type":"ERR_BN_LIMIT"}
```

结论：**418 / 429 与额度状态强相关，而不是挑战算法错误**。额度健康时同一套代码连续 200；额度紧张时
「挑战正确也会 418」，再恶化就连 `/status` 都 429。多个客户端共用同一出口 IP 时额度互相消耗。

- 建议实现（本项目 `DuckClient` 已内置，见 §8）：全局并发 ≤1、请求间隔 ≥1s 起、每请求 400–1500ms 随机抖动、
  418/429 时丢弃挑战并指数退避（1s/2s/4s + 抖动，最多 3 次），429 记录 `retryAt` 且不烧重试。

---

## 6. 模型目录与 reasoning

来源：官网 bundle（`recon/model-catalog.json`）+ `docs/ADMIN_API_V2.md` §4 的免费/付费划分。
Free 档位可用性以 `capabilities.accessLevel` 为准；付费模型在匿名（无订阅）会话不可用。

### 6.1 免费 / 付费划分

| 上游 `model` | 展示名 | 类型 | 档位 | Free 可用 | `reasoningEfforts` | 工具 |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-6-luna` | GPT-6 Luna | reasoning | free | ✅ | `none`, `low` | WebSearch / GenerateImage / … |
| `gpt-5.4-mini` | GPT-5.4 mini | reasoning | free | ✅ | `none`, `low`, `medium` | WebSearch / GenerateImage / … |
| `claude-haiku-4-5` | Claude Haiku 4.5 | reasoning | free | ✅ | `none`, `low` | WebSearch / … |
| `mistral-small-2603` | Mistral Small 4 | general | free | ✅ | — | — |
| `tinfoil/gpt-oss-120b` | gpt-oss 120B | reasoning | free | ✅ | `low` | WebSearch / …（加密） |
| `tinfoil/gemma4-31b` | Gemma 4 31B | reasoning | free | ✅ | `none`, `low` | WebSearch / …（加密） |
| `gpt-5.6-terra` | GPT-5.6 Terra | reasoning | plus | ❌ 需订阅 | `none`, `low`, `medium` | 全工具 |
| `gpt-5.6-sol` | GPT-5.6 Sol | reasoning | pro | ❌ 需订阅 | `none`, `low`, `medium` | 全工具 |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | reasoning | plus | ❌ 需订阅 | `none`, `low` | 全工具 |
| `claude-opus-5-5` | Claude Opus 5.5 | reasoning | pro | ❌ 需订阅 | `none`, `low`, `medium` | 全工具 |

> `claude-haiku-5-5` 在官网 bundle 中存在（Internal 档位），但不对外暴露、`src/duck/models.js` 不收录。

### 6.2 元数据字段（`src/duck/models.js` / `DuckClient.getModelCatalog()`）

每个模型包含：`model`、`id`、`displayName`/`display_name`、`createdBy`/`owned_by`、`modelType`、
`tier`（`free|plus|pro`）、`paid`、`available`、`requires_subscription`、`reasoningEfforts`/
`supportedReasoningEfforts`/`supported_reasoning_efforts`、`tools`（API 名：`web_search`/`image_generation`）、
`supportedTools`（上游工具名：`WebSearch`/`GenerateImage`/…）、`tiers`、`default`、`costRank` 等。

网关行为（`docs/ADMIN_API_V2.md` §4）：

- `duck.allowPaidModels` 默认 `false`：`/v1/models` 仍列出付费模型，但 `paid:true, available:false, requires_subscription:true`；
  对它们发请求由 API 层直接返回 `403 model_requires_subscription`（不消耗上游额度）。
- `allowPaidModels=true` 时才会请求上游；匿名上游通常返回 `ERR_MODEL_RESTRICTED`（403）或 `ERR_ACCOUNT_LIMIT`，
  按 `docs/PROTOCOL-ERRORS.md` §9 映射。
- `resolveModelAvailability(id, {allowPaidModels})`（`src/duck/models.js`）给出 `{found, available, paid, tier, reason}`，
  供 API 层实现 403 判定。

### 6.3 reasoning 与被测状态

- 默认模型：`gpt-6-luna`（Free 可用）。
- `reasoningEffort` 取值域 `none|minimal|low|medium|high`；模型不支持时 `DuckClient` 自动降级到
  「不高于请求档位的最高支持档位」（如 `gpt-6-luna` + `medium` → `low`）。
- 模型目录数据在 `src/duck/models.js`；别名（`gpt-6` / `duck-*` 前缀）也在此维护。
- **付费模型匿名响应待验证**：2026-11-02 逐个探测时首个 `gpt-5.6-terra` 即遇匿名额度冷却
  （传输层 `418 ERR_BN_LIMIT`，`overrideCode:8e04`），按约定立即停止；待额度恢复后各试 1 次并回填本节。
- **推理内容**：Free 匿名档 reasoning 以 JWE 密文下发（`reasoningEncrypted:true`，无明文），详见 §4.5；
  付费档是否给明文 `summaryText` 待验证。

---

## 7. 可复现验证命令

所有命令在 `duckai-cpa/` 目录执行；前置：`node >= 20`、`jsdom` 已安装（`node_modules/jsdom`）。
**注意**：真实上游有匿名额度，验证请串行、少量，间隔 1s 以上。

### 7.1 文本对话（流式）

```bash
node --input-type=module -e "
import { DuckClient } from './src/duck/index.js';
const client = new DuckClient();
console.log(await client.init().then(h => ({ ok: h.ok, version: h.version, challengeOk: h.challengeOk })));
const res = await client.chat(
  { model: 'gpt-6-luna', messages: [{ role: 'user', content: '用一句话说明为什么天空是蓝色的。' }] },
  { onTextDelta: (t) => process.stdout.write(t) }
);
console.log('\n---', JSON.stringify({ sources: res.sources.length, effort: res.reasoningEffort, events: res.rawEvents.length }));
"
```

### 7.2 多轮 + 滚动挑战

```bash
node --input-type=module -e "
import { DuckClient } from './src/duck/index.js';
const client = new DuckClient();
await client.init();
const r1 = await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: '我叫小明，请记住。' }] });
const r2 = await client.chat({ model: 'gpt-6-luna', messages: [
  { role: 'user', content: '我叫小明，请记住。' },
  { role: 'assistant', content: r1.cleanContent },
  { role: 'user', content: '我叫什么名字？' }
] });
console.log(r1.cleanContent, '|', r2.cleanContent);
console.log((await client.health()).challenge);   // solves=2, rollingChallenges=1, statusFetches=1
"
```

### 7.3 联网搜索

```bash
node --input-type=module -e "
import { DuckClient } from './src/duck/index.js';
const client = new DuckClient();
await client.init();
const res = await client.chat(
  { model: 'gpt-6-luna', messages: [{ role: 'user', content: '2026年11月1日纽约今天天气如何？' }], webSearch: true },
  { onSearchResults: (sources) => console.log('sources:', sources.length, sources[0]) }
);
console.log(res.cleanContent);
console.log(res.sources.map((s) => s.url));
"
```

### 7.4 图片生成

```bash
node --input-type=module -e "
import fs from 'node:fs';
import { DuckClient } from './src/duck/index.js';
const client = new DuckClient();
await client.init();
const out = await client.imageGeneration({ prompt: '画一只戴墨镜的卡通鸭子' });
console.log(out.images.length, out.images[0].format, out.images[0].b64.length, out.modelDisplayName);
fs.writeFileSync('data/tmp/duck.png', Buffer.from(out.images[0].b64, 'base64'));
"
```

### 7.5 挑战求解单独验证

```bash
node --input-type=module -e "
import { ChallengeManager } from './src/duck/challenge.js';
const challenge = new ChallengeManager();
console.log(await challenge.init());               // { version, challengeReady: true }
const r = await challenge.refresh();               // 重新 GET /status + 求解
console.log(r);                                     // { solved: true, headerLen: ~1200 }
console.log(challenge.stats());
"
```

### 7.6 已知开发期脚本（gitignored，仅供本机排查）

`duckai-cpa/data/tmp/` 下的 `probe-challenge.mjs`、`raw-client.mjs`、`test-client-text.mjs`、
`test-client-search.mjs`、`test-client-image.mjs` 是协议探针；它们不提交。
Lead 的浏览器抓包参考脚本在 `duckai-cpa/recon-tmp/`（`solver-ref.mjs`、`rolling.mjs`）。

---

## 8. 实现映射（`src/duck/**`）

| 文件 | 职责 |
| --- | --- |
| `challenge.js` | 版本发现、`/status` 取挑战、jsdom 求解、滚动状态机（pending/solved）、互斥锁（同一时刻只有一个请求消费/更新挑战）、重取/失效 |
| `sse.js` | SSE 行解析、事件归一化（text/reasoning/tool-call/tool-result/ui-component/source/image/generated-image/partial-image/refusal/continuation/skill-references/image-validated/limit/stop-reason/伪事件）、严格模式校验、citation 提取与 markdown 化、脱敏摘要 |
| `index.js` | `DuckClient` / `DuckError`：请求头、body 构造、多轮历史、工具开关、reasoning 降级、humanize（并发/间隔/抖动）、重试与退避、限流冷却、**v2 严格协议校验与即时中断**、错误映射 `mapUpstreamError`、健康检查 |
| `models.js` | 模型目录（免费/付费、tier/availability/tools/displayName）、别名、默认模型、可用性判定 |

### 8.1 humanize（拟人化 / 反风控）配置

`new DuckClient({ humanize: { ... } })`：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时关闭所有间隔/抖动（仅调试用，慎用） |
| `concurrency` | `1` | 全局上游并发上限（聊天/图片请求槽位；挑战刷新发生在槽位内） |
| `minIntervalMs` | `1000` | 相邻上游请求最小间隔 |
| `minDelayMs` / `maxDelayMs` | `400` / `1500` | 每请求随机抖动区间 |
| `maxRetries`（别名 `retries`） | `3` | 418/429/5xx 最大重试次数（对应退避 1s/2s/4s） |
| `retryBaseDelayMs` | `1000` | 指数退避基数（额外叠加 0–250ms 抖动与 `Retry-After`） |
| `rateLimitCooldownMs` | `60000` | 429 后冷却窗口（无 `Retry-After` 时使用） |
| `rateLimitWaitMs` | `5000` | `chat()` 愿意为冷却阻塞的最长时间，超过则直接抛 429（带 `retryAfterMs`/`retryAt`） |

`health()` 暴露：`ok`、`upstreamStatus`、`challengeOk`、`version`、`strictProtocol`、`rateLimited`、`retryAt`、
`challenge.{solves, solveErrors, statusFetches, rollingChallenges, externalChallenges, lastSolveSource, solvedAgeMs}`、
`stats.{requests, success, failures, retries, limitHits418, limitHits429, consecutiveFailures, lastStatus}`、
`recentErrors[]`（含 `status/type/code/upstreamType/retriable/transportStatus/body/eventIndex/detail/partial/challengeSource/attempt`，
全部经 `redactSnippet()` 脱敏，不含 base64 / moderationToken / 原始帧）。

`DuckClient` 的其他配置：`warmup`（默认 `true`，init 预热一个挑战）、`strictProtocol`（默认 `true`，见 §2.7）、
`systemPromptMode`（默认 `'prefix'`）、`strictInit`（默认 `false`，init 失败不抛错）、`defaultModel`、`timeoutMs`、
`challenge.*`（透传给 `ChallengeManager`：`versionTtlMs`/`challengeTtlMs`/`statusTimeoutMs`/`solveTimeoutMs`/`userAgent`）。

### 8.2 与浏览器行为的对齐清单

| 行为 | 浏览器 | 本实现 |
| --- | --- | --- |
| 挑战求解环境 | 同源隐藏 iframe | jsdom 页面源（`window.eval`），UA 一致 |
| 挑战滚动 | 消费响应头新挑战 | ✅ `ChallengeManager` pending→solved 状态机 |
| `x-fe-signals` | `{start,events:[],end}` | ✅ 每请求重新生成 |
| `journey-id` | 会话固定 | ✅ 构造时生成一次 |
| `response-id` | 每请求随机 uuid | ✅ 每请求 `crypto.randomUUID()` |
| 工具开关 | `metadata.toolChoice` | ✅ `webSearch` / `imageGeneration` 参数映射 |
| 请求节奏 | 人类打字间隔 | ✅ 并发 1 + ≥1s 间隔 + 400–1500ms 抖动 |
| system 角色 | 不支持（inline 到首条 user） | ✅ 默认 `prefix` 模式 |

---

## 9. A/B 实验记录（受匿名额度限制，部分待补测）

Lead 要求验证「418 是否与 UA 一致性 / init 预热 / 请求间隔相关」。真实上游请求受共用出口 IP 的匿名额度限制，
无法在本次窗口内跑完全部对照组，下面区分【已观测】与【待验证】。

| 变量 | 对照组 | 结论 | 状态 |
| --- | --- | --- | --- |
| 求解环境 UA 与请求头 UA 是否一致 | 一致（`resources.userAgent=header UA`） | 一致时大量 200（文本/多轮/搜索/图片均成功过） | 已观测 |
| 同上 | 不一致（jsdom 默认 UA 写进 client_hashes） | 未跑完（额度耗尽）；无证据表明更好 | 待验证 |
| `init()` 是否预热挑战 | 预热 | 预热后可正常使用；首个请求偶发 418，重取 `/status` 后成功 | 已观测 |
| 同上 | 不预热（首个 chat 自行取挑战） | 未跑完 | 待验证 |
| 请求间隔 | 1–2s（DuckClient 默认） | 额度健康时可连续 200；额度紧张时 418/429 | 已观测 |
| 同上 | 12s | 未消除 418（额度紧张期连续 3 次 418） | 已观测 |
| 同上 | 14s（Lead 的 E2E） | Lead 侧 6/6 全过（额度健康期） | 已观测（Lead） |

**当前判断**：418 的主要驱动因素是**匿名额度/软风控状态**，而不是 UA、warmup 或间隔的算法性问题；
在额度健康时，同一套实现（UA 一致 + 预热 + 1s+ 间隔 + 滚动挑战）可以稳定 200。
额度紧张时任何参数组合都可能 418，唯一有效手段是冷却 + 退避重试（丢弃挑战 → 重新 `/status`）。
待额度恢复后可按 §9.1 脚本补测剩余两组。

### 9.1 补测脚本（gitignored，本机 `duckai-cpa/data/tmp/test-pacing.mjs`）

```bash
# 对照组 A：UA 一致 + 预热 + 12s 间隔
INTERVAL=12000 WARMUP=1 UAMODE=consistent CHATS=3 node data/tmp/test-pacing.mjs
# 对照组 B：UA 不一致
INTERVAL=12000 WARMUP=1 UAMODE=inconsistent CHATS=3 node data/tmp/test-pacing.mjs
# 对照组 C：不预热
INTERVAL=12000 WARMUP=0 UAMODE=consistent CHATS=3 node data/tmp/test-pacing.mjs
```

判定口径：`health().stats.limitHits418`、`recentErrors[].type/code`、每次 chat 的 `requests/retries`。
脚本产出 `data/tmp/ab-<uaMode>-warm<0|1>-<interval>.json`。

---

## 10. 未决 / 风险

1. **418 两种形态**：`ERR_CHALLENGE`（`dd89`/`f741`/`3501`）与 `ERR_BN_LIMIT`（`8e04`，"unsupported entrypoint"）。
   实测与额度/软风控状态强相关：额度健康时同样的实现连续 200；额度紧张时挑战正确也 418，再恶化 `/status` 直接 429。
   处理方式：丢失挑战 → 重新 `/status` → 指数退避重试，最多 3 次；仍失败抛 `DuckError`（`retriable=true`）。
   **v2 映射**：`ERR_CHALLENGE` → 403 `upstream_anomaly_check`（`cd` 是 anomaly tile 挑战，网关不可解；与 api-core 错误映射对齐），
   `ERR_BN_LIMIT` → 429 `upstream_rate_limited`；传输层 418 仍先重试自愈。
2. **匿名额度**：额度窗口与阈值未精确测得（共用出口 IP 时互相消耗，多 agent 并行测试会很快烧穿）；网关必须串行 + 退避，
   禁止并发刷；对外文档需明确「匿名额度有限，额度窗口恢复后可继续」。
3. **付费模型匿名行为待验证**：`gpt-5.6-terra` / `gpt-5.6-sol` / `claude-sonnet-5-5` / `claude-opus-5-5`
   在无订阅会话下的真实响应尚未抓包（2026-11-02 探测首个模型即遇 `418 ERR_BN_LIMIT`，按约定立即停止）。
   源码预期为 `ERR_MODEL_RESTRICTED`（403）/`ERR_ACCOUNT_LIMIT`（403）；待额度恢复后各试 1 次回填 §6.3。
4. **推理事件（reasoning）**：真实形态已抓包（§4.5）：Free 匿名档只有 `state:"done"` + 空 `summaryText`
   + `encryptedText`（JWE），网关拿不到明文推理；实现已归一化并给出 `reasoningEncrypted` 标记，
   `rawEvents` 保留原帧。付费档明文形态待验证。
5. **`x-fe-version` 更新**：上游发版后首页 `data-version-tag/sha` 变化，`/status` 可能返回 4xx；实现里版本缓存 30 分钟，
   失败会重新抓首页。建议 `/healthz` 暴露 `version` 便于发现漂移。
6. **挑战 JS 变体**：混淆 JS 内含环境自检；若某次求解在 jsdom 中抛错，`ChallengeManager` 记录 `solveErrors`
   并在下次请求重取挑战。真出现系统性失败时，备选方案是用真实浏览器执行（本环境无浏览器）。
7. **`role:"system"`**：当前版本 400；若上游后续支持，可通过 `systemPromptMode: 'system'` 直接启用（已实现自动降级）。
8. **严格模式的误杀风险**：`strictProtocol:true` 依赖 §4.7.1 的 role 白名单。若上游新增事件 role 而网关未同步，
   会按协议错误中断（502 `upstream_protocol_mismatch`）。出现该情况时：先看 `health().recentErrors[].detail/snippet`
   确认 role，再更新 `src/duck/sse.js` 白名单并补 PROTOCOL 文档；应急可临时 `strictProtocol:false`。
   **已做真实回归（2026-11-02，额度冷却期少量请求）**：`gpt-6-luna` 文本 200（事件 title/text/done，role=assistant）
   与 `reasoningEffort:"low"` 200（事件 title/reasoning/text/done）均未被严格模式误杀。
9. **离线回归**：`data/tmp/offline-checks.mjs`（17 项协议基础）+ `data/tmp/v2-strict-tests.mjs`
   （22 项 v2 严格模式 mock：响应头校验/JSON 失败/未知 role/error 帧/缺 DONE/图片缺失/额度标记/拒答/
   传输层 418 重试/429 冷却/非严格模式/模型目录）在无网络环境全部通过；正式单测由 QA 的 `tests/` 覆盖。

---

## 11. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-01 | 初版：挑战求解、文本/多轮/搜索/图片链路、限流实测、模型目录、humanize 配置 |
| 2026-11-02 | **v2**：`strictProtocol` 严格校验（§2.7/§4.7）；SSE role 白名单与 `[DONE]` 行内标记；`generated-image`/`partial-image`/`refusal`/`continuation`/`skill-references`/`image-validated` 事件；免费/付费模型元数据（§6）；错误映射表（`docs/PROTOCOL-ERRORS.md`）；推理事件形态逆向确认（§4.5） |


