# 每模型上下文与 token 上限：源码分析 + 真实测量（v2.20）

> 用户问题：CPA 网关需要「每个模型最长上下文 / 输出 token」的确定值；
> 源码里对**不支持自动压缩**的模型（如 gpt-6-luna）达到上限时怎么处理？
>
> 本文分两部分：**A. 源码分析（不可变事实）**、**B. 真实对话实测（可复现命令与结果）**。

## A. 源码分析结论

1. **duck.ai bundle 里没有 `maxTokens` / `contextWindow` / `maxOutputTokens` 常量**
   （`entry.duckai*.js` 全文检索 `maxTokens`、`contextWindow` 均无命中；`contextWindow`
   仅命中 vendored framer-motion 的无关字段）。
2. 前端能拿到的**硬上限只有字符数**：模型对象的 `inputCharLimit`（bundle @651292，
   免费模型展示为 16000 字符，属于输入框软限制）。
3. **token 预算由服务端计算并通过协议帧下发**，前端只消费：
   - `[FIXED_COST_WINDOW_USAGE:{...}]`：DONE 帧里的固定成本窗口使用量；
   - `[SUMMARY_REFRESH_HINT:{baseCoveredPairCount,targetPairCount,trigger:"tokens",thresholdTokens}]`：
     服务端要求刷新摘要时下发，`thresholdTokens` 为 token 阈值（bundle @1979264）；
   - `[SUMMARY_INVALID]`：摘要失效；
   - `[LIMIT_CONVERSATION]` / `[LIMIT_ACCOUNT]` / `[LIMIT_ENTITY]`：会话/账号/实体额度。
4. 会话长度提示：`DUCKCHAT_CONVERSATION_LIMIT_PERCENT`（"Conversation limit: %s%"），
   用量 ≥70% 时显示（bundle @581009：`null!=O&&O>=70`）。
5. **不支持压缩的模型达到会话上限时：报错并要求新开会话，源码不会自动新开会话。**
   - `DUCKCHAT_ERROR_CONVERSATION_LIMIT` = "You've reached the maximum chat length in this
     conversation. **Start a new chat to continue.**"
   - 支持压缩的模型：`DUCKCHAT_COMPACTION_LIMIT_DESCRIPTION` + 「**Summarize and Continue**」，
     摘要后在同一会话继续。

## B. 真实对话实测（v2.20，2026-11-02）

### B.1 测量方法

脚本：`scripts/limit-probe-gateway.mjs`（**通过网关自身的连接测试接口**，与前端「连接测试」
完全同一条链路：身份池 → rps=1 队列 → 上游 → SSE 解析）。

```powershell
# 单条输入上限（每级一个新会话，只发一条消息）
node scripts/limit-probe-gateway.mjs --admin-token <ADMIN> \
  --models gpt-6-luna --input-only --filler ascii --steps 18000,19500,19600,19900,20000

# 会话上限（同一会话连续多轮，每轮追加一段文字）
node scripts/limit-probe-gateway.mjs --admin-token <ADMIN> \
  --models gpt-6-luna --conversation-only --max-turns 8 --per-turn-chars 3000

# 输出长度（一次“尽量长”的写作请求）
node scripts/limit-probe-gateway.mjs --admin-token <ADMIN> \
  --models gpt-6-luna --output-only
```

判定依据：HTTP 200 + SSE 有 `done` = 成功；HTTP 413 且 `code=context_length_exceeded`
= 单条输入超限；HTTP 409 且 `code=conversation_limit_reached` = 会话超限；429 = 限流（跳过）。

### B.2 实测结果：单条输入上限 ≈ 19,500–19,600 字符

| 模型 | filler | 字符数 | 结果 |
| --- | --- | --- | --- |
| gpt-6-luna | 中文 | 16,000 / 16,100 / 18,000 / 19,000 / 19,500 | ✅ HTTP 200 |
| gpt-6-luna | 中文 | 19,900 / 20,000 | ❌ HTTP 413 `context_length_exceeded` |
| gpt-6-luna | **英文 ASCII** | 19,500 | ✅ HTTP 200 |
| gpt-6-luna | **英文 ASCII** | 19,600 / 19,900 / 20,000 | ❌ HTTP 413 `context_length_exceeded` |
| gpt-5.4-mini | 中文 | 16,000 / 16,100 | ✅ HTTP 200 |
| gpt-5.4-mini | 中文 | 20,000 | ❌ HTTP 413 `context_length_exceeded` |
| claude-haiku-4-5 | 中文 | 16,000 / 16,100 | ✅ HTTP 200 |

**结论：**

- **限制按字符计，不是按 token**：中英文在同样的 ~19.5k 字符边界上被拒绝
  （若按 token，英文 20k 字符仅约数千 token，应轻松通过）。
- 上游真实单条输入上限 **约 19,5xx 字符**（19,500 通过、19,600 被拒）；
  前端 `inputCharLimit=16,000` 是 **UI 软限制**，不是服务端硬限制。
- 超限错误经网关映射为 **HTTP 413 `context_length_exceeded`**（v2.20 修复了此前误报 502
  `upstream_error` 的问题）。

### B.3 会话上限与压缩行为（真实连续对话）

实测命令：

```powershell
# 非压缩模型：8 轮，每轮约 3,000 字符输入
node scripts/limit-probe-gateway.mjs --admin-token <ADMIN> \
  --models gpt-6-luna --conversation-only --max-turns 8 --per-turn-chars 3000

# 压缩白名单模型：10 轮，每轮约 3,000 字符输入
node scripts/limit-probe-gateway.mjs --admin-token <ADMIN> \
  --models gpt-5.4-mini --conversation-only --max-turns 10 --per-turn-chars 3000
```

实测结果：

| 模型 | 轮数 | 累计字符（含回复） | 压缩事件 | 结果 |
| --- | --- | --- | --- | --- |
| gpt-6-luna（**非**白名单） | 8 | 24,286 | 无 | 全部 HTTP 200，未触发会话上限 |
| gpt-5.4-mini（白名单） | 10 | 30,164 | **第 6、10 轮触发 `compacted`** | 全部 HTTP 200，压缩后继续 |

结论：

- **会话上限 > 30,000 字符**（单条消息 19.5k 的限制不适用于整段会话）；真正的会话上限由
  服务端 token 预算决定，超出时发 `[LIMIT_CONVERSATION]`（网关映射 409
  `conversation_limit_reached`）。
- 白名单模型在 **4 个完整 pair** 后自动压缩（实测第 6 轮即触发）→ 对应
  `session_limit_behavior: summarize_and_continue`。
- 非白名单模型（gpt-6-luna）**不会自动压缩**：达到上限时上游文案是
  「Start a new chat to continue」，网关不做自动新会话 → `session_limit_behavior: new_chat`。
- 限额探测脚本在会话仍未触顶时记录为「下界」，不会伪造上限值。

### B.4 输出长度

实测命令：

```powershell
node scripts/limit-probe-gateway.mjs --admin-token <ADMIN> --models gpt-6-luna,gpt-5.4-mini --output-only
```

实测结果（"尽量长"写作请求，记录实际输出字符数作为**下界**）：

| 模型 | 输出字符数 | 估算 token（/3） | 备注 |
| --- | --- | --- | --- |
| gpt-6-luna | **6,427** | ~2,143 | 未触发输出截断错误 |
| gpt-5.4-mini | **4,335** | ~1,445 | 未触发输出截断错误 |

说明：源码/响应里没有输出 token 硬上限；以上为**下界**。`/v1/models` 的
`max_output_tokens` 维持 **4096 估算值**（`max_output_tokens_estimated: true`），
中文约 1.5 字符/token 时 6,427 字符 ≈ 4.3k tokens，与 4096 估算量级一致。

## C. `/v1/models` 已落地的字段（v2.20）

| 字段 | 取值/来源 |
| --- | --- |
| `context_window_chars` | **20,000**（实测单条上限 19,5xx 的保守向上取整；会话实测 >30k） |
| `context_window` / `max_input_tokens` | `max_input_chars / 3`（估算值，仅参考） |
| `max_input_chars` | **19,500**（实测通过的安全值；19,600 被上游拒绝） |
| `input_char_limit` | duck.ai 前端 `inputCharLimit`（免费模型 16,000，UI 软限制） |
| `max_output_tokens` | 4096 |
| `max_output_tokens_estimated` | `true` |
| `compaction_supported` | 白名单（duck 压缩白名单 9 个模型） |
| `compaction_trigger` | 支持压缩时 `tokens`，否则 `null` |
| `compaction_threshold_tokens` | `null`（服务端运行期 `[SUMMARY_REFRESH_HINT]` 下发） |
| `activation_target_pair_count` | 上游提供时 >0，否则 0（fallback ≥4 pairs） |
| `session_limit_behavior` | `summarize_and_continue` / `new_chat` |

## D. 结论（v2.20 已实现）

1. `context_window_chars = 20,000`、`max_input_chars = 19,500`（实测边界保守值）；
   `input_char_limit = 16,000` 原样保留（duck.ai 前端 UI 软限制）。
2. `session_limit_behavior`：白名单模型 `summarize_and_continue`，其余 `new_chat`；
   达到上限时网关返回 409 `conversation_limit_reached`，**不会**替客户端自动新开会话。
3. `max_output_tokens = 4096`，`max_output_tokens_estimated = true`（实测输出下界见 B.4）。
4. 超长输入的对外错误：**HTTP 413 `context_length_exceeded`**。

---

## E. 每模型上下文/压缩矩阵（v2.19 任务汇总；证据强度标注）

| 模型 | 自动压缩 | 触发阈值 | 单条输入上限 | 会话上限行为 | 输出上限 | 证据强度 |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6-luna | ❌ | —（不压缩） | 前端 16,000；真实 ~19,5xx 字符（实测） | 上游 `ERR_CONVERSATION_LIMIT`，文案要求新开会话；**不自动清空/新开** | 未公布；实测 ≥6,427 字符（下界） | 压缩白名单=源码证据；input/会话=源码+实测；输出=实测下界 |
| gpt-5.4-mini | ✅ | fallback 4 pair（实测第 6 轮触发）；activation 未在静态目录 | 前端 16,000；实测 16,100 通过、20,000 413 | 摘要后同会话继续（Summarize and Continue） | 未公布；实测 ≥4,335 字符 | 白名单=源码；触发=源码+实测 |
| claude-haiku-4-5 | ✅ | 同上（fallback ≥4 pair） | 16,000；实测 16,100 通过 | summarize_and_continue | 未知 | 白名单=源码；输入上限=部分实测 |
| mistral-small-2603 | ❌ | — | 16,000（无实测） | 新开会话（推断同非白名单行为） | 未知 | 白名单=源码；上限行为=推断 |
| tinfoil/gpt-oss-120b | ❌ | — | 16,000（无实测） | 新开会话（推断） | 未知 | 源码白名单 + 推断 |
| tinfoil/gemma4-31b | ❌ | — | 16,000（无实测） | 新开会话（推断） | 未知 | 同上 |
| gpt-5.6-terra | ✅ | fallback ≥4 pair / activation（运行时） | 16,000（未实测） | summarize_and_continue | 未知 | 白名单=源码；触发=源码 |
| gpt-5.6-sol | ✅ | 同上 | 16,000 | summarize_and_continue | 未知 | 源码 |
| claude-sonnet-5-5 | ✅ | 同上 | 16,000 | summarize_and_continue | 未知 | 源码 |
| claude-opus-5-5 | ✅ | 同上 | 16,000 | summarize_and_continue | 未知 | 源码 |
| claude-haiku-5-5 | ✅（仅 internal） | 同上 | 16,000 | summarize_and_continue（internal） | 未知 | 源码（白名单 o 列表） |
| claude-sonnet-4-6 / claude-opus-4-8 | ✅ | 同上 | 16,000 | summarize_and_continue | 未知 | 源码（白名单含，未在网关目录） |

### E.1 非压缩模型达到上限时的真实源码处理（gpt-6-luna 等）

源码证据（bundle ~1978800 DONE 解析 + 文案表）：

1. 服务端在 DONE 行下发 `[LIMIT_CONVERSATION]`；
2. 前端映射 `_ = "ERR_CONVERSATION_LIMIT"`，`n("ERR_CONVERSATION_LIMIT", ...)`，并调用 `s(...)`；
3. UI 文案 key：`DUCKCHAT_ERROR_CONVERSATION_LIMIT` =
   "You've reached the maximum chat length in this conversation. **Start a new chat to continue.**"；
4. **不会自动新开会话、不会清空历史**；用户主动点「New chat」（`DUCKCHAT_NEW_CHAT` 系文案）才新开；
5. 对比白名单模型：`DUCKCHAT_COMPACTION_LIMIT_DESCRIPTION` =
   "You've reached the maximum length for this chat. Summarize the conversation and pick up where you left off."，
   按钮 `DUCKCHAT_COMPACTION_SUMMARIZE_BUTTON = "Summarize and Continue"`，完成后同会话继续；
6. `[ERR_INPUT_LIMIT]`（单条超限）与 `[LIMIT_CONVERSATION]`（整段会话超限）是两条不同分支：
   前者提示缩短输入，后者才是会话长度限制。

> 因此网关对非白名单模型只能原样映射 409 `conversation_limit_reached`（当前 v2.20 行为），
> 不应替用户自动裁剪/新开会话；自动 compact 仅白名单模型可用（客户端可调 `/v1/compact`）。

### E.2 建议的 `/v1/models` 字段（已落地 + 建议语义）

| 字段 | 类型 | 来源/语义 | 当前状态 |
| --- | --- | --- | --- |
| `context_window_chars` | number | 会话可用字符窗口（保守值 20,000；实测会话 >30k，单条 19.5k） | ✅ v2.20 |
| `context_window` / `max_input_tokens` | number | `max_input_chars/3` 估算 | ✅（估算） |
| `max_input_chars` | number | 单条输入安全上限（19,500，实测边界） | ✅ v2.20 |
| `input_char_limit` | number | duck.ai 前端 `inputCharLimit`（16,000，UI 软限制） | ✅ |
| `max_output_tokens` | number | 4096 估算（上游无公开值） | ✅（estimated） |
| `max_output_tokens_estimated` | boolean | 是否估算 | ✅ |
| `compaction_supported` | boolean | 是否在 9 模型压缩白名单 | ✅ |
| `compaction_trigger` | `"tokens"|"pairs"|null` | 服务端/客户端触发类型 | ✅ tokens/null |
| `compaction_threshold_tokens` | number|null | 运行期 `[SUMMARY_REFRESH_HINT].thresholdTokens`；静态未知→null | ✅ |
| `activation_target_pair_count` | number | 上游 capabilities/modelConfig 提供；0=未配置 | ✅ |
| `session_limit_behavior` | enum | `summarize_and_continue` / `new_chat` | ✅ |
| `default_reasoning_effort` | string|null | 源码无字段；建议按 UI 默认（推断，需实测确认） | ❌ 未提供（避免臆造） |
| `supports_images` / `input_image_support` | boolean/object | 模型 `inputImageSupport`（bundle 有值，网关未逐模型录入） | ❌ 建议后续补 |
| `supported_tools` | string[] | 上游工具名（WebSearch/GenerateImage/Browser*…） | ⚠️ 网关仅 API 级 tools |

> 说明：`context_window_tokens` 无法从源码确证，只能由 `context_window_chars / 3` 估算；
> 真实 token 预算由服务端按模型/账号计算（`[SUMMARY_REFRESH_HINT].thresholdTokens`、
> `[FIXED_COST_WINDOW_USAGE]` 下发），不要用字符表直接当 token 计费依据。
