# duck.ai 上下文压缩（compaction）逆向研究（v2.12）

> 证据来源：`recon/entry.duckai.2d2656b1fcd20ced62d9.js`（2026-11-01 抓取）。
> 关键模块：`76036`（压缩模型白名单 `Ce/Og`）、`1715000~1718000`（`buildBindingIfActivated`/`maybeSchedule`/`start`）、
> `1978800`（DONE 行标记解析）、`58935`（summarize 端点）、`89099`（newMessages 序列化）、`942000~942800`（发送时
> `initialContext`/`messages.slice` 与 checkpoint/apply/invalidate）。
> 代码实现：`src/duck/compact.js` + `DuckClient.summarizeNative`（见 docs/COMPACT.md）。

---

## 1. 哪些模型会被自动压缩（白名单）

bundle 模块 `76036`：

```js
const r = ["claude-haiku-4-5","claude-haiku-5-5","claude-sonnet-4-6","claude-sonnet-5-5",
           "claude-opus-4-8","claude-opus-5-5","gpt-5.4-mini","gpt-5.6-terra","gpt-5.6-sol"];
const a = [...同 r...];          // 允许 pair fallback 的模型（Og）
const o = ["claude-haiku-5-5"];  // 仅 internal tier 可用压缩
function Ce(e, t=false){ return !(!e || !r.includes(e) || (o.includes(e) && !t)); }
function Og(e){ return !!e && a.includes(e); }
```

结论：
- **`gpt-6-luna` 不在白名单**（免费默认模型，duck.ai 不自动压缩它）。真实实测：用 `gpt-6-luna` 调
  `POST /duckchat/v1/summarize` 返回 **404 `ERR_MODEL_UNAVAILABLE`**，进一步验证白名单。
- `claude-haiku-5-5` 仅 internal tier 可压缩（`Ce` 第二参数为 internal 才 true）；其他白名单模型对所有 tier 可压缩。
- 白名单中的 `claude-haiku-5-5`、`claude-sonnet-4-6`、`claude-opus-4-8` 目前不在网关 `src/duck/models.js` 的 10 个模型里
  （网关可选模型集不同）；网关的 `isCompactionSupported` 按 bundle 原列表判定，不要求模型存在于本地目录。
- 网关实现：`COMPACTION_MODELS`、`COMPACTION_INTERNAL_ONLY`、`isCompactionSupported(model,{internalTier})`。

---

## 2. 触发规则（何时发起摘要）

`buildBindingIfActivated(chat)`（~1715000）逐条：

1. `mode === 'chat'`；非 chat（voice/images）不压缩。
2. skills 检查：若 skills 关闭且存在非空 skills 的 user 消息 → 不压缩。
3. `model = modelConfig.serviceModelId || modelConfig.model`；`Ce(model, tier===Internal)` 必须 true。
4. `$.ok(messages)`（模块 89099 `m`）：消息可压缩性检查（含 skills/附件/页面上下文等；任何 user 消息带
   skill-references、非 file 的 page-context、文本粘贴等会阻止压缩；具体条件较长，网关不复制该完整判定）。
5. `coveredPrefixDigest` 存在 → `baseCoveredPairCount = summary.coveredPairCount ?? 0`，否则 0；只有 digest 存在时
   才带 `baseSummaryVersion = summary.version`。
6. `activePairs = q(chat)`：**active assistant 消息数**（`LZ`：role==='assistant' 且 `meta.status|status` 缺省/active）。
7. `activationTargetPairCount` 来自 `chat.activationTargetPairCount`（由 UI 传入/modelConfig capabilities），随后：

```js
function target({activePairs, baseCovered, activationTargetPairCount, allowPairFallback}) {
  if (activationTargetPairCount !== undefined) {
    if (!Number.isInteger(activationTargetPairCount)) return null;
    if (activationTargetPairCount <= baseCovered || activationTargetPairCount > activePairs) return null;
    return activationTargetPairCount;               // 显式目标
  }
  if (!allowPairFallback) return null;
  if (activePairs - baseCovered < 4 || activePairs < 4) return null;
  return activePairs;                               // fallback：全部未覆盖的 pair
}
// allowPairFallback = !Og(model) 取反 → 即白名单模型都允许 fallback
```

8. 返回 binding：`{chatId, model, baseSummaryVersion, baseCoveredPairCount, targetPairCount, coveredPrefixRevision}`。
9. `maybeSchedule` 再做去重/退避：same binding key 进行中则 abort 旧任务；`backoff` 按 `baseSummaryVersion` 重置；
   5xx 连续 5 次熔断 60s；429 不熔断但记录 backoff。
10. `start`：`newMessages = serialize(messages).slice(0, 2*target).slice(2*baseCovered)`；
    `previousSummary = baseSummaryVersion && summary ? summary : null`（**完整 summary 对象**，不是 {text,version}）；
    body `{model, previousSummary, targetPairCount, newMessages}`。

**网关实现（`shouldCompact`）**：
- 对象形式精确复刻：有 `activationTargetPairCount` → `target > covered && target <= pairCount`；
  否则 fallback `pairCount - covered >= 4 && pairCount >= 4`；`allowPairFallback:false` → false；model 不在白名单 → false。
- `pairCount` 可用 `countPairs(messages)`（active assistant 数）。
- `triggerChars` 仅保留为旧网关启发式（duck.ai 不按字符）。

**注意**：`activationTargetPairCount` 在**静态模型目录里没有**，是运行时 `modelConfig/capabilities` 提供的字段
（本 bundle 只在调用点看到 `e.activationTargetPairCount`，未在静态 model 定义里出现）。网关 `getActivationTargetPairCount`
支持从 capabilities/modelConfig 读取；读不到则用 fallback pair 规则。

**`0` vs 缺省/null 语义（v2.12 修正）**：
- duck.ai 原逻辑只判断 `activationTargetPairCount !== undefined`，若传入 `0` 会因 `0 <= baseCovered` 直接不触发；
  实际上服务端/UI 只在**正数**时传 activation target。
- 网关实现约定：**`0` / `null` / `undefined` 都视为「未配置」→ 使用 fallback pair 规则**；只有正整数才按
  `target > covered && target <= pairCount` 触发；负数/非整数等非法值返回 false。
- `getActivationTargetPairCount()` 同样只在 `>0` 时返回数字，`0` 返回 null（供 api-core 直接透传，无需手动把 0 改成 null）。

---

## 3. 服务端信号（DONE 行标记，~1978800）

DONE 行可能形如：
`[DONE][FIXED_COST_WINDOW_USAGE:...][SUMMARY_REFRESH_HINT:...][SUMMARY_INVALID]...`

| 标记 | 解析/语义 |
| --- | --- |
| `[SUMMARY_REFRESH_HINT:<urlencoded JSON>]` | `JSON.parse(decodeURIComponent(value))`；必须 `trigger === 'tokens'`；`targetPairCount` 正整数；`baseCoveredPairCount` 可选、非负整数；`thresholdTokens` 可选 number。解析成功 → 强制触发**一次** summary refresh（tokens 场景）；解析失败仅 log，不报错。 |
| `[SUMMARY_INVALID]` | `summaryInvalidated = true`：本地 summary 失效，需要重新摘要（`SERVICE_INVALIDATE_SUMMARY`）。 |
| `[LIMIT_CONVERSATION]` | 映射 `ERR_CONVERSATION_LIMIT`（UI 提示达到最大长度）；自动压缩入口。 |
| `[LIMIT_ACCOUNT]` | `ERR_ACCOUNT_LIMIT`（账号额度）。 |
| `[LIMIT_ENTITY]` | `ERR_USER_LIMIT`（实体/IP 额度）。 |
| `[LIMIT_IMAGE_GENERATIONS]` | `ERR_IMAGE_GENERATION_LIMIT`。 |
| `[FIXED_COST_WINDOW_USAGE:<value>]` | URL-decode/JSON 解析为 usage windows（6h/day/week/month 等）。 |
| `[ADS:<JSON>]` | 解析广告 payload（仅 DONE 中在这些标记之前的文本里匹配；`windowID` 用于广告窗口）。 |
| `[WARN_CONVERSATION_LIMIT:<n>]` | 会话使用百分比警告。 |
| `[STOP_REASON:<word>]` | 结束原因（`max_tokens` 等）。 |

网关实现：`sse.js parseDoneFrame` 已解析这些事件；`compact.js parseCompactMarkers(line|string[])` 提供同一规则的独立解析器
（返回 `{summaryRefreshHint, summaryInvalid, limitConversation, limitAccount, limitEntity, limitImageGenerations,
fixedCostWindowUsage, ads, warnConversationLimit, stopReason, markers}`），供 Admin/测试直接解析原始 DONE 行。

---

## 4. 端点与错误

### 4.1 `POST /duckchat/v1/summarize`
- 请求头：与 chat 相同（`Content-Type`、`accept: application/json`、`x-fe-version`、`x-fe-signals`、
  `x-vqd-hash-1`（挑战/jsa）、auth headers、`x-ddg-journey-id` 等）；响应头可带新 `x-vqd-hash-1` → 必须 commit
  （网关 `summarizeNative` 已 `lease.commit(response.headers)`，并 `lease.release()` 防 mutex 死锁）。
- 请求体：`{ model, previousSummary: summary|null, targetPairCount, newMessages }`。
- `newMessages` 形状（模块 `89099` c/u/d）：**`{ role:'user'|'assistant', text, parts? }` 数组**，不是 chat 的
  `{role,content}`。`parts` 可为 `{type:'uploaded-image'|'page-context'|'file'|'generated-image'|'tool-result'}` 等
  占位（服务端用于计数/防护）。网关 `summarizeNative` 已按 `{role,text}` 序列化；真实 400 的根因即旧实现发 `{role,content}`。
- 响应 200：`{ summary: { text, version? }, coveredPairCount?, fixedCostWindowUsage? }`；`summary.text` 为空视为失败。
- 错误：`SummarizeHttpError{status, fixedCostWindowUsage?, errorType?, retriable?}`；网关映射为 DuckError
  （`code=errorType`、`status/transportStatus`、`fixedCostWindowUsage`、`retriable`）。
- 网关真实结果：`gpt-5.4-mini`（白名单）**200 成功**（probe 首次成功后配额软限导致后续 418）；
  `gpt-6-luna` → 404 `ERR_MODEL_UNAVAILABLE`；匿名共享出口偶发 418 `ERR_BN_LIMIT`（overrideCode 8e04）。

### 4.2 `POST /duckchat/v1/summarize/compact`（主动压缩）
- bundle 仅有常量：`const u = `${DUCKCHAT_API}/summarize`; const d = `${u}/compact``，导出函数 `sY(e,t)` 复用同一个
  `fetch` 封装；**未在本 bundle 找到其调用点与请求体构造**（可能只在特定 active compact 流程/feature flag 下使用）。
- 网关状态：未实现（无 payload 证据，避免臆测）。待后续找到调用点或实测抓包再补。

### 4.3 摘要存储 / checkpoint / UI（~942000、1715000）
- summary 合法结构（`C` 校验）：`{ text:string, version:string, coveredPairCount:int>=0, model:string, signature:string,
  coveredPrefixDigest }`；`version` 为字符串（不是数字）。
- 发送 chat 时：`initialContext = summary.text`；`messages = messages.slice(2*summary.coveredPairCount)`
  （仅当 `2*covered <= messages.length`；否则不裁剪）；`seedText` 场景直接 `initialContext=seedText`。
- `SERVICE_APPLY_SUMMARY` / `SERVICE_INVALIDATE_SUMMARY`：按 `coveredPrefixRevision` 校验，避免并发覆盖；
  失效后 `coveredPrefixRevision+1`。
- 主动压缩 checkpoint：`SERVICE_APPLY_COMPACTION {expectedChatId, checkpointId, anchorId, baseCompactionId, text}`；
  在 `metadata.compactions` 记录 `{id, afterMessageCount, ...}`；`compactionRevision+1`；`USER_EDIT_COMPACTION` 允许
  用户编辑「Chat Summary」（`DUCKCHAT_COMPACTION_RESULT_TITLE = "Chat Summary"`，Button「Summarize and Continue」）。
- 失败语义（~942700）：429 → `usage-limit`；400/404 → `unavailable`；413 且 `ERR_INPUT_LIMIT` 或 `retriable===false`
  → `unavailable`；其他 → `failed`；`fixedCostWindowUsage` 即使失败也更新 UI。
- 重试/并发：`inflight` Map + `abortController`；同 binding 键变化时 abort 旧任务（`superseded`）；5xx 连续 5 次熔断 60s；
  429/退避记录在 `backoff`；`consecutive5xx` 成功清零。

---

## 5. 每模型差异表

> `inputCharLimit`：bundle 模型定义均为 **16000**（voice-mode 为 0；图片/文件另有独立限制）。
> 压缩支持：`Ce` 白名单；`activationTargetPairCount` 为**运行时 capabilities/modelConfig 字段**（静态目录未发现默认值）；
> 阈值来源：服务端 `SUMMARY_REFRESH_HINT.thresholdTokens`（tokens 触发）或 activation 目标（pair 触发）。

| 模型 | 网关目录 tier | inputCharLimit | 自动压缩 | 备注 |
| --- | --- | --- | --- | --- |
| gpt-6-luna | free | 16000 | ❌ | 不在白名单；summarize 实测 404 ERR_MODEL_UNAVAILABLE |
| gpt-5.4-mini | free | 16000 | ✅ | fallback pair 规则可用；真实 summarize 200（probe） |
| claude-haiku-4-5 | free | 16000 | ✅ | |
| claude-haiku-5-5 | 目录外 | 16000 | ⚠️ internal-only | 非 internal tier → false |
| claude-sonnet-4-6 | 目录外 | 16000（bundle） | ✅ | |
| claude-sonnet-5-5 | plus | 16000 | ✅ | |
| claude-opus-4-8 | 目录外 | 16000（bundle） | ✅ | |
| claude-opus-5-5 | pro | 16000 | ✅ | |
| gpt-5.6-terra | plus | 16000 | ✅ | |
| gpt-5.6-sol | plus | 16000 | ✅ | |
| mistral-small-2603 | free | 16000 | ❌ | 不在白名单 |
| tinfoil/gpt-oss-120b | free | 16000 | ❌ | 不在白名单 |
| tinfoil/gemma4-31b | free | 16000 | ❌ | 不在白名单 |

（`activationTargetPairCount`：静态 bundle 模型定义中未出现；由运行时 `modelConfig/capabilities` 提供，
`getActivationTargetPairCount()` 从这些对象读取，缺省时使用 fallback `>=4 pairs` 规则。）

---

## 6. 网关实现与差异清单

| 能力 | duck.ai 原生 | 网关（v2.12） |
| --- | --- | --- |
| 压缩模型白名单 | `Ce/Og` 9 模型 + internal 限制 | ✅ `COMPACTION_MODELS`/`isCompactionSupported` |
| 触发规则 | activationTargetPairCount 优先；fallback 4 pairs；skills/不可压缩消息检查 | ✅ pair 规则/allowPairFallback；⚠️ `$.ok` 完整可压缩性判定未逐条复刻（仅基础序列化） |
| 摘要端点 | `/summarize`（newMessages `{role,text}`） | ✅ `summarizeNative`（真实 200 已验证）；❌ `/summarize/compact` |
| 增量摘要 | `previousSummary` = 完整 summary 对象（含 version/digest） | ✅ 支持 text/version；⚠️ 不维护 `coveredPrefixDigest/signature` |
| 摘要存储/checkpoint | `initialContext` + `slice(2*covered)`；anchorId/baseCompactionId；Chat Summary 编辑 | ⚠️ 由 api-core session summary 简化实现；无 checkpoint/编辑/撤销 |
| DONE 标记 | 全部解析 | ✅ SSE 层解析；✅ `parseCompactMarkers` 独立解析 |
| 429/418 行为 | 429 usage-limit；418 视为异常/风控 | ✅ 原生失败 418/429 不回退；400/404 回退 chat |
| 主动 compact | `/summarize/compact`（条件/payload 未证实） | ❌ 未实现（待证据） |

---

## 7. 复跑/参考

- `node data/tmp/compact-tests.mjs`（21/21：白名单/activation/fallback/标记解析/native/回退）
- `node data/tmp/probe-summarize-native.mjs`（真实 summarize 变体探针；需代理 10808 + `data/pairing.json` 官方码）
- `node data/tmp/verify-compact-live.mjs`（真实 compact；注意匿名出口 418/429 共享额度）
- 相关文档：`docs/COMPACT.md`（API/实现）、`docs/DUCKAI-FEATURE-MAP.md`（功能缺口）
