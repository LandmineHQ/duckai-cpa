# Sync 设备注册实现说明（v2.8，`src/duck/sync-client.js`）

> 目标：让手机 DuckDuckGo「Sync & Backup → My Devices」里出现本机（`DuckCPA@xxxx`）。
> 协议由 验收执行者 用真实账号验证（代理 10808）；本文记录实现、真实响应形状、接口契约、自测与风险。
>
> 与 pairing 的关系：`PairingHost` 的 joiner 完成会拿到**官方恢复码**；本模块用它登录 Sync 账号并注册设备。
> `src/duck/pairing.js` 由 验收执行者 在真实手机联调中继续修改（不回声 hello、改发 exchange init），与本模块无硬依赖。

---

## 1. 协议（真实服务核对）

Base：`https://sync.duckduckgo.com/sync`（必须走代理出网）

1. 官方恢复码：`base64url(JSON({recovery:{user_id,secret}}))`。
2. 派生：
   ```
   secretBytes    = base64urlDecode(secret)
   scopedPassword = HKDF-SHA256(ikm=secretBytes, salt=UTF8(userId), info="Main Key", 32)   // Buffer
   hashedPassword = base64url(HKDF-SHA256(ikm=secretBytes, salt=UTF8(userId), info="Password", 32))
   ```
3. `POST {base}/login`
   ```json
   { "user_id": "...", "hashed_password": "<base64url>", "device_id": "<uuid>",
     "device_name": "<JWE compact dir/A256GCM kid=3party, plaintext=name>",
     "device_type": "<JWE ... plaintext=browser>",
     "scope": "ai_chats" }
   ```
   → `200 {"token": "<jwt>"}`（token 约 732 字符；也兼容响应字段 `jwt`）。
4. `GET {base}/keys`（`Authorization: Bearer <token>`）
   → **数组** `[{kid,purpose,encrypted_with,encrypted_private_key,public_key(JWK)}]`（不是 `{keys:...}` 包装；真实账号同一 kid 有 `ddg` 与 `3party` 两条）。
   - `3party` 的 `encrypted_private_key` 是 **5 段 compact JWE**（header kid=`3party`）；`ddg` 的是 1 段不透明串。
   - 私钥 JWE 的明文是 **PKCS#8 DER 字节**（不是 JWK JSON）→ 用 `decryptJwe(compact, scopedPassword, {kid:'3party'})` 得 Buffer 后 `createPrivateKey({format:'der',type:'pkcs8'})`。用 `decryptJweToString` 会把二进制当 UTF-8 破坏。
5. account_info 缺失时创建（3072-bit）：
   - RSA 3072，`kid=uuid`；`encrypted_private_key = encryptJwe(privateKeyDer(Buffer), scopedPassword, {kid:'3party'})`；
   - `POST {base}/keys/purpose/account_info/set-if-absent` body：
     `{"key":{"kid":"<uuid>","purpose":"account_info","encrypted_with":"3party","encrypted_private_key":"<5 段>","public_key":<JWK>}}`
   - 再 `GET /keys` 确认；并发下可能被其他设备抢先（set-if-absent 语义）。
6. 设备 info 信封（phone 可解）：
   `createEnvelope(JSON.stringify({name,type}), account_info.public_key, {kid:account_info.kid, typ:"device"})`
   （RSA-OAEP-256 + A256GCM；AAD=header）。
7. `PATCH {base}/devices`（Bearer）body `{"updates":[{"id":"<deviceId>","info":"<envelope.payload>"}]}` → 200。
   **真实服务限制（v2.9 实测）**：
   - 每次 PATCH **只接受 1 个 update**（多条 → 400 `updates must contain exactly one entry`）；
   - token 只能 PATCH **它 login 时的 device_id**（否则 401/403 `forbidden_device`）。
   因此「注册多台设备」= 每台各自 `login(deviceId)` → PATCH 自己（不是一次 login 多 updates）。
   账号**没有 5 台上限**：实测账号已有 5 台时注册第 6/7 台成功。
8. `GET {base}/devices`（Bearer）真实形状：
   ```json
   { "devices": {
       "entries":    [{ "id": "...", "jwt_iat": "...", "name": "<密文>", "type": "<密文>" }],
       "entries_v2": [{ "credential_id": "3party", "id": "...", "info": "<设备 info 信封>" }]
   } }
   ```
   → 解析时优先 `entries_v2`（`info` 可解密），并用 `entries` 补 `jwt_iat/name/type`。
9. `POST {base}/logout-device`（Bearer）body `{"device_id":"<uuid>"}` → 200；**会立即失效当前 token**
   （之后任何请求 401 `invalid_login_credentials`，需重新 login）。

---

## 2. `src/duck/sync-client.js` 接口

```js
import {
  SyncClient, SyncClientError, createSyncClient,
  deriveSyncKeys, credentialsFromRecoveryCode, defaultDeviceName,
  createPairingAutoRegister, parseOfficialRecoveryCode,
  DEFAULT_SYNC_BASE_URL, DEFAULT_DEVICE_TYPE, DEFAULT_MAIN_DEVICE_NAME
} from './src/duck/sync-client.js';
```

### 2.1 创建
```js
const client = await createSyncClient({
  proxyManager,                 // 优先；所有请求走 proxyManager.fetch（真实 10808 联调）
  fetchImpl,                    // 或注入 fetch（mock 测试）
  logger,
  baseUrl: 'https://sync.duckduckgo.com/sync',
  officialRecoveryCode,         // 由 网关后端 从 data/pairing.json 传入；不自动读文件
  deviceId,                     // 稳定 identity.deviceId（uuid）
  deviceName,                   // 缺省 defaultDeviceName() = DuckCPA@<4hex>
  deviceType: 'browser',
  timeoutMs: 30000
});
```
`createSyncClient` 不发网络、不自动登录。

### 2.2 方法
| 方法 | 说明 |
| --- | --- |
| `login({recoveryCode?, userId?, secret?, deviceId?, deviceName?, deviceType?})` | HKDF + JWE + POST /login → `{ok,userId,token,jwt,deviceId,deviceName,deviceType,loginAt}`；无码抛 `recovery_code_not_configured` |
| `getKeys()` | GET /keys → 数组（真实返回数组） |
| `findAccountInfoKey(keys?)` | 选 `purpose=account_info` 且 `encrypted_with=3party`、私钥可用 scopedPassword 解开的候选 → `{kid, publicKeyJwk, encryptedWith, record}` 或 null |
| `ensureAccountInfoKey()` | 缺失时创建 3072-bit RSA + DER-JWE + set-if-absent，返回 `{kid, publicKeyJwk}` |
| `registerDevice({deviceId?, name?, type?})` | 单台便捷封装（= `registerDevices([...])` 一条）：`{ok,id,name,type,credential_id:'3party',info,devices,registeredAt}` |
| `registerDevices(items)` | **v2.9 批量**：`items=[{deviceId,name?/deviceName?,type?}]`（1–50）。每台用自己的 `deviceId` **单独 login** 后 PATCH（服务限制见 §1）；共享一次 account_info keys 查询/缓存。→ `{ok:true,items:[{ok,id,name,type,credential_id,info,registeredAt}],devices}`；失败抛 `SyncClientError`（带 `partial`） |
| `listDevices()` | 解析 `{devices:{entries_v2,entries}}` → `[{id,credential_id,info,jwt_iat?,name?,type?}]` |
| `listDevicesDetailed()` | **v2.9**：用 account_info 私钥（PKCS#8 DER）解密每条 info → `[{id,credential_id,jwt_iat,name,type,current,decoded,decryptable}]`；解密失败 `name/type=null,decoded=false`，**不返回 info/JWE 原文** |
| `logoutDevice(deviceId)` | POST /logout-device `{device_id}` → `{ok,removed,httpStatus}`（token 随后失效） |
| `logoutDevices(ids)` | **v2.9 批量**：每个 id 一次 POST；token 失效后自动用内存凭据重新 login；404 视为成功但**不计入 `removed`** → `{ok,removed:[],failed:[{id,code,status,httpStatus}],results:[{id,ok,removed,httpStatus?,code?}]}` |
| `getStatus()`（同步） | `{loggedIn,userId,deviceId,deviceName,deviceType,tokenPresent,lastLoginAt,lastRegisteredAt,lastError,baseUrl}` |
| `close()` | 清空内存 token/scopedPassword/credentials |

### 2.3 设备名（v2.9）
- 普通身份默认 `DuckCPA@<4 位小写 hex>`：`defaultDeviceName()`（`crypto.randomBytes(2).toString('hex')`），如 `DuckCPA@xxxx`。
- **默认身份 `id_default` 默认 `DuckAI@main`**：新增导出 `DEFAULT_MAIN_DEVICE_NAME = 'DuckAI@main'`。
- 自定义：`createSyncClient({deviceName})` / `login({deviceName})` / `registerDevice({name})` / `registerDevices([{deviceName}])`；持久化由 网关后端 调 `identity.setDeviceName()`（1–100 字符）或 `pool.update(id,{deviceName})`。
- identity-pool：`generate/create` 自动给每个身份写 `identity.deviceName`（默认身份 `DuckAI@main`，其他 `DuckCPA@<4hex>`），启动时迁移旧默认名；详见 §7。
- `deviceId` 固定用 `identity.deviceId`（稳定 uuid）；`type` 默认 `browser`。

### 2.4 错误
`SyncClientError {status, code, hint?, detail?, httpStatus?}`：
`sync_transport_unavailable`(503)、`sync_unauthorized`(401)、`sync_login_failed`(502)、
`sync_register_failed`(502)、`sync_not_logged_in`(409)、`sync_account_info_unavailable`(502)、
`sync_logout_failed`(502)、`invalid_device`(400)、`recovery_code_not_configured`(400)、`invalid_recovery_code`(400)。

### 2.5 pairing 自动注册
```js
const autoRegister = createPairingAutoRegister({
  syncClient, deviceId: identity.deviceId, deviceName: identity.getDeviceName(),
  type: 'browser',
  onRegistered: async (result) => identity.setSyncServer(result)
});
const host = await createPairingHost({ ..., onCompleted: autoRegister });
// 之后：const result = await autoRegister.pending; // 也可为 null（host/same_account）
```
仅当 `status.completedAs==='joiner' && status.recoveryCode` 时触发 login+registerDevice；
返回函数带 `.pending` Promise（可 await）；错误同时写 `getStatus().lastError`，不会抛进 pairing 回调。
注册成功结果：`{ok,userId,deviceId,deviceName,deviceType,registeredAt,lastLoginAt,device}`。

---

## 3. `IdentityStore` 新增持久化（网关后端 使用）

- `async setDeviceName(name)`：1–100 字符，trim 后写 `identity.deviceName` 并原子落盘（`_mutate`）。
- `getDeviceName()`：读取当前设备名（IdentityStore 与 MemoryIdentityStore 都实现）。
- `async setSyncServer(server)`：合并写 `identity.sync.server = {userId,deviceId,deviceName,registeredAt,lastLoginAt}`；
  `server=null` 清空；未知字段忽略，非法字段 `IdentityError{status:400, code:'invalid_identity'}`；不破坏 v2.2 其他字段。
- `identity-pool` 的 identity summary 含 `deviceName`（v2.9 命名规则见 §7）。

---

## 4. 自测

### 4.1 mock（`data/tmp/sync-client-tests.mjs`，**13/13**）
本地 mock Sync 服务逐字段校验（并按真实服务限制强制「PATCH 仅 1 条 update + 设备级 token」）：
1. HKDF 与 Node `crypto.hkdfSync` 独立复算一致（scopedPassword 32B / hashedPassword base64url）；
2. 默认设备名 `DuckCPA@[0-9a-f]{4}`；`DEFAULT_MAIN_DEVICE_NAME='DuckAI@main'`；
3. login：mock 解 JWE 得 name/type、校验 hashed_password/scope/device_id，返回 token；
4. 无恢复码 → `recovery_code_not_configured`；错误密码 → 401 `sync_unauthorized`；
5. account_info 缺失时创建：3072-bit、PKCS#8 DER、JWE kid=3party、set-if-absent body 正确，PATCH info 可被私钥解出 `{name,type}`；
6. 已有 account_info 时复用；未登录/非法 deviceId/超长 name 报错；
7. listDevices 解析 `entries_v2`；logout 200 与 404 容忍；
8. `createPairingAutoRegister` 仅在 joiner+recoveryCode 时注册，`onRegistered` 回调正确；
9. 网络不可达 → `sync_transport_unavailable`；
10. `setDeviceName`/`setSyncServer` 持久化 + reload 后仍存在；非法值 400；
11. **v2.9 `registerDevices`**：2 台设备 → 每台一次 login（设备级 PATCH）+ 每台一次单条 PATCH，info 全部可解；
12. **v2.9 `listDevicesDetailed`**：解密出 `Android 手机`/`Chrome` 可读名，坏 info → `name/type=null, decoded:false`，无 JWE 泄漏；
13. **v2.9 `logoutDevices`**：每个 id 一次 POST（token 失效自动重登）、404 不计入 `removed`、`results.length===ids.length`。

### 4.2 真实联调（代理 10808，用户真实账号）

**v2.8 单设备**（`data/tmp/verify-sync-live.mjs` / `sync-live.json`）：
用户 `489adc11-…`；本机 deviceId `ad9c87a3-…`；设备名 `DuckCPA@xxxx`。

| 步骤 | 真实结果 |
| --- | --- |
| `login()`（HKDF/JWE） | ✅ 200，token ~732 字符 |
| `GET /keys` | ✅ 4 条：account_info(ddg/3party)、ai_chats(ddg/3party) |
| `registerDevice()` → `PATCH /devices` | ✅ 200，返回 device id = 本机 deviceId，name=`DuckCPA@xxxx` |
| `GET /devices` | ✅ 共 5 台，含本机 id，`credential_id:"3party"`，`hasInfo:true` |
| 用 account_info 私钥解密服务端 `info` | ✅ `{"name":"DuckCPA@xxxx","type":"browser"}`（证明手机端可解密显示） |
| `logoutDevice()` | ✅ 200 `removed:true`；**token 立即失效**（后续 401），重新 login 可继续 |
| 重新 login 后 `GET /devices` | ⚠️ 本机 id 仍在列表（服务端删除传播/刷新延迟；logout 为 best-effort） |

**v2.9 多设备 + 解密列表 + 批量注销**（`data/tmp/verify-sync-multidevice-live.mjs` / `sync-multidevice-live.json`）：
账号已有 5 台（Android 手机、Chrome 156.0.0.0、Edge 156.0.0.0、旧 id_default、孤儿 ad9c…）。

| 步骤 | 真实结果 |
| --- | --- |
| `registerDevices([{main,'DuckAI@main'},{extra,'DuckCPA@xxxx'}])` | ✅ 两台均注册成功（**第 6/7 台**，无 5 台上限）；每台各自 login → 单条 PATCH |
| `listDevicesDetailed()` | ✅ total 6；`decoded:true` 名称：`Android 手机`、`Chrome 156.0.0.0`、`Edge 156.0.0.0`、`DuckAI@main`、`DuckCPA@xxxx`；1 台旧 ddg 凭据无法解密（name/type=null）；`leaksJwe:false` |
| `logoutDevices([main,extra])` | ✅ `ok:true`、removed 2，token 失效后自动重登 |
| `current` 标记 | ✅ `listDevicesDetailed` 中最后注册的设备为 current |

结论：真实账号上 **登录 / 多设备注册 / 解密名称（含手机 Android 手机/Chrome）/ 批量注销** 全部达成；
`forbidden_device` 是「用错的 token PATCH 非本机设备」，不是设备上限（本次实测第 6/7 台成功）。
设备名默认 `DuckAI@main`（默认身份）与 `DuckCPA@<4hex>`（普通身份）按要求生效。

---

## 5. 风险与限制

1. **token 仅存内存**：不写 identity.json（避免泄漏）；进程重启需重新 login（网关后端 可在需要时懒登录）。
2. **官方恢复码是账号级敏感凭证**：`officialRecoveryCode` 在 `data/pairing.json`（0600），导出/日志必须脱敏；
   `scopedPassword`/`hashedPassword` 不得落盘。
3. **account_info 私钥格式**：必须使用 PKCS#8 DER 的 Buffer 加密（bundle `L0`），不要用 JWK JSON 或 latin1 字符串，
   否则手机无法导入私钥（我们已按 bundle 实现并用真实账号 key 解出 DER 验证）。
4. **`forbidden_device` ≠ 设备上限**：真实服务要求 PATCH 的 device_id == 当前 login 的 device_id；`registerDevices`
   已按设备逐个 login 处理。**不要**把 403 forbidden_device 直接映射为「设备数上限」（实测第 6/7 台可注册）。
   Admin 若需防御性上限，请以 `GET /devices` 数量自行判断，而非依赖该错误。
5. **logout-device** 会失效当前 token；从列表移除的传播有延迟（重新 login 后仍可能短暂列出，best-effort）；
   批量注销时客户端会自动重登，但不要在注销后立即依赖“已移除”做业务判断。
6. **注册会真实出现在用户手机 My Devices**：调用方（Admin API）应明确由用户操作触发。
7. **未验证**：手机端“移除本机”后服务端 devices 的最终一致性；若 account_info 不存在时我们创建的 3072-bit key，
   官方 App 的实际解密显示（mock 已按 DER/JWE 校验，无手机端回归）。
8. `GET /keys` 真实返回数组而非 `{keys:...}`；`GET /devices` 是 `{devices:{entries,entries_v2}}`；客户端已兼容。
9. 批量注册会为每台设备各发一次 login + PATCH（2N 个请求）：N 较大时注意 418/429 限流（真实同步服务当前未触发）与耗时。

---

## 6. v2.9 每身份设备名（identity-pool）

| 规则 | 行为 |
| --- | --- |
| 默认身份 `id_default` | `identity.deviceName = **DuckAI@main**`（首次生成/迁移时；自定义名保留） |
| 其他身份（`create`/`generate`） | `DuckCPA@<4hex>`（随机、池内尽量不重复、持久化到该身份记录；`create({deviceName})` 可自定义） |
| 启动迁移 | 已有池：`id_default` 的空/旧默认名（`DuckAI CPA @ …` 或自动 `DuckCPA@xxxx`）→ `DuckAI@main`；其他身份空/旧默认名 → `DuckCPA@<4hex>`；一次持久化 |
| 自定义 | `pool.update(id, {deviceName})`（1–100 字符）/ `pool.setDeviceName(id,name)`；`identity.setDeviceName(name)` |
| 读取 | `pool.getDeviceName(id)`；`pool.list()/get()` summary 的 `deviceName`；`pool.getDefaultIdentityId()`（`id_default` 或 activeId） |
| 校验 | 空/超 100 → `PoolError{400, code:'invalid_identity', field:'deviceName'}`（`IdentityError` 同义） |

真实联调：`id_default` 以 `DuckAI@main` 注册、新身份以 `DuckCPA@xxxx` 注册，手机端 `listDevicesDetailed` 均可读。

---

## 7. 复跑命令

```powershell
node data/tmp/sync-client-tests.mjs            # mock 13/13（含 v2.9 批量/解密/注销）
node data/tmp/pool-device-names-tests.mjs      # 身份池设备名 7/7
node data/tmp/verify-sync-live.mjs             # v2.8 真实单设备（代理 10808 + data/pairing.json 官方码）
node data/tmp/verify-sync-multidevice-live.mjs # v2.9 真实双设备 + 解密列表 + 批量注销
node --check src/duck/sync-client.js
```
