# 身份池实现说明（v2.4，`src/duck/identity-pool.js`）

> 契约：`docs/IDENTITY-POOL.md` §1–§3。本文记录 **协议层实现**：存储布局、路由公式、绑定、每身份 RPS 队列、
> 运行时（每身份一个 DuckClient）、订阅身份路由、接口签名与自测结果。
>
> Admin API（`/admin/api/identities*`）、`/v1/*` 的 `X-Session-Id` 解析、上下文裁剪守卫由 api-core 实现；
> 身份页/身份池页/配对二维码由 web-dashboard 实现。协议层只暴露 `IdentityPool`，不直接暴露 HTTP 端点。

---

## 1. 模块与导出（`src/duck/identity-pool.js`）

```js
import {
  createIdentityPool, IdentityPool, PoolError, IdentityPoolError,
  IdentityQueue, DEFAULT_POOL_CONFIG, POOL_FILE_NAME, POOL_VERSION, PAID_TIERS
} from './src/duck/identity-pool.js';
```

| 导出 | 说明 |
| --- | --- |
| `class IdentityPool` | 池状态机（CRUD/路由/绑定/队列/运行时） |
| `class PoolError` | `{ status, code, field?, hint?, detail?, retryAfterMs?, retryAfter? }` |
| `IdentityPoolError` | `PoolError` 的别名（QA/测试用） |
| `class IdentityQueue` | 单身份 FIFO 队列（rps + maxConcurrent + queueLimit/timeout） |
| `async createIdentityPool({ dataDir, config, logger, proxyManager, createRuntime })` | 创建并 `init()` |
| `DEFAULT_POOL_CONFIG` | `{maxIdentities:20, bindingsLimit:5000, rps:1, maxConcurrent:1, queueLimit:50, queueTimeoutMs:300000, idleTimeoutMs:600000, strategy:'hash'}`；`config.pool.runtimeIdleMs` 是 admin 对外契约键，作为 `idleTimeoutMs` 的别名被接受 |
| `POOL_FILE_NAME` | `identity-pool.json` |

`createRuntime(identityRecord, ctx)`（或别名 `duckFactory`）是测试/自定义注入点：
`ctx = { identityId, config, proxyManager, logger, pool }`；返回 DuckClient-like 对象（自身有 `chat` 方法）
或 `{ client, store }`。不注入时默认构造 `new DuckClient({ ...config.duck, identityStore: MemoryIdentityStore(record), proxyManager })`。

---

## 2. 存储（`<dataDir>/identity-pool.json`）

```json
{
  "version": 1,
  "activeId": "id_default",
  "salt": "<32 hex>",
  "identities": [
    {
      "id": "id_ab12cd34",
      "label": "分身 1",
      "enabled": true,
      "subscribed": false,
      "source": "generated|migrated|imported|file",
      "createdAt": 1793,
      "identity": { "version": 1, "journeyId": "...", "deviceId": "...", "conversationId": "...",
                    "durableStream": { "publicKeyJwk": {}, "privateKeyJwk": {}, "fingerprint": "..." },
                    "sync": { "enabled": false, "..." : "..." },
                    "auth": { "token": null, "email": null, "tier": "free", "...": "..." } },
      "stats": { "sessions": 0, "requests": 0, "failures": 0, "lastUsedAt": null }
    }
  ],
  "bindings": {
    "<sessionKey>": { "identityId": "id_ab12cd34", "createdAt": 1793, "updatedAt": 1793 }
  },
  "router": { "strategy": "hash" }
}
```

- **原子写**：`identity-pool.json.tmp-<hex>` → `rename`，`chmod 0600`（尽力而为）。
- **损坏**：备份为 `identity-pool.corrupt-<ts>.json` 后重建。
- **首启迁移**：若 pool 文件不存在，读取 `<dataDir>/identity.json` 并按 v2.2 规则校验/规范化后作为
  `id_default`（label「默认身份」、`source:"migrated"`、`activeId=id_default`）；**原 `identity.json` 保留不动**
  （v2.2 身份页/接口继续可用）。`identity.json` 不存在或不可用时，生成全新默认身份。
- **bindings 格式**：契约 §1 写的是 `sessionKey → id` 字符串；实现落盘为对象
  `{identityId,createdAt,updatedAt}`（管理 API 需要时间戳），**加载时兼容字符串值**，所以两种格式都能读。
- **上限**：`maxIdentities`（1–100，默认 20，超限 `409 pool_full`）；bindings 默认上限 5000，超出按
  `updatedAt` 淘汰最旧（写盘前自动执行）。
- 私钥/token 不出 `list()`/`get()`；仅 `exportIdentity()` 返回完整内容。

---

## 3. 路由（session → identity）

### 3.1 公式（新绑定，严格按契约）

```
candidates = identities.filter(enabled)
if (paidModel) candidates = candidates.filter(subscribed)
candidates.sort(by id asc)
index = parseInt(sha256(sessionKey + ":" + salt).slice(0, 8), 16) % candidates.length
identityId = candidates[index].id
bindings[sessionKey] = { identityId, createdAt, updatedAt }   // 持久化，此后固定
```

- `sessionKey` 为空/null → 单轮请求：按 **least-loaded** 选一个身份且**不写绑定**（返回 identityId）。
- 已绑定会话：校验身份存在且 `enabled`，付费模型还要求 `subscribed`；
  - 身份被删除/禁用 → `503 identity_unavailable`（提示启用或解绑）；
  - 付费模型 + 未订阅 → `403 model_requires_subscription`（提示新会话或订阅该身份）。
- 无候选：付费 → `403 model_requires_subscription`；免费 → `503 no_identity_available`。
- 策略可切 `hash`（默认）/ `least-loaded`（管理页 PATCH router）；`salt` 轮换只影响**新**绑定。

### 3.2 绑定管理

`bind(sessionKey, identityId)` / `unbind(sessionKey)` / `getBinding(sessionKey)` /
`listBindings({limit,offset})`（按 `updatedAt` 倒序，返回 `{items,total,limit,offset}`）。

---

## 4. 每身份队列（RPS=1）

`IdentityQueue`（`IdentityQueue` 也可单独导出）：

- `rps`（默认 1）→ 相邻两次请求开始间隔 ≥ `1000/rps` ms；
- `maxConcurrent`（默认 1）；
- `queueLimit`（默认 50）→ `waiting.length >= queueLimit` 时 `429 queue_full`；
- `queueTimeoutMs`（默认 300000）→ 仍在 waiting 的任务超时 `429 queue_timeout`；
- 错误带 `retryAfterMs` / `retryAfter`（秒）；abort signal 在 waiting 阶段生效（`499 aborted`）。
- 不同身份队列完全独立 → **不同身份并行**。
- `stats()`：`{waiting,inFlight,rps,maxConcurrent,queueLimit,requests,failures,lastStartedAt,lastCompletedAt,peakInFlight,totalWaitMs,avgWaitMs,lastWaitMs}`。

`pool.run(identityId, fn, {signal})`：入队 → `fn(runtime)`（`runtime.queueWaitMs` 为该请求排队时长）→ 统一计数
`stats.requests` / `stats.failures` / `lastUsedAt`。api-core 用它把上游调用包在身份队列里：

```js
const identityId = await pool.route(sessionKey, { paidModel });
const result = await pool.run(identityId, (runtime) => runtime.chat(params, handlers), { signal });
```

> 注：rps 门控定时器**不 unref**（否则调用方会 await 一个永不 settle 的 promise）；空闲回收定时器会 unref。

---

## 5. 运行时（每身份一个 DuckClient）

- `getRuntime(identityId)` 懒加载：从池内身份记录构造 `MemoryIdentityStore`（不落额外文件）→
  `new DuckClient({...config.duck, identityStore, proxyManager})` → `await client.init()`。
- 运行时对象：`{ identityId, identity, store, client, journeyId, fingerprint, chat(params,handlers),
  imageGeneration(params), health(), queueWaitMs, createdAt, lastUsedAt }`。
- 独立 journeyId/challenge/限速状态；proxyManager 共享。
- 空闲 `idleTimeoutMs`（默认 10 分钟）回收（60s 周期扫描；队列 busy 时跳过）；`releaseRuntime(id)` 手动回收；
  CRUD（update/rotate/bindSubscription/clearSubscription/删除/禁用）会自动失效运行时。
- 运行时创建失败 → `PoolError{503, identity_unavailable}`（detail 带原始错误）。
- `close()`：停定时器、flush 持久化、释放运行时、关闭队列。

---

## 6. 订阅身份路由

- `bindSubscription(id, tokenInfoOrToken)`：
  - 传**字符串** → `auth.parseSubscriptionToken()` 解析（非法/过期抛 `PoolError`，code `token_invalid`/`token_expired`，422）；
  - 传已解析对象 → `{token,email,tier,entitlements,expiresAt,activatedAt,verified,tokenHash}`；
  - `tier ∈ {plus,pro}` → 该身份 `subscribed=true`，写入 `identity.auth`；
- `clearSubscription(id)` → auth 归零、`subscribed=false`；
- `update(id,{subscribed:true})` 也支持手工标记（不校验 token，供运营兜底）；
- 付费模型路由只选 `subscribed && enabled` 的身份；已绑定会话不满足 → 403。

---

## 7. 接口清单（api-core / QA 使用）

| 方法 | 签名/返回 |
| --- | --- |
| 初始化 | `init()`；`getSummary()`（同步）`{total,enabled,subscribed,activeId,saltPresent,bindingCount,maxIdentities,busy}`；`getPoolSummary()`/`getRedacted()` 同义；`healthSummary()` `{total,enabled,subscribed,busy}` |
| 列表/详情 | `list()`、`get(id)`（脱敏，含 durableStream/sync/auth 摘要与 stats） |
| CRUD | `create({label, identity\|import})`、`generate({count,labelPrefix,subscribed})`、`importIdentity(doc,{label})`、`update(id,{label,enabled,subscribed})`、`delete(id,{force})`（别名 `remove`）、`activate(id)`、`rotate(id,scope)`、`exportIdentity(id)`（别名 `export`） |
| 订阅 | `bindSubscription(id, tokenInfoOrToken)`、`clearSubscription(id)` |
| 路由 | `route(sessionKey,{paidModel})` → identityId；`routeDetailed(...)` → `{identityId,identity,bound,strategy}`；`resolve(input,opts)`（`{sessionKey,paidModel|paid,model}` 或字符串）；`routeRuntime(...)` |
| 绑定 | `bind`、`unbind`、`getBinding`、`listBindings({limit,offset})` |
| 路由配置 | `getRouting()`、`setRouter({strategy,salt})`（别名 `setStrategy`） |
| 运行时/队列 | `run(identityId, fn, {signal})`、`getRuntime(id)`、`releaseRuntime(id)`、`queueStats()`/`queueStats(id)`、`stats()`/`getStats()`、`close()` |

### 错误码

| code | status | 场景 |
| --- | --- | --- |
| `identity_not_found` | 404 | id 不存在 |
| `identity_in_use` | 409 | 删除 active/被绑定身份（未 force） |
| `pool_full` | 409 | 超 `maxIdentities`，或 generate 后超限 |
| `invalid_identity` | 400 | 身份记录/字段非法（`field` 指明字段） |
| `invalid_request` | 400 | 参数非法（count/limit/strategy/salt/fn 等） |
| `model_requires_subscription` | 403 | 付费模型无订阅身份 / 绑定身份未订阅 |
| `no_identity_available` | 503 | 没有启用身份 |
| `identity_unavailable` | 503 | 绑定身份被删除/禁用、运行时创建失败、池已关闭 |
| `queue_full` / `queue_timeout` | 429 | 队列满/等待超时（带 `retryAfterMs`/`retryAfter`） |
| `aborted` | 499 | 排队期间被 abort |

---

## 8. 自测（`data/tmp/identity-pool-tests.mjs`，18/18 通过）

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | 全新池生成 `id_default`（journey/device/fingerprint 合法、无密钥泄漏、文件结构） | ✅ |
| 2 | 迁移既有 `identity.json` 为 `id_default` 且原文件不变 | ✅ |
| 3 | 损坏 pool 文件备份 + 重建 | ✅ |
| 4 | `generate(3)` 三个身份 journeyId/deviceId/fingerprint 互不相同；超限 409；count 0/21 400；create/update/activate/rotate | ✅ |
| 5 | 删除被绑定/active → 409 `identity_in_use`；force 清理绑定、activeId 转移 | ✅ |
| 6 | 导出 → 新池导入，journeyId/deviceId/fingerprint 一致、新 id | ✅ |
| 7 | 路由严格按 hash 公式；重复调用一致；**重启后绑定不变**；无 sessionKey 不写绑定 | ✅ |
| 8 | 付费模型只选订阅身份；无订阅 403；绑定免费身份 + 付费 = 403；清除订阅后 403；非法 token 拒绝 | ✅ |
| 9 | 绑定身份被禁用 → 503 `identity_unavailable`；解绑后重新路由 | ✅ |
| 10 | salt 轮换影响新绑定（按公式断言）；least-loaded 策略；非法 strategy 400 | ✅ |
| 11 | bindings 手工绑定/列表/解绑/上限淘汰 | ✅ |
| 12 | 同身份 2 并发：串行（耗时 ≥1s、`peakInFlight=1`、`totalWaitMs` ≈1s）；不同身份并行（<1s） | ✅ |
| 13 | `queue_full`（第 3 个）/`queue_timeout`（等待超时）错误码与 `retryAfterMs` | ✅ |
| 14 | 排队中 abort → 499；运行中请求不受影响 | ✅ |
| 15 | 运行时懒加载缓存、release 重建、无效 id 404、rotate 失效重建且新 journeyId 生效 | ✅ |
| 16 | stats/healthSummary/fileInfo/close；close 后 run → 503 | ✅ |
| 17 | `mapUpstreamError('ERR_CONVERSATION_LIMIT')` → `{409, conversation_limit_reached}` | ✅ |
| 18 | `MemoryIdentityStore` / `identityRecord` 构造 DuckClient（离线） | ✅ |

回归：identity 23/23、v2 strict 22/22、baseline 17/17、proxy-unit 9/9 全绿；`node --check` 通过。

### 8.1 真实集成（身份池 → DuckClient → SOCKS5 代理 → 上游）

脚本：`data/tmp/verify-pool-live.mjs` / `verify-pool-live-retry.mjs`（本机代理 `127.0.0.1:10808`，SOCKS5，exit IP 70.39.202.155）。

| 步骤 | 结果 |
| --- | --- |
| `createIdentityPool({dataDir, config:{duck,pool}, proxyManager})` | ✅ 池初始化（迁移/生成默认身份）+ 3 个身份 |
| `generate({count:2})` + `list()` | ✅ 身份各自独立 journeyId/fingerprint |
| `route('live-session-1')` | ✅ 返回 `id_default`，绑定落盘（`getBinding` 可见） |
| `pool.run(identityId, rt => rt.chat(...))` 首次 | ⚠️ 上游 `418 ERR_CHALLENGE`（映射 403 `upstream_anomaly_check`）——出口 IP 的 anomaly/额度软限流；DuckClient 已按 418 重试 1 次仍失败 |
| 重试（新进程，另一个身份，间隔 6s） | ✅ **200**，内容「分身」；`queueWaitMs=1`、`queueStats.requests=1`、runtime journeyId/fingerprint 来自池内身份 |

结论：池 → 身份记录 → MemoryIdentityStore → DuckClient → 共享 proxyManager → 队列 的真实链路可用；
chat 成功与否取决于出口 IP 的匿名额度/风控（与 v2.3 观察一致），失败时错误会经过 `PoolError`/`DuckError` 正常冒泡。

---

## 9. 与 DuckClient 的协作（v2.4 新增）

- `DuckClient` 构造新增 `identityRecord`（内存身份对象，自动包成 `MemoryIdentityStore`）与
  `createDuckClientForIdentity(record, config)` 便捷工厂。
- `MemoryIdentityStore`：与 `IdentityStore` 同读接口（journey/conversation/durableStream/auth/health 摘要），
  不落盘；池负责持久化。
- `mapUpstreamError`：`ERR_CONVERSATION_LIMIT` 由 429 改为 **409 `conversation_limit_reached`**
  （`openaiType:"invalid_request_error"`，不可重试），供 api-core 的上下文守卫使用。
- 上下文裁剪（`config.context`、`ERR_INPUT_LIMIT`/`ERR_CONVERSATION_LIMIT` 裁剪后重试一次）由 api-core 在
  server 层实现；会话 `contextTrimmed` 由 sessions store 记录。

---

## 10. 已知边界 / 风险

1. **每身份 rps=1 会放大延迟**：同一会话连续请求需排队（默认 ≥1s 间隔）；不同会话路由到不同身份才并行。
2. **lastUsedAt/requests 等统计为内存态 + 1s 去抖持久化**：异常退出可能丢失最近 ≤1s 的统计（不影响绑定/身份数据，绑定与 CRUD 均即时落盘）。
3. **bindings 存储结构为对象**（含时间戳）而非契约示例的字符串；加载兼容字符串，导出/管理 API 不受影响。
4. **least-loaded 策略**是 v2.4 附加能力（契约 §5 router 提及），按 `inFlight*1000 + waiting` 选择；默认仍为 hash。
5. **运行时不会自动重建 challenge 类状态以外的偏好**：修改 `config.duck`（如 defaultModel）需重启；身份记录变更会失效运行时。
6. **真实上游池化验证**：已做一次（§8.1）：首次 418（出口风控/额度）、重试 200；chat 失败时错误正常冒泡，不代表池链路问题。
7. 身份池文件含私钥/token（契约要求），运维需按密钥保管（0600/加密盘）。
