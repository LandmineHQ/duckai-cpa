# Duck.ai 匿名身份 / durable stream / Sync & Backup / 订阅 —— 源码分析 + 实测

> 产出：`协议层`（，v2.2）。契约见 `docs/IDENTITY-SYNC.md`；上游协议见 `docs/PROTOCOL.md`；
> 错误映射见 `docs/PROTOCOL-ERRORS.md`。
>
> 目标：解释 duck.ai 如何在**无登录**状态下「认识同一个客户端」，并说明本项目如何把这些标识
> **持久化到 `data/identity.json`**，让 CPA 网关重启/多轮/长跑都不「身份漂移」。
>
> 证据来源：`recon/entry.duckai.2d2656b1fcd20ced62d9.js`（Web bundle，2026-11-01 下载）、
> `data/tmp/identity-recon.txt`、`data/tmp/identity-recon2.txt`、以及 2026-11-02 本机真实上游实测。

---

## 1. 结论摘要

duck.ai 的匿名追踪由 **4 套互不依赖的机制**叠加，而不是 cookie（匿名 `document.cookie` 为空）：

| # | 机制 | 上游载体 | 浏览器是否持久 | 网关实现 |
| --- | --- | --- | --- | --- |
| 1 | **journey id** | 请求头 `x-ddg-journey-id: <32 hex>` | ❌ 每次页面加载随机（`crypto.getRandomValues`） | ✅ 持久化到 `identity.json`，每次请求复用 |
| 2 | **durable stream 身份** | body `durableStream:{messageId,conversationId,publicKey}`；`publicKey` 为 RSA-OAEP-256 **JWK**（只发公钥，私钥本地） | ✅ 客户端本地密钥 | ✅ 持久化 RSA-2048 密钥对 + 稳定 conversationId；默认关闭（见 §3.4） |
| 3 | **DuckDuckGo Sync & Backup** | `mainKey`(32B) + `encryptedPrivateKey`(JWE `alg=dir/enc=A256GCM/kid=streams`) + `scopedPasswordSeed`；配对码 v2 / 恢复码 | ✅ localStorage/IndexedDB + 配对码 | ✅ 本地能力完整（生成/导入导出/配对码/恢复码）；真实同步 transport 在本当前环境不可达 |
| 4 | **订阅身份** | `Authorization: Bearer <jwt>`（`/duckchat/v1/auth/token`） | ✅ 登录态 | ✅ token 解析/落盘/在线验证；匿名无 token |

**漂移根因**：旧实现每次进程启动都用 `crypto.randomBytes(16)` 生成 journey id（且不保存），
上游看到的是「每次都是新访客」。v2.2 起 journey id / durable-stream 指纹 / sync 密钥 / token 全部落盘复用。

---

## 2. 源码证据（bundle 逆向）

### 2.1 journey id

```js
// bundle（约定与校验）
const u = "x-ddg-journey-id";                 // 请求头名
const p = /^[a-f0-9]{32}$/;                   // 校验：32 位小写 hex
function m(){ return Array.from(crypto.getRandomValues(new Uint8Array(16)), e => e.toString(16).padStart(2,"0")).join("") }
function h(){ const e = window.journey_id; return typeof e === "string" && p.test(e) ? e : null }
```

- 生成方式：16 字节随机 → 32 hex；**只存在内存**（`window.journey_id`），页面刷新会换新的。
- 用途：埋点/归因（bundle 中 `getJourneyId()` 被传给 chat 请求与 telemetry），服务端用它在一次访问内串联请求。
- 另有 `duck-chat-suggested-prompts` 等 **journey 事件**（前端掩码埋点对象），与请求头 journey id 无直接关系。

### 2.2 durable stream 身份（真正的「上游认识你」）

请求体构造（bundle，POST `/duckchat/v1/chat`）：

```js
// 当前 conversation 的稳定 id 与导出的公钥
const Ge = await _("chat");                                     // persistent conversationId
const ht = Ie() && !isLoading && exportedPublicKey
  ? { conversationId: Ge, publicKey: exportedPublicKey } : undefined;

// 每条 user message 的 meta.recovery.messageId（重试/断线恢复用）
const Ve = Ne?.meta?.recovery?.messageId;
const We = ht && ht.publicKey && Ve
  ? { messageId: Ve, conversationId: ht.conversationId, publicKey: ht.publicKey }
  : undefined;

body.durableStream = R ? undefined : We;                        // R = continuation 模式时省略
```

密钥与算法（bundle 模块 2113909）：

```js
const modulusLength = 2048;                                     // CHAT 用途 2048 位
const { kid, keyPair } = {
  kid: crypto.randomUUID(),
  keyPair: await crypto.subtle.generateKey({ name:"RSA-OAEP", modulusLength: 2048,
    publicExponent: new Uint8Array([1,0,1]), hash:"SHA-256" }, true, ["encrypt","decrypt"])
};
async function E(e){ const t = await crypto.subtle.exportKey("jwk", e); t.use || (t.use = "enc"); return t; }
```

- 公钥以 **JWK** 形式发送（`exportKey("jwk")`，并补 `use:"enc"`）；私钥 `pkcs8` 导出后**只用本地 JWE 包裹**，
  永不发给上游（`encryptedPrivateKey` 见 §2.3）。
- `conversationId` 是持久化的（bundle 用 provider 的 `_("chat")` 取/建 conversation id），不是每请求随机；
  `messageId` 来自该轮 user message 的 recovery 元数据（每轮用户消息一个）。
- 上游用「同一把公钥 + 同一 conversationId」把不同请求关联为同一个人，并用公钥加密保存 recent chats；
  私钥在客户端 → 上游能识别身份但读不到聊天内容。
- 相关的 durable stream 恢复接口：`https://sync.duckduckgo.com/sync/ai_chat_streams/<messageId>`
  （JWE `schema_version:"2"` 的 `stream_parts[]`，需私钥解密；本网关不用，见 PROTOCOL-ERRORS §8）。

### 2.3 Sync & Backup 密钥

bundle 中的密钥派生（HKDF-SHA256）：

```js
async function w(ikm, bits, salt, info) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name:"HKDF", hash:"SHA-256", salt: enc(salt), info: enc(info) }, key, 8*bits));
}
async function P(password, salt) { return crypto.subtle.importKey("raw", await w(password,32,salt,"Main Key"), {name:"AES-GCM"}, true, ["encrypt","decrypt"]); }
async function N(seed, salt)     { return base64url(await w(seed,32,salt,"Password")); }   // scopedPasswordSeed → scopedPassword
```

- `mainKey`：32 字节对称密钥（HKDF 派生/随机生成均可），用于**包裹** durable-stream RSA 私钥。
- `encryptedPrivateKey`：**compact JWE**，`protected = base64url({"alg":"dir","enc":"A256GCM","kid":"streams"})`，
  5 段 `header..iv.ciphertext.tag`（`alg:dir` 时 `encrypted_key` 为空），AAD = protected header；
  与 bundle 中 `L(e,t,n,r)` 完全一致。
- `scopedPasswordSeed`：派生 `scopedPassword`（HKDF `info:"Password"`），用于 sync 设备绑定的 KEK。

### 2.4 配对码（v2）与恢复码

```js
// v2 配对码构造
const qrUrl = `${"https://duckduckgo.com"}/sync/pairing/#&code2=${
  base64url(new TextEncoder().encode(JSON.stringify({
    version: "2",
    channel_id: self.channelId,                 // 16B 随机，base64url
    public_key: self.keypair.publicKeyBase64Url // RSA 公钥 base64url（SPKI DER）
  })))
}`;

// 解析约束（bundle）
const origin = "https://duckduckgo.com";
const paths = ["/sync/pairing", "/sync/pairing/"];
const versionRe = /^2(?:\.\d+)?$/;
const channelUuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicKeyRe = /^[A-Za-z0-9_-]+$/;
const v1Code = { type: "v1-pairing" };
const pairingErrors = new Set(["bad_base64","bad_encoding","bad_json","bad_payload",
  "unsupported_version","bad_channel_id","bad_public_key"]);
// 配对码长度上限 2048；v1 码在 v2 界面提示 version_mismatch
```

- 恢复码（DuckDuckGo 官方）：`base64url(JSON({"recovery":{"user_id":...}}))`，本身**不含密钥材料**
  （恢复需要访问 sync 服务拿加密数据）。
- 本当前环境 `duckduckgo.com` 不可达，因此 `duckai-cpa` 的恢复码扩展为
  `{"recovery":{"user_id","main_key","scoped_password_seed","encrypted_private_key",...}}`
  （base64url JSON），可在**另一台 CPA 实例离线还原 mainKey/私钥**；官方短码仍可被识别，
  但 `importRecoveryCode` 会明确提示缺少密钥材料。

### 2.5 订阅 token

```js
// bundle auth 模块
const endpoints = { authorize:"/duckchat/v1/auth/authorize", token:"/duckchat/v1/auth/token",
                    logout:"/duckchat/v1/auth/logout", callback:"/duckchat/v1/auth/callback" };
function parse(token) {
  if (token.length === 62) throw new Error("ERR_AUTH_V1_TOKEN");   // 旧 v1 token
  const [, payload] = token.split(".");                            // 三段 base64url
  const json = JSON.parse(atob(payload));
  return { api: json.api, email: json.email, exp: Number(json.exp), entitlements: json.entitlements };
}
function tier(entitlements) {
  const has = (name) => entitlements.some(e => e.product === "Duck.ai" && e.name === name);
  return has("pro") ? "Pro" : has("plus") ? "Plus" : "Free";
}
function authHeaders(tier, token, isInternal) {
  return { ...(isInternal && tier !== Internal ? { "x-tier-internal": "ignore" } : {}),
           ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
```

- 匿名 `/duckchat/v1/auth/token` → `200 {}`；`/auth/authorize`、`/auth/callback` 无参数 → `400`（实测与源码一致）。
- `entitlements` 里 `product === "Duck.ai" && name in {plus,pro}` 决定档位；过期以 `exp` 判断。

---

## 3. 实现（`src/duck/**`，v2.2）

### 3.1 模块与导出

| 模块 | 导出 | 说明 |
| --- | --- | --- |
| `identity.js` | `IdentityStore`、`IdentityError`、`createIdentityStore({dataDir,config,logger,sync})`、`generateJourneyId()`、`generateDurableStreamKeyPair()`、`durableStreamFingerprint(jwk)` | 稳定身份存储（原子写/0600/损坏备份） |
| `jwe.js` | `encryptJwe/decryptJwe/decryptJweToString`、`generateKey32`、`base64urlEncode/Decode`、`JWE_PROTECTED_HEADER`、`jweKid` | DuckDuckGo Sync 兼容 compact JWE |
| `sync.js` | `buildPairingCode`、`parsePairingCode`、`buildPairingUrl`、`createRecoveryCode`、`decodeRecoveryCode`、`detectSyncTransport`、`generateChannelId`、`PAIRING_ERRORS`、`MAX_PAIRING_CODE_LENGTH/MAX_RECOVERY_CODE_LENGTH` | 配对码/恢复码/transport 探测（纯本地） |
| `auth.js` | `parseSubscriptionToken`、`entitlementsToTier`、`verifySubscriptionOnline`、`hashToken`、`AuthError` | JWT 解析 + 在线验证 |
| `index.js` | `DuckClient`（v2.2 集成）、`IdentityStore/IdentityError/createIdentityStore` re-export | 见 §3.3 |

### 3.2 `data/identity.json`（示例，敏感字段已脱敏）

```json
{
  "version": 1,
  "createdAt": 1793529273063,
  "rotatedAt": 1793529273063,
  "journeyId": "dd02097e8bce23d38a7aefccf1f80d05",
  "deviceId": "f3216393-e1d8-4f21-990d-39fe8e5f5c6b",
  "deviceName": "DuckAI CPA @ <hostname>",
  "conversationId": "f3216393-e1d8-4f21-990d-39fe8e5f5c6b",
  "durableStream": {
    "version": "0.2.0",
    "publicKeyJwk": { "kty": "RSA", "n": "<…>", "e": "AQAB", "alg": "RSA-OAEP-256",
                      "ext": true, "key_ops": ["encrypt"], "use": "enc" },
    "privateKeyJwk": { "kty": "RSA", "n": "<…>", "e": "AQAB", "d": "<redacted>", "p": "<redacted>", "q": "<redacted>", "dp": "<redacted>", "dq": "<redacted>", "qi": "<redacted>" },
    "fingerprint": "22afdd3762454c53481ae4ca293a1228",
    "createdAt": 1793529273068
  },
  "sync": { "enabled": false, "userId": null, "mainKey": null, "scopedPasswordSeed": null,
            "encryptedPrivateKey": null, "pairingCode": null, "recoveryCode": null,
            "lastSyncAt": null, "devices": [] },
  "auth": { "token": null, "email": null, "tier": "free", "entitlements": [],
            "expiresAt": null, "activatedAt": null, "verified": false,
            "verifyError": null, "tokenHash": null }
}
```

- `fingerprint = sha256(SPKI DER) 前 32 hex`；`privateKeyJwk`/`token` 永不出 `getRedacted()`。
- 原子写：`identity.json.tmp-<rand>` → `rename`；`chmod 0600`（尽力而为，Windows 上可能退化为 ACL）。
- 损坏：`identity.corrupt-<ts>.json` 备份 + 重建（`getRedacted().source="recovered"`）。

### 3.3 DuckClient 集成

```js
import { createIdentityStore, DuckClient } from './src/duck/index.js';

const identityStore = await createIdentityStore({ dataDir: 'data', config: config.duck, logger });
const client = new DuckClient({ ...config.duck, identityStore });   // 或 new DuckClient(config, { identityStore })
await client.init();
```

> 与 网关后端 的对齐（v2.2 最终裁决）：HTTP 层用 `createServer({ config, store, duck, logger, identity })`
> **显式注入** identityStore（不再用 `store.identity` 隐式挂载）；`src/index.js` 同时把 identityStore 传给
> DuckClient，并把 `config.identity.durableStream` 传入构造参数。IdentityError 的 `code/status/hint/detail`
> 由 网关后端 映射为 HTTP 状态；identity store 缺失时 网关后端 返回 `503 identity_unavailable` 优雅降级。

| 行为 | 实现 |
| --- | --- |
| `x-ddg-journey-id` | `identityStore.getJourneyId()`（持久化，请求时实时读取，rotate 后自动生效） |
| `durableStream` | `{messageId: uuid/请求, conversationId: identity.conversationId, publicKey: identity.durableStream.publicKeyJwk}`；仅 `config.durableStream.enabled===true` 时发送（默认 **false**） |
| 400 自动降级 | 带 durableStream 收到 `400 ERR_BAD_REQUEST` → 进程内标记 degraded、统计 `durableStreamRejected`，去掉 durableStream 重试一次，后续不再发送 |
| `Authorization` | identity.auth.token 且未过期时 `Bearer`；过期不发并标记 `authExpired` |
| `health().identity` | `{journeyId,fingerprint,conversationId,deviceId,stable,source,authTier,authenticated,authExpired,syncEnabled,durableStreamEnabled,durableStreamDegraded,volatile}` |
| `health().durableStream` | `{configured,enabled,degraded,rejectedCount}` |
| `recentErrors[]` | 每条带 `identityFingerprint` / `identityJourneyId` |
| 未注入 identity | 旧行为：进程随机 journeyId、不发 durableStream/Authorization，`health().identity.volatile=true`（warn 日志提示漂移） |

### 3.4 durableStream 的匿名档行为（重要，含实测冲突说明）

- 验收执行者 2026-11-02 实测：匿名 public 档发送 `durableStream:{messageId,conversationId,publicKey(RSA-OAEP-256 JWK)}`
  → **400 ERR_BAD_REQUEST**（两次），因此约定 `enabled` 默认 **false**。
- 本机 2026-11-02 实测（本实现形状：`publicKey` = 带 `alg/ext/key_ops/use` 的 JWK、`conversationId` = 持久化值、
  `messageId` = 每请求 uuid）：**携带 durableStream 的 chat 第一次即 200**（内容「鸭子」），且 journey id/指纹与
  此前不携带时完全一致（见 §4.3）。
- 推测差异：验收执行者 的请求可能使用了不同的 `publicKey` 形态（例如 base64url SPKI 而非 JWK）、或 `conversationId`
  未持久化/为空、或当时处于额度软限流窗口。**结论**：
  1) `durableStream` 属于增强项，匿名档并非必然拒绝，但存在环境/形状差异；
  2) 保持默认 **false** + 400 自动降级作为安全策略（配置可显式开启）；
  3) 待 验收执行者 复核后可考虑把默认值改为 true（本实现已支持）。
- 身份稳定性不依赖 durableStream 是否被接受：journey id + RSA 指纹已经持久化，durableStream 只是
  上游侧「会话关联」的增强。

---

## 4. 实测证据（2026-11-02，本机真实上游）

### 4.1 稳定身份

```
identity: {
  journeyId: "dd02097e8bce23d38a7aefccf1f80d05",
  conversationId: "f3216393-e1d8-4f21-990d-39fe8e5f5c6b",
  fingerprint: "22afdd3762454c53481ae4ca293a1228",
  stableAcrossInstances: true,
  file: { path: ".../data/identity.json", bytes: 3131 }
}
# 两次独立进程运行（重新加载同一 identity.json）journeyId/fingerprint 完全相同 → 不漂移
```

### 4.2 不携带 durableStream 的 chat

```
chat(no durableStream) -> OK: "稳定"
```

### 4.3 携带 durableStream 的 chat（本实现形状）

```
chat(durableStream) -> OK: "鸭子"
requests: [{
  journeyId: "dd02097e8bce23d38a7aefccf1f80d05",
  authorization: false,
  durableStream: true,
  durableStreamPublicKeyAlg: "RSA-OAEP-256",
  conversationId: "f3216393-e1d8-4f21-990d-39fe8e5f5c6b"
}]
durableStream state: { configured:true, enabled:true, degraded:false, rejectedCount:0 }
```

即：**带 durableStream 的请求被接受（200）**，且复用了持久化 journey id 与同一 conversationId。
自动降级逻辑未被触发（degraded=false）。

### 4.4 订阅 / sync

- 匿名 `GET /duckchat/v1/auth/token` → `200 {}`；伪造 Bearer 同样 `{}`；`/auth/authorize`、`/auth/callback` 无参 → 400（验收执行者 实测，与源码一致）。
- `duckduckgo.com` 在本当前环境不可达（`fetch failed`，验收执行者 实测）→ `detectSyncTransport()` 返回
  `{status:"blocked", reason:"network: fetch failed"}`，`pair()` 抛 `503 sync_transport_unavailable`，
  本地状态不变；`/admin/api/sync` 应展示 `transport:"blocked"` + 原因。

---

## 5. 本地自测（无网络）

`data/tmp/identity-tests.mjs`：**23/23 通过**，覆盖：

- JWE：5 段、空 `encrypted_key`、header 精确、round-trip、篡改检测、错误密钥、kid 不匹配；
- identity：首启生成/重载稳定/损坏备份恢复/rotate/export-import/reveal；
- sync：enableSync 生成 32B mainKey、JWE 可解密、恢复码 >2048 字符仍可往返、跨身份导入还原 mainKey、
  disableSync、v2 配对码 build/parse/URL/错误枚举/v1/recovery/transport blocked 503 不破坏状态；
- auth：JWT 解析（email/tier/exp/api）、Bearer 前缀、62 字符 v1 token、过期 422、在线 verify（mock）；
- DuckClient：journeyId 来自 identity、body.durableStream 形状、Authorization 仅有效 token、
  400 自动降级、volatile 兜底、recentErrors.identityFingerprint。

真实上游验证脚本：`data/tmp/verify-identity-live.mjs`（本次运行结果见 §4；生成 `data/tmp/identity-live.json`）。

---

## 6. 未决 / 风险

1. **durableStream 匿名档行为存在实测冲突**（§3.4）：本实现 200、验收执行者 侧 400。已实现默认关闭 + 自动降级；
   建议用同一 identity 文件与配置再复测两次后决定默认值。
2. **订阅 token 只能粘贴真实 token**：匿名无法获取；`verify` 依赖 `GET /duckchat/v1/status` + `/capabilities`
   带 `Authorization`（本机未用真实 token 验证过 HTTP 200，逻辑已 mock 验证）。
3. **Sync 真实传输未实现**：sandbox 不可达 duckduckgo.com；`pair()` 在 transport 可用时返回 501
   `sync_handshake_unimplemented`（明确错误而非假成功），跨实例迁移请用 identity export/import 或本地恢复码。
4. **durable stream 恢复流**（`sync.duckduckgo.com/sync/ai_chat_streams/<messageId>`，JWE stream_parts）
   未实现；`durableStream` 仅用于上游身份关联，不做断线续传。
5. `privateKeyJwk`/`token` 仅落盘；若运维导出了 `data/identity.json` 需按密钥对待（0600 / 加密盘）。
