# duck.ai API / 网页功能地图（v2.12）

> 证据来源：`recon/entry.duckai.2d2656b1fcd20ced62d9.js`（2026-11-01）+ 既有协议文档。
> 状态图例：✅ 网关已实现；🟡 部分实现/仅解析不做动作；❌ 缺失。
> "网关" 指 duckai-cpa 当前代码（`src/duck/**`、`src/openai/**`、`src/admin/**`、`src/http/**`、`src/webapp`），
> 具体以代码为准；本表用于补齐遗漏。

---

## 1. `/duckchat/v1/*` 端点清单

| 端点 | 方法 | 用途/关键字段 | 网关状态 |
| --- | --- | --- | --- |
| `/duckchat/v1/status` | GET | 挑战/能力探测；请求头 `x-vqd-accept:1`、`x-vqd-hash-1:initial`、`x-fe-version`、`x-fe-signals`；响应头回传 `x-vqd-hash-1` 挑战 JS；也返回 feature/limit 信息 | ✅ ChallengeManager（滚动挑战、能力探测） |
| `/duckchat/v1/chat` | POST SSE | 对话主端点；body `{model,messages,reasoningEffort,canUseTools,metadata.toolChoice,canShowGreeting,durableStream?}`；响应 `text/event-stream`，逐 data 帧 | ✅ DuckClient.chat（文本/推理/搜索/图片/工具事件归一化） |
| `/duckchat/v1/capabilities` | GET | 启动时拉取模型/能力/features/limits（含 `activationTargetPairCount` 等运行时字段） | 🟡 仅 `fetchCapabilitiesWithHeaders` 取挑战头/能力；未把 capabilities 用于模型目录或压缩触发 |
| `/duckchat/v1/summarize` | POST JSON | 原生摘要；body `{model,previousSummary:{text,version}|null,targetPairCount,newMessages:[{role:'user'\|'assistant',text,parts?}]}`；响应 `{summary:{text,version?},coveredPairCount?,fixedCostWindowUsage?}` | ✅ `DuckClient.summarizeNative`（真实 gpt-5.4-mini 200；gpt-6-luna 404 白名单） |
| `/duckchat/v1/summarize/compact` | POST JSON | 主动 compact 端点（bundle 仅有常量/导出函数 `sY`，未找到调用点与 payload 证据） | ❌ 未实现（待证据） |
| `/duckchat/v1/usage` | GET | 用量窗口（`six_hours`/`day`/`iso_week`/`month`）、`fixedCostWindowUsage` | ❌ 未接入（网关只从 chat DONE 标记拿 usage windows） |
| `/duckchat/v1/campaigns` | GET | Bonus/限时额度活动（campaignName/multiplier） | ❌ 未实现 |
| `/duckchat/v1/redeem` | POST | 兑换 bonus/额度活动；状态 409 ended、400/404 等 | ❌ 未实现 |
| `/duckchat/v1/dictation` | POST audio | 语音听写/转写；音频类型 `audio/webm;codecs=opus` 等，限制常量（30s/`3e4`、`1e3` 等） | ❌ 未实现 |
| `/duckchat/v1/auth/authorize` | GET | 订阅/账号 OAuth 授权 | 🟡 仅发送 `Authorization` token；无 OAuth 流程 |
| `/duckchat/v1/auth/token` | POST | 用授权码换 token | ❌ 未实现（网关仅解析外部 token） |
| `/duckchat/v1/auth/logout` | POST | 退出登录 | ❌ 未实现 |
| `/duckchat/v1/auth/callback` | GET | OAuth 回调（浏览器侧） | ❌ 未实现 |

### 请求/响应通用机制
- 挑战：`x-vqd-hash-1`（rolling，响应头新值必须 commit；本网关 v2 严格校验）。
- 稳定身份：`x-ddg-journey-id`（32 hex）、`durableStream`（RSA-OAEP-256 JWK）。
- 客户端标识/工具：`x-duckai-client-tools: {"version":1,"capabilities":[]}`、`x-duckai-response-id`、`x-duckai-continuation: resubmit-context`、`x-duckai-tool-approval`、`x-duckai-consent-purposes`。
- 订阅：`Authorization: Bearer <token>`（过期不发）。
- 请求体 system prompt：上游 `role:"system"` 会被 400 拒绝 → 网关默认 inline prefix。

---

## 2. SSE 事件 / DONE 标记（chat 响应）

### 2.1 事件角色（`src/duck/sse.js` 白名单）
| 角色/事件 | 含义 | 网关 |
| --- | --- | --- |
| `assistant`/text delta | 正文流 | ✅ |
| `reasoning`（state=…/summaryText/encryptedText） | 推理；免费模型仅加密 JWE | ✅（`reasoningEncrypted`） |
| `tool-invocation` call/result | 工具调用/结果 | ✅（WebSearch/GenerateImage/FindInDocument…） |
| `source` | 引用来源 | ✅（`sources`/citations 拼接） |
| `generated-image` | 生成图片 | ✅ |
| `partial-image` | 图片生成进度 | ✅（忽略/归并） |
| `ui-component` | UI 组件（search-results、generate-image、writing block 等） | 🟡 通用解析；writing block 不渲染 |
| `refusal` | 拒答/内容过滤 | ✅ 映射 403 content_filter |
| `image-validated` | 图片安全校验 token | ✅ 透传 |
| `continuation` | 续写/continue 指令 | ✅ 透传 |
| `skill-references` | 技能引用 | 🟡 解析透传，不执行技能 |
| `error`（action:"error"） | 错误事件 | ✅ DuckError 映射 |
| `[PING]` | 心跳 | ✅ |
| `[CHAT_TITLE:<title>]` | 自动标题 | ✅ |
| `[DONE]` | 结束 | ✅（strict 模式必须出现） |

### 2.2 DONE 伪标记
| 标记 | 语义 | 网关 |
| --- | --- | --- |
| `[FIXED_COST_WINDOW_USAGE:…]` | 固定成本窗口用量（6h/day/week/month） | ✅ 解析为 `quotaWindows` |
| `[SUMMARY_REFRESH_HINT:{…}]` | 服务端建议摘要刷新（tokens 触发；`baseCoveredPairCount/targetPairCount/thresholdTokens`） | ✅ 解析为 `summaryRefreshHint`；🟡 未自动触发摘要（api-core 决定） |
| `[SUMMARY_INVALID]` | 摘要失效 | ✅ `summaryInvalid`；🟡 未自动失效处理 |
| `[LIMIT_CONVERSATION]` / `[LIMIT_ACCOUNT]` / `[LIMIT_ENTITY]` / `[LIMIT_IMAGE_GENERATIONS]` | 额度限制 | ✅ 映射 DuckError（429/403） |
| `[ADS:<JSON>]` | 广告窗口数据 | ✅ 解析 `adWindow`；🟡 不渲染广告 |
| `[STOP_REASON:<word>]` | 结束原因（max_tokens 等） | ✅ |
| `[WARN_CONVERSATION_LIMIT:<n>]` | 会话使用百分比警告 | ✅ |
| `[LIMIT_ENTITY]`/`[LIMIT_ACCOUNT]` 等 | 与上同 | ✅ |

---

## 3. Sync / 配对 / 身份端点

| 端点/功能 | 说明 | 网关 |
| --- | --- | --- |
| `GET/POST https://sync.duckduckgo.com/sync/…` | Sync 账号服务（base `/sync`） | 🟡 部分（见下） |
| `POST /sync/signup` | 创建 3party 账号（credential_id/keys/device_info） | ❌ 未实现（官方 App 账号创建流程） |
| `POST /sync/login` | 账号登录（HKDF：Main Key/Password；JWE device_name/type；scope=ai_chats） | ✅ `sync-client.login`（真实 200） |
| `GET /sync/keys` | 密钥列表（account_info/ai_chats；`encrypted_with` ddg/3party） | ✅（读取/选择 account_info） |
| `POST /sync/keys/purpose/account_info/set-if-absent` | 创建 account_info 3072-bit key（DER 私钥 JWE） | ✅（缺失时创建） |
| `GET/PATCH /sync/devices` | 设备列表/注册（每次 PATCH 仅 1 条 update；token 只能改本机） | ✅ `sync-client`（多设备、解密列表、批量注销） |
| `POST /sync/logout-device` | 注销设备（会失效 token） | ✅ |
| `GET/POST /sync/data` | 同步数据（聊天历史元数据） | ❌ 未实现 |
| `GET/POST /sync/ai_chats` | 聊天历史同步 | ❌ 未实现 |
| `GET /sync/files` | 文件同步（`/data/<chat>/files/<id>`） | ❌ 未实现 |
| `GET /sync/ai_chat_streams/<messageId>` | durable stream 数据 | 🟡 身份有 durableStream 密钥，但未请求该数据流 |
| `PUT/GET/POST /sync/v2/exchange/<uuid>[/messages]` | 配对交换频道（hello/信封） | ✅ `PairingHost`（频道注册/轮询/hello/最小 exchange） |
| `https://duckduckgo.com/sync/pairing/#&code2=…` | 配对二维码 URL | ✅ `buildPairingCode` + 前端二维码（web） |
| Sync 恢复码 | `base64url(JSON({recovery:{user_id,secret}}))` | ✅ 解析/生成（`pairing.js`/`sync-client.js`） |

---

## 4. 网页功能 / 组件

| 功能 | 说明/证据 | 网关状态 |
| --- | --- | --- |
| Chat 文本/流式 | 主页面 | ✅ |
| 模型选择 | 模型目录 + reasoning efforts | ✅（`models.js`；前端选择由 webapp） |
| 推理档位（none/minimal/low/medium/high） | `reasoningEffort` 映射/裁剪 | ✅ |
| 联网搜索 WebSearch | tool-choice + sources/annotations | ✅ |
| 图片生成 GenerateImage | `/chat` 工具 + generated-image | ✅ |
| 图片输入/附件上传 | `inputImageSupport`、文件支持 PDF 等；`/files` 端点 | ❌（网关未实现上传/多模态输入） |
| 文件/PDF 读取（FindInDocument/ReadDocument） | tools + 文件引用 | ❌（仅工具名透传，无上传） |
| Skills（技能） | skill-references、skillsEnabled；配对/分享技能 | 🟡（解析/透传；不执行/不管理技能） |
| 页面上下文（page-context）/浏览器工具 | BrowserListOpenTabs/BrowserReadTabContent 等 | ❌（网关不支持浏览器扩展上下文） |
| 语音聊天（voice-mode）/ 实时语音 | `voice-mode` 模型、`gpt-realtime-2.1-mini` | ❌ |
| 语音听写（Dictation） | `/duckchat/v1/dictation` 音频上传 | ❌ |
| 写作块（Writing blocks） | `[Writing block]` UI 组件/channel/subject | ❌（不解析写作块内容） |
| 分享/分享链接 | 分享聊天、`isSharePreview`、删除 shared links | ❌（网关无分享链接 API） |
| 侧栏/历史/置顶 | 会话列表、pinned、删除/清空 | 🟡（api-core 有自建 sessions/webapp，无 duck.ai 原生历史同步） |
| 广告 ADS | DONE `[ADS]` + 广告窗口 | 🟡（解析数据，不展示） |
| Bonus/奖励/Campaigns/Redeem | `/campaigns`、`/redeem`、bonus 文案/多倍额度 | ❌ |
| 订阅 Plus/Pro | `Authorization` token、tier/entitlements、付费模型 | 🟡（解析 token/路由付费模型；无购买/OAuth 流程） |
| Sync & Backup（聊天记录同步） | Sync 账号 + `/data`/`/ai_chats`/`/files` | 🟡（配对+设备注册；历史/文件同步未实现） |
| Durable Stream（聊天长期存储） | `durableStream` 密钥、`/ai_chat_streams` | 🟡（chat body 带密钥；未读写 stream） |
| 设置（外观/聊天/订阅/用量/关于） | Duck.ai Settings | ❌（网关有自己的 admin 设置，非 duck.ai） |
| 反馈/调查 | Feedback section、匿名 survey | ❌ |
| 错误/离线/刷新提示 | 各类文案/重试 | ✅ 部分（网关错误映射；无前端页面） |
| 用量限制/6h/日/周/月 | `/usage` + DONE windows | 🟡（DONE windows 解析；无 `/usage` 查询） |
| 账号/登录/退出（duck.ai 账号） | auth 端点 | ❌（网关用本地 identity，无 Duck 账号登录 UI） |
| 新版本提示/刷新 | version modal | ❌（不涉及） |

---

## 5. duck.ai URL 参数/路由

| 参数/路由 | 用途 | 网关 |
| --- | --- | --- |
| `?chatID=<id>`（`mt="chatID"`，载入后从 URL 删除） | 打开指定聊天 | ❌（网关用 X-Session-Id/自建 sessions） |
| `?showLog=true` | 前端日志开关 | ❌ |
| `?willerror=oauth.getsessionid…` | 调试/OAuth 错误注入 | ❌ |
| `#/…` 前端路由（设置/历史/分享等） | webapp 路由 | ❌（网关 webapp 独立） |
| 其他模型/推理参数 | 前端状态，不在 URL 中持久化（bundle 未发现） | — |

---

## 6. 网关缺口优先级建议

1. **压缩闭环**（task-40）：`activationTargetPairCount` 从 capabilities 读取；`SUMMARY_REFRESH_HINT` 自动触发一次
   `/summarize`；`SUMMARY_INVALID` 失效重算；`initialContext` + `slice(2*coveredPairCount)` 发送；Chat Summary 展示/编辑。
2. **模型目录补全**：白名单中 `claude-haiku-5-5/claude-sonnet-4-6/claude-opus-4-8` 不在网关目录（若用户 tier 可用需补）。
3. **`/summarize/compact`**：找到调用点/payload 后实现主动 compact。
4. **上传/多模态**：`/files` + PDF/图片输入；对应 OpenAI `input_image`/file 映射。
5. **语音**：`/dictation`（语音输入）与 voice-mode（实时语音）——属于大功能，需评估。
6. **Sync 历史**：`/data`、`/ai_chats`、`/files`、`/ai_chat_streams`（聊天记录跨设备）——比设备注册大很多。
7. **订阅/账号**：auth OAuth 流程、`/usage`、`/campaigns`、`/redeem`（额度与 Plus/Pro 购买）。
8. **网页功能**：写作块、skills 执行、分享链接、侧栏历史、设置、反馈、广告展示——多数属于 webapp 层，需用户确认是否要 1:1 复刻。

---

## 7. 备注

- 本表以 bundle 证据 + 现有网关代码为限；未在 bundle 出现的端点（如某些内部 admin）不臆造。
- 「网关状态」描述的是**协议层/服务层能力**，不等于 Web UI 是否有入口；webapp 由 web-dashboard 维护。
- 与 compaction 相关的细节见 `docs/COMPACTION-RESEARCH.md`；compact API 见 `docs/COMPACT.md`。

## 自定义 tools 支持评估（v2.39 源码调研）

### 结论

**duck.ai 协议层不支持注册任意自定义 tool（没有 OpenAI 的 `tools[]` 定义通道）。**
上游只认每个模型静态声明的工具白名单，`canUseTools` 只是总开关。

### 源码依据（entry.duckai bundle, serp_20261104）

1. `/duckchat/v1/chat` 请求体字段固定：`{model,messages,canUseTools,reasoningEffort,canUseApproxLocation,
   canDelegateImageGeneration,canShowGreeting,durableStream,metadata,continuation,currentAssistant}`；
   **没有** `tools` / `tool_definitions` / JSON Schema 通道。
2. `metadata.toolChoice` 只接受内置工具名（WebSearch / GenerateImage 等）。实测传 `{MyCustomTool:true}`：
   上游**静默忽略**，模型照常用 WebSearch 回答（不报错、也不调用自定义工具）。
3. 模型目录里 `supportedTools` 是固定枚举（每个模型一份）：
   `BrowserListOpenTabs, BrowserSwitchToTab, BrowserSearchHistory, BrowserReadTabContent,
   BrowserFindInPage, BrowserHighlightInPage, WebSearch, RelatedSearchTerms, FindInDocument,
   ReadDocumentSelection, ReadDocument, LocationPrompt, GenerateImage`。
4. `x-duckai-client-tools` 只是**客户端能力声明**：`{"version":1,"capabilities":[{"name","version"}]}`，
   由浏览器扩展 bridge 提供，名字/版本必须是服务端已知的（如 `loadUserSkill` v1 与浏览器工具）；
   且受实验开关 `client-tools-support`（默认 **false**）控制。实测注入自定义 capability：被忽略。
5. `client-output` continuation 只支持固定 contract（如 `BrowserLoadUserSkill.v1`），没有任意 schema。
6. `userSkills` 是「技能文本」（≤32KB，经 bridge 加载），属于**指令/文档**而非可执行函数；
   单独在 metadata 传 userSkills 也被忽略（还需要 bridge capability + 实验开关 + skill-reference 流程）。

### 可行的自定义工具方案（网关层）

- **A. 网关侧 function-calling shim（推荐）**：OpenAI `tools` → 注入 system prompt 的 JSON 协议 →
  模型输出 `{"tool":...,"args":...}` → 网关执行（HTTP / 本地进程 / MCP）→ 把结果作为 tool 消息回填并再请求；
  支持流式时先发 tool_call 事件再继续。代价：依赖模型遵循 prompt，需要严格解析与重试。
- **B. 固定内置工具增强**：仅使用 WebSearch / GenerateImage / LocationPrompt 等，不做任意工具。
- **C. 客户端自行实现 tools**：网关只负责透传模型输出；实际调用与结果回填由客户端做（仍需要 prompt 协议）。

> v2.40：experimental client tools 的详细调研见 `docs/CLIENT-TOOLS-RESEARCH.md`（结论：不能实现任意自定义 client tools，只能复用 loadUserSkill 做技能文本加载）。
