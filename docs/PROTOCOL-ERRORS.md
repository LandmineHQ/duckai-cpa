# Duck.ai 错误处理与异常分析（源码逆向 + 实测）

> 产出：`协议层`（）。来源：`recon/entry.duckai.2d2656b1fcd20ced62d9.js`（duck.ai Web 前端 bundle）、
> `recon/allchunks.js`、`recon/TEAM-NOTES.md` 抓包，以及 2026-11-01/02 的真实上游实测。
> 目的：让 `docs/PROTOCOL.md` 的「正常路径」之外，把「异常路径」也固化下来，供 `src/duck/**`（已实现）
> 与 `src/openai/**`（错误映射）直接引用。
>
> 阅读顺序建议：§1 帧与伪事件 → §2 错误对象 → §3 ERR_* 清单 → §4 客户端处理行为 → §5 anomaly/captcha
> → §6 moderation/refusal → §7 continuation/409 → §8 流中断与重连 → §9 网关映射表（网关后端 直接用）。

---

## 1. SSE 帧解析（bundle 实现）

前端通过 `fetch` 流式读取，按行把每个 `data:` 帧交给解析函数（bundle 中 `re({streamData, ...})`）。行为：

| 判断顺序 | 条件 | 处理 |
| --- | --- | --- |
| 1 | 帧文本匹配 `[PING]` | 忽略（保活） |
| 2 | 帧文本匹配 `[CHAT_TITLE:(.*)]` | 标题更新回调 |
| 3 | 帧文本匹配 `[DONE]` | **终止帧**；同时解析同行附加标记（见 §1.2） |
| 4 | JSON 解析成功且 `role === "continuation"` | continuation 回调（见 §7） |
| 5 | JSON 解析成功且 `role === "skill-references"` | 技能引用（校验 `action:"success"` + `skills[].source === "bundled"`，否则抛 `ERR_RESPONSE_PARSING`） |
| 6 | JSON 解析失败 | 浏览器**忽略**该帧（不抛错）；网关严格模式视为协议错误 |
| 7 | `action !== "success"` | `action:"error"` → 抛 `ERR_*`；其他 action → 抛 `ERR_INVALID_ACTION` |
| 8 | `role` 在白名单内 | 分发到消息聚合（见 §1.1） |
| 9 | `role` 不在白名单 | 浏览器**静默忽略**；网关严格模式视为协议错误 |

### 1.1 已知 SSE role 白名单（bundle 中的判断链）

| role | 子字段 | 含义 | 浏览器行为 |
| --- | --- | --- | --- |
| `assistant`（或无 role 但有 `message`） | `message` | 正文增量 | 追加文本 |
| `reasoning` | `state`: `part-start` / `text-delta` / `text-done` / `part-end` / `done`；`text`、`summaryText[]`、`encryptedText`、`redacted` | 推理增量 | 追加 `reasoning-progress` / `reasoning` 内容（`done` 用 `summaryText`） |
| `tool-invocation` | `state:"call"` → `toolCallId, toolName, toolArguments`；`state:"result"` → `toolCallId, result, data` | 工具调用/结果 | 追加 tool-call/tool-result 内容 |
| `source` | `source:{url,title,site}`、`toolCallId` | 引用来源（WebSearch） | 追加 source 内容 |
| `generated-image` | `id, result(Base64), width, height, format, moderationToken?` | 最终图片（新协议形态） | 追加 generated-image 内容 |
| `partial-image` | `id, result(Base64), width, height, format` | 图片预览分片 | 更新/忽略 partial-image |
| `ui-component` | `state:"placement"`/`"data"`；`id, name, data` | UI 组件（search-results / generate-image / greeting / permission-prompt / writing-block） | 追加/更新组件；未知 `name` → `ERR_RESPONSE_PARSING` |
| `refusal` | `detectedBy:"api"` 等 | 模型拒答 | 标记 `hasRefusal`，流结束后按 `ERR_REFUSAL` 处理 |
| `image-validated` | `tokens:[{messageIndex,kind,partIndex,moderationToken}]` | 图片审核 token 回填 | 更新消息 moderationToken |
| `continuation` | `action:"success"`, `token`, `pendingActions[]`, `replayPolicy?`, `consentDecisions?`, `responses?` | 客户端工具/授权续传 | 渲染授权提示；收集后重发（见 §7） |
| `skill-references` | `action:"success"`, `skills:[{source:"bundled"\|"browser", name}]` | 技能引用 | 写入用户消息元数据 |

### 1.2 `[DONE]` 行内附加标记（HTTP 200 的“软错误”）

`[DONE]` 不是简单字符串——上游会把配额/停止原因等标记**追加在同一行**。前端用正则提取，网关必须同样解析：

| 标记 | 内容 | 含义 | 浏览器行为 |
| --- | --- | --- | --- |
| `[FIXED_COST_WINDOW_USAGE:<urlencoded JSON>]` | `{windows:[{id,percentUsed,resetAt,isBlocked,isBypassed?}]}` | 额度窗口用量 | 更新额度状态；`isBlocked` 时后续请求进入 blocked |
| `[SUMMARY_REFRESH_HINT:<urlencoded JSON>]` | `{trigger:"tokens",baseCoveredPairCount?,targetPairCount,thresholdTokens?}` | 会话摘要刷新建议 | 触发摘要刷新 |
| `[SUMMARY_INVALID]` | — | 摘要失效 | 触发摘要重建 |
| `[ADS:<json>]` | `{windowID}` | 广告窗口 id | 记录 windowID |
| `[LIMIT_ACCOUNT]` | — | 账号额度耗尽 | 抛 `ERR_ACCOUNT_LIMIT`（HTTP 仍 200） |
| `[LIMIT_ENTITY]` | — | 用户/IP 额度耗尽 | 抛 `ERR_USER_LIMIT`（HTTP 200） |
| `[LIMIT_CONVERSATION]` | — | 会话 token 上限 | 抛 `ERR_CONVERSATION_LIMIT`（HTTP 200）+ 自动压缩上下文 |
| `[LIMIT_IMAGE_GENERATIONS]` | — | 图片生成额度耗尽 | 抛 `ERR_IMAGE_GENERATION_LIMIT`（HTTP 200） |
| `[STOP_REASON:<reason>]` | `max_tokens` 等 | 生成停止原因 | `max_tokens` → 视为 `ERR_MAX_TOKENS` 失败（网关映射 `finish_reason:"length"`） |
| `[WARN_CONVERSATION_LIMIT:<n>]` | 百分比 | 接近会话上限预警 | UI 提示 |

> 网关实现：`src/duck/sse.js parseDoneFrame()` 已解析以上全部标记，归一化为
> `quota` / `summary-refresh-hint` / `summary-invalid` / `ad-window` / `limit` / `stop-reason` /
> `conversation-limit-warning` 事件；`DuckClient` 对 `limit` / `refusal` / `stop-reason` 做映射。

---

## 2. 错误对象模型

### 2.1 HTTP 非 2xx 响应（`fetch` 失败路径）

前端在 `onopen` 中判断 `!response.ok || content-type !== "text/event-stream"`，然后解析 JSON body：

```json
{
  "action": "error",
  "status": 418,
  "type": "ERR_CHALLENGE",
  "overrideCode": "dd89",
  "r": "<reason / request id>",
  "cd": { "cc": "duckchat", "gk": "...", "p": "...", "o": "...", "s": "...", "r": "...", "i": "3", "er": null, "e": 0 },
  "message": "可选的服务端文案",
  "fixedCostWindowUsage": { "windows": [ { "id", "percentUsed", "resetAt", "isBlocked" } ] },
  "suppressErrorImpression": 1,
  "retriable": true,
  "supportCode": "sc22"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `action` | string | `"error"`；`"continuation-restart-required"` 用于 409（见 §7） |
| `status` | number | HTTP 状态码副本（框架内会解析） |
| `type` | string | `ERR_*` 错误码（see §3） |
| `overrideCode` | string | 4 位十六进制支持码（如 `dd89`、`8e04`、`f741`、`3501`；2026-11-06 观察到 `975b`=缺失/initial、`f741`=`q7klm` 布局 suite 指纹不符、`d78d`=`vz95n` 页面态 suite 指纹不符） |
| `r` | string | reason / request id（`ERR_RATE_LIMIT` 时是 UUID 请求 id） |
| `cd` | object | **anomaly 挑战数据**（见 §5），仅 `ERR_CHALLENGE` 使用 |
| `message` | string | 服务端文案（`serverMessage`） |
| `fixedCostWindowUsage` | object | 额度窗口（`windows[]`），驱动 blocked/degraded 状态 |
| `suppressErrorImpression` | 0/1 | 不上报错误曝光埋点 |
| `retriable` | bool | 上游显式声明是否可重试（缺失时按错误码默认） |
| `supportCode` | string | `sc19`–`sc25` 支持码（见 §4.1） |

### 2.2 流内错误帧（HTTP 200 + `data: {"action":"error",...}`）

```json
{"action":"error","status":429,"type":"ERR_RATE_LIMIT","fixedCostWindowUsage":{...},"retriable":true,"supportCode":"sc19"}
```

前端只取 `type`（缺省 `ERR_UNKNOWN`）、`status`、`fixedCostWindowUsage`、`retriable`、`supportCode` 构造错误；
`overrideCode`/`cd`/`r` 在流内错误帧**不解析**（只有 HTTP 错误路径解析）。网关实现保留完整原文用于诊断。

### 2.3 内部错误编码（仅供理解，不需要复刻）

前端把错误对象序列化成 `type<>status<>overrideCode<>reason<>challengeData<>fixedCostWindowUsage<>suppressImpression<>retriable<>supportCode<>serverMessage` 字符串在 React 状态里传递；
`retriable` 字段语义：`"1"`=true、`"0"`=false、空=undefined。`supportCode` 会加 `-s`（订阅用户）/`-i`（Internal）后缀。

---

## 3. `ERR_*` 全量清单

bundle 中一共扫到 **153 个唯一 `ERR_*` 标识**（含同步/语音/文件等非聊天链路）。下表按「与网关相关度」分组；
「网关映射」列为 `src/duck/index.js mapUpstreamError()` 的实现（OpenAI 层见 §9）。

### 3.1 聊天 / 限流 / 额度（网关必须处理）

| 错误码 | 浏览器含义 / 处理 | 网关映射 HTTP | 网关 error.code | OpenAI error.type | 可重试 |
| --- | --- | --- | --- | --- | --- |
| `ERR_CHALLENGE` | 反爬挑战（有 `cd` 时弹出 anomaly 挑战，成功后可自动重试一次） | 403 | `upstream_anomaly_check` | permission_error | ❌（网关无法解 captcha） |
| `ERR_BN_LIMIT` | 软风控/入口限制（"unsupported entrypoint"），前端提示联系客服 | 429 | `upstream_rate_limited` | rate_limit_exceeded | ✅（传输层 418 会重试） |
| `ERR_RATE_LIMIT` | 请求频率限制，前端显示 Retry 按钮 | 429 | `rate_limit_exceeded` | rate_limit_exceeded | ✅ |
| `ERR_USER_LIMIT` | 用户额度（匿名/Free 额度），引导订阅 | 429 | `user_limit_exceeded` | rate_limit_exceeded | ✅ |
| `ERR_ACCOUNT_LIMIT` | 账号/订阅额度（Plus/Pro 用量），引导升级 | 403 | `upstream_subscription_required` | model_unavailable | ❌ |
| `ERR_CONVERSATION_LIMIT` | 会话 token 上限，前端自动压缩上下文后再试 | 429 | `conversation_limit_exceeded` | rate_limit_exceeded | ❌（网关无自动压缩） |
| `ERR_IMAGE_GENERATION_LIMIT` | 图片生成额度 | 429 | `image_generation_limit_exceeded` | rate_limit_exceeded | ✅ |
| `ERR_SERVICE_LIMIT` | 服务/容量限制 | 429 | `service_limit_exceeded` | rate_limit_exceeded | ✅ |
| `ERR_INPUT_LIMIT` | 输入超长 | 413 | `context_length_exceeded` | invalid_request_error | ❌ |
| `ERR_SELECTION_INPUT_LIMIT` | 选区输入超长 | 413 | `context_length_exceeded` | invalid_request_error | ❌ |
| `ERR_OUTPUT_LIMIT` | 输出上限 | 200 + finish_reason length | `max_tokens` | — | ❌ |
| `ERR_MAX_TOKENS` | 达到 max tokens | 200 + finish_reason length | `max_tokens` | — | ❌ |

### 3.1.1 `ERR_BN_LIMIT` / "unsupported entrypoint" 触发原因（v2.21 分析）

上游 429 响应体形如：

```json
{"action":"error","status":429,"type":"ERR_BN_LIMIT","message":"You appear to be using an unsupported entrypoint, please use https://duck.ai/ instead"}
```

这不是普通频率限流，而是**入口/自动化检测**。真实浏览器请求（Chrome + 外部工具 抓包）与网关请求的差异：

| 信号 | 真实浏览器（200） | 网关旧实现（会被判定 unsupported） |
| --- | --- | --- |
| `x-vqd-hash-1`.meta.stack | `Error\nat l (https://duck.ai/dist/duckai-dist/entry.duckai.<当前hash>.js:2:2151366)\nat async …` | `Error\nat stackText (file:///C:/…/src/duck/challenge.js:76:15)\nat ChallengeManager._solveLocked (file:///…)\nat process.processTicksAndRejections (node:internal/…)` |
| `x-vqd-hash-1`.meta.duration | `"42"`（毫秒，浏览器内解算） | `"3xx–4xx"`（jsdom 解算，明显更慢） |
| `x-fe-signals` | 真实交互事件：`{start,events:[{name:"startNewChat_free",...},{name:"action",...,"trusted":true}],end}` | `{start,events:[],end}`（空事件） |
| 浏览器指纹头 | `cookie: ddg_auth_session_id=…; duckai_experiment_*=…`、`sec-ch-ua`、`sec-ch-ua-platform`、`sec-ch-ua-mobile`、`sec-fetch-*`、`priority` | 无 cookie / 无 client hints |
| 入口 bundle | homepage 的 `/dist/duckai-dist/entry.duckai.965285ea097e2b920cc8.js`（与 stack 中的 hash 一致） | 请求 stack 指向本地源码路径 |

**结论（证据强度排序）：**

1. **最强证据：`meta.stack` 指向本地文件系统。** 上游把 challenge 的 stack 当作“请求是否来自
   duck.ai 官方入口 bundle”的证据；浏览器 stack 的每一帧都指向当前部署的
   `entry.duckai.<hash>.js`，而 Node 原生 stack 暴露 `file:///C:/…` / `node:internal`，
   与入口 bundle 完全无关 → `ERR_BN_LIMIT`。
2. **次级信号：`meta.duration` 偏大**（jsdom 解算 300–400ms vs 浏览器 ~40ms），以及
   `x-fe-signals` 为空。它们可能参与风险评分，但单凭它们不会有 "unsupported entrypoint" 文案。
3. **环境信号：缺少 cookie 与 `sec-ch-ua*` / `sec-fetch-*` 头。** 属于指纹差异，可能加重判定，
   但不是入口检查的直接依据（否则所有匿名请求都会失败）。

**v2.21 修复（`src/duck/challenge.js` + `src/duck/index.js`）：**

- 从 homepage HTML 解析当前入口 bundle 路径（`/dist/duckai-dist/entry.duckai.<hash>.js`），
  `meta.stack` 生成与浏览器同形态的帧：
  `Error\nat l (https://duck.ai<entry>:2:2151366)\nat async https://duck.ai<entry>:2:1869472`；
- `x-fe-signals` 生成非空事件（首次 `startNewChat_free` + `action{trusted:true}`，之后 `action`）；
- 排障开关：`DUCKAI_NATIVE_STACK=1` 恢复原生 stack、`DUCKAI_EMPTY_SIGNALS=1` 恢复空信号；
- 单测：`tests/entrypoint-meta.test.js`（6 例）。

> 仍未验证：`meta.duration` 是否参与判定（未改动真实耗时；若错误复现，下一步是把 duration
> 缩放到浏览器区间并透传 cookie）。修复后实测连接测试 200，但“不出现 ERR_BN_LIMIT”需要更长时间的
> 线上观察才能宣称彻底解决。

### 3.2 聊天 / 服务 / 模型

| 错误码 | 含义 | 网关映射 HTTP | 网关 code | 可重试 |
| --- | --- | --- | --- | --- |
| `ERR_SERVICE_UNAVAILABLE` | 服务不可用（前端 retry:true） | 503 | `upstream_unavailable` | ✅ |
| `ERR_SERVICE_OFFLINE` | 服务离线 | 503 | `upstream_offline` | ✅ |
| `ERR_NETWORK` | 浏览器网络错误（fetch 失败） | 503 | `upstream_network_error` | ✅ |
| `ERR_BAD_REQUEST` | 请求无法处理（前端 retry:true） | 400 | `bad_request` | ❌ |
| `ERR_UNKNOWN` | 未知错误（默认兜底） | 502 | `upstream_error` | ✅ |
| `ERR_UPSTREAM` | 上游模型错误，前端建议切换模型 | 502 | `upstream_error` | ✅ |
| `ERR_EMPTY_RESPONSE` | 空响应 | 502 | `upstream_empty_response` | ✅ |
| `ERR_INVALID_ACTION` | 事件 action 非法 / 409 续传失效 | 502 | `upstream_invalid_action` | ❌ |
| `ERR_RESPONSE_PARSING` | 响应解析失败（未知组件/非法角色） | 502 | `upstream_response_parsing` | ❌ |
| `ERR_MODEL_RESTRICTED` | 模型需要订阅（引导激活） | 403 | `model_requires_subscription` | ❌ |
| `ERR_MODEL_UNAVAILABLE` | 模型不可用 | 404 | `model_not_found` | ❌ |
| `ERR_MODEL_DEPRECATED` | 模型已弃用 | 410 | `model_deprecated` | ❌ |
| `ERR_MODEL_REMOVED` | 模型已下架 | 410 | `model_removed` | ❌ |

### 3.3 内容安全 / 上传

| 错误码 | 含义 | 网关映射 |
| --- | --- | --- |
| `ERR_REFUSAL` | 模型拒答（`role:"refusal"` 归一结果） | 403 `content_filter`（不可重试） |
| `ERR_MODERATION_FLAG` | 文本/图片审核拦截 | 403 `content_filter` |
| `ERR_MODERATION_UNAVAILABLE` | 审核服务不可用 | 503 `moderation_unavailable`（可重试） |
| `ERR_IMAGE_PROCESSING` | 图片处理失败 | 502 `upstream_image_processing`（可重试） |
| `ERR_IMAGE_UPLOAD_DISABLED` / `ERR_UPLOAD_CONSENT_REQUIRED` | 上传被禁用 / 需授权 | 网关不涉及上传，归入 400/403 |
| `ERR_FILE_ENCRYPTED` / `ERR_FILE_PAGE_COUNT` | 加密 PDF / 页数超限 | 网关不涉及上传 |

### 3.4 流式续传（durableStream，浏览器专用）

| 错误码 | 含义 | 浏览器处理 |
| --- | --- | --- |
| `ERR_STREAM_NETWORK` | 流断开且没有 `[DONE]`（onclose 时 `hasContent && !done`） | 显示连接错误 + Retry |
| `ERR_STREAM_EXPIRED` | 流过期（起始 > 15 分钟 / HTTP 410） | 提示不可恢复 |
| `ERR_STREAM_NOT_SAVED` | 流未保存/不可用（HTTP 404 且超过重试窗口） | 失败提示 |
| `ERR_STREAM_DECRYPTION_FAILED` / `ERR_STREAM_DECOMPRESSION_FAILED` / `ERR_STREAM_PARSE_FAILED` | JWE 解密/解压/解析失败 | 恢复失败 |
| `ERR_STREAM_PRIVATE_KEY_NOT_FOUND` / `ERR_STREAM_SETUP_USER_FAILED` | 密钥缺失 / 用户初始化失败 | 恢复失败 |

> 网关使用普通明文 SSE（`durableStream: null`），不实现端到端加密续传；上述错误若出现映射为
> `upstream_stream_*`（502/410）。

### 3.5 非聊天链路（仅记录，网关不处理）

| 分组 | 错误码 |
| --- | --- |
| 语音通话 | `ERR_VOICE_LIMIT`、`ERR_VOICE_DURATION`、`ERR_VOICE_INACTIVITY`、`ERR_VOICE_CONNECTION`、`ERR_VOICE_CONNECTION_FAILED`、`ERR_VOICE_DATA_CHANNEL_*`、`ERR_VOICE_DISABLED`、`ERR_VOICE_NO_MIC`、`ERR_VOICE_NO_MIC_PERMISSION`、`ERR_VOICE_RESPONSE_FAILED`、`ERR_VOICE_UNKNOWN` |
| 听写 | `ERR_DICTATION_SERVER`、`ERR_DICTATION_MIC_DENIED`、`ERR_DICTATION_UNSUPPORTED`、`ERR_DICTATION_EMPTY_RECORDING`、`ERR_DICTATION_TIMEOUT`、`ERR_DICTATION_SILENCE`、`ERR_DICTATION_DISABLED`、`ERR_DICTATION_UNKNOWN` |
| 同步/加密（E2E） | `ERR_SYNC_*`（约 40 个：CREDENTIALS/KEK/JWE/ENVELOPE/STORAGE/...）、`ERR_BRIDGE_*`（约 10 个）、`ERR_JWE_UNSUPPORTED_ALG/ENC`、`ERR_JWE_KID_MISMATCH` |
| 保存会话 | `ERR_SAVED_CHATS_*`、`ERR_SAVED_CHAT_*`（约 23 个：STORAGE_GET/SET/REMOVE、PARSE_JSON_ERROR、DEPRECATED_VERSION、UNSUPPORTED_VERSION、EXPORT、SHARE、CAPACITY_REACHED_ALL_PINNED…） |
| 订阅/营销 | `ERR_OPEN_SUBSCRIPTION_PURCHASE/UPGRADE/SETTINGS/ACTIVATION`、`ERR_BONUS_DISABLED`、`ERR_BONUS_INELIGIBLE`、`ERR_CAMPAIGN_ENDED`、`ERR_CAMPAIGN_NOT_FOUND` |
| 鉴权 | `ERR_AUTH_V1_TOKEN`、`ERR_AUTH_NO_PAYLOAD`、`ERR_AUTH_MALFORMED_TOKEN` |
| 其它 | `ERR_INVALID_ARG_TYPE` / `ERR_INVALID_URL_SCHEME` / `ERR_INVALID_FILE_URL_HOST` / `ERR_INVALID_FILE_URL_PATH`（vendors 中 Node/URL 相关） |

---

## 4. 浏览器客户端对每类错误的处理

### 4.1 错误消息字典（bundle 中的 `ERR_* → {token, retry?, switchModel?, header?, link…}`）

| 错误码 | UI token | 附加行为 |
| --- | --- | --- |
| `ERR_NETWORK` / `ERR_STREAM_NETWORK` | `DUCKCHAT_ERROR_CONNECTION` | `retry:true`，`header.kind:"offline"` |
| `ERR_UPSTREAM` | `DUCKCHAT_ERROR_MODEL_UNAVAILABLE` | `retry:true`、`switchModel:true`、`header.kind:"model"` |
| `ERR_REFUSAL` | `DUCKCHAT_ERROR_MODEL_REFUSAL` | `switchModel:true`、`header.kind:"model"` |
| `ERR_MODERATION_FLAG` | `DUCKCHAT_ERROR_TEXT_PROCESSING` | `header:{kind:"error", title:"DUCKCHAT_ERROR_TEXT_PROCESSING_TITLE"}` |
| `ERR_USER_LIMIT` | `DUCKCHAT_ERROR_USER_LIMIT` | 帮助页 / 订阅 / 升级 Pro 链接 |
| `ERR_ACCOUNT_LIMIT` | `DUCKCHAT_ERROR_ACCOUNT_LIMIT` | 用量帮助 / 升级 Pro |
| `ERR_SERVICE_UNAVAILABLE` / `ERR_SERVICE_OFFLINE` | `DUCKCHAT_ERROR_SERVICE_UNAVAILABLE` | `retry:true` |
| `ERR_BAD_REQUEST` | `DUCKCHAT_ERROR_REQUEST_PROCESSING` | `retry:true` |
| `ERR_SERVICE_LIMIT` | `DUCKCHAT_ERROR_SERVICE_LIMIT` | 帮助页 |
| `ERR_RATE_LIMIT` | `DUCKCHAT_ERROR_RATE_LIMIT` | `retry:true` |
| `ERR_CONVERSATION_LIMIT` | `DUCKCHAT_ERROR_CONVERSATION_LIMIT` | 触发上下文自动压缩（compaction） |
| `ERR_INPUT_LIMIT` / `ERR_OUTPUT_LIMIT` | `DUCKCHAT_ERROR_INPUT_LIMIT` | — |
| `ERR_SELECTION_INPUT_LIMIT` | `DUCKCHAT_ERROR_SELECTION_INPUT_LIMIT` | — |
| `ERR_MODEL_UNAVAILABLE` | `DUCKCHAT_ERROR_MODEL_UNAVAILABLE` | `header.kind:"model"` |
| `ERR_MODEL_RESTRICTED` | `DUCKCHAT_ERROR_MODEL_RESTRICTED` | 激活订阅链接 |
| `ERR_MODEL_DEPRECATED` / `ERR_MODEL_REMOVED` | 对应 token | — |
| `ERR_EMPTY_RESPONSE` / `ERR_INVALID_ACTION` / `ERR_RESPONSE_PARSING` | `DUCKCHAT_ERROR_REQUEST_PROCESSING` | `retry:true` |
| `ERR_STREAM_EXPIRED` / `ERR_STREAM_NOT_SAVED` / `ERR_STREAM_DECRYPTION_FAILED` … | `DUCKCHAT_ERROR_STREAM_EXPIRED` | `retry:true`（部分） |
| `ERR_BN_LIMIT` / `ERR_CHALLENGE` | `DUCKCHAT_ERROR_BN_LIMIT` | 显示 `overrideCode` + 联系 `aichat-error@duckduckgo.com`（订阅用户加 `-s`） |
| `ERR_MAX_TOKENS` | `DUCKCHAT_ERROR_SERVICE_UNAVAILABLE` | 视为生成失败 |

**supportCode 字典**（错误响应里 `supportCode` 字段，UI 显示为 `sc19` 等，订阅用户加 `-s`、Internal 加 `-i`）：

| 错误码 | supportCode |
| --- | --- |
| `ERR_SERVICE_UNAVAILABLE` | `sc19` |
| `ERR_SERVICE_OFFLINE` | `sc20` |
| `ERR_UNKNOWN` | `sc21` |
| `ERR_BAD_REQUEST` | `sc22` |
| `ERR_EMPTY_RESPONSE` | `sc23` |
| `ERR_INVALID_ACTION` | `sc24` |
| `ERR_RESPONSE_PARSING` | `sc25` |

### 4.2 重试 / 中止 / 弹窗 / 继续流

| 场景 | 前端行为 |
| --- | --- |
| 错误带 `retry:true`（NETWORK / UPSTREAM / RATE_LIMIT / SERVICE_UNAVAILABLE / BAD_REQUEST / STREAM_* 等） | 消息下方显示 **Retry** 按钮；点击后 `retry_count++`（埋点 `dc_redoResponse`，含 `error_type=overrideCode||r`、`error_code=status`、`model`）并重发 |
| `ERR_CHALLENGE` 且带 `cd` | 弹 **anomaly tile 挑战**（§5）；用户完成后自动重试原请求；失败可再试（`i` 为允许重试次数） |
| `ERR_CONVERSATION_LIMIT` | 自动 **压缩上下文**（compaction）：调用摘要服务生成 checkpoint，成功后自动重发；失败则提示 |
| `ERR_USER_LIMIT` / `ERR_ACCOUNT_LIMIT` / `ERR_IMAGE_GENERATION_LIMIT` + `fixedCostWindowUsage` | 进入 `blocked` 状态；`canUseCurrentDegradedModel` 为真时提供 **降级模型** 选择（`degradedModelOptions`），可选 `x-duckai-bypass-fixed-cost-windows` 绕过窗口 |
| `ERR_MODEL_RESTRICTED` | 显示激活订阅引导，可切换模型 |
| `ERR_REFUSAL` / `ERR_MODERATION_FLAG` | 显示拒答/内容处理错误，建议切换模型；不自动重试 |
| 流内 `role:"refusal"` | 标记 `hasRefusal`；流正常结束后整体按 `ERR_REFUSAL` 处理（`detectedBy:"api"`） |
| 流断开且没有 `[DONE]`（`onclose` 时 `hasContent && !done`） | 抛 `ERR_STREAM_NETWORK`（可重试）；durable stream 客户端走 §8 重连 |
| 离线/上线 | 监听 `online` 事件：若当前 status 为 `error` → 触发 `SERVICE_STREAM_RESTART_RECONNECTION` |
| 用户手动停止 | `AbortController.abort()`；上报 `CANCELLED / user_stopped` |

### 4.3 埋点字段（排障参考）

错误埋点 `dc_*` 的关键字段：`error_type = overrideCode || r`、`error_code = status`、`model`、`retry_count`、
`supportCode`、`suppressErrorImpression`；`Gw` 集合中的错误码不重复上报 `send_error`。

---

## 5. anomaly / captcha（`ERR_CHALLENGE` + `cd`）

`418 ERR_CHALLENGE`（以及部分 `ERR_BN_LIMIT`）的 body 会带 `cd`（challenge data）：

```json
"cd": {"q":"", "cc":"duckchat", "gk":"d4cddabcf4caa22ad92fab40844c786", "p":"...", "o":"...", "s":"...", "r":"...", "i":"3", "er":null, "e":0}
```

浏览器流程：

1. 用 `cd` 渲染 **anomaly tile 选择**弹窗（用户点选可疑 tile）；
2. 提交时 `GET /anomaly.js?<urlencoded payload>`，payload 形如
   `{q, type:"anomaly", acs:"<选中的 tile>", cc, gk, p, o, s, r, i}`；
3. 响应 JSON `{cc, gk, sc, e, p, i, o, s, er, r, q}`：
   - `e` 非空 → 挑战失败（`CHALLENGE_FAILURE`）；
   - `sc` 非空 → 挑战错误，`i` 作为允许重试次数（`CHALLENGE_ERROR`）；
   - 否则 → 成功，自动重发原聊天请求。
4. 失败达上限或用户关闭 → 隐藏挑战，走普通错误提示。

**网关策略**：网关没有人工/视觉能力，无法解 anomaly 挑战。因此 `ERR_CHALLENGE` 映射为
`403 upstream_anomaly_check`（`anomaly:true`，与 网关后端 的 `DUCK_CODE_MAP` 对齐），`ERR_BN_LIMIT` 映射为 `429 upstream_rate_limited`；
两者都记录 `overrideCode` 与 `challengeData` 摘要到 `health().recentErrors`，供运维判断。
若某次 `418` 后重新取挑战即可通过（实测常见），`DuckClient` 的传输层重试会先自愈。

> **2026-11-06 重要修正（v2.62）**：当前部署下绝大多数 `418 ERR_CHALLENGE` **不是 anomaly captcha**，
> 而是 `x-vqd-hash-1` 的 `client_hashes` 环境指纹与真实浏览器不一致：
> 挑战随机抽 `q7klm`（布局探针）/`vz95n`（duck.ai 页面结构探针）时，旧 jsdom 求解必然算错（42 样本中 19 个，45%），
> 服务端精确校验后返回 418（`overrideCode` 分别为 `f741` / `d78d`，`cd` 里并没有需要人工点选的 challenge）。
> 求解器现在仿真 duck.ai 页面（`#jsa` iframe + 页面全局变量 + 布局 shim + iframe 内 eval）后可消除该类 418；
> 详见 `docs/X-VQD-HASH-1-DEEP-ANALYSIS.md`。真正的 anomaly captcha（`cd` 内含 tile/`gk` 交互数据）仍需人工，网关保持 403 映射。
>
> **v2.63 附加**：`overrideCode` 现在写入 `DuckError.overrideCode` 与 `health().stats.lastOverrideCode`/
> `overrideCodes`（按 `code:type` 计数），可直接区分 `f741`(layout)/`d78d`(page-state) 环境类 418 与 429/限流；
> continuation 的 418 会换新挑战重试一次，`summarizeNative` 也补了 418/429 重试。

---

## 6. moderation / refusal

| 触发 | 事件形态 | 浏览器行为 | 网关映射 |
| --- | --- | --- | --- |
| 模型拒答 | `data: {"role":"refusal","detectedBy":"api"}`（流内） | `hasRefusal=true`；流结束后按 `ERR_REFUSAL` 失败处理 | `403 content_filter`（带 partial 内容） |
| 文本/图片被审核拦截 | HTTP 4xx/流内 `ERR_MODERATION_FLAG` | `DUCKCHAT_ERROR_TEXT_PROCESSING`，不自动重试 | `403 content_filter` |
| 审核服务不可用 | `ERR_MODERATION_UNAVAILABLE` | 可重试 | `503 moderation_unavailable` |
| 图片审核 token | `role:"image-validated"` + `tokens:[{messageIndex,kind,partIndex,moderationToken}]`；图片 `data.moderationToken` | 回填到消息/图片组件 | 忽略（仅记录） |
| 生成图片被判定失败 | `ui-component generate-image data.status:"error"` | 组件显示失败态 | 图片缺失 → `502 upstream_no_image` |

---

## 7. continuation / 409

浏览器支持「客户端工具 + 授权」的续传协议（默认关闭或仅特定场景）：

1. SSE 帧 `{"role":"continuation","action":"success","token":"<opaque>","pendingActions":[{"kind":"approval","toolCallId","toolName","purpose":"web-search|image-generation|user-location","approvalId","imageModelDisplayName?"}],"replayPolicy":"continuation-only"|"existing-consent-fallback","consentDecisions":[...],"responses":[...]}`；
2. 前端把 `pendingActions` 渲染成授权提示（`web-search-permission-prompt` / `image-generation-permission-prompt` / `location-permission-prompt`），用户同意后带着 **token** 重新 POST `/chat`（body 增加 `continuation:{token,responses,consentDecisions}`）；
3. 若 token 过期/不兼容/被禁用/策略变化 → HTTP **409**：
   ```json
   {"action":"continuation-restart-required","reason":"expired|incompatible|disabled|policy"}
   ```
   浏览器抛 `ERR_INVALID_ACTION`（不可重试，重新开始对话）；
4. 其他 continuation 相关错误：`ERR_STREAM_NOT_SAVED` / `ERR_STREAM_EXPIRED`。

**网关策略**：`DuckClient` 不实现 continuation（请求固定带
`x-duckai-continuation: resubmit-context`、`x-duckai-consent-purposes: user-location,image-generation,web-search`，
即浏览器默认同意态）。若收到 `role:"continuation"` 事件，只记录到 `chat().continuations` 并继续消费；
若收到 HTTP 409 `continuation-restart-required`，抛
`DuckError{status:409, code:"upstream_continuation_restart_required", retriable:false}`。

---

## 8. 流中断与重连（durableStream，浏览器专用）

bundle 中的 `RETRY_INTERVAL_MS = 4000`、`MAX_RETRY_DURATION_MS = 600000`（10 分钟）、
`EXPIRATION_THRESHOLD_MS = 900000`（15 分钟）：

- 恢复请求（GET 已保存的 durable stream）对 **418/429** 使用指数退避（`retryInterval * 2^(n-1)`），其他失败线性 4s；
- **410 Gone** → `ERR_STREAM_EXPIRED`；**404** → 在 15 分钟内继续重试，超时 → `ERR_STREAM_EXPIRED` / `ERR_STREAM_NOT_SAVED`；
- 累计重试超过 10 分钟 → `ERR_STREAM_NOT_SAVED`；
- 恢复数据是 JWE `schema_version:"2"` 的 `stream_parts[]`，需解密/解压/解析（失败分别对应
  `ERR_STREAM_DECRYPTION_FAILED` / `DECOMPRESSION_FAILED` / `PARSE_FAILED`）；
- 恢复时 `partial-image` 帧会被跳过（不重放预览）。

**网关策略**：不使用 durable stream（`durableStream:null`），普通 SSE 中断按网络错误处理：
- 已有部分内容 → 抛 `DuckError` 且带 `partial`，由 API 层发送 `error` 事件后结束；
- `DuckClient` 自身对 418/429/5xx/网络错误做有限重试（最多 `humanize.maxRetries`，默认 3）。

---

## 9. 网关映射表（给 `src/openai/**` 直接使用）

`mapUpstreamError()`（`src/duck/index.js`）返回 `{httpStatus, code, openaiType, retriable, finishReason?}`。
API 层建议映射：

| 上游情况 | HTTP | `error.type` | `error.code` | 备注 |
| --- | --- | --- | --- | --- |
| `[STOP_REASON:max_tokens]` / `ERR_MAX_TOKENS` | 200 | — | — | `choices[0].finish_reason = "length"`，正常返回 |
| `role:"refusal"` / `ERR_REFUSAL` | 403 | `content_filter` | `content_filter` | 附 `partial` 内容（已产生文本） |
| `ERR_MODERATION_FLAG` | 403 | `content_filter` | `content_filter` | |
| `ERR_CHALLENGE`（含 anomaly cd） | 403 | `permission_error` | `upstream_anomaly_check` | 记 `overrideCode`/`challengeData`；`ADMIN_API_V2` §6 的 anomaly 映射 |
| `ERR_BN_LIMIT` | 429 | `rate_limit_exceeded` | `upstream_rate_limited` | 传输层 418 时客户端会先重试 |
| `ERR_RATE_LIMIT` | 429 | `rate_limit_exceeded` | `rate_limit_exceeded` | 带 `Retry-After`（若有） |
| `ERR_USER_LIMIT` | 429 | `rate_limit_exceeded` | `user_limit_exceeded` | 匿名额度 |
| `ERR_ACCOUNT_LIMIT` | 403 | `model_unavailable` | `upstream_subscription_required` | 订阅额度/档位不足 |
| `ERR_CONVERSATION_LIMIT` | 429 | `rate_limit_exceeded` | `conversation_limit_exceeded` | 建议提示新开会话 |
| `ERR_IMAGE_GENERATION_LIMIT` | 429 | `rate_limit_exceeded` | `image_generation_limit_exceeded` | |
| `ERR_INPUT_LIMIT` / `ERR_SELECTION_INPUT_LIMIT` | 413 | `invalid_request_error` | `context_length_exceeded` | `param:"messages"` |
| `ERR_MODEL_RESTRICTED` | 403 | `model_unavailable` | `model_requires_subscription` | `param:"model"` |
| `ERR_MODEL_UNAVAILABLE` | 404 | `model_unavailable` | `model_not_found` | `param:"model"` |
| `ERR_MODEL_DEPRECATED` / `ERR_MODEL_REMOVED` | 410 | `model_unavailable` | `model_deprecated` / `model_removed` | `param:"model"` |
| `ERR_SERVICE_UNAVAILABLE` / `ERR_SERVICE_OFFLINE` / `ERR_NETWORK` | 503 | `upstream_unavailable` | `upstream_unavailable` / `upstream_offline` / `upstream_network_error` | 可重试 |
| `ERR_EMPTY_RESPONSE` / `ERR_UPSTREAM` / `ERR_UNKNOWN` | 502 | `upstream_error` | `upstream_error` / `upstream_empty_response` | 可重试 |
| `ERR_BAD_REQUEST` | 400 | `invalid_request_error` | `bad_request` | 不重试 |
| `ERR_INVALID_ACTION` | 502 | `invalid_request_error` | `upstream_invalid_action` | 不重试 |
| `ERR_RESPONSE_PARSING` | 502 | `upstream_error` | `upstream_response_parsing` | 不重试 |
| `upstream_protocol_mismatch`（严格校验） | 502 | `upstream_error` | `upstream_protocol_mismatch` | 立即中断，不重试 |
| `upstream_no_image`（图片模式无线成功图） | 502 | `upstream_error` | `upstream_no_image` | 不重试 |
| `upstream_continuation_restart_required`（HTTP 409） | 409 | `invalid_request_error` | `upstream_continuation_restart_required` | 不重试 |
| `limited`/`quota` 流标记（`[LIMIT_*]`） | 同对应 `ERR_*` | | | HTTP 200 的软错误 |
| 429 冷却中（`DuckError.retryAfterMs`） | 429 | `rate_limit_exceeded` | `rate_limit_exceeded` | 设置 `Retry-After` 响应头（秒） |

`DuckError` 字段（全部可选除前四个）：`status`（网关面对客户的 HTTP）、`code`、`type`、`retriable`、
`transportStatus`（上游真实 HTTP，418 时用于判断重试）、`upstreamType`（原始 `ERR_*`）、`eventIndex`、
`detail`（脱敏，含 `reason/message/snippet/eventIndex`）、`partial`（已产出内容）、`requestId`（`r`）、
`retryAfterMs` / `retryAt`（429）以及 `challengeData` / `fixedCostWindowUsage`（挑战/额度，非枚举字段）。

---

## 10. 严格校验（v2）与实现对应

`DuckClient` 默认 `strictProtocol: true`（`docs/PROTOCOL.md` §2.7/§4.7）。触发严格中断的情况：

| 情况 | 错误码 | HTTP | 是否 abort 上游 | 是否重试 |
| --- | --- | --- | --- | --- |
| 成功响应 `content-type` 不含 `text/event-stream` | `upstream_protocol_mismatch` | 502 | ✅ 立即 | ❌ |
| 成功响应缺少滚动挑战头 `x-vqd-hash-1` | `upstream_protocol_mismatch` | 502 | ✅ 立即 | ❌ |
| SSE 帧 JSON 解析失败 | `upstream_protocol_mismatch` | 502 | ✅ 立即 | ❌ |
| 未知 SSE `role`（白名单外） | `upstream_protocol_mismatch` | 502 | ✅ 立即 | ❌ |
| 流内 `action:"error"` 帧 | 按 `ERR_*` 映射 | 映射值 | ✅ 立即 | 按映射 |
| 流结束缺少 `[DONE]` | `upstream_protocol_mismatch` | 502 | ✅ 立即 | ❌ |
| `tool-invocation` 帧缺 `toolCallId`/`result` | `upstream_protocol_mismatch` | 502 | ✅ 立即 | ❌ |
| `generate-image` success 缺 `b64Image` | `upstream_no_image` | 502 | ✅ 立即 | ❌ |
| 图片模式流结束无成功图 | `upstream_no_image` | 502 | 流已结束 | ❌ |
| `role:"refusal"` | `content_filter` | 403 | 流已结束 | ❌ |
| `[LIMIT_*]` 标记 | 对应额度错误 | 429/403 | 流已结束 | 否（429 由 API 决定） |

已产生内容后中断时，`DuckError.partial` 携带 `{content, cleanContent, markdown, reasoning, sources, images,
toolCalls, toolResults, finishReason:"error", eventIndex, rawEventCount, lastEvents[]}`，
API 层据此发送 `error` 事件后结束，不伪造完成事件。`health().recentErrors[]` 只存脱敏片段
（base64 → `<b64>`、`moderationToken` → `<redacted>`、截断 300 字符），不落原始帧。

---

## 11. 待验证 / 已知不确定项

1. **付费模型匿名行为**：`gpt-5.6-terra` / `gpt-5.6-sol` / `claude-sonnet-5-5` / `claude-opus-5-5`
   在匿名（无订阅）下的真实响应**尚未验证**——2026-11-02 探测首个模型即遇传输层 `418 ERR_BN_LIMIT`
   （额度冷却期），按约定立即停止。源码预期错误为 `ERR_MODEL_RESTRICTED`（403，引导激活订阅）
   或 `ERR_ACCOUNT_LIMIT`（403）；待额度恢复后各试 1 次并回填。
2. **anomaly 挑战可解性**：`cd` 的 tile 挑战需要视觉判断，网关不可解；若上游未来改为纯计算挑战，
   可考虑实现。
3. **`ERR_ANOMALY`**：bundle 中**不存在**该错误码；anomaly 通过 `ERR_CHALLENGE` + `cd` / `/anomaly.js` 表达。
   `docs/ADMIN_API_V2.md` §6 中的 `ERR_ANOMALY(如出现)` 按 `ERR_CHALLENGE` 处理。
4. **durable stream 恢复端点**：bundle 中有独立恢复请求与 JWE 解密流程，本次未逆向出完整 URL 与字段
   （网关不使用；如需支持需另立任务）。
5. **`fixedCostWindowUsage` 的 `windows[]` 字段**：bundle 中可见 `id/percentUsed/resetAt/isBlocked/isBypassed?`，
   具体语义以实测为准；网关只透传，不做额度判断。


## 7. free 身份额度耗尽与恢复时间（v2.32 补充）

### 7.1 源码依据

| 上游标记 | 错误类型 | 语义 |
| --- | --- | --- |
| `[LIMIT_ENTITY]` | `ERR_USER_LIMIT` | **用户/IP 每日额度耗尽**（free 身份最常见） |
| `[LIMIT_ACCOUNT]` | `ERR_ACCOUNT_LIMIT` | 账号额度耗尽（登录账号） |
| `[LIMIT_CONVERSATION]` | `ERR_CONVERSATION_LIMIT` | 单个会话长度上限（不是身份额度） |
| `[LIMIT_IMAGE_GENERATIONS]` | `ERR_IMAGE_GENERATION_LIMIT` | 图片生成额度 |

对应文案（bundle i18n）：
- `DUCKCHAT_ERROR_USER_LIMIT` = “You’ve reached the maximum number of messages for one day. Please continue this chat tomorrow.”
- `DUCKCHAT_ERROR_FIXED_COST_WINDOW_LIMIT_SIX_HOUR` = “6-hour usage limit reached. You can continue this chat after %s.”
- `DUCKCHAT_USAGE_LIMIT_RESETS_IN` = “Resets in %s”

### 7.2 何时恢复（resetAt）

额度窗口随 `[FIXED_COST_WINDOW_USAGE:<JSON>]` 下发：`{ windows: [{ id, percentUsed, resetAt, isBlocked }] }`，
窗口 id 为 `six_hours` / `day` / `iso_week` / `month`。**恢复时间就是 `resetAt`**；
free 身份的 `ERR_USER_LIMIT` 文案是「tomorrow」，即按天窗口在 UTC 零点重置（status 实测 `day.resetAt = 次日 00:00:00Z`）。

### 7.3 网关处理（v2.32）

- 上游返回 `ERR_USER_LIMIT` / `ERR_ACCOUNT_LIMIT` 时，`callUpstream` 会把**当前身份**标记为冷却：
  `cooldownUntil = windows 中 isBlocked 窗口的 resetAt（否则最近的未来 resetAt；都没有则 now + pool.quotaCooldownMinutes）`；
- 冷却期内该身份**不参与路由**（新会话不会选到它），但**已有会话绑定保持不变**；
- 冷却身份上的会话只有在**真的有请求到来**时才改绑到其他身份（改绑后持久化），未调用的会话不动；
- 额度恢复（`resetAt` 到期）后冷却自动解除；也可在身份池手动「解除冷却」。
## 8. continuation（工具审批续传）兼容性——天气类问题 502 的根因（v2.35）

### 8.1 现象

询问「今天天气怎么样？」时，上游以 `continuation` 帧挂起（LocationPrompt 审批），
网关重发续传请求却收到 **409**：

```json
{"action":"continuation-restart-required","reason":"incompatible"}
```

修复前表现为 `upstream_protocol_mismatch`（SSE 流没有 [DONE]）或 502。

### 8.2 根因（2026-11-04 浏览器抓包 + 上游 bundle）

1. **显式 `metadata.toolChoice` 会让该流不可续传**：网关此前对 `webSearch:true` 发送
   `metadata:{toolChoice:{WebSearch:true}}`；浏览器默认**不发** toolChoice（只发 `canUseTools:true`），
   由模型自行决定是否联网。带 toolChoice 的流在审批续传时被上游判为 `incompatible`。
2. **continuation 请求体必须与浏览器一致**：

```json
{"model":"...","messages":[...],"canUseTools":true,"reasoningEffort":"...",
 "canUseApproxLocation":true,            // 同意位置后为 true（初始为 null）
 "canDelegateImageGeneration":null,
 "canShowGreeting":true,
 "continuation":{"token":"...","responseId":"<与首次请求 x-duckai-response-id 相同>",
                 "responses":[{"kind":"approval","approvalId":"<uuid>","approved":true}]},
 "currentAssistant":{"role":"assistant","content":"","parts":[{"type":"reasoning","id":"rs_...",
   "state":"done","summaryText":[],"encryptedText":"gAAAA...","sourceUpstreamId":"u10",
   "sourceModelId":"..."}]}}
```

   - 不带 `metadata`、不带 `durableStream`；
   - `currentAssistant.parts` 必须回放挂起前已流出的 **reasoning part（含 encryptedText）**；
   - 同意「大致位置」后 `canUseApproxLocation` 必须为 `true`。
3. 请求头保持 `x-duckai-continuation: resubmit-context`、`x-duckai-tool-approval: web-search`、
   `x-duckai-consent-purposes: user-location,image-generation,web-search`；浏览器**不发送**
   `x-duckai-client-tools`（无客户端工具时），网关也已改为不发。

### 8.3 网关实现（v2.35）

- `chat()` 不再注入 `metadata.toolChoice.WebSearch`（图片生成仍保留 `GenerateImage`）；
- `_buildContinuationAssistant()` 从已接收的 raw reasoning 帧重建 `currentAssistant.parts`；
- continuation 重发复用首次响应的滚动挑战 `x-vqd-hash-1`，并删除 `metadata`/`durableStream`；
- 若仍收到 400/409：按浏览器 `onRestartRequired` 语义**重启一次**（去掉 continuation/currentAssistant
  /metadata，保留已批准的能力位），不再注入 toolChoice。
### 8.4 v2.38 修正：定位关闭时必须发送 `canUseApproxLocation:false`（不是 null）

浏览器抓包（duck.ai 设置里关闭「使用大致位置」后询问天气）：

```json
{"model":"gpt-5.6-terra","messages":[...],"canUseTools":true,"reasoningEffort":"medium",
 "canUseApproxLocation":false,        // ← 关闭时明确为 false，且不会出现 LocationPrompt
 "canDelegateImageGeneration":null,"canShowGreeting":true,"durableStream":{...}}
```

- **v2.36 的错误**：关闭定位时网关发的是 `null`（表示「未决定」）→ 上游仍会弹出 LocationPrompt 审批；
  走审批/拒绝续传路径时，匿名档容易被判 `ERR_CHALLENGE`（HTTP 418），天气问题表现为随机 418/403。
- **v2.38 修正**：`config.tools.location=false` → 初始请求直接发 `false`，上游不再询问位置，
  模型直接走联网搜索路径（与浏览器关闭设置的行为一致）；开启时才先发 `null` 等待询问、审批后发 `true`。
- 验证：关闭定位后 free 身份（gpt-6-luna）连续两次天气请求均 200（此前随机 418）；
  连接测试天气 200 且工具调用记录为 `WebSearch`（不再出现 LocationPrompt）。