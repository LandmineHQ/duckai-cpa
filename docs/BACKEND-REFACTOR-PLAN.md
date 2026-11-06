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
