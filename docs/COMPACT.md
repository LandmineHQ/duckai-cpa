# 上下文压缩（compact）实现说明（v2.11，`src/duck/compact.js`）

> 目标：长会话在网关侧做「摘要 + 保留最近消息」的上下文压缩，避免上游 `ERR_CONVERSATION_LIMIT`。
> 关键更新（2026-11-01）：duck.ai 真实 bundle 里存在**原生摘要接口**，本实现优先使用它，
> 原生不可用时回退到普通 chat 生成摘要（保底）。
>
> 关联：`docs/SYNC-DEVICES.md`（无关）；自动压缩接线（task-40）由 api-core 实现。

---

## 1. 原生端点（bundle 模块 58935 / 真实服务）

| 项 | 内容 |
| --- | --- |
| Endpoint | `POST https://duck.ai/duckchat/v1/summarize`（`DUCKCHAT_API + "/summarize"`） |
| 请求体 | `{ model, previousSummary: {text, version}|null, targetPairCount, newMessages: [...] }` |
| `newMessages` | 本次要覆盖的「新增消息」；按 pair 语义（1 pair = user+assistant 2 条），不含已覆盖前缀 |
| Headers | 与 chat 相同：`content-type: application/json`、`accept: application/json`、`x-fe-version`、`x-fe-signals`、`x-vqd-hash-1`（挑战/ jsa）、`x-ddg-journey-id`、auth、`x-duckai-client-tools` 等 |
| 响应 | 200 JSON：`{ summary: {text, version}, coveredPairCount?, fixedCostWindowUsage? }` |
| 滚动挑战 | 响应头可带新的 `x-vqd-hash-1`；实现里通过 `lease.commit(response.headers)` 提交，供下一个请求复用 |
| 错误 | 非 2xx 抛 `SummarizeHttpError`-like：`status`、`fixedCostWindowUsage`、`errorType`、`retriable`；本实现映射为 `DuckError`（`code`=上游 `type`，`status`/`transportStatus`，`fixedCostWindowUsage`，`retriable`） |
| 触发语义（duck.ai 原生） | `[DONE]` 行 `[SUMMARY_REFRESH_HINT:{baseCoveredPairCount,targetPairCount,thresholdTokens,trigger:"tokens"}]` 主动压缩；`[SUMMARY_INVALID]` 失效；`ERR_CONVERSATION_LIMIT` 时自动 summarise（「Summarize and Continue」）；发送时 `initialContext = summary.text`、`messages.slice(2*coveredPairCount)` |

实现：`DuckClient.summarizeNative(params)`（`src/duck/index.js`）：
- 复用现有挑战机制（`challenge.acquire` + `lease.commit`/`release`）；失败时 `challenge.invalidate`，避免回退请求拿到已消费的挑战而挂起。
- 支持 `messages`/`newMessages`、`coveredPairCount`、`targetPairCount`、`previousSummary:{text,version}`、`systemPromptMode/ systemPrompt`、`signal`、`extraHeaders`。
- 非 2xx：抛出 `DuckError`（`ERR_*` 映射、`fixedCostWindowUsage` 透传、`retriable` 优先取上游）；**418/429 不做回退**（避免额外消耗额度）。

---

## 2. `src/duck/compact.js` API

```js
import {
  buildSummaryPrompt, serializeMessages, estimateChars, estimateTokens, shouldCompact,
  summarizeMessages, DEFAULT_MAX_SUMMARY_CHARS, MIN_SUMMARY_CHARS, MAX_SUMMARY_PROMPT_CHARS,
  COMPACTION_MODELS, COMPACTION_INTERNAL_ONLY, FALLBACK_MIN_NEW_PAIRS,
  isCompactionSupported, getActivationTargetPairCount, parseCompactMarkers, countPairs
} from './src/duck/compact.js';
```

| 导出 | 说明 |
| --- | --- |
| `buildSummaryPrompt({ maxSummaryChars?, previousSummary? })` | 摘要指令（保留目标/事实/决定/待办/数字/标识/代码/约束；不编造；纯文本；≤ max）。`previousSummary` 非空时追加「增量合并、不要重复不变内容」。上限 clamp 到 200–20000。 |
| `serializeMessages(messages)` | 生成 `[user] ...\n\n[assistant] ...` 文本；跳过 `role='reasoning'` 与空内容；兼容 content parts。 |
| `estimateChars(messages)` | 参与摘要消息的 content 字符数（不含 role 前缀/分隔符），用于旧阈值兼容。 |
| `estimateTokens(input)` | 估算 `ceil(chars/3)`（中英保守值，非精确 token）。 |
| `shouldCompact(input, options?)` | **v2.12 按 duck.ai pair/activation 语义**（非字符）：对象形式见下；messages 形式自动 `countPairs`；`triggerChars` 仅旧网关兼容。 |
| `summarizeMessages(client, messages, options)` | 原生优先（仅白名单模型）；失败回退 chat；返回见下。 |
| `COMPACTION_MODELS` | 9 个自动压缩白名单（`gpt-6-luna` 不在内，见 docs/COMPACTION-RESEARCH.md）。 |
| `COMPACTION_INTERNAL_ONLY` | `['claude-haiku-5-5']`（仅 internal tier 可压缩）。 |
| `FALLBACK_MIN_NEW_PAIRS` | 4（无 activation 时的 fallback pair 门槛）。 |
| `isCompactionSupported(model, {internalTier?} \| boolean)` | 白名单 + internal-only 判定；未知/空 → false。 |
| `getActivationTargetPairCount(capabilitiesOrNumber)` | 从 `capabilities/modelConfig` 读 `activationTargetPairCount`；整数≥0 返回，否则 null。 |
| `countPairs(messages)` | duck.ai `LZ` 语义：active assistant 消息数（role=assistant 且 status/meta.status 缺省或 'active'）。 |
| `parseCompactMarkers(line \| string[])` | 解析 DONE 标记（SUMMARY_REFRESH_HINT/INVALID/LIMIT_*/FIXED_COST_WINDOW_USAGE/ADS/WARN_CONVERSATION_LIMIT/STOP_REASON），返回结构化对象 + `markers` 列表。`SUMMARY_REFRESH_HINT` 支持单次/双次 URL 编码、裸 JSON、仅 value 形式（如 `%7B...%7D`）。 |

`shouldCompact` 判定（duck.ai `buildBindingIfActivated` 复刻）：
- `{model?, pairCount, coveredPairCount=0, activationTargetPairCount?, allowPairFallback?=true, internalTier?}`；
  - model 不在白名单 → false；
  - 有 activation（正整数）：`activation > covered && activation <= pairCount`；
  - activation 为 `0` / `null` / `undefined` → 视为未配置，走 fallback；
  - 无 activation：`pairCount - covered >= 4 && pairCount >= 4`（`allowPairFallback:false` 时 false）；
- messages 形式：`shouldCompact(messages, {model?, coveredPairCount?, activationTargetPairCount?, triggerChars?})`；
  `triggerChars` 仅在显式传入时按字符判断（旧网关行为，duck.ai 不按字符）。
- `getActivationTargetPairCount()` 只在 >0 时返回数字（0 → null），api-core 可直接透传，无需手动把 0 改成 null。

`options`：`{ model?, maxSummaryChars?, previousSummary?: string|{text,version}, previousSummaryVersion?, systemPrompt?, signal?, inputCharsLimit?, targetPairCount?, coveredPairCount?, newMessages?, extraHeaders?, systemPromptMode? }`

返回：
```js
{
  ok: true,
  text, summary,                 // 摘要文本（≤ maxSummaryChars，硬截断）
  model,
  inputChars, outputChars,
  coveredMessageCount,           // 实际纳入序列化的消息条数
  coveredPairCount,              // 原生路径返回值（fallback 为 null）
  previousSummaryUsed, previousSummaryVersion,
  summaryVersion,                // 原生 summary.version（fallback 为 null）
  fixedCostWindowUsage,          // 原生错误/响应透传
  native,                        // true=原生端点；false=chat 回退
  fallbackReason,                // 原生失败原因（code/type/message）
  usage: { inputChars, outputChars, estimatedInputTokens, estimatedOutputTokens },
  finishReason
}
```
`DuckClient` 便捷方法：`duckClient.summarizeMessages({ messages, ... })`（内部动态 import compact，避免循环依赖）。

### 2.1 原生 → chat 回退
- **原生门控（v2.12）**：只有 `isCompactionSupported(model)` 的模型才尝试 `summarizeNative`；`gpt-6-luna` 等非白名单模型
  直接 chat 回退，`fallbackReason:'compaction_unsupported_model'`（duck.ai 对 gpt-6-luna 返回 404 `ERR_MODEL_UNAVAILABLE`）。
- 原生 `newMessages` 形状为 `{role:'user'|'assistant', text}`（bundle `89099`），**不是** chat 的 `{role,content}`；
  `previousSummary` 传完整 summary 对象（含 text/version 等）。
- 原生失败（非 418/429）→ 用 `buildSummaryPrompt` + `serializeMessages` 走普通 chat 生成摘要（`reasoningEffort:'none'`，单条 user 消息，非流式聚合）。
- 输入超过模型 `maxInputChars`（默认 16000）→ 保留 transcript 尾部并加 `[...earlier conversation truncated...]`。
- 失败统一抛 `DuckError`：普通异常 → `type:'summary_failed'`（502，`retriable:true`）；空摘要 → `type:'empty_summary'`；原生与回退都失败时 chat 错误上带 `nativeError`。
- 回退路径与原生差异：不走 pair 语义（无 `coveredPairCount/version`），summary 由我们自建 prompt 生成，质量/风格可能与 duck.ai 原生不同；因此返回 `native:false` 供上层标注。

---

## 3. 模型能力元数据（`src/duck/models.js`，v2.11）

每个模型顶层新增：
```js
contextWindowChars: 16000,          // duck.ai inputCharLimit（默认 16000）
maxInputChars: 16000,              // 网关输入上限（= contextWindowChars）
maxOutputTokens: 4096,             // 上游 catalog 未提供 → 保守估算
maxOutputTokensEstimated: true,
capabilities: {                    // 对象
  webSearch, imageGeneration, reasoningEfforts, tier,
  contextWindowChars, maxInputChars, maxOutputTokens, maxOutputTokensEstimated
}
```
导出 `getModelCapabilities(id)` → `{model, displayName, tier, paid, webSearch, imageGeneration, reasoningEfforts, contextWindowChars, maxInputChars, maxOutputTokens, maxOutputTokensEstimated, capabilities}`；未知 id → `null`；支持 `MODEL_ALIASES`（`gpt-6` → `gpt-6-luna`）。
`getApiModelCatalog()` 现在带上述顶层字段（`/v1/models` 的 `context_window`/`max_input_tokens` 等映射由 api-core 做）。
示例：`gpt-6-luna`：tier free、webSearch true、imageGeneration true、reasoningEfforts `['none','low']`、contextWindowChars 16000；`mistral-small-2603`：webSearch/imageGeneration false；付费模型 paid true、tier plus/pro。

---

## 4. 与 duck.ai 原生摘要的差异 / 限制

1. **原生语义一致部分**：端点、请求体（`model/previousSummary/targetPairCount/newMessages`）、响应 `summary.text/version/coveredPairCount`、滚动挑战提交、`fixedCostWindowUsage`、`ERR_*`/`retriable` 映射；`previousSummary` 增量与 pair 语义按原生实现。
2. **未实现**：`POST /duckchat/v1/summarize/compact`（主动 compact，body 形状待确认）；`[SUMMARY_REFRESH_HINT]`/`[SUMMARY_INVALID]` 的**自动触发**由 api-core（task-40）根据 session 状态与 DONE 行决定，本模块只提供摘要能力与 `shouldCompact`。
3. **usage 非精确**：上游可能不返回 token usage；本模块只有字符数与 `estimateTokens=ceil(chars/3)` 估算，不能当计费依据。
4. **回退质量差异**：原生端点不可用时用普通 chat 生成；prompt 由我们构造，可能与原生摘要风格/覆盖范围不同（返回 `native:false, fallbackReason` 便于上层标注）。
5. **额度/风控**：匿名出口 IP 共享额度；原生端点偶发 `418 ERR_BN_LIMIT`（`overrideCode 8e04`）或 `418 ERR_CHALLENGE`；
   本实现会原样抛 `DuckError`（含 `retriable`），**不**回退 chat（418/429）以避免二次消耗；400/404 等则回退。
6. **真实成功样例**：白名单模型 **`gpt-5.4-mini`** 真实调用 `POST /duckchat/v1/summarize` 已 **200 成功**（返回
   `summary.text`，响应未必带 version/coveredPairCount）；`gpt-6-luna` 返回 404 `ERR_MODEL_UNAVAILABLE`（白名单验证）。
7. **未实现**：`/summarize/compact`（body 未证实）、checkpoint/Chat Summary 编辑、`/usage`/campaigns 等见功能地图。

---

## 5. 自测

`data/tmp/compact-tests.mjs` **21/21 通过**：
1. prompt 指令/上限 clamp/增量合并语句；
2. 序列化跳过 reasoning/空内容、role 行格式、content parts；
3. `estimateChars/estimateTokens/shouldCompact`；
4. summarize 正常路径（单条 user 消息、无 reasoning、返回 text/model/chars/usage）；
5. 增量 previousSummary（字符串/对象 + version）、自定义 systemPrompt/model/signal；
6. maxSummaryChars 硬截断；超长输入截断标记；
7. 错误：DuckError 原样、普通异常→summary_failed、空摘要→empty_summary、空 messages→invalid_request；
8. 原生优先：`summarizeNative` 成功 → 不发 chat，透传 `summaryVersion/coveredPairCount/fixedCostWindowUsage`，`previousSummary` 以对象传入；
9. 原生失败（404）→ chat 回退，`native:false, fallbackReason`；双失败 → chat 错误带 `nativeError`；
10. 原生 418/429 → 不回退（避免额度二次消耗）；
11. 非白名单模型（gpt-6-luna）跳过原生，chat 回退 `fallbackReason:'compaction_unsupported_model'`；
12. `DuckClient.summarizeNative`：请求 URL/headers/body（`newMessages` 为 `{role,text}`）、`lease.commit/release`、200 解析、非 200 映射；
13. `DuckClient.summarizeMessages` 自动走原生路径（白名单模型）；
14. 所有模型能力字段/`getModelCapabilities`（free/paid/alias/unknown）/catalog 字段；
15. **v2.12**：`COMPACTION_MODELS` 白名单/internal-only、`getActivationTargetPairCount` 多来源、`countPairs`、
    `shouldCompact` activation/fallback 边界（含 covered/allowPairFallback/字符兼容）、`parseCompactMarkers` 全部标记与非法输入。

真实联调（代理 10808 + 已保存官方码，`data/tmp/probe-summarize-native.mjs` / `verify-compact-live.mjs`）：
- `client.init()` ✅；
- `gpt-5.4-mini` + `POST /duckchat/v1/summarize` → **200**（`summary.text` 正常，已实测；随后同出口偶发 418 `ERR_BN_LIMIT` 软限）；
- `gpt-6-luna` → **404 `ERR_MODEL_UNAVAILABLE`**（不在压缩白名单）；
- 418/429 时实现正确抛 `DuckError{code:'ERR_BN_LIMIT'|'ERR_CHALLENGE', status:418, retriable:true}` 且不回退；
- 结论：原生 200 与白名单行为均已真实验证；剩余为共享出口额度波动。

---

## 6. 复跑命令

```powershell
node data/tmp/compact-tests.mjs               # mock 21/21（含 v2.12 白名单/触发/标记解析）
node data/tmp/verify-compact-live.mjs         # 真实原生摘要（代理 10808；额度受限时记录 418/429）
node --check src/duck/compact.js
```
