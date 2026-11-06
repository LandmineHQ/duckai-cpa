# 后端架构重构方案（待确认，不直接改代码）

> 状态：**设计稿 / 等待用户确认**
> 范围：`src/http`、`src/openai`、`src/admin` 的 HTTP/业务分层；`src/duck` 上游协议层保持边界，不在本方案内重写。
> 本轮只产出方案，不修改 `src/`、`tests/`、配置或运行中的其它任务文件。

## 1. 结论先行

当前的主要问题不是“用了 `node:http`”本身，而是：

- 传输层（HTTP/SSE/静态/鉴权）与业务层（OpenAI 映射/会话/压缩/图片/持久化）**耦合在单文件**；
- `server.js` 同时承担路由、上下文装配、请求体读取、CORS、静态资源、错误处理、SSE、管理 API 分发；
- `chat.js`、`responses.js` 各自实现会话/PDF/图片/工具/流式逻辑，重复且难以保证行为一致；
- `admin/routes.js` 集中了过多资源路由，新增接口只能继续堆大文件；
- 结果：可测试性差、改动风险高、契约容易漂移。

**推荐目标：**

1. 先把 HTTP 核心拆成可组合模块（不改变行为）；
2. 抽出 `ConversationService` 统一 chat/responses 的 canonical、PDF、图片、工具语义；
3. 管理 API 按资源拆分；
4. 最后用 **Fastify adapter** 替换原生 `http` 分发，保留一个可回滚的 adapter 层。

这不是“重写业务”，而是**把现有行为装进清晰边界**，每个阶段都可独立合并、测试全绿、可回滚。

## 2. 现状问题（按严重度）

| 严重度 | 问题 | 证据/影响 |
| --- | --- | --- |
| P0 | `src/http/server.js` 约 1,171 行，传输与业务/管理 API 混杂 | 路由、鉴权、CORS、body、静态、SSE、健康检查、upstream 队列都在一个 `createServer` 内；改一处易伤其它接口 |
| P0 | `chat.js` 1,873 行、`responses.js` 1,707 行 | 会话 diff、PDF、压缩、图片、工具协议、SSE 分别重复实现；canonical/session 语义靠约定维持 |
| P0 | `admin/routes.js` 1,576 行 | 所有管理资源的手写 path 解析/方法/错误映射集中；缺 schema，新增路由持续膨胀 |
| P1 | 手写路由 + 手写 body 解析 + 手写错误映射 | 鉴权/bodyLimit/错误 envelope/await 错误捕获重复，容易出现路径遗漏 |
| P1 | 传输与流式强耦合 | SSE writer、heartbeat、abort、首事件 gate 直接依赖 `res`；业务 handler 难以单测 |
| P1 | 上下文对象 `ctx` 过大 | `ctx` 同时含 config/store/duck/queue/identity/...，依赖关系不可见，单测需要构造巨型对象 |
| P1 | 路由没有统一 schema | admin 输入校验散落各 handler；错误码/状态码靠人工约定 |
| P2 | 静态资源/SPA fallback 与 API 同文件 | 路径穿越、缓存头、MIME、fallback 规则难以单独回归 |
| P2 | `src/duck` 以外的模块存在反向 imports | OpenAI/admin 层直接拼 upstream 细节，领域层无法独立测试 |
| P2 | 文件级职责命名模糊 | `chat.js` 既做协议映射又做会话状态与流式输出，命名无法表达边界 |

## 3. 框架选型

### 3.1 候选对比

| 方案 | 优点 | 缺点 | 适用性 |
| --- | --- | --- | --- |
| **继续 `node:http`，仅模块化** | 零新依赖；SSE 完全可控；迁移最安全 | 仍需自己维护 router/middleware/schema/error；长期收益有限 | 作为**过渡阶段**非常合适 |
| **Fastify** | 成熟插件生态；hook/错误处理/schema/日志；性能好；Node 原生支持；SSE 可 `reply.hijack()` | 迁移成本；handler 从 `req/res` 改为 Fastify 语义；需要适配 raw SSE | **推荐最终目标** |
| **Hono** | 极轻、Web 标准、部署灵活 | Node 原生 SSE/raw response 适配不如 Fastify 成熟；生态偏轻 | 备选 |
| **Express** | 最熟悉 | 异步错误/模式较弱，性能一般，维护性不如 Fastify | 不推荐 |

### 3.2 推荐决策

**目标框架：Fastify。**

但不要一次性把全部 handler 改为 Fastify：

1. 先把现有 `node:http` 核心拆成模块；
2. 定义 handler 的 transport-neutral 接口；
3. 增加 Fastify adapter，与原 adapter 并存；
4. 测试全部通过后切换默认 adapter；
5. 稳定后再删除原生 adapter。

理由：

- 当前风险主要在**业务语义和 SSE**，不在 HTTP 库；
- adapter 层可以把迁移风险切成可回滚的阶段；
- Fastify 的 hooks/schema/error handler 正好解决当前鉴权、body 限制、错误映射散落的问题；
- SSE 通过 `reply.hijack()` 使用原始 `reply.raw`，可保留现有流式语义。

## 4. 目标分层与目录

```text
src/
  app/
    create-app.js              # 组合根：config/store/duck/queue/repos -> app
    http/
      adapter-native.js        # node:http 适配（过渡）
      adapter-fastify.js       # Fastify 适配（目标）
      router.js                # 路由定义/注册/匹配
      context.js               # 每请求 RequestContext
      auth.js                  # API key / admin token hooks
      body.js                  # JSON body + 大小限制
      cors.js
      errors.js                # 领域错误 -> HTTP envelope
      sse.js                   # SseSink + heartbeat/abort/first-event gate
      static.js                # 静态资源 + SPA fallback + traversal 防护
    routes/
      health.js
      v1/
        models.js
        chat.js
        responses.js
        images.js
        compact.js
      admin/
        overview.js
        config.js
        keys.js
        logs.js
        sessions.js
        history.js
        identities.js
        identity-pool.js
        subscriptions.js
        sync.js
        pairing.js
        proxy.js
  domain/
    conversation/
      canonical.js             # canonical/client diff/epoch
      upstream-snapshot.js     # 精确 upstream 前缀 append
      pipeline.js              # 统一 chat/responses 会话流水线
      compaction.js            # manual marker / compact epoch
      context-pdf.js           # PDF 溢出/摘要 PDF
      image-context.js         # 图片持久化/回放
    openai/
      chat-mapper.js           # 内部结果 -> chat.completion/chunk
      responses-mapper.js      # 内部结果 -> response/output items
      tool-protocol.js         # client tools
      tokens.js
    history.js
    usage.js
  ports/
    duck-port.js               # 上游能力接口
    repositories.js            # conversation/context_pdf/history/log 等接口
  infra/
    duck/                      # 现有 src/duck 保持协议边界
    sqlite/                    # db/repositories 实现
    config/
    logger/
    queue/
    store/
  index.js                     # 只负责装配与启动
```

### 依赖方向（硬约束）

```text
routes -> domain -> ports
app/http -> routes + ports
infra -> ports
index -> app + infra
```

禁止：

- `domain/**` import `node:http`、`fastify`、`src/http/**`；
- `domain/**` import 具体 SQLite/duck 实现；
- `routes/**` 直接访问 `src/duck` 内部协议细节；
- `src/duck/**` 反向 import OpenAI/admin 层。

## 5. 核心抽象

### 5.1 RouteDefinition

每个路由显式声明：

```text
method, path, auth(api|admin|public), bodyLimit,
handler(ctx) -> result | stream
```

由 adapter 负责：

- body 读取；
- 鉴权；
- CORS；
- 错误捕获；
- 统一响应；
- SSE writer 注入。

### 5.2 RequestContext

代替当前巨型 `ctx`，显式携带：

```text
requestId, method, path, headers, query,
auth, sessionKey, conversationKey, epoch,
log, signal,
config, repositories, duck, queue
```

handler 只通过 `RequestContext` 访问外部依赖，方便 mock。

### 5.3 SSE sink

统一接口：

```text
start(headers)
event(name, data)
data(chunk)
end()
abort signal
```

adapter 实现：

- native：现有 heartbeat/flush/first-event gate；
- Fastify：`reply.hijack()` + `reply.raw`。

业务 handler 不再直接读写 `res`。

### 5.4 Domain error

统一错误：

```text
DomainError { status, code, type, retriable, hint, details }
```

HTTP adapter 统一映射：

- OpenAI envelope：`{error:{message,type,code,param}}`
- Admin envelope：`{error:{code,message,details?}}`

禁止在 route/handler 内手写 `res.statusCode` 分支。

### 5.5 ConversationService

把当前 chat/responses 中共有的逻辑抽成单一服务：

- session 解析与 client diff；
- canonical append；
- upstream snapshot append；
- PDF 溢出 / manual marker / compact epoch；
- 图片持久化与回放；
- tool protocol 映射；
- history 记录。

Chat/Responses route 只做：

```text
请求形状归一化 -> ConversationPipeline 执行 -> 输出 mapper
```

这样 `chat.js`/`responses.js` 不再各自实现会话和 PDF 逻辑。

## 6. 分阶段迁移计划

### Phase 0 — 基线冻结（不改行为）

- 增加/补齐黑盒契约测试：
  - 路由表（method/path/status）；
  - 鉴权/CORS/body 限制；
  - SSE 事件序列；
  - 错误码矩阵；
  - canonical/PDF/图片/工具/历史关键不变量。
- 目标：`npm test` 全绿；记录当前 HTTP 响应快照。
- 产出：`tests/contract/**` 或现有测试补充。
- 风险：低。

### Phase 1 — 拆 `server.js`（仍用原生 http）

新增：

```text
src/app/http/{context,auth,body,cors,errors,sse,static,router}.js
```

`server.js` 只保留：

```text
createServer -> 组合 http 模块 -> route registry -> adapter
```

先搬无业务风险的逻辑：

- body 读取/限制；
- auth；
- CORS；
- static + SPA fallback；
- error envelope；
- SSE writer；
- healthz。

验证：现有测试 + page-check + 静态路径穿越/大小限制。

### Phase 2 — 路由模块化

按端点拆 `routes/*`，保持 native adapter：

1. `/healthz`、`/v1/models`、`/v1/images/generations`、`/v1/compact`；
2. `/v1/chat/completions`、`/v1/responses` 改为薄路由；
3. `/admin/api/*` 先按资源拆 router，不重写 handler。

每拆一个路由：

- 路由表测试确认无缺失；
- 响应头/错误码不变；
- 不修改业务逻辑。

### Phase 3 — 抽 ConversationService（最关键）

从 `chat.js`/`responses.js` 提取共享流水线：

```text
normalize -> session diff -> canonical/upstream append
-> PDF/compaction/image/tool handling
-> upstream call -> output mapping -> history
```

要求：

- chat/responses 的 **所有现有 golden 行为**保持一致；
- canonical/upstream/client_json/epoch 字段不改变；
- PDF/图片/工具协议/缓存前缀语义不改变；
- 只做移动和参数化，不改变策略。

### Phase 4 — 管理 API 拆分

按资源拆 `admin/routes/*`：

- overview/config/keys/logs；
- sessions/history；
- identities/identity-pool；
- subscriptions/sync/pairing/proxy。

公共 helper：

```text
adminError, parseId, requireMethod, pagination, auditLog
```

输入校验逐步改为 schema/JSDoc 校验；先保持行为。

### Phase 5 — Fastify adapter

新增 `adapter-fastify.js`：

- `fastify.addHook('onRequest', authHook)`
- body limit/schema
- error handler
- static plugin 或现有 static 模块
- SSE：`reply.hijack()` + raw writer
- route registration：复用 `RouteDefinition`

切换方式：

```text
HTTP_ADAPTER=native|fastify
```

默认先 native；测试矩阵覆盖两种 adapter；稳定后默认 fastify，再删除 native。

## 7. 必须保留的契约（回归红线）

重构不得改变：

1. `/v1/*`、`/admin/api/*` 的路径、鉴权、状态码、错误码；
2. OpenAI chat/responses 响应字段和 SSE 事件顺序；
3. `X-Session-Id` / `X-Session-Epoch` / `X-Duckai-*` 响应头；
4. authoritative session：
   - client diff；
   - 409 `session_history_mismatch`；
   - fork/epoch；
   - 精确 upstream snapshot append；
5. PDF 溢出 / manual marker / compact：
   - 摘要 PDF、client-tools PDF、图片；
   - context_pdfs scope/覆盖；
6. 工具协议、图片回放、history 记录；
7. 4MB JSON body 限制、CORS、静态路径穿越防护；
8. 行级错误信息/hint 中已有用户可见中文。

## 8. 测试与验收

每个 Phase 必须：

```text
npm test                      # 全量
npm run build:web             # 如涉及
node scripts/build-check.mjs
node scripts/page-check.mjs   # 真实网关
```

新增：

- 路由契约快照；
- SSE 事件 golden；
- 错误映射矩阵；
- auth/body/static traversal；
- chat/responses canonical/PDF/image/tool 回归；
- native + fastify 双 adapter 同一套黑盒测试。

Phase 完成标准：

- 对外响应字节级/字段级无意外变化；
- 文件规模明显下降（`server.js` 只做装配）；
- 循环依赖为 0（可用 `dependency-cruiser`/自定义脚本检查）；
- 真实网关 `page-check` 通过；
- Docker 启动/healthz 通过。

## 9. 风险与边界

- **不要**在重构同时改 challenge/上游协议/PDF 策略，否则无法区分回归来源；
- **不要**一次性迁移到 Fastify；先模块化 + adapter 并存；
- **不要**引入重型 DI 容器；显式组合根即可；
- **不要**同时 TypeScript 化；类型可作为后续独立项目；
- Fastify raw SSE 必须确保只发送一次、abort/heartbeat 行为与原实现一致；
- 当前工作区有其它任务的未提交修改，重构开始前需先由用户确认这些改动已合并/隔离。

## 10. 需要用户确认的决策

1. 最终框架：**Fastify**（推荐）还是“原生 http 模块化即可”？
2. 迁移方式：**分阶段 adapter 并存**（推荐）还是一次性切换？
3. 是否接受 Phase 1/2 期间只移动代码、不优化行为？
4. 是否把 `src/duck` 上游协议层保持原样（推荐），只抽 ports？
5. Phase 3 的 `ConversationService` 是否允许改变内部函数签名（对外行为不变）？

确认后，建议从 **Phase 0 + Phase 1** 开始，先做低风险拆分，不同时碰 canonical/PDF 业务。

---

## 附录 A — Phase 3 设计稿：ConversationService 抽取（v2.65）

> **前提**：Phase 0–2 已合并（`82a8014` / `ba61427` / `e6f6a3d`），基线 `npm test` **512/512**、
> `page-check` **22/22**；`src/http/server.js` 已降到 474 行，HTTP 核心在 `src/app/http/*`。
> **本附录只做设计审计，不改 `src/`、`tests/`**；行号均指当前 HEAD（`chat.js` 1957 行、`responses.js` 1790 行）。
> **方向说明**：§3 曾推荐 Fastify，但用户已决策走「原生 `node:http` + 模块化」，Phase 0–2 即该方向；
> 本附录延续该决策，不改写 §1–§10。Phase 3 不引入框架、不引入 DI 容器、不做 TS 化。

### A.1 目标与非目标

**目标（Phase 3 结束时）**

1. 把 `chat.js` / `responses.js` 中重复的**会话流水线**（session 解析、state 加载、manual compaction、
   PDF/tools PDF、canonical/upstream/client 保存、history 记录）收敛为共享模块；
2. 删除 `handleChatCompletions` 与 `handleResponses` 之间可识别的重复块（当前约 **400 行**，
   8 行滑窗检测：chat 侧 401 行 / responses 侧 396 行）；
3. 对外可观察行为**逐字节不变**：上游 messages、`conversation_state`/`context_pdfs`/`responses`/`history`
   行内容、SSE 事件、响应头、日志字段、错误码与错误消息。

**非目标（Phase 3 明确不做）**

- 不改 SSE 输出协议与 output mapper（chat chunk vs responses 事件序列分离保留）；
- 不改 canonical / epoch / compression / prefix-cache 策略（只搬移调用，不重排、不合并条件）；
- 不把 handler 改成 transport-neutral（Phase 5/6 再做），`(req, res, ctx)` 签名暂留；
- 不搬移 `src/openai/*` 现有 helper 文件（Phase 3 只在 `src/app/session/` 新增，避免大范围 import 变更）；
- 不处理 admin 连接测试（`admin/routes.js#generateAssistantReply`）的同类重复，Phase 4 再复用本层；
- 不顺手修 bug（如 chat 流式 history 用 `guardedMessages` 而非 `historyMessages` 的既有不一致）。

### A.2 两个 handler 的会话流程对照（HEAD 行号）

| # | 步骤 | chat（`handleChatCompletions` L763–1432） | responses（`handleResponses` L366–911） | 差异 | 可抽取 |
| --- | --- | --- | --- | --- | --- |
| 1 | body/model/ephemeral | L764–773 | L367–376 | responses 多 `instructions` 类型校验（L378–380） | 小，暂不抽 |
| 2 | 输入归一化 | `normalizeChatMessages(body.messages)` L775 | `normalizeResponsesInput(body.input)` L407 | 形状不同 | 否 |
| 3 | 会话链来源 | `body.messages`（客户端回放） | `previousRecord.conversation + outputItemsToConversation + input.conversation` L410–412 | responses 独有 `previous_response_id` 链 | 否 |
| 4 | session key + manual marker | L777–789 | L413–421 | 同函数，`kind`/conversation 不同 | 是（小）→ **3C** |
| 5 | state 加载 + 图片回放 | L790–799 | L422–431 | responses 回放两份（chained + input） | 是 → **3C** |
| 6 | manual compaction | L800–866 | L432–487 | 结构相同，hot 应用方式不同 | 是 → **3B** |
| 7 | authoritative diff | L868–914 | L488–526 | 输入/输出/异常路径不同，核心 `diffSession` 相同 | 部分 → **3C** |
| 8 | reasoning/tools/systemPrompt | L916–935 | L539–561 | chat 在 authoritative 时强制复用 `conversationState.systemPrompt`；responses 用 `previousRecord.systemPrompt`/instructions | 否（语义不同） |
| 9 | selectIdentity | L931–935 | L642–646 | 相同 | 小，暂不抽 |
| 10 | conversation mode（server/stateless） | L936–967 | 无此概念 | chat 独有 `X-Conversation-Mode`/`X-Conversation-Delta` | 否 |
| 11 | 会话头 | L968–993 | L792–811 | chat 优先 `ctx.sessionKey`，responses 只用 `conversationSessionKey` | 否（保持现状） |
| 12 | PDF 规划/复用/legacy 压缩 | L1007–1103 | L563–614 | chat 有 `chatSummaries` 旧自动压缩；gating 分别用 `storedConversation` / `reusablePrefix` | 高难 → **3E（暂缓）** |
| 13 | prefix 复用 / rebuild + protocol 注入 | L1104–1201 | L615–641 | 数据来源与 `storedConversation`/`previousRecord` 形态不同 | 否（暂留） |
| 14 | **PDF/tools PDF 装配 + 历史展示 + injection** | **L1202–1341** | **L648–788** | **几乎逐行相同**（仅会话来源与 413 `param` 不同） | **是 → 3A（首选）** |
| 15 | 输出 mapping / SSE | L1357–1432、L1440–1956 | L824–844、L913–1789 | 协议完全不同（chunk+[DONE] vs 命名事件+`sequence_number`+`response.failed`） | 否 |
| 16 | 结果持久化 | conversation_state only：L1383–1431 | responses 表 L845–857 + conversation_state L858–910 | responses 多 `save()`；`nextEpoch` 逻辑完全重复 | 是 → **3D** |
| 17 | history 记录 | 非流式 `params.historyMessages`；**流式用 `params.guardedMessages`**（既有不一致） | `params.historyMessages` | 调用点已由 `recordHistoryOnLog` 统一，无需改 | 否 |

### A.3 可安全抽取的共享步骤（按“低风险高收益”排序）

判定标准（同时满足才进入 3A/3B/3D）：① 不写 canonical/epoch/client_json；② 输入输出可枚举；
③ 现有测试覆盖；④ 分支差异可用参数表达且不改变判断顺序；⑤ 不涉及 SSE 写协议。

| 优先级 | 共享步骤 | 现状重复量 | 风险 | 切片 |
| --- | --- | --- | --- | --- |
| ★★★ | PDF 上下文装配 + client-tools.pdf + 历史展示/injection | ~140 行 × 2 | 低（纯下游转换） | **3A** |
| ★★☆ | manual compaction 的 PDF 复用/生成 + compression record + epoch 日志 | ~60 行 × 2 | 低–中 | 3B |
| ★★☆ | state 加载/图片回放 + `diffAuthoritativeSession` 包装 + 5 个 session log 字段 | ~25 行 × 2 | 中 | 3C |
| ★★☆ | `nextEpoch` + `buildConversationStateWrite` | ~35 行 × 2（epoch IIFE 完全重复） | 中 | 3D |
| ★☆☆ | session key / marker 解析、`setSessionHeaders`、resolution headers | ~15 行 × 2 | 低 | 3C/3D 顺带 |
| — | PDF 规划（legacy compaction、gating） | ~90 行 × 2 但语义分叉 | 高 | 暂缓（3E） |
| — | systemPrompt 组装、prefix 复用/rebuild、协议注入 | 分叉大 | 高 | 暂缓 |
| — | 输出 mapper / SSE / with-tools 回放 | 协议不同 | 高 | Phase 5 |

### A.4 最小可落地切片 3A：`src/app/session/context-assembly.js`

#### A.4.1 切片边界（只搬这一段）

- 来源：`chat.js` **L1202–1341**（`let spillDisplay = null` → `ctx.log.upstreamMessageCount = ...`）；
  `responses.js` **L648–788**（`let displayHistoryMessages = canonicalConversation` → `ctx.log.upstreamMessageCount`）。
- 该段内部包含 4 个分支：① 复用已存 context PDF + 附带 client-tools.pdf；② 生成/保存 context PDF；
  ③ 仅 client-tools.pdf（无 context PDF）；④ 历史展示转换 + `historyInjection` + log 字段。
- **不包含**：`pdfScopeKey()` 计算、`responseStore.getContextPdf()` 读取、`guardConversation()`、
  `buildDuckMessages()`、`injectProtocolIntoFirstUser()`、canonical/epoch 保存、SSE。

#### A.4.2 新模块

```js
// src/app/session/context-assembly.js
import {
  attachPdfFile, createToolsPdf, pdfFileFromState, sanitizeFileMetadata,
  spillMessagesToPdf, stripSpillInstruction, PDF_PURPOSE_TEXT
} from '../../openai/context-spill.js';
import { buildToolProtocol } from '../../openai/tool-protocol.js';
import { OpenAIError } from '../../openai/errors.js';

/**
 * 统一 chat/responses 的「context PDF 装配 + client-tools.pdf + 历史展示 + injection」。
 * 只消费调用方已算好的会话状态；不做 session resolve / diff / epoch / 压缩决策。
 *
 * @param {{
 *   kind: 'chat'|'responses',
 *   duckMessages: Array<object>,        // 已 buildDuckMessages、尚未附 PDF
 *   conversation: Array<object>,        // coveredCount/hash 用：chat=messages.conversation；responses=chainedConversation
 *   historyMessages: Array<object>,     // 无 PDF 时的历史展示回退：chat=historyMessages；responses=canonicalConversation
 *   clientTools: Array<{name:string}>,
 *   pdfSpillConfig: { enabled?: boolean, inputCharLimit?: number, maxPages?: number },
 *   scopeKey: string|null,              // 调用方已算好的 pdfScopeKey(...)
 *   responseStore: object|null,
 *   storedPdf: object|null,             // 调用方已读取的 getContextPdf(scopeKey) 结果
 *   reuseStoredPdf: boolean,
 *   conversationChain: string|null,     // ctx.log.conversationChain（写进 injection.chain）
 *   compression: object|null,           // manualCompaction?.compression ?? conversationState?.compression
 *   logger: object
 * }} input
 * @returns {Promise<{
 *   duckMessages: Array<object>,        // 最终发给上游的消息（含 PDF file part / 指令文本）
 *   displayMessages: Array<object>,     // 历史展示（stripSpillInstruction + sanitizeFileMetadata）
 *   injection: object,                  // historyInjection 完整结构
 *   logPatch: object,                   // 只含本次新增的 log 字段，由 handler Object.assign(ctx.log, patch)
 *   savedContextPdf: boolean
 * }>}
 */
export async function assembleContextMessages(input) { /* 按 L1202–1341 / L648–788 顺序实现 */ }
```

#### A.4.3 入参来源对照

| 入参 | chat 来源（L 号） | responses 来源（L 号） |
| --- | --- | --- |
| `kind` | `'chat'` | `'responses'` |
| `duckMessages` | L1193–1197 构建结果 | L635–639 构建结果 |
| `conversation` | `messages.conversation`（L1009 已用同值算 scope） | `chainedConversation` |
| `historyMessages` | `historyMessages`（L1186，prefix-reuse 时 L1172） | `canonicalConversation`（L630） |
| `clientTools` | L920–921 | L546–547 |
| `pdfSpillConfig` | L1007 | L563 |
| `scopeKey` | L1009–1014 `pdfScope` | L579–585 `pdfScope` |
| `responseStore` | `ctx.responsesStore` | `ctx.responsesStore` |
| `storedPdf` | L1019 `pdfState`（含 L1034/L1040 的 manual/compression 覆盖） | L590 `pdfState`（含 L604/L608 覆盖） |
| `reuseStoredPdf` | L1018–1031 / L1032–1045 `pdfReuse` | L589–602 / L603–614 `pdfReuse` |
| `conversationChain` | `ctx.log.conversationChain` | 同 |
| `compression` | `manualCompaction?.compression ?? conversationState?.compression` | 同 |

#### A.4.4 返回与 handler 侧改法（chat 示例；responses 对称）

```js
// before（chat L1202–1341 整段）
let spillDisplay = null;
if (pdfReuse && pdfState) { ... } else if (pdfSpillConfig.enabled !== false) { ... }
if (useClientToolsPdf && !ctx.log.contextPdf && !ctx.log.contextPdfReused) { ... }
const protocolText = ...;
const historyForDisplay = spillDisplay ? ... : historyMessages;
ctx.historyMessages = historyForDisplay;
ctx.historyInjection = { ... };
ctx.log.protocolInjected = ...; ctx.log.clientToolsPdf = ...; ctx.log.upstreamMessageCount = ...;

// after（约 10 行）
const assembled = await assembleContextMessages({
  kind: 'chat',
  duckMessages,
  conversation: messages.conversation,
  historyMessages,
  clientTools,
  pdfSpillConfig,
  scopeKey: pdfScope,
  responseStore,
  storedPdf: pdfState,
  reuseStoredPdf: pdfReuse,
  conversationChain: ctx.log.conversationChain,
  compression: manualCompaction?.compression ?? conversationState?.compression ?? null,
  logger: ctx.logger
});
duckMessages = assembled.duckMessages;
const historyForDisplay = assembled.displayMessages;
ctx.historyMessages = historyForDisplay;
ctx.historyInjection = assembled.injection;
Object.assign(ctx.log, assembled.logPatch);
```

> responses 侧仅 `kind` / `conversation` / `historyMessages` 三个入参不同；其余一致。

#### A.4.5 3A 必须保持的不变量（I1–I10）

| # | 不变量 | 验证点 |
| --- | --- | --- |
| I1 | `duckMessages` 内容/顺序/字段逐字节不变（PDF file part：`mimeType/filename/b64/pages/bytes/textChars/text`；首条 user 的 `\n\n[系统提示] 附件 client-tools.pdf …` 指令文本与位置） | 用 mock DuckClient 断言 `calls.chat.at(-1).params.messages`；与改动前 JSON 全等 |
| I2 | 复用路径不再生成 context PDF，但仍生成/附 `client-tools.pdf` | `context-pdf-v249`「同一会话复用同一 context PDF」 |
| I3 | `context_pdfs` 写库参数不变：`scopeKey/filename/mimeType/pages/bytes/textChars/textContent/coveredCount/coveredHash/pdfB64` | `context-pdf-v249`、`summary-pdf-compaction` |
| I4 | 413 `context_pdf_capacity_exceeded` 的 message/status/code 不变，`param` 分别为 `messages`（chat）/`input`（responses），且发生在 tools PDF 之前 | 构造超页 PDF 用例；`http-contract` 错误矩阵 |
| I5 | 日志字段名/值不变：`contextPdf/contextPdfReused/contextPdfMoved/contextPdfSaved/toolsPdf/protocolInjected/clientToolsPdf/upstreamMessageCount` | `logs-*`、`history-injection-v248`、`context-pdf-v249` |
| I6 | `historyInjection` 结构与字段不变（含 `protocolKind`、`PDF_PURPOSE_TEXT`、`firstUserContent`、`chain`、`contextPdfReused`、`compression`） | `history-injection-v248`、`manual-compaction-pdf`、`summary-pdf-compaction` |
| I7 | 历史展示转换不变：`stripSpillInstruction(...)` + `sanitizeFileMetadata(files)`；无 PDF 时原样返回 `historyMessages` | `/admin/api/history/:id` 详情断言 |
| I8 | 异常降级不变：PDF / tools PDF 生成失败 → warn 后继续；仅 capacity 超限抛出 | 单测注入抛错 store / 超大会话 |
| I9 | 不改变 `saveContextPdf` 的 `coveredCount` 计算（从 `conversation` 末尾找首个 `role==='user'` 的下标） | 与改动前 DB 行对比 |
| I10 | 不改变 `historyMessages` 的传递语义：`params.historyMessages` 仍是展示视图；chat 流式仍用 `guardedMessages`（不顺手修） | 全量测试 + 对比 history 表 |

#### A.4.6 3A 明确“先不要动”

- `pdfScopeKey` / `hashConversationPrefix` / `messageTextChars` 的调用位置与参数（仍在 handler 的规划块）；
- `guardConversation`、`buildDuckMessages`、`injectProtocolIntoFirstUser`、`buildToolProtocol`（除 3A 内部使用）；
- `findCompactionMarker` / `resolveConversationSessionKey` / `resolveEpochFlags` / `diffSession`；
- `saveConversation` / `responseStore.save` / `recordHistoryOnLog` 的调用点；
- `ctx.chatSession` 的字段集合与 `epoch` 计算（3D 才动）；
- PDF 生成器本身（`context-pdf.js` / `context-spill.js`）与页数/分页参数；
- SSE writer、`openSSE`、header 设置。

### A.5 后续切片（Phase 3 完整路线）

**3B — manual compaction（`src/app/session/manual-compaction.js`，低–中风险）**

```js
export async function prepareManualCompaction({
  kind, conversationSessionKey, conversationState, marker, responseStore, logger
}) -> Promise<{
  manualCompaction: { marker, scopeKey, contextPdfState, compression },
  logPatch: { manualCompaction: true, compression: {...} }
} | null>
```

- 搬 `chat.js` L800–849 与 `responses.js` L432–477（PDF 复用/生成 + `buildCompressionRecord` + 413 映射）；
- **hot 应用留在各 handler**：chat 仍需 `normalizeChatMessages(marker.hot, {allowEmptyUser:true})` 并合并
  `systemParts`（L850–866）；responses 仍需 `chainedConversation = marker.hot` + `input.conversation` 赋值（L478）；
- 顺带抽 `resolveManualCompactionEpoch({conversationState, manualCompaction})`，对应 chat L905–914 / responses L527–536
  （两段完全相同），返回 `{ sessionEpoch, sessionMode }` 写回 `ctx.log`。

**3C — state 加载 + authoritative diff 包装（`src/app/session/authoritative.js`，中风险）**

```js
export async function loadConversationState({ responseStore, conversationSessionKey }) // state|null
export function diffAuthoritativeSession({ ctx, body, state, incoming }) // { diff, epochFlags }
export function applySessionLogFields(ctx, diff) // sessionMode/sessionEpoch/sessionAppended/sessionRepaired
```

- 搬 `chat.js` L790–799 + L868–914 与 `responses.js` L422–431 + L488–526 中**相同的骨架**；
- 保留差异：chat 的 `incoming` 需先过滤 system/developer；responses 用 `replayedInputConversation`；
  `noop` 报错文案（`no new messages` / `no new input`）与 `mode==='fork'`/`stateRepaired` 后的
  canonical/previousRecord 重建逻辑仍留在各 handler；
- 不在本切片改 `systemPrompt` 语义（chat 的 authoritative 覆盖 L927–929 与 responses 的 previousRecord 分支保持原样）。

**3D — 持久化写入（`src/app/session/persistence.js`，中风险）**

```js
export function nextEpoch({ baseEpoch, requestedEpoch, state, toolsHash, systemPrompt, contextPdfSaved })
export function buildConversationStateWrite({
  sessionKey, model, mode, systemPrompt, canonical, upstream, toolsHash,
  compression, contextPdfScope, compactedAt, images, state, requestedEpoch, contextPdfSaved
})
```

- 搬两处完全重复的 epoch IIFE（chat L1415–1425 / responses L894–904）；
- `assistantCanonical` / `assistantUpstream` 的构造保留在各 handler（chatFinal vs output items 不同）；
- responses 的 `responseStore.save()`（L845–857）留在 handler。

**3E — 可选 facade（仅在 3A–3D 后仍有明显重复时做）**

- `src/app/session/index.js` 导出 `prepareConversationTurn(...)`；**不要一次性**把两个 handler 改成单入口，
  否则回滚粒度变大、golden 对比困难。若 3A–3D 后 handler 仍 >600 行，再评估。

### A.6 chat 与 responses 的差异点（Phase 3 必须保留、不能“统一掉”）

1. **输入形状**：`messages`（chat role/content/tool_calls）vs `input`（items：message/function_call/function_call_output/image_generation_call）。
2. **`previous_response_id`**：responses 一等公民（缺失/过期/`store:false` → 400 `previous_response_not_found`）；
   chat 无此语义。
3. **会话模式**：chat 有 `X-Conversation-Mode` / `X-Conversation-Delta` / `config.conversations.mode`（默认 stateless）；
   responses 固定服务端 canonical + `store` 语义。
4. **chain 来源**：chat = 客户端回放（authoritative 时只用于 diff）；responses = `previousRecord + outputItemsToConversation + input`。
5. **`X-Session-Id` 回写**：chat 优先 `ctx.sessionKey`（header/body），responses 只用 `conversationSessionKey`（L792）。
6. **systemPrompt 语义**：chat 在 authoritative 路径强制复用 `conversationState.systemPrompt`（L927–929）
   以保证前缀稳定；responses 由 `previousRecord.systemPrompt` + `instructions` 组合，`instructions` 变化会触发 rebuild/新 epoch。
7. **fork/stateRepaired 应用**：responses 会重建 `previousRecord` 并把 `input.conversation` 置为 canonical；
   chat 只替换 `messages.conversation`。
8. **压缩路径**：chat 多一条 `chatSummaries` 旧自动压缩（L1051–1103，依赖 `ctx.chatSummaries`）；
   responses 没有该路径（只有 PDF 溢出 + manual marker）。**不要合并**。
9. **PDF scope**：`pdfScopeKey({ kind:'chat'|'responses', previousResponseId?, ... })`；responses 带 `previousResponseId`，
   scope 不同；复用 gating 分别是 `!storedConversation`（chat）与 `!reusablePrefix`（responses）。
10. **输出协议**：chat = `data: {...}` chunk + `[DONE]`，with-tools 先收集后回放；responses = 命名事件
    (`response.created/in_progress/output_item.added/output_text.delta/…/response.completed`，`sequence_number` 递增)，
    流中错误发 `response.failed` + `error` 事件（L1542–1551 / L1769–1787），chat 发 `data:{error}` + `[DONE]`。
11. **413 的 `param`**：chat `messages`，responses `input`。
12. **持久化**：responses 额外写 `responses` 表（`store:false` 可关）；conversation_state 两者都写（ephemeral 除外）。
13. **history 调用点**：chat 非流式用 `historyMessages`、流式用 `guardedMessages`；responses 始终 `historyMessages`。
14. **图片-only 回退**：responses 在 complete/stream 中补 message item + 占位文本（v2.40）；chat 用 `message.images`。属输出 mapper，不动。
15. **legacy 会话兼容**：chat 的 `conversationState.systemPrompt.includes('[对话摘要]')` 分支（L997–1006）为 chat 独有。

### A.7 Phase 3 红线（契约冻结清单）

1. `conversation_state`：`canonical_json` / `upstream_json` / `client_json` / `client_hash` / `tools_hash` /
   `system_prompt` / `compression_json` / `context_pdf_scope` / `compacted_at` / `images_json` / `epoch` / `first_user_hash`
   的**内容与写入时机**不变；普通轮次仍精确 append，不每轮 rebuild。
2. `upstream_json` 前缀逐字节稳定：作者性 session 测试用 `deepEqual(turn2.slice(0, turn1.length), turn1)` 断言，
   任何“重新序列化/重排字段”都视为回归。
3. `context_pdfs`：scope key、覆盖消息数/hash、页面/字节、图片嵌入、15 页上限与 413 行为不变。
4. `responses` / `history` / `test_sessions` 行内容不变；`injection_json` 结构不变。
5. 工具协议：`client-tools.pdf` 始终附带；首条 user 注入位置不变；文本协议模式（pdfSpill 禁用）不变；
   `toolsHash` 计算输入不变。
6. 图片：`image_generation_call` 回放仍为真实 image part；JPEG→PNG ≤512px 只在 duck 层发生一次；
   history images ≤4 张/≤6MB 结构不变。
7. 错误码/状态码：`session_history_mismatch`、`conversation_session_conflict`、`context_pdf_capacity_exceeded`、
   `conversation_limit_reached`、`queue_full/timeout`、`model_requires_subscription` 等全部不变。
8. 响应头：`X-Session-Id`、`X-Session-Epoch`、`X-Duckai-*`、`X-Request-Id`、`X-Duckai-Queue-Wait` 不变。
9. 日志字段（43 个 `ctx.log.*` 中与 session/PDF 相关的 14 个）名称与取值不变。
10. DSH 标题请求（ephemeral）：仍跳过 diff/save，且不污染 canonical/history。

### A.8 验证清单

#### A.8.1 每个切片统一门禁

```powershell
npm test                                              # 512/512（Phase 3 起新增测试计入）
node --test --test-isolation=none tests/http-contract-v264.test.js   # Phase 0 契约基线
node scripts/build-check.mjs                          # 16/16（如动 web 才必须）
node scripts/page-check.mjs --admin-token <ADMIN> --api-key <KEY>    # 真实网关 22/22
```

#### A.8.2 3A 专项回归（按不变量映射）

| 不变量 | 必跑测试 |
| --- | --- |
| I1 上游 messages 逐字节 | `authoritative-session-v259`、`chat-session-v247`、`responses-chain-v246`、`client-tools-v244`（稳定前缀用例） |
| I2/I3 PDF 复用与写库 | `context-pdf-v249`（全部）、`summary-pdf-compaction`、`manual-compaction-pdf` |
| I4 413 | 手工构造 >15 页用例（或临时脚本），断言 `status/code/param` |
| I5 日志字段 | `logs-split`、`logs-history-v233`、`logs-usage-v224`，并 grep `store.recordUpstream` 入参 |
| I6 injection | `history-injection-v248`、`manual-compaction-pdf`（L219）、`summary-pdf-compaction`（L232） |
| I7 历史展示 | `/admin/api/history/:id` 断言（现有测试） |
| I9 coveredCount | 复跑 `context-pdf-v249`「历史记录包含 PDF 附件元数据」；对比 `context_pdfs` 行 |
| I10 history 视图 | `openai-chat`、`openai-responses` 全量 + 流式用例 |

#### A.8.3 3A 额外的“字节级”手工核验（建议在 PR 描述贴出）

1. 用 mock 上游跑同一脚本化场景（chat 3 轮 + 1 个 >20k 会话 + 1 个 tools 会话；
   responses 3 轮 + previous_response_id + 1 个 >20k 会话），记录每轮 `duck.calls.chat.at(-1).params.messages`；
2. 对比改动前后 JSON（`JSON.stringify` 后逐字节 diff；允许的差异仅 random id/时间戳）；
3. 用 `sqlite3 data/duckai.db "select canonical_json, upstream_json, client_json, epoch, compression_json, context_pdf_scope, images_json from conversation_state where session_key=..."` 对比；
4. `/admin/api/history/:id` 的 `messages/injection` 对比。

> 若数据目录隔离不便，可直接复用 `tests/helpers/test-server.js` + `MockDuckClient` 写一个 20 行的临时脚本放在
> `data/tmp/`（不入库），或由 QA 在 `tests/` 增加一个 golden fixture 用例（推荐后者，Phase 3 PR 一并提交）。

#### A.8.4 真实上游（可选，额度允许时）

- `node scripts/smoke.js --mock --search`（离线）；
- 需要真实缓存前缀/PDF 复用时再用 `scripts/live-check.mjs` + `page-check --allow-upstream`（先确认额度）。

### A.9 风险、回滚与 PR 拆解

**风险（3A 视角）**

| 风险 | 缓解 |
| --- | --- |
| logPatch 应用时机早于 epoch 计算，`contextPdfSaved` 丢失 | handler 在返回后立即 `Object.assign(ctx.log, patch)`，再执行 3D；3A 测试断言 patch 字段 |
| 返回数组与保存引用不一致，导致 `upstream_json` 少 PDF part | 断言 `chatSession.upstreamBeforeResponse === returned duckMessages`（引用/内容） |
| 413 抛出点后移，导致先产生 tools PDF | 保持现有分支顺序：reuse → spill → tools PDF；超页在 spill 内抛出 |
| 日志 warn 文案变化被测试/排障依赖 | 原样保留 `'client tools PDF generation failed'` 等文案 |
| 显示历史数组被原地修改 | 3A 内部一律返回新数组；`stripSpillInstruction` 返回新对象（与现状一致） |
| 把 chat 流式 history 的既有不一致“顺手修” | 列入 A.4.6 禁止项 |

**回滚**

- 每个切片是纯搬移 + 参数化：无 schema、无 config、无 API、无存储格式变更；
- 回滚 = `git revert <slice commit>`；不涉及数据迁移，重启即恢复；
- 若 3A 出现无法快速定位的 SSE/DB 回归，直接 revert，3B 之前暂停合并。

**建议 PR 拆解（每 PR 独立可合并、可回滚）**

| PR | 内容 | 预期净行数 | 风险 |
| --- | --- | --- | --- |
| 3A | `src/app/session/context-assembly.js` + 两处替换 + 单测/黄金用例 | −280 / +200 | 低 |
| 3B | `src/app/session/manual-compaction.js` | −120 / +90 | 低–中 |
| 3C | `src/app/session/authoritative.js` | −50 / +40 | 中 |
| 3D | `src/app/session/persistence.js` | −70 / +50 | 中 |
| 3E | 可选 facade / admin 复用 | 视收益 | 中 |

> 3A 合并后先观察一轮（全量测试 + page-check + 一次真实网关手工会话），再做 3B。
> 不在同一 PR 同时做 3A+3B，否则回归来源无法二分。

### A.10 结论

- Phase 3 的**首个可落地切片是 3A**：抽取 `assembleContextMessages()`，替换 chat L1202–1341 与
  responses L648–788。它不触碰 canonical/epoch/SSE，是当前重复度最高、风险最低的一段。
- 3B/3C/3D 依次推进；每一段都只搬移与参数化，禁止“顺手优化”。
- 若 3A 合并后发现 handler 仍难读，再评估 3E facade / admin 复用；**不在 Phase 3 引入 Fastify**。

