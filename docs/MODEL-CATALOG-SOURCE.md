# duck.ai 模型目录：获取方式与参数（源码分析，v2.19）

> 结论先行：**duck.ai 的模型列表不是从前端硬编码的完整数组拿的**，页面通过 bootstrap
> `GET /duckchat/v1/capabilities` 获取 flag/实验配置，再结合内置的模型元数据与订阅档位
> （free / Plus（plus）/ Pro）在 `useModelCatalog`（bundle 内 hook）里组装出
> `availableModels / plusModels / proModels / completeListOfModels / deprecatedModels`。
> 每个模型对象携带 `model`、`modelName`、`modelVariant`、`modelType`、`inputCharLimit`、
> `inputImageSupport`、`toolChoice`、推理档位等字段。
>
> ⚠️ 本文证据来自 `recon/entry.duckai.2d2656b1fcd20ced62d9.js`（下称 bundle）静态分析 +
> 真实抓包；bundle 偏移仅供参考（压缩产物）。

## 1. 模型列表如何获取

### 1.1 Bootstrap：`GET /duckchat/v1/capabilities`

bundle @1443603 处（`KF` 函数）：

```js
fetch('/duckchat/v1/capabilities', {
  cache: 'no-store',
  credentials: 'include',
  headers,             // 与 chat 相同的 x-* 头（挑战、journey 等）
  signal               // AbortController，默认 3s 超时
})
```

响应形状（由使用处推断）：

```jsonc
{
  "assignments": { /* 功能开关 name -> value */ },
  "experimentEnrollments": [],
  "experimentStateResets": []
}
```

- 失败时回退到内置默认 `FF`（同文件内常量），即**离线仍可渲染默认模型目录**；
- 该请求带 3s header timeout / 3s body timeout，且在有 lock 的浏览器侧 `request('duckai-capabilities')`
  做单飞去重（@1508470）。

### 1.2 模型目录 hook 暴露的字段

bundle @326086 / @1102196 处通过 hook 解构：

```js
const {
  availableModels,
  plusModels,
  proModels,
  completeListOfModels,
  deprecatedModels,
  preferredModel,
  defaultModel,
  isModelAvailable,
  setPreferredModel
} = useModelCatalog();      // bundle 内实际函数名已压缩（Qe.GB）
```

- 模型选择器按档位分区：`availableModels`（免费）、`plusModels`、`proModels`；
- 文案证据（@53186）：
  - `DUCKCHAT_MODEL_PICKER_SUBSCRIBER_EXCLUSIVE` = "Unlock with subscription."
  - `DUCKCHAT_MODEL_PICKER_PRO_EXCLUSIVE` = "Pro exclusive."
  - `DUCKCHAT_MODEL_MODAL_DISCLAIMER` = "…starting a new chat with any model will delete your current chat session."

### 1.3 模型对象字段（真实使用点）

| 字段 | 出现位置/含义 | 证据 |
| --- | --- | --- |
| `model` | 请求体的 `model` 值（如 `gpt-6-luna`） | @327678 `metadata.modelId = R.current.model` |
| `modelName` | UI 显示名 | @527883 `<span>{modelConfig.modelName}</span>` |
| `modelVariant` | 显示名后缀（如档位/版本） | @527883 |
| `modelType` | `chat` / `image` 等类型，决定是否显示推理块 | @593347 `"reasoning"!==ge`（ge=`modelType`） |
| `inputCharLimit` | 单条输入字符上限，输入框计数器直接用 | @651292、@1148412 `ze.inputCharLimit` |
| `inputImageSupport` | 是否支持图片输入；切换图片工具时优先选 `inputImageSupport` 的模型 | @1148412 |
| `toolChoice` | `{WebSearch:true}` / `{GenerateImage:true}` 等工具偏好 | @1994747、body `metadata.toolChoice` |
| `reasoningEffort`（请求参数） | 推理档位，写入 body；模型是否支持由 `reasoningMode`/`modelType` 决定 | @593347、@1994747 |
| 档位/付费 | 通过 `accessTier`、`isEligibleForSubscription`、`isProTierEnabled` 判定（@607039） | @607039 |

### 1.4 模型定义的真实位置与字段枚举（bundle ~1,954,000 起）

模型元数据是**打包进前端的常量数组**（不是从 `/capabilities` 拿完整对象）：
bundle 约 1,954,600 起可见 `gpt-5.6-terra`、`claude-haiku-5-5` 等完整定义；另有
`DuckAssist` / `voice-mode` 等内部/语音伪模型。字段枚举（同一定义内）：

| 字段（真实名称） | 枚举/形状 | 证据 |
| --- | --- | --- |
| `model` | 请求体 model id（`gpt-5.6-terra`、`claude-haiku-5-5`、`gpt-6-luna` …） | 模型定义数组 |
| `serviceModelId` | 可选，上游实际服务模型（如 voice-mode → `gpt-realtime-2.1-mini`） | voice-mode 定义 |
| `modelName` / `modelVariant` / `modelShortName` | UI 名称/变体/短名 | 模型定义 |
| `createdBy` | `OpenAI` / `Anthropic` / `Mistral AI` / `Google` / `DuckDuckGo` | 模型定义 |
| `modelType` | `"reasoning"` / `"general"`（决定是否展示推理块） | 模型定义 + @593347 |
| `supportedReasoningEffort` | 数组，如 `["none","low"]`、`["none","low","medium"]`；**没有 `defaultReasoningEffort` 字段** | 模型定义（gpt-5.6-terra 等） |
| `moderationLevel` | `HIGH` / `LOW` | 模型定义 |
| `availableTo` | 访问档位数组：`[ac.Free]` / `[ac.Plus,ac.Pro,ac.Internal]` / `[]`（语音/内部） | 模型定义 |
| `inputCharLimit` | 数字，绝大多数为 **16000**；voice-mode 为 0 | 模型定义/@651292 |
| `inputImageSupport` | `{isAvailable:true,inputMessageLimits:{imageCount:3,textCharacters:4500},conversationLimits:{totalImageCount:...},maxDimension}` | paid 模型定义 |
| `inputFileSupport` | `{isAvailable:true,supportedMediaTypes:["application/pdf"],limitsByAccessTier:{FREE/PLUS/PRO/INTERNAL:{maxFileSizeBytes,totalFileCount,combinedFileSize,maxPagesPerFile}}}` | paid 模型定义 |
| `settingId` | 设置项 id（`"271"`、`"295"` 等） | 模型定义 |
| `supportedTools` | 上游工具名数组：`WebSearch`、`RelatedSearchTerms`、`FindInDocument`、`ReadDocument`、`ReadDocumentSelection`、`LocationPrompt`、`GenerateImage`、`Browser*` 等 | 模型定义 |
| `assistantPrefillUnsupported` | 可选 boolean | `claude-haiku-5-5` |
| `costRank` | 数字，模型成本排序 | 模型定义 |
| `isOpenSource` / `isEncrypted` | 可选 boolean | oss/gemma 等 |

**不存在/未找到的字段**（源码全文检索）：
- `maxTokens`、`contextWindow`、`maxOutputTokens`：bundle 无命中（`contextWindow` 仅 vendored 库无关字段）；
- `defaultReasoningEffort`：无字段；默认推理档由 UI 状态/用户偏好决定（具体默认值**未在 bundle 找到确证**，推断为模型 supported 列表内选择）；
- `visibility`：模型定义里用 `availableTo` 表达可见档位，没有独立 `visibility` 字段；
- `artifacts`：无命中；skills 走运行时 `skill-references` 消息/`skills` 元数据，不是模型字段。

### 1.5 每模型参数矩阵（bundle 定义 + 网关目录对照）

| 模型 | modelType | availableTo | supportedReasoningEffort | inputCharLimit | inputImageSupport | 关键 supportedTools | 网关目录 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-luna | reasoning | Free/Plus/Pro | none/low | 16000 | 未在定义中确认 | WebSearch/Related/FindInDocument/ReadDocument/Location/GenerateImage | ✅ free |
| gpt-5.4-mini | reasoning | Free/Plus/Pro | none/low/medium | 16000 | 未确认 | 同上 | ✅ free |
| claude-haiku-4-5 | reasoning | Free/Plus/Pro | none/low | 16000 | 未确认 | WebSearch/Related/FindInDocument/ReadDocumentSelection/ReadDocument/Location | ✅ free |
| mistral-small-2603 | general | Free/Plus/Pro | （无推理档） | 16000 | 未确认 | 无工具 | ✅ free |
| tinfoil/gpt-oss-120b | reasoning | Free/Plus/Pro | low | 16000 | 未确认 | WebSearch/Location/FindInDocument/ReadDocument/ReadDocumentSelection | ✅ free |
| tinfoil/gemma4-31b | reasoning | Free/Plus/Pro | none/low | 16000 | 未确认 | 同上 | ✅ free |
| gpt-5.6-terra | reasoning | Plus/Pro/Internal | none/low/medium | 16000 | ✅（3 图/对话 10 图） | Browser* + WebSearch + GenerateImage | ✅ paid plus |
| gpt-5.6-sol | reasoning | Plus/Pro/Internal | none/low/medium | 16000 | ✅ | 同上族 | ✅ paid pro |
| claude-sonnet-5-5 | reasoning | Plus/Pro/Internal | none/low（bundle 定义） | 16000 | ✅ PDF | WebSearch/ReadDocument/GenerateImage 等 | ✅ paid plus |
| claude-opus-5-5 | reasoning | Plus/Pro/Internal | none/low/medium（bundle 定义） | 16000 | ✅ PDF | 同上 | ✅ paid pro |
| claude-haiku-5-5 | reasoning | Internal | none/low | 16000 | 未确认 | WebSearch/FindInDocument/ReadDocument… | ❌ 目录外（internal-only） |
| claude-sonnet-4-6 | reasoning | Plus/Pro/Internal | 未逐一确认 | 16000 | 未确认 | 未逐一确认 | ❌ 目录外 |
| claude-opus-4-8 | reasoning | Plus/Pro/Internal | 未逐一确认 | 16000 | 未确认 | 未逐一确认 | ❌ 目录外 |
| voice-mode / DuckAssist | general | [] / Internal | — | 0 / 16000 | — | — | ❌（不对外 chat） |

> 注：`availableTo` 中的 Free/Plus/Pro/Internal 是内部枚举；网关用 `tier` 字段近似，
> 真正的可见性应以 `/capabilities` 的 tier/实验 + 该数组为准（本次验证不改代码）。
> 上表「未确认」项表示当前 bundle 静态扫描未定位到明确值，不应臆造。

## 2. 我们网关当前的实现与差距

我们 `src/duck/models.js` 是**内置静态目录**（免费 6 个 + 付费 4 个），再叠加
`compaction 白名单`、`inputCharLimit=16000`、`context_window_chars=16000`、
`max_output_tokens=4096`、`tools: [web_search, image_generation]` 等字段。
`GET /v1/models` 实测（2026-11-02）：

| id | paid | tier | compaction | input_char_limit | reasoning |
| --- | --- | --- | --- | --- | --- |
| gpt-6-luna | ❌ | free | ❌ | 16000 | none/low |
| gpt-5.4-mini | ❌ | free | ✅ | 16000 | none/low/medium |
| claude-haiku-4-5 | ❌ | free | ✅ | 16000 | none/low |
| mistral-small-2603 | ❌ | free | ❌ | 16000 | —（无推理档） |
| tinfoil/gpt-oss-120b | ❌ | free | ❌ | 16000 | low |
| tinfoil/gemma4-31b | ❌ | free | ❌ | 16000 | none/low |
| gpt-5.6-terra | ✅ | plus | ✅ | 16000 | none/low/medium |
| gpt-5.6-sol | ✅ | pro | ✅ | 16000 | none/low/medium |
| claude-sonnet-5-5 | ✅ | plus | ✅ | 16000 | none/low |
| claude-opus-5-5 | ✅ | pro | ✅ | 16000 | none/low/medium |

差距清单：

| 项 | 现状 | 源码可动态获得？ | 建议 |
| --- | --- | --- | --- |
| 模型清单 | 静态数组（更新需改代码） | ✅ `/capabilities` 的 assignments/实验 + 内置元数据 | 启动/定时拉 `/capabilities`（TTL 10–30 分钟），失败回退静态表 |
| `inputCharLimit` | 全部写死 16000 | ✅ 来自模型对象 | 按模型透出，不要写死 |
| 付费档位（plus/pro） | 用 tier 字段近似 | ✅ `plusModels/proModels` 分区 | 用 3 档：free / plus / pro |
| 推理档位 | 静态 `supported_reasoning_efforts` | ⚠️ 部分（模型对象 + UI 判断） | 保留静态兜底，能力变更以 `/capabilities` 为准 |
| 图片/联网工具 | 静态 tools | ⚠️ 模型对象 + 运行时 `toolChoice` | 增加 `inputImageSupport` / `supportsWebSearch` 字段 |
| `modelVariant` | 无 | ✅ | `/v1/models` 增加 `variant` 字段（仅信息展示） |

> 备注：bundle 中**没有** `/duckchat/v1/models` 端点；模型元数据与 UI 文案一起打包在
> 前端模块里，`/capabilities` 只负责实验/开关与部分运行时配置。

## 3. 与本次修复相关

- 问「洛杉矶天气怎么样」时上游用 `continuation` 帧要求 `user-location` / `web-search`
  工具审批（不是 `[DONE]`）；网关已实现 continuation 续传 + 显式 WebSearch 兜底
  （见 `docs/PROTOCOL.md` §continuation 与 `src/duck/index.js::_resumeContinuation`）。
- 模型工具能力（web_search / image_generation）应通过 `/v1/models` 的
  `tools` / `capabilities` 明确暴露，客户端据此决定是否传 `tools:[{"type":"web_search"}]`。
