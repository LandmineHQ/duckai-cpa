# 扫码配对实现说明（v2.5，`src/duck/pairing.js`）

> 契约：`docs/IDENTITY-SYNC.md` §1/§4（Sync & Backup 配对码）与本次验证（）描述。
> 背景：用户实测「扫二维码后 DuckDuckGo 客户端提示**绑定失败**」。根因不是二维码编码，而是
> **只生成了本地 `code2`，没有向 DuckDuckGo Sync 交换服务注册频道、也没有参与 host 握手**——
> 手机扫码后会去 host 频道发 hello，而那个频道根本不存在，必然失败。

---

## 1. 协议（已按 bundle + 真实服务核对）

| 项 | 内容 |
| --- | --- |
| Sync 服务 base | `https://sync.duckduckgo.com/sync`（需代理出网；本机 10808 已验证可达） |
| 创建频道 | `PUT {base}/v2/exchange/<channelId>` → **204**（channelId 为 UUIDv4） |
| 读消息 | `GET {base}/v2/exchange/<channelId>/messages?after=<seq>` → `{messages:[{seq,version,payload}]}`（`seq` 从 1 连续递增；也兼容 `{seq,envelope:{version,payload}}`） |
| 写消息 | `POST {base}/v2/exchange/<channelId>/messages` → body `{"messages":[{"version":"2","payload":"…"}]}`（1–5 条）→ **204** |
| 信封 | `payload = [header, encKey, iv, ciphertext, tag].join('.')`；`header=base64url(JSON{alg:"RSA-OAEP-256",enc:"A256GCM",typ,kid,iat})`；AES-256-GCM（iv 12B / tag 16B / **AAD=header 的 base64url 字符串 UTF-8**）；`encKey=RSA-OAEP-256(peerPublicKey, raw AES key)`；ct/tag 各自 base64url |
| 二维码 | `https://duckduckgo.com/sync/pairing/#&code2=base64url({version:"2",channel_id,public_key:base64url(SPKI)})` |
| 握手 | scanner 自建频道 → 向 host 频道 POST 加密 `{type:"hello",channel_id,public_key,version:"2"}` → host 解密校验 → 向 scanner 频道回 `hello` → 进入 exchange（`recovery_code_request/available/…/response`）→ `completed` |
| 结束原因（bundle 枚举） | `completed / same_account / aborted / denied / unavailable / timeout / network / read_channel_lost / write_channel_lost / version_mismatch / sequence_gap / protocol_violation / peer_key_changed / self_scan / incompatible_code / malformed_code / account_join_failed` |

---

## 2. 实现（`src/duck/pairing.js`）

### 2.1 导出

```js
import {
  PairingHost, PairingError, createPairingHost,
  createEnvelope, decryptEnvelope, encryptPayload, decryptPayload,
  generateHostKeyPair, importPublicKeyBase64Url, parsePairingUrl,
  PAIRING_STATES, PAIRING_ERROR_CODES, DEFAULT_PAIRING_OPTIONS, SYNC_BASE_URL
} from './src/duck/pairing.js';
```

- `generateHostKeyPair()` → `{ publicKey(KeyObject), privateKey(KeyObject), publicKeyBase64Url }`（RSA-OAEP 2048）
- `createEnvelope(plaintext, peerPublicKey, {kid,typ})` / `decryptEnvelope(envelope, privateKey)`
  （`peerPublicKey` 支持 base64url SPKI / JWK / KeyObject；envelope 支持 `{version,payload}` 或裸 payload）
- `parsePairingUrl(urlOrCode)` → `{version,channel_id,public_key}`（非法码抛 `PairingError`）
- `createPairingHost(options)` = `new PairingHost(options)` + `await start()`

### 2.2 `PairingHost` 选项

```js
createPairingHost({
  proxyManager,            // 优先：所有请求走 proxyManager.fetch（真实联调 10808）
  fetchImpl,               // 或注入 fetch（mock 测试）
  logger,
  syncBase = 'https://sync.duckduckgo.com/sync',
  pollIntervalMs = 1000,
  idleTimeoutMs = 30000,   // 无活动 → timeout
  timeoutMs = 300000,      // 会话硬超时
  httpTimeoutMs = 30000,
  autoPoll = true,         // false 时用 pollOnce() 手动驱动（测试）
  account = null,          // { getRecoveryCode(): string|null, userId?, recoveryCode? } —— exchange 阶段使用
  onStateChange?, onCompleted?
})
```

### 2.3 方法与状态机

- `start()` → `{channelId, pairingCode, url, qrUrl, publicKeyBase64Url, createdAt, expiresAt, syncBase}`；
  内部 `PUT` 建频道，失败抛 `PairingError`（404 → `write_channel_lost`，其他 → `network`）。
- `status()` → `{state, substate, channelId, peerChannelId, peerPublicKey, peerName, peerKind, peerUserId, lastSeq, messages:[{dir,type,at,seq?,httpStatus?}], endReason, endDetail, completedAs, recoveryCode, recoveryUserId, recoveryCodeReceived, accountConflict, httpStatus, startedAt, expiresAt, expiresInMs, qrUrl, pairingCode, accountAvailable, syncBase}`
  - `recoveryCode` 是 joiner 收到的**原始官方 DuckDuckGo 恢复码**（敏感，仅 admin API；`onCompleted` 同样带此字段）。
  - `substate`：`null | 'joiner_awaiting' | 'awaiting_confirmation'`（`exchange` 阶段的细分，便于 UI 显示「等待手机确认/等待恢复码」）。
- 状态：`idle → waiting → hello → exchange → completed | failed | timeout`（失败原因在 `endReason`）。
- `pollOnce()`（手动单次轮询）、`waitForPeer({timeoutMs})`（等到 peer 出现）、`stop(reason='aborted')` / `close()`。
- 轮询：默认 1s；`seq` 必须严格 `lastSeq+1`（否则 `sequence_gap` 终止）；404 → `read_channel_lost`；
  30s 无活动 → `timeout`（idle）；5min 硬超时 → `timeout`（max_session）。
- hello 处理：校验 `channel_id/public_key/version`；自己扫自己 → `self_scan`；重复 hello 且 key 变化 → `peer_key_changed`；
  正常 → 记录 peer、回 hello、`state=exchange`。
- **exchange 状态机（v2.5.1 修复）**：
  - `recovery_code_request`（对方无账号、向 host 要码）：host 有官方恢复码（`account.getRecoveryCode()` /
    `account.recoveryCode`，或 `account.userId + account.secret` 现场编码）→ 回 `recovery_code_response` →
    `completed, completedAs="host"`；没有 → 回 `recovery_code_unavailable` → `failed/unavailable`
    （实现 `createAccount` 不在本轮范围）。
  - `recovery_code_available`（对方有账号）：
    - 同 `user_id` → `completed, endReason="same_account", completedAs="host"`；
    - 否则（本地无账号，或本地账号不同）→ **不回复**，`substate="joiner_awaiting"`，等待对方（leader）发
      `recovery_code_response`；本地账号不同时 `accountConflict=true`（网关后端 决定是否覆盖既有官方码）。
      **修复点**：v2.5 在这里错误回了 `recovery_code_unavailable`，导致真实手机「绑定失败」。
  - `recovery_code_response`（joiner 路径）：解析 `recovery_code` = base64/base64url(JSON
    `{recovery:{user_id,secret}}`)（也容忍裸 JSON 与顶层 `{user_id,secret}`）→ 保存原始码 →
    `state=completed, endReason="completed", completedAs="joiner"`，并通过 `onCompleted` 上抛
    `recoveryCode`/`recoveryUserId`/`peer*`。
  - `recovery_code_awaiting_confirmation` → `substate="awaiting_confirmation"`（不回复）；
    `confirmed` → `completed`；`denied` → `failed/denied`；`unavailable` → `failed/unavailable`；
    未知 type → 回 `protocol_error` → failed/protocol_violation。
- 生成/解析官方恢复码：`encodeOfficialRecoveryCode({userId,secret,format:'base64url'|'base64'})`、
  `parseOfficialRecoveryCode(code)`（返回 `{userId,secret,raw}` 或 `null`）。
- **`onCompleted(payload)` 契约**：`{...status(), completedAs, recoveryCode, recoveryUserId, peerUserId, peerName, peerKind, accountConflict, endReason, state, channelId, peerChannelId}`；
  `completedAs ∈ {host, joiner}`，joiner 时 `recoveryCode` 为官方恢复码原文（网关后端 用于落盘）。
- 错误码（`PairingError.code`）：`network`、`read_channel_lost`、`write_channel_lost`、`version_mismatch`、
  `protocol_violation`、`peer_key_changed`、`sequence_gap`、`self_scan`、`timeout`、`unavailable`、`aborted`、`invalid_argument`。

---

## 3. 真实联调（2026-11-02，代理 `127.0.0.1:10808` → `sync.duckduckgo.com`）

脚本：`data/tmp/verify-pairing-live.mjs`，原始记录 `data/tmp/pairing-live.json`。
方式：host = 本实现；**scanner = 本地模拟客户端**（同一线协议：自建频道 + RSA 密钥对 + 信封加密）。

| 步骤 | 真实结果 |
| --- | --- |
| `host.start()` → `PUT /v2/exchange/cb556297-…` | ✅ **204**，channel 创建成功 |
| `GET …/cb556297-…/messages?after=0`（空轮询） | ✅ 200，空列表，state=waiting |
| scanner `PUT /v2/exchange/3f245c79-…`（自建频道） | ✅ 204 |
| scanner `POST /v2/exchange/cb556297-…/messages`（hello 信封 1189 字节） | ✅ 204，seq=1 |
| host `pollOnce()` | ✅ 解密 hello，`state=exchange`，peer=3f245c79-… |
| host 回 hello → `POST …/3f245c79-…/messages` | ✅ 204；scanner GET 解密成功，`channel_id=host` |
| scanner `POST recovery_code_request`（634 字节） | ✅ 204，seq=2 |
| host `pollOnce()` | ✅ 回 `recovery_code_response`，`state=completed`、`completedAs="host"`、`lastSeq=2` |
| scanner GET | ✅ 解密得到 `recovery_code_response`（内容为注入的测试恢复码） |

最终 `requests` 5 条（PUT 204 / POST 204 / GET 200 / POST 204 / GET 200），全程经代理；**真实 Sync 交换服务接受本实现的频道与信封格式**。
消息日志：`in:hello → out:hello → in:recovery_code_request → out:recovery_code_response`。

> 未能验证：真实 DuckDuckGo 手机 App 扫码后的**完整账号加入**（需要手机端与真实 DDG 账号）。见 §4。

### 3.1 v2.5.1 修复验证：joiner 流程（真实 Sync 服务，代理 10808）

脚本 `data/tmp/verify-pairing-live-joiner.mjs`，结果 `data/tmp/pairing-live-joiner.json`。scanner 用与手机相同的线协议模拟。

**Flow A（手机有账号 → host 无账号，即用户遇到的失败场景）**：

| 步骤 | 真实结果 |
| --- | --- |
| host `start()` | ✅ 频道 `6dafcc37-8f9f-4ca9-b10b-c4f370c11c67`，state=waiting |
| scanner PUT 自建频道 | ✅ 204 |
| scanner hello → host poll | ✅ 204 / host state=exchange，seq=1 |
| scanner `recovery_code_available`（Android 手机 / ddg / user_id） | ✅ 204；host `state=exchange, substate=joiner_awaiting`，**不回任何消息**（scanner 新消息数 = 0） |
| scanner `recovery_code_response`（官方码 base64url） | ✅ 204；host `state=completed, completedAs="joiner", endReason="completed"`，`recoveryCodeReceived=true`、`recoveryUserId` 与手机 user_id 一致，`onCompleted` 收到 `recoveryCode` 原文 |
| 消息日志 | `in:hello → out:hello → in:recovery_code_available → in:recovery_code_response`（无 out:unavailable） |

**Flow B（手机无账号 → host 有官方码）**：频道 `a604c51f-…`；scanner `recovery_code_request` → host 回
`recovery_code_response` → `state=completed, completedAs="host"`；scanner 解密校验恢复码 `user_id` 匹配 ✅。

结论：v2.5 的失败根因（`recovery_code_available` 被回 `unavailable`）已修复；真实 Sync 频道上 joiner 路径可完成并把官方恢复码交给 网关后端 落盘。

---

## 4. 限制与未完成部分（如实说明，不虚报）

1. **官方 App 的账号加入分支已覆盖，但账号数据合并不在网关侧完成**：
   - 手机**无账号** → `recovery_code_request`：host 未配置官方恢复码时回 `recovery_code_unavailable`
     （仍会「绑定失败」，属预期；实现 DDG `createAccount` 不在本轮范围）；配置了官方码 → 手机可加入 host 账号。
   - 手机**有账号** → `recovery_code_available`：v2.5.1 起 host **进入 joiner 等待**，收到 leader 的
     `recovery_code_response` 后解析并保存官方恢复码，`completedAs="joiner"`、`endReason="completed"`；
     网关不执行 DDG 的 `account.joinAccount/exitAccount`（不碰用户账号数据）。
   - 本地已有**不同**账号时：仍进入 joiner，但 `accountConflict=true`，由 网关后端 决定是否覆盖本地官方码。
   - 同 `user_id` → `same_account`（completed）。`awaiting_confirmation → confirmed/denied` 已处理。
2. **duckai-cpa 的本地 `recoveryCode`（v2.2 扩展格式）不是官方 DuckDuckGo 恢复码**；`account.recoveryCode`
   必须是官方码（`base64url(JSON({recovery:{user_id,secret}}))`）或 `account.userId+account.secret`
   （我们现场编码）。**不要**把 `identity.sync.recoveryCode` 直接传给手机。
3. **pairing 成功后不自动写 `identity.sync`**（mainKey/加密私钥语义与官方账号不同）；官方恢复码由 网关后端
   写入 `data/pairing.json` 的 `officialRecoveryCode`，供后续 Sync 能力使用。
4. 官方 App 扫码的 UI 文案、二维码刷新/过期行为未在本当前环境验证（无手机端）；但我们已用同一线协议的
   模拟 scanner 完成真实服务端到端（含 hello/available/response/completed）。

### UI 建议（管理后台/网关后端）

- **二维码只在 `host.start()` 成功（频道已注册）后展示**；对话框打开期间保持轮询（1s），关闭时调用 `stop()`。
- 状态文案：`waiting`「等待手机扫码…」；`hello/exchange`「手机已连接，正在配对…」；
  `exchange + substate=joiner_awaiting`「手机已有账号，正在接收恢复码…」；
  `exchange + substate=awaiting_confirmation`「等待手机确认…」；
  `completed`（`completedAs=joiner`）「配对完成（已接收手机恢复码）」；
  `failed/timeout` 显示 `endReason` 并给「重试」（重新 start 生成新频道）。
- **实验性标注**（推荐）：二维码下方标注
  「实验性：已完成频道注册与设备握手；完整 DuckDuckGo 账号同步需提供真实恢复码/后续迭代」。
  未配置真实恢复码时，手机端仍可能提示绑定失败——这是协议限制，不是二维码/网络问题。
- 会话有效期：无活动 30s、硬超时 5min；建议对话框显示倒计时并在超时后自动隐藏二维码。
- **Admin API 契约（v2.5 最终版，网关后端 实现；webapp 按此对接，避免两版契约）**：
  - 进程内单例 `pairingSession = { host: PairingHost | null }`，同一时刻只允许一个 host 会话。
  - `POST /admin/api/sync/pairing`（admin token）
    - 已有活动会话（state ∉ {completed,failed,timeout}）→ `409 {"error":{"code":"pairing_in_progress",...}}`（或先 `stop()` 再重启，二选一并固定）。
    - 内部：`createPairingHost({ proxyManager, logger, account: resolvePairingAccount(config), onCompleted })`；
      `resolvePairingAccount`：`config.sync?.pairing?.recoveryCode`（运维手填**真实 DuckDuckGo 恢复码**）存在则 `{recoveryCode}`；
      `config.sync?.pairing?.userId` 存在则附带 `userId`；否则 `null`。
    - 成功 → `200 {"ok":true,"pairing":{channelId,url,qrUrl,expiresAt,state,accountAvailable}}`。
    - `start()` 抛 `PairingError`：`network` → `503 {"error":{"code":"sync_transport_unavailable","hint":"enable the proxy..."}}`；
      `write_channel_lost`/其他 → `502 {"error":{"code":"pairing_start_failed","reason":...}}`。
  - `GET /admin/api/sync/pairing` → `200 {"pairing": host.status()}`；无会话 → `{"pairing":null}`（或 `state:"idle"`，二选一并固定）。
    **前端唯一数据源字段**：`state`（`waiting|hello|exchange|completed|failed|timeout`）、`substate`
    （`null|joiner_awaiting|awaiting_confirmation`）、`channelId`、`peerChannelId`、`peerName`、`peerKind`、
    `lastSeq`、`messages:[{dir,type,at,seq?,httpStatus?}]`（无 payload）、`endReason`、`endDetail`、
    `completedAs`（`host|joiner|null`）、`recoveryCodeReceived`、`recoveryUserId`、`accountConflict`、
    `startedAt`、`expiresAt`、`expiresInMs`、`qrUrl`、`accountAvailable`。
    **`recoveryCode` 原文仅通过 `onCompleted` 回调给后端落盘**（GET 接口建议不返回原文，或仅 admin 可见；
    前端只需要 `recoveryCodeReceived` 布尔）。
  - `DELETE /admin/api/sync/pairing` → `host.stop()`，返回 `{"ok":true,"pairing": status}`（无会话 → `{"ok":true,"pairing":null}`）。
  - 前端只读 `pairing.accountAvailable` 判断是否显示「需真实恢复码」提示，**不要**读 config。
  - `account.getRecoveryCode()` 来自 config 的**真实 DuckDuckGo 恢复码**，**不要**默认使用本地 identity recovery code（格式不兼容）。

---

## 5. 自测

`data/tmp/pairing-tests.mjs`（本地 mock Sync 服务）**17/17 通过**：

1. 信封跨 RSA 密钥对 round-trip、篡改/错 key/版本不匹配检测；
2. `parsePairingUrl` 与 `buildPairingCode` 往返；
3. `start()`：PUT 204、GET 空、状态 waiting、QR URL 形状；
4. hello 全流程：解密 → 回 hello → scanner 解密验证 → recovery_code_request/response → completed（含消息日志顺序）；
5. 无 account → `recovery_code_unavailable` + failed/unavailable；
6. `recovery_code_available` + 同 userId → completed/same_account；
7. **joiner（v2.5.1 修复）**：available 后 **不回复**、`state=exchange/substate=joiner_awaiting`；
   收到 response 后 `completed/completedAs=joiner/recoveryCode 原文 + recoveryUserId`，
   `onCompleted` 顶层含 `recoveryCode`；消息日志无 `out:unavailable`；
8. **joiner + 本地不同账号** → 等待且 `accountConflict=true`，response 后 completed(joiner)；
9. **request + account（userId/secret）** → host 现场编码官方码并回 response，完成 host 分支；
10. `awaiting_confirmation → confirmed` completed；`denied` → failed/denied；
11. `encodeOfficialRecoveryCode/parseOfficialRecoveryCode`（base64/base64url/裸 JSON）；
12. `sequence_gap`、`read_channel_lost`(404)、`write_channel_lost`(回复 404)；
13. `self_scan`、`version_mismatch`、未知消息 → `protocol_error` + protocol_violation；
14. 硬超时 / `waitForPeer` 超时；
15. `status()` 快照不可变、`waitForPeer` 在 hello 时 resolve。

真实联调脚本：`data/tmp/verify-pairing-live.mjs`（host 分支）与 `verify-pairing-live-joiner.mjs`
（joiner + host 双分支，真实 `sync.duckduckgo.com`，经 10808 代理）均通过（见 §3/§3.1）。

`node --check src/duck/pairing.js` 通过。

---

## 6. 与现有模块关系

- `sync.js` 的 `buildPairingCode/parsePairingCode` 继续负责 **code2 编解码**；`pairing.js` 在此基础上增加
  **频道注册 + 握手 + 信封**，是「让二维码真正能被连接」的缺失部分。
- `identity.js` / `identity-pool.js` 的 `pair()` 仍返回语义化错误（`sync_transport_unavailable` 503 /
  `sync_handshake_unimplemented` 501）；本次验证未改动它们。若网关后端要接「身份页配对」，
  优先使用 `PairingHost`（host 角色），而不是 v2.2 的 `identityStore.pair()`（它没有 host 轮询）。
- 依赖：无新增；Node `crypto`（RSA-OAEP/AES-GCM）+ 现有 `undici`/代理层。

---

## 9. 修复：host 必须在 hello 之后发送首条 exchange 消息（deadlock）

真实手机失败日志（验收执行者 抓取，`GET /admin/api/sync/pairing`）：

```
in:hello → out:hello → in:recovery_code_available → (无任何出站) → timeout/idle
```

原因：Duck.ai 真实实现在完成 hello 后会立刻发送自己的首条 exchange 消息（`Is()`）：
- 无账号 → `recovery_code_request`（请求对端给码）
- 有账号 → `recovery_code_available`（告知对端自己的 user_id）

旧实现只回 hello、不主动发首条消息，手机（leader）没有可响应的对象 → 手机显示「已连接，正在交换密钥…」后 sync failed。

修复（`src/duck/pairing.js`）：
- **不回 hello**：Duck.ai 的 presenter（二维码展示方）收到 hello 后**直接发首条 exchange 消息**；回 hello 会让官方 App 以 protocol_violation 中止（实测手机停在「已连接，正在交换密钥…」）；
- `_handleHello()` 收到 hello 后调用 `_sendExchangeInit()`：无官方码 → `recovery_code_request{name,kind:"3party"}`；有官方码 → `recovery_code_available{...,user_id}`；
- `_handleRecoveryCodeAvailable()` 在尚无本地账号且未发过首条消息时补发 `recovery_code_request`（兜底）；
- `account.getRecoveryCode()` 允许 async（PairingStore 异步读取），避免 unhandled rejection；
- 收到手机 `recovery_code_response` → 解析官方码 → `completed(joiner)` → 官方码落盘（网关后端 `onCompleted`）。

验证（验收执行者，模拟手机走真实 Sync 服务）：hello → 收 host hello+request → 回 response → `completed/joiner`，官方码 configured=true；全量 `npm test` 250/250。
## 10. v2.7：手机确认流程（confirmed 后必须重新请求）

真实手机在用户点「确认」后的消息序列：

```
in:hello
out:recovery_code_request          # presenter 首条 exchange 消息
in:recovery_code_available
in:recovery_code_awaiting_confirmation
in:recovery_code_confirmed         # 用户点了确认，但这里还没有恢复码
out:recovery_code_request          # 必须再请求一次
in:recovery_code_response          # 手机这时才发官方恢复码
out:recovery_code_confirmed        # joiner 收到后回 ack（可选但更稳）
```

关键点：
1. `recovery_code_confirmed` **不是**完成信号，只是「用户已同意」；把这里当 completed 会导致「显示成功、其实没拿到码」，账号未加入，手机 My Devices 也不会出现该设备。
2. 收到 `recovery_code_confirmed` 且尚未拿到码时：重新发送 `recovery_code_request`（实现内最多 3 次）。
3. 收到 `recovery_code_response` 后：保存官方码 → `completed(joiner)` → 回发 `recovery_code_confirmed` ack。
4. presenter 不回应 `hello`；收到 hello 直接发首条 exchange 消息。

验证：模拟真实手机（真实 Sync 服务 + 代理 10808）完整序列 → `completed/joiner`、官方码落盘、ack 发出；`npm test` 250/250。

### 补充（v2.8）：手机确认后会删除自己的频道

真实手机在用户点确认后：先发 `recovery_code_confirmed`，随后**删除自己的频道**（不再监听），但会把 `recovery_code_response` 发到 host 频道（in-flight 消息）。

因此 host 在 `confirmed` 后的 advisory `recovery_code_request` 会收到 **404 write_channel_lost**。旧实现立即 abort → 前端显示配对失败，虽然手机端已成功。

修复：
- `_requestRecoveryCode()` 改用 **soft send**：404/网络错误只记录、不终止；
- 继续轮询 host 频道，读取 in-flight 的 `recovery_code_response` → 保存官方码 → completed(joiner)；
- ack `recovery_code_confirmed` 同样 soft send（404 忽略）。

复现验证：模拟手机 confirmed → DELETE 自己频道 → 发 response → host 记录 `out:recovery_code_request:404(soft)` 后成功读到 response → completed/joiner、官方码落盘；`npm test` 250/250。
