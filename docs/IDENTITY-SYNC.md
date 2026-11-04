# Duck.ai 身份、Sync & Backup 与订阅（v2.2 契约）

> 本文是 v2.2 的唯一契约。目标：把 duck.ai 的**匿名身份**做成**稳定、可保存、可导出**的后端标识，
> 提供控制页管理 **Sync & Backup**（同步与备份）与 **DuckDuckGo 订阅激活**，保证 CPA 长期运行不「漂移」。

---

## 1. 源码分析结论（匿名追踪机制）

duck.ai 没有账号也能「记住你」，**不是靠 cookie**（匿名 `document.cookie` 为空），而是三套机制叠加：

| 机制 | 形式 | 是否持久 | 说明 |
| --- | --- | --- | --- |
| **journey id** | 请求头 `x-ddg-journey-id: <32 hex>` | ❌ 内存态（每次加载随机） | 前端 `crypto.getRandomValues` 生成，校验正则 `/^[a-f0-9]{32}$/`；用于「一次访问旅程」的埋点/归因，服务端用它把同一 journey 的请求串起来 |
| **durable stream 身份** | 请求体 `durableStream: { messageId, conversationId, publicKey(RS256 JWK) }` | ✅ 由客户端持有私钥 | 客户端生成 RSA-OAEP-256 密钥对，只把**公钥**发给服务端；聊天用这把公钥加密保存（recent chats / 跨设备恢复），**私钥永不出客户端** → 服务端能识别「同一个人」，但读不到内容 |
| **Sync & Backup 密钥** | `mainKey`(32B) + `encryptedPrivateKey`(JWE, `kid:"streams"`, `alg:"dir"`, `enc:"A256GCM"`) + `scopedPasswordSeed` | ✅ localStorage/IndexedDB + 配对码 | DuckDuckGo Sync 体系：设备配对（`https://duckduckgo.com/sync/pairing/#&code2=<base64url({version:"2",channel_id,public_key})>`），配对后通过 sync 服务交换加密的设备信息；恢复码为 base64 JSON `{"recovery":{"user_id":...}}`（v1 旧格式 `{type:"v1-pairing"}`） |
| **订阅身份** | `Authorization: Bearer <token>`（`/duckchat/v1/auth/token`，OAuth via `/duckchat/v1/auth/authorize`） | ✅ 登录态 | token 是 base64url 三段 JWT，payload 含 `api/email/exp/entitlements`；`entitlements` 里 `product:"Duck.ai"` + `name:"plus"|"pro"` 决定档位；匿名返回 `{}` |

此外：`x-fe-signals`（前端信号，非身份）、`x-duckai-client-tools`（能力声明）、
`internal_duckchat_user` cookie（内部账号专用，匿名无）、`x-tier-internal`（内部档位修正）。

**关键结论**：要「稳定不漂移」，必须把 journey id、durable-stream 密钥对、sync mainKey/私钥、
订阅 token **持久化到 data/identity.json**，每次启动加载、每个请求复用——
而不是像现在这样每次进程启动重新生成（这就是当前实现会漂移的根因）。

---

## 2. 稳定身份存储（`data/identity.json`）

```json
{
  "version": 1,
  "createdAt": 1793520000000,
  "rotatedAt": 1793520000000,
  "journeyId": "<32 hex>",
  "deviceId": "<uuid v4>",
  "deviceName": "DuckAI CPA @ <hostname>",
  "durableStream": {
    "version": "0.2.0",
    "publicKeyJwk": { "kty": "RSA", "alg": "RSA-OAEP-256", "e": "AQAB", "n": "..." },
    "privateKeyJwk": { "...": "仅落盘，永不出接口" },
    "fingerprint": "<sha256(spki) 前 32 hex>",
    "createdAt": 1793520000000
  },
  "sync": {
    "enabled": false,
    "mainKey": "<base64url 32B>",
    "scopedPasswordSeed": "<base64url>",
    "encryptedPrivateKey": "<JWE compact>",
    "pairingCode": null,
    "recoveryCode": null,
    "lastSyncAt": null,
    "devices": []
  },
  "auth": {
    "token": null,
    "email": null,
    "tier": "free",
    "entitlements": [],
    "expiresAt": null,
    "activatedAt": null
  }
}
```

- **原子写**（临时文件 + rename）、权限 `0600`（尽力而为）；损坏时备份为 `identity.corrupt-<ts>.json` 并重建。
- **绝不把 `privateKeyJwk` / `token` 明文返回给前端**；只返回指纹、公钥、token 的 email/tier/exp。
- **稳定输出**：`GET /admin/api/identity` 每次返回同一 `journeyId`/`fingerprint`，重启后不变。
- 轮换（rotate）只在用户显式操作时发生，并记录 `rotatedAt`。

### 2.1 请求集成

- `x-ddg-journey-id` 使用 identity.journeyId（不再每次进程随机）。
- `durableStream`：**默认开启（`identity.durableStream.enabled=true`）**。
  - 发送格式：`{messageId: uuid, conversationId: 稳定 uuid, publicKey: durableStream.publicKeyJwk}`；
    公钥 JWK 必须带 `alg:"RSA-OAEP-256"`、`use:"enc"`、`ext:true`、`key_ops:["encrypt"]`（缺 `use` 会被上游 400）。
  - 实测：正确形状下真实 chat **200**，上游接受该身份字段（`rejectedCount=0`）。
  - 兜底：若个别环境上游仍返回 **400 ERR_BAD_REQUEST**，自动去掉 durableStream 重试一次，
    记录 `durable_stream_rejected` 计数、`degraded=true`；用户可在配置/设置中关闭。
- 若订阅 token 存在：请求带 `Authorization: Bearer <token>`；token 过期（exp 已过）自动降级匿名并标记 `authExpired=true`。
- 身份稳定性由 **journeyId + 本地 RSA 指纹**保证（持久化即可，不依赖 durableStream 是否被上游接受）。
- 所有上游请求失败时的 `recentErrors` 附带 `identityFingerprint`，便于排查漂移。

---

## 3. Admin API（v2.2 新增）

> 鉴权与 v2 一致：`/admin/api/*` 必须 admin token。

### 3.1 身份

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /admin/api/identity` | `{ identity: { journeyId, deviceId, deviceName, fingerprint, createdAt, rotatedAt, stable: true, source: "file"|"generated" }, durableStream: { fingerprint, publicKeyJwk, hasPrivateKey, version }, auth: { authenticated, email, tier, entitlements, expiresAt, activatedAt }, sync: { enabled, deviceCount, lastSyncAt, hasPairingCode, hasRecoveryCode }, file: { path, bytes, updatedAt } }` |
| `POST /admin/api/identity/rotate` | body `{ scope?: "journey"|"device"|"all" }` → 轮换并返回新 identity（会提示「可能导致上游重新识别」） |
| `GET /admin/api/identity/export` | 下载完整身份（含私钥/token）`{ version, exportedAt, identity }`；响应 `Content-Disposition: attachment; filename="duckai-identity-<ts>.json"` |
| `POST /admin/api/identity/import` | body `{ identity }` → 校验版本/字段/密钥可用性后原子替换；`{ ok, identity }` |
| `POST /admin/api/identity/reveal` | body `{ field: "token"|"mainKey" }` → 仅当请求带 `confirm: true` 时返回该字段明文（用于迁移） |

### 3.2 Sync & Backup

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /admin/api/sync` | `{ sync: { enabled, deviceId, deviceName, deviceCount, devices: [{id,name,type,thisDevice}], lastSyncAt, transport: "available"|"blocked", transportReason?, pairingCode: null|{code,url,channelId,publicKey,createdAt,expiresAt}, recoveryCode: null|{present,preview} } }` |
| `POST /admin/api/sync/enable` | body `{ deviceName? }` → 初始化 mainKey/scopedPasswordSeed/encryptedPrivateKey 与 recovery code；`{ ok, sync, recoveryCode }`（恢复码**只在此次返回完整值**） |
| `POST /admin/api/sync/disable` | 关闭并清空 sync 密钥（保留 durable stream 身份）；`{ ok, sync }` |
| `POST /admin/api/sync/pairing-code` | 生成 v2 配对码 `{ version:"2", channel_id, public_key }` → `{ code, url: "https://duckduckgo.com/sync/pairing/#&code2=...", expiresAt }` |
| `POST /admin/api/sync/pair` | body `{ code }` → 解析并校验 v2 配对码；若本环境无法访问 duckduckgo.com sync 服务 → `503 sync_transport_unavailable`（附 `hint`），否则发起配对并 `{ ok, sync }` |
| `GET /admin/api/sync/recovery-code` | `{ recoveryCode }`（完整值，需 admin token） |
| `POST /admin/api/sync/recovery-code` | body `{ recoveryCode }` → 解析 v1 恢复码/新格式，导入 mainKey+encryptedPrivateKey；`{ ok, sync }` |

**沙箱限制（必须优雅处理）**：本沙箱网络仅允许 `duck.ai`，`duckduckgo.com` 不可达（已实测 `fetch failed`）。
因此 sync 的**本地能力**（身份初始化、密钥生成、配对码/恢复码编码解析、导出导入、状态展示）必须完整可用；
真正的跨设备传输在 `transport: "blocked"` 时返回 `503 sync_transport_unavailable`，并在 UI 明确提示原因。

### 3.3 订阅

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /admin/api/subscription` | `{ subscription: { authenticated, email, tier: "free"|"plus"|"pro", entitlements: [{product,name,expiresAt?}], expiresAt, activatedAt, verified: boolean, verifyScope: "reachability", verifyNote: string, verifyError?: string, allowPaidModels } }` |
| `POST /admin/api/subscription/activate` | body `{ token }` → 解析 JWT payload（`api/email/exp/entitlements`），校验格式与过期；写回 identity.auth；随后用该 token 调 `GET /duckchat/v1/status` + `/capabilities` 探测可达性（`verified`）；`{ ok, subscription }` |
| `DELETE /admin/api/subscription` | 注销（清除 token）→ `{ ok, subscription }` |
| `POST /admin/api/subscription/verify` | 重新在线探测 → `{ ok, subscription }` |

- token 解析：三段 base64url，payload JSON；`entitlements` → 取 `product === "Duck.ai"` 且 `name in {plus,pro}` 映射 tier；
  过期 → `tier: "free"`、`authenticated: false`、`expired: true`，不抛 500。
- **`verified` 语义（重要）**：`verifyScope: "reachability"`，仅表示「token 本地解析通过 + 上游可达」，
  **不代表 Duck.ai 已确认 token 有效**（匿名 `/status` 恒 200）。真实档位以实际请求上游（模型权限/额度）为准。
- 激活成功后，`config.duck.allowPaidModels` 可保持 false（付费模型仍由网关开关控制），但状态页应显示「已登录 Plus/Pro」。

---

## 4. 前端（新增页面「身份与订阅」）

侧边栏导航新增 **身份**（Icon: Fingerprint / ShieldCheck），页面 3 个卡片：

1. **匿名身份**：journeyId、deviceId、durable-stream 指纹、创建时间、稳定性徽章（「已持久化，重启不漂移」）、
   「轮换」按钮（二次确认）、「导出/导入身份文件」。
2. **Sync & Backup**：开关（启用后展示恢复码一次并支持下载/复制）、配对码生成（展示 URL + 复制 + 二维码可选）、
   导入配对码 / 导入恢复码、设备列表（本机标记）、`transport` 状态（blocked 时显示「当前环境无法访问 duckduckgo.com」）。
3. **DuckDuckGo 订阅**：token 输入框（粘贴）、激活/验证/注销、显示 email、tier 徽章（free/plus/pro）、到期时间、`verified`
   （并展示 `verifyScope/verifyNote`：仅可达性校验，非 token 有效性）。激活成功后概览页的模型目录应付费模型显示「已登录 Plus/Pro，仍受 allowPaidModels 控制」。

UI 要求：与现有 React 控制台风格一致（shadcn 卡片/表单/徽章/Toast），所有敏感值默认掩码，复制按钮。

---

## 5. 验收标准（v2.2）

1. `data/identity.json` 首次启动生成，**重启后 journeyId / deviceId / durableStream 指纹完全不变**（自动化断言）。
2. `GET /admin/api/identity` 不返回私钥/token 明文；`export` 包含完整信息可 `import` 回来。
3. 轮换后 identity 文件更新且新请求使用新 journeyId（日志可见），`rotatedAt` 更新。
4. `durableStream.publicKeyJwk` 为合法 RSA-OAEP-256 JWK（含 `use:"enc"`）；**默认发送**，真实 chat 200 且
   `rejectedCount=0`（已实测）；若上游 400 自动降级并记录 `durable_stream_rejected`（`degraded=true`）。
5. `POST /admin/api/sync/enable` 生成 mainKey/scopedPasswordSeed/encryptedPrivateKey(JWE 可解密验证) 与 recovery code；
   恢复码导入到另一个 identity 目录后能还原同一 mainKey。
6. 配对码生成/解析符合 `{version:"2",channel_id,public_key}` + URL `https://duckduckgo.com/sync/pairing/#&code2=`；
   `transport:blocked` 时 `POST /sync/pair` 返回 503 `sync_transport_unavailable` 且不破坏本地状态。
7. `POST /admin/api/subscription/activate`：合法 token → 解析出 email/tier/entitlements；非法/过期 token → 400/422 明确错误；
   `GET` 显示 `authenticated/tier/expiresAt/verified`；DELETE 注销后回到 free。
8. 前端「身份与订阅」页三卡片可用，敏感值掩码，操作有 Toast，无 console 报错；`npm run build:web` 成功。
9. 回归：v2.1 全部能力（队列/日志拆分/付费模型/会话 retry/严格中断）不受影响（`npm test` 全绿）。
