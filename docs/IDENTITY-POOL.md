# v2.4：身份池（匿名分身池）+ 会话绑定 + 配对二维码 契约

> 目标：
> 1. **配对码同时生成二维码**（参考 duck.ai 网页端 Sync & Backup 的扫码配对）。
> 2. **匿名分身池**：可手动创建 / 规则批量生成 / 导入匿名身份；每个身份有独立的 journeyId、durable-stream 密钥、Sync 密钥与订阅状态。
> 3. **会话 ↔ 身份唯一绑定**：新会话按映射算法路由到一个身份并**永久固定**；同身份并发时按 **rps=1** 排队等待；同一会话后续消息始终走该身份。
> 4. **订阅身份路由**：可为身份开启「订阅绑定」，付费模型请求只路由到已订阅身份。
> 5. 回答上下文问题（见 §7），并增加网关侧上下文守卫。

---

## 1. 数据模型（`data/identity-pool.json`，原子写）

```json
{
  "version": 1,
  "activeId": "id_default",
  "salt": "<随机 hex>",
  "identities": [
    {
      "id": "id_ab12cd34",
      "label": "分身 1",
      "enabled": true,
      "subscribed": false,
      "source": "generated",
      "createdAt": 1793,
      "identity": { "version": 1, "journeyId": "...", "deviceId": "...", "conversationId": "...",
                    "durableStream": { "publicKeyJwk": {}, "privateKeyJwk": {}, "fingerprint": "..." },
                    "sync": { "enabled": false, ... }, "auth": { "token": null, "email": null, "tier": "free", ... } },
      "stats": { "sessions": 0, "requests": 0, "failures": 0, "lastUsedAt": null }
    }
  ],
  "bindings": { "<sessionKey>": "id_ab12cd34" }
}
```

- 每个身份 = 一份完整的 v2.2 `identity.json` 内容 + 元数据（label/enabled/subscribed/stats）。
- 首次启动自动迁移：现有 `data/identity.json` 作为 `id_default`（label `默认身份`，activeId 指向它），原文件保留（兼容 v2.2 接口）。
- 上限：`pool.maxIdentities`（默认 20，1–100）；`bindings` 最多 5000 条（超出淘汰最旧/未使用）。
- 私钥/token 永不通过列表/详情接口返回；仅 `export` 返回完整内容。

## 2. 身份路由（session → identity）

- **sessionKey** 来源优先级：
  1. `/v1/*` 请求头 `X-Session-Id`（或 body `session_id` / `conversation_id`）；
  2. 管理后台测试会话：`sess_xxx`；
  3. 其他请求：按请求随机生成（不绑定，单轮）。
- **映射算法**（新绑定）：
  - 候选池 = `enabled=true` 的身份；付费模型请求时再过滤 `subscribed=true`（无候选 → 403 `model_requires_subscription`）。
  - 候选按 `id` 升序排列，`index = int(sha256(sessionKey + ":" + salt).slice(0,8),16) % candidates.length` → 选中身份。
  - 绑定写入 `pool.bindings[sessionKey] = identityId`（原子持久化），**此后固定**；身份被禁用/删除时不改绑定，仅返回 503 `identity_unavailable`（提示启用该身份或解绑）。
- 绑定接口支持手工指定（管理页）与解绑（重新路由）。
- **唯一性**：同一 sessionKey 永远映射同一身份（持久化），跨重启不变。

## 3. 每身份限速（RPS=1）

- 每个身份独立队列：`rps=1`（两次上游请求开始间隔 ≥1000ms）、`maxConcurrent=1`；
  配置 `pool.queueLimit`（默认 50）、`pool.queueTimeoutMs`（默认 300000）。
- 同一身份并发请求 → 排队（响应头/日志带 `identityId` 与 `queueWaitMs`）；队列满/超时 → 429 `queue_full` / `queue_timeout`。
- **不同身份可并行**（互不影响）。
- 每个身份持有一个运行时（独立 DuckClient 实例：独立 challenge 状态、journeyId、代理共享），空闲 10 分钟可回收（懒加载重建）。
- `GET /admin/api/identities` 暴露每个身份的 `queue: {waiting, inFlight, rps}`。

## 4. 订阅绑定

- `PATCH /admin/api/identities/:id { subscribed: true }` 或 `POST /api/identities/:id/subscription {token}`：
  绑定订阅 token 到该身份（校验 JWT + `verifyScope:"reachability"`，语义同 v2.2）。
- 付费模型请求（`paid:true` 且 `allowPaidModels=true`）只路由到 `subscribed && enabled` 的身份；
  若会话已绑定到未订阅身份 → 403 `model_requires_subscription`（提示改用订阅身份或新会话）。
- 免费模型不受影响。

## 5. Admin API

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /admin/api/identities` | `{ pool: { total, enabled, subscribed, activeId, salt?, bindingCount, maxIdentities }, items: [identitySummary] }`；`identitySummary = { id,label,enabled,subscribed,source,createdAt,journeyId,deviceId,fingerprint,durableStreamEnabled,syncEnabled,authTier,authenticated,sessions,requests,lastUsedAt,queue:{waiting,inFlight,rps},active }`（无密钥/token） |
| `POST /admin/api/identities` | body `{ label?, import?: identityJSON }` → 手动创建（import 则导入完整身份）→ 201 `{ identity }` |
| `POST /admin/api/identities/generate` | body `{ count=1, labelPrefix="分身", subscribed=false }` → 批量生成（1–20）→ `{ items }` |
| `GET /admin/api/identities/:id` | 详情（脱敏，含 sync/auth 摘要与 stats） |
| `PATCH /admin/api/identities/:id` | `{ label?, enabled?, subscribed? }` → `{ identity }` |
| `DELETE /admin/api/identities/:id` | 删除（若为 activeId 或仍被绑定：默认 409 `identity_in_use`，`?force=true` 强制并清理绑定） |
| `POST /admin/api/identities/:id/activate` | 设为 `activeId`（v2.2 默认身份）→ `{ ok, pool }` |
| `POST /admin/api/identities/:id/rotate` | `{ scope?: "journey"|"device"|"all" }` 轮换该身份 |
| `GET /admin/api/identities/:id/export` | 下载完整身份文件（含私钥/token） |
| `POST /admin/api/identities/:id/subscription` | `{ token }` 绑定订阅到身份 → `{ identity, subscription }`；`DELETE` 解除 |
| `GET /admin/api/identities/bindings?sessionKey=&limit=` | `{ items: [{ sessionKey, identityId, createdAt, updatedAt }], total }` |
| `POST /admin/api/identities/bindings` | `{ sessionKey, identityId }` 手工绑定 → `{ binding }` |
| `DELETE /admin/api/identities/bindings/:sessionKey` | 解绑（下次重新路由） |
| `GET /admin/api/identities/routing` | `{ strategy, saltPresent, perIdentity: [{id,waiting,inFlight,requests}], totals }` |
| `PATCH /admin/api/identities/router` | `{ strategy: "hash"|"least-loaded", salt? }`（切换策略；salt 轮换影响**新**绑定） |

- 会话详情/列表新增 `identityId` 与 `identityLabel`（测试会话页展示）。
- `/healthz` 增加 `identityPool: { total, enabled, subscribed, busy }`。
- `/admin/api/overview` 增加 `identities` 摘要与各身份队列。

## 6. 前端

1. **身份页（现有）**：
   - Sync & Backup 生成配对码时**同时展示二维码**（QR 编码 `pairingCode.url`，可下载 PNG / 复制链接）；样式参考 duck.ai 扫码配对（白底、居中、提示「在另一台设备打开 DuckDuckGo → Sync & Backup → 扫描」）。
2. **新页面「身份池」`#/identities`**（侧边栏「身份」之后）：
   - 概览条：身份总数/启用/已订阅/会话绑定数；
   - 身份列表：label、journeyId 前缀、指纹、订阅/启用徽章、会话数、队列（执行/排队）、最后使用；行操作：设为默认、轮换、订阅绑定（输入 token 弹窗）、导出、禁用、删除；
   - 工具栏：新建（手动）、批量生成（数量/前缀）、导入身份文件；
   - 会话绑定列表（sessionKey → 身份，支持手工绑定/解绑/筛选）；
   - 路由信息：策略、salt 存在性、每身份队列。
3. **连接测试（会话页）**：会话头部显示绑定的身份（label + 指纹前缀）；切换身份需解绑。
4. **代理页**：不变。

## 7. 上下文长度与自动压缩（源码结论 + 网关守卫）

**duck.ai 行为（源码实测）**：
- 每条消息输入上限 `inputCharLimit`，免费模型均为 **16,000 字符**（`16e3`）；超限报 `ERR_INPUT_LIMIT`（413）。
- **会话最大长度由服务端控制**：超限返回 `ERR_CONVERSATION_LIMIT`，前端提示
  「You've reached the maximum chat length in this conversation. Start a new chat to continue.」
  并自动触发 **compaction/summarize**：调用摘要服务生成 `summary.text`（携带 `previousSummary`、
  `targetPairCount`、`coveredPairCount`），成功后把摘要作为 `initialContext`，只发送最近消息
  （`messages.slice(2*coveredPairCount)`）继续对话；失败时展示「Summarize」按钮。
- 服务端还会在 `[DONE]` 行下发 `[SUMMARY_REFRESH_HINT:{baseCoveredPairCount,targetPairCount,thresholdTokens,trigger:"tokens"}]`
  与 `[SUMMARY_INVALID]`，用于**基于 token 阈值主动刷新摘要**。
- 结论：**duck.ai 会自动压缩（摘要化）长会话**，不是无限上下文；免费模型单条输入 16k 字符。

**网关侧（v2.4 新增）**：
- `config.context = { maxInputChars: 12000, maxMessages: 40, onLimit: "trim"|"error" }`：
  - 发送前按字符/条数裁剪（保留 system/summary + 最近消息），并在会话中记录 `contextTrimmed: true`；
  - 上游返回 `ERR_CONVERSATION_LIMIT` / `ERR_INPUT_LIMIT` 时：若 `onLimit="trim"` 自动裁剪后重试一次；否则原样映射（413/409）。
- 会话消息记录 `summary` 字段（预留），管理页可显示「已裁剪 N 条」。
- 不实现真正的摘要生成（需额外模型调用/额度）；裁剪策略仅保证可用性，文档明确说明。

## 8. 验收标准

1. 配对码生成后页面显示可扫描二维码（内容是配对 URL），可下载/复制；二维码与 code2 URL 解码一致。
2. 批量生成 3 个身份 → journeyId/deviceId/指纹互不相同；`GET /admin/api/identities` 列表正确；导出→导入到新池后身份一致。
3. 创建 4 个测试会话 → 各自获得绑定（hash 映射，分布合理）；同一会话连续多轮 identityId 不变；重启网关后绑定不变。
4. 同一身份并发 2 个请求 → 串行（日志 `queueWaitMs` 递增、该身份 `inFlight<=1`）；不同身份并发 → 并行。
5. 付费模型：无订阅身份 → 403；绑定订阅身份后 → 请求路由到该身份（日志 identityId 可验证）。
6. 导入/导出/删除/禁用/轮换/会话手工绑定解绑均正确；删除被绑定身份默认 409。
7. 上下文：超长会话/`ERR_CONVERSATION_LIMIT` 场景下网关自动裁剪重试（或按配置映射），会话标记 `contextTrimmed`。
8. 回归：`npm test` 全绿；`build-check`/`page-check` 含身份池页与二维码；浏览器人工验收无 console 报错。
