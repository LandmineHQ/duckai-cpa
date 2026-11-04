# duckai-cpa v2 / v2.1 / v2.2 / v2.3 / v2.4 / v2.5 / v2.8 / v2.9 / v2.10 / v2.11 / v2.12 验收报告（QA）

> 维护者：qa-verifier（task-8 / task-11 / task-15 / task-19 / task-23 / task-27）。契约唯一来源：**`docs/ADMIN_API_V2.md`**（v2 + v2.1 增量）、
> **`docs/IDENTITY-SYNC.md`**（v2.2 身份/Sync/订阅）、**`docs/PROXY.md`**（v2.3 代理）、**`docs/IDENTITY-POOL.md`**（v2.4 身份池/
> 二维码/上下文）、**`docs/PAIRING-IMPL.md`**（v2.5 扫码配对握手实现）、`docs/IDENTITY-POOL-IMPL.md`（v2.5 会话并发实现）与
> **`docs/SYNC-DEVICES.md`**（v2.8 Sync 设备注册/设备名，duck-protocol）。
> 结论来自：`tests/`（node:test + mock DuckClient/代理/Sync 服务 + mock Sync 设备 API + jsdom 构建产物，**343 项**）、`scripts/smoke.js`（黑盒冒烟，强制 API Key）、
> `scripts/build-check.mjs`（React 构建产物完整性 + 版本文案）、`scripts/page-check.mjs`（React 页面 + Admin API 契约）、
> `scripts/proxy-live-check.mjs`（v2.3 本机代理真实联调）、`scripts/live-check.mjs` / `scripts/sdk-check.mjs`（真实上游，需额度窗口）。
>
> 更新时间：2026-11-02（v2.8：Sync 设备注册（HKDF/JWE/login/account_info/keys/devices）+ 设备名 + 轮换二次确认）。**v1 的验收报告与断言已全部作废/重写**。

---

## 1. 结论摘要

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 单元 + mock 集成（`npm test`，v2–v2.12 契约） | ✅ **343 / 343 PASS**（exit 0） | §3 / §4 |
| 冒烟 `smoke.js --mock --search`（强制 API Key + 搜索注解） | ✅ **9 / 9 PASS**（exit 0） | §5.2 |
| 冒烟 `smoke.js --no-upstream --api-key --admin-token`（对运行中 v2 网关） | ✅ **4 PASS / 4 SKIP**（exit 0） | §5.3 |
| React 构建产物 `build-check.mjs`（… v2.11 compact+恢复码 / **v2.12 触发语义+摘要折叠块**） | ✅ **16 / 16 PASS**（exit 0） | §5.4 |
| React 后台 + Admin API `page-check.mjs`（… v2.11 compact+恢复码 / **v2.12 压缩能力+summary 编辑/清除**） | ✅ **22 / 22 PASS**（exit 0） | §5.5 |
| v2.1 重新生成（retry）与 reasoningEncrypted | ✅ **7 / 7 新用例 PASS** | §4.7 |
| v2.2 身份 / JWE / Sync / 订阅 | ✅ **32 / 32 新用例 PASS** | §4.8 |
| v2.3 代理（ProxyManager / Admin / DuckClient / sync transport） | ✅ **22 / 22 新用例 PASS** | §4.13 |
| v2.4 身份池 / 路由 / 每身份队列 / 上下文守卫 / 二维码 | ✅ **31 / 31 新用例 PASS** | §4.18 |
| v2.5 会话并发（后端+jsdom 前端）/ 扫码配对握手 / joiner / 冲突策略 / Admin/官方恢复码 | ✅ **28 / 28 新用例 PASS** | §4.23 |
| v2.8 Sync 设备注册（HKDF/JWE/account_info/PATCH devices）/ 设备名 / 轮换二次确认 | ✅ **29 / 29 新用例 PASS** | §4.28 |
| v2.9 每身份设备名 / 设备槽拖拽+PUT 增量注册注销 / 默认身份保护 / 多设备批量 | ✅ **11 / 11 新用例 PASS** | §4.31 |
| v2.10 设备槽删除/禁用保护 + force + 孤儿自愈 + 独立设备列表卡 | ✅ **6 / 6 新用例 PASS** | §4.34 |
| v2.11 compact（协议层/自动/手动/失败回退/limit 重试/summary 持久化+重启）/ 模型上下文能力 / 官方恢复码明文查看+下载+二维码 | ✅ **26 / 26 新用例 PASS** | §4.37 |
| v2.12 compact 触发语义（白名单/gpt-6-luna 不压缩/pair/char 兜底/activation/标记解析）+ 后端 pendingCompaction/LIMIT 压缩重试/summary PATCH-DELETE + 摘要折叠块前端 | ✅ **22 / 22 新用例 PASS** | §4.41 |
| 本机代理真实联调（HTTP + SOCKS5，127.0.0.1:10808） | ✅ **11 / 11 PASS**（exitIp=70.39.202.155，sync transport available） | §5.6 |
| v2.4 真实身份池联调（2 身份 × 2 会话真实消息） | ✅ **2 个身份各 1 条真实 200**（经 10808 代理，内容「分身/分身1」，日志 identityId 正确） | §5.7 / §6.7 |
| v2.5 真实联调（2 身份并行真实消息 + 配对真实 start） | ✅ 身份路由/并行可测（含一次双 200；复跑遇上游 429 限额）；**配对 start 200（channelId/waiting）** 经 10808；官方恢复码端点 200 | §5.8 / §6.8 |
| v2.11 真实联调（恢复码明文/下载一致 + 模型能力 + compact 额度受限） | ✅ 恢复码 GET 200/len=191/source=pairing、download 一致；模型能力 200；compact **BLOCKED**（上游 rate limited） | §5.13 / §6.12 |
| v2.10 真实联调（slots 内身份 DELETE 409 → force 删除） | ✅ **409 identity_in_device_slots → force 200 removedDevice**、slots 无残留；默认身份 force 409 | §5.12 / §6.11 |
| v2.9 真实联调（device-slots 双设备注册 → 注销） | ✅ **GET/PUT 200**：默认 `DuckAI@main` + 分身 `DuckCPA@70e7` 注册、serverDevices 解密 HONOR/DuckCPA、PUT 注销成功（10808） | §5.11 / §6.10 |
| v2.8 真实联调（真实官方恢复码 → 注册设备） | ✅ **register-device 200**（userId=489adc11…）、`server-devices` total=5 含本机 `DuckCPA@498a` current；DELETE 当前 400（经 10808） | §5.10 / §6.9 |
| OpenAI 官方 SDK × v2 网关（mock 上游） | ✅ **4 / 4 PASS** | §6.4 |
| 真实上游端到端（经网关） | ⚠️ **部分实测 / 仍受额度 429 限制**：v2.2 durableStream 200（§6.5）、v2.3 代理解锁（§6.6）、v2.4 身份池（§6.7）、v2.5 身份路由+配对（§6.8）；其余文本/搜索/图片/SDK 受共享出口额度影响 | §6 |
| OpenAI 官方 SDK 真实兼容（v2 强制 key） | ⚠️ **BLOCKED**（同上，冷却后执行） | §6.4 |
| ADMIN_API_V2 §8 验收补充（v2.1 共 9 条） | ✅ 8 条 mock 独立通过；第 7 条真实上游交互项 BLOCKED | §7.2 |
| IDENTITY-SYNC §5 验收标准（v2.2 共 9 条） | ✅ 8 条通过；1 条（真实订阅 token）BLOCKED | §7.3 |
| PROXY §5 验收标准（v2.3 共 6 条） | ✅ 6 条通过（含真实 10808 联调） | §7.4 |
| IDENTITY-POOL §8 验收标准（v2.4 共 8 条） | ✅ 8 条通过 | §7.5 |
| v2.5 并发/配对验收（Lead 任务口径 4 组） | ✅ 4 组通过（后端并发、前端 jsdom 并发、配对模块/Admin、脚本与真实联调） | §7.6 |

**QA 结论：v2–v2.12 mock/集成层可交付（343/343 全绿，脚本 9/9 · 16/16 · 22/22，真实代理 11/11，真实配对 start 200，真实设备注册 200，真实 device-slots 双设备注册/注销 200，真实删除保护 409/force 200，真实恢复码明文/下载一致，v2.12 真实 compact 上游 418 BLOCKED）；真实上游配额与官方 App 完整账号数据同步仍为已知边界。**

---

## 2. 环境与运行方式

- Node.js 24.12.0（ESM）；运行时依赖 jsdom + undici（ProxyAgent/Agent）+ socks；前端为 Vite + React + Tailwind（devDependencies）。
- 平台：Windows + DSH 沙箱（workspace-write；网络仅 `duck.ai` / `127.0.0.1`）。
- **沙箱注意**：默认 `node --test` 会 spawn 子进程（stdio 管道）报 `spawn EPERM`，`package.json` 已使用
  `node --test --test-isolation=none "tests/*.test.js"`；PowerShell 中避免 `node ... | ...`（管道被拒）。
- 命令（在 `duckai-cpa/` 下）：

```powershell
npm test                                   # 343 项 v2–v2.12 单测 + mock 集成（无网络）
node scripts/smoke.js --mock               # 离线全链路冒烟（含强制 API Key/admin token）
node scripts/build-check.mjs [--build]     # React 构建产物完整性（--build 先跑 npm run build:web）
node scripts/smoke.js --no-upstream --base-url http://127.0.0.1:8787 --api-key <key> --admin-token <token>
node scripts/page-check.mjs --base-url http://127.0.0.1:8787 --admin-token <token>
node scripts/proxy-live-check.mjs --base-url http://127.0.0.1:8787 --admin-token <token> --with-proxy   # v2.3 真实代理联调
node scripts/live-check.mjs --interval 12000            # 真实上游直连（需额度）
node scripts/sdk-check.mjs --base-url http://127.0.0.1:8787 --api-key <key>   # 真实 SDK（需额度）
```

**v2 强制 API Key**：`/v1/*` 必须 `Authorization: Bearer <apiKey>`；首次启动 `src/index.js` 自动创建 `default`
key（打印一次并写入 `data/keys.json`），也可在后台 API Key 页创建。测试中固定使用 `config.auth.apiKeys`
或 `store.createKey()`。

---

## 3. 测试矩阵（v2–v2.12，343 项）

| 文件 | 覆盖点 | 用例数 | 结果 |
| --- | --- | --- | --- |
| `tests/auth.test.js` | 强制 API Key（无/错 key 401、静态 key/managed key 200）；admin API 仅 adminToken（API key 不可替代、?token= 仅 GET）；`auth.required` 已删除；公开路由 | 7 | ✅ |
| `tests/queue.test.js` | RPS FIFO 队列：默认 rps=1 下 3 并发串行、inFlight≤1、开始间隔≥1000ms、queueWaitMs 递增；PUT config 实时生效（并发提升）；queueLimit→429 queue_full；queueTimeoutMs→429 queue_timeout（Retry-After）；失败请求同样入队/记日志 | 5 | ✅ |
| `tests/logs-split.test.js` | upstream/admin 日志分离、字段、分页；分别清空互不影响；`stats.upstream`/`stats.admin` 拆分且旧扁平字段删除；限流记录 rateLimited | 4 | ✅ |
| `tests/paid-models.test.js` | `/v1/models` 免费/付费字段（paid/tier/available/requires_subscription/display_name/supported_reasoning_efforts/tools）；默认付费模型 403 `model_requires_subscription` 且不触达上游；`allowPaidModels=true` 放行；`ERR_ACCOUNT_LIMIT`→403 `upstream_subscription_required` | 6 | ✅ |
| `tests/sessions.test.js` | sessions CRUD（201/列表 messageCount/详情/PATCH/DELETE/404）；连续 3 轮服务端拼接历史 + SSE session/delta/done；SSE reasoning/search/image；自动标题 30 字符；首事件前失败→HTTP JSON + 错误 assistant 消息；流中失败→error 事件无 done；重启持久化；100 会话淘汰；200 消息上限（400 session_message_limit）；旧 `POST /admin/api/test`→404；**v2.1 retry：末轮/中间轮截断、429 错误消息重试、404/409/400 错误分支、409 session_busy、SSE retryOf/retriedFrom、首事件前 JSON 与流中 error；reasoningEncrypted 持久化与 GET/SSE 透出** | 17 | ✅ |
| `tests/strict-protocol.test.js` | DuckClient 严格中断：非 SSE content-type / 缺滚动挑战头 / JSON 解析失败 / 未知 role / 缺 `[DONE]` → `upstream_protocol_mismatch`(502)+abort；图片缺失→`upstream_no_image`(502)；server 映射 502/403 content_filter/429 anomaly/403 subscription；流中错误只发 error 且无完成事件；首事件前失败 HTTP JSON | 13 | ✅ |
| `tests/duck-client.test.js` | DuckClient 契约：init/health/catalog、chat 会话头/请求体、滚动挑战复用、webSearch→sources、imageGeneration 只取 success、418 传输层重试（成功/耗尽→anomaly）、429 retryAfter、400 system 降级；**v2.2：注入 identityStore → chat body 含 durableStream（messageId 随机/conversationId 稳定/publicKey RSA-OAEP-256）、journeyId 来自 identity；未注入时降级不发 durableStream；v2.3：注入 proxyManager → 所有上游请求经 proxyManager.fetch（计数≥3）、health().proxy 透出；未注入时 direct/disabled** | 14 | ✅ |
| `tests/challenge.test.js` | 挑战求解器（真实抓包 fixture）：解码→jsdom→SHA-256→payload 结构、UA 一致性、滚动/invalidate、无挑战/5xx/429/超时/异常分支 | 14 | ✅ |
| `tests/sse.test.js` | SSE 行解析/分块/CRLF；伪事件；text/tool-invocation/citations/source/ui-component/error；严格模式 unknown 帧；consumeSSE | 12 | ✅ |
| `tests/admin-api.test.js` | overview（service/queue/stats 拆分/models/recent 拆分）；config 脱敏/深合并/live/restartRequired/ignored/reset；keys 生命周期 201+preview+吊销；models/health；404/405；旧 test 404 | 6 | ✅ |
| `tests/openai-chat.test.js` | v1 接口行为（强制 key）：非流/流结构、别名/默认模型、reasoning_effort、system 合并、web_search 注解、image_generation b64、首事件前/流中错误、错误映射、请求校验、citation 过滤 | 17 | ✅ |
| `tests/openai-responses.test.js` | Responses 非流/流、instructions、reasoning、web_search 注解、image output item、官方事件序列+sequence_number、annotation 事件、首事件前/流中错误 | 10 | ✅ |
| `tests/openai-images.test.js` | b64_json/url、n、校验、工具关闭、无图/限流错误 | 6 | ✅ |
| `tests/openai-models.test.js` | `/v1/models` list/单模型/duck- 前缀/别名解析、405/404/非法 JSON、healthz、CORS | 6 | ✅ |
| `tests/identity-store.test.js` | **v2.2 稳定身份 store**：同 dataDir 两次创建 → journeyId/deviceId/指纹一致；getRaw 私钥+公钥 RSA-OAEP-256+`fingerprint=sha256(SPKI)前32hex`；getFileInfo/原子写无 tmp 残留；损坏 identity.json → `identity.corrupt-*.json` 备份重建；getRedacted 不含私钥 | 5 | ✅ |
| `tests/identity.test.js` | **v2.2 Admin identity**：GET 字段完整/stable/source=file；**默认 durableStream.enabled=true**；重启后 journeyId/deviceId/指纹不变；rotate journey/device/all + rotatedAt（非法 scope→400 invalid_identity）；export（含私钥附件）→ import 新 dataDir 身份一致；损坏重建；reveal 需 confirm（限制字段）；identity/subscription 响应不泄漏 token/私钥 | 8 | ✅ |
| `tests/jwe.test.js` | **v2.2 JWE**：generateKey32=32B；compact 5 段、encrypted_key 为空、protected=dir/A256GCM/kid=streams；round-trip；错误 key 失败；可加密真实 RSA 私钥 JWK | 4 | ✅ |
| `tests/sync.test.js` | **v2.2 Sync**：配对码 build→`{version:"2",channel_id,public_key}`→parse→URL；错误枚举；v1/recovery 识别；createRecoveryCode→decodeRecoveryCode round-trip；transport blocked；enable 生成 recoveryCode/状态持久、disable 保留身份；pairing-code + pair blocked 503+hint 且不破坏状态；recovery 跨 identity 还原同一 mainKey；未启用 GET recoveryCode=null；**v2.3：mock 代理可用 → transport available → pair 501 sync_handshake_unimplemented** | 10 | ✅ |
| `tests/subscription.test.js` | **v2.2 订阅**：entitlementsToTier plus/pro/free；parseSubscriptionToken 合法/非法（AuthError）；activate → email/tier=plus/expiresAt；过期→422 token_expired；非法→422 token_invalid；DELETE→free；verify 返回 verified；pro 档；不泄漏 token | 7 | ✅ |
| `tests/proxy-manager.test.js` | **v2.3 ProxyManager**：默认 direct/脱敏（无 password）；update 校验（type/port/host/noProxy/testUrl/ipCheckUrl → 400 invalid_proxy + field）；密码语义（省略不变/''清除/非空设置，hasAuth=username‖password）；noProxy 精确/`*.suffix`/后缀；dispatcher（http/https→ProxyAgent，socks4/5→Agent，direct→undefined）；进程内 mock HTTP CONNECT/SOCKS5 代理端到端（getFetch 成功、test() exitIp）；代理不可达 ok:false+code+lastError；noProxy 命中绕过（fetch 与 test 均直连、bypassNoProxy）；test() 非法 overrides 不抛（ok:false+invalidField）；update 立即生效 | 11 | ✅ |
| `tests/proxy-api.test.js` | **v2.3 Admin 代理**：GET 默认 direct/字段/无 password；PUT 深合并、9 类非法值 400 invalid_proxy 且不改配置；密码语义与不回显；POST /proxy/test 成功（mock 代理→exitIp/status/latency）与失败（不可达→ok:false+code+lastError）、非法 overrides（统一 200+ok:false+invalidField，契约 §3.3）、直连；healthz.proxy；未注入 → 502/503 proxy_unavailable | 9 | ✅ |
| `tests/identity-pool.test.js` | **v2.4 IdentityPool**：迁移 identity.json→id_default（原文件保留）；generate 3 身份 journeyId/deviceId/指纹唯一+列表脱敏；create/update/activate/rotate/exportIdentity→importIdentity 往返；删除被绑定/active→409 identity_in_use、force 清理绑定；bindings 持久化+重启不变+解绑；hash 公式精确（固定 salt）与跨重启一致；付费模型无 subscribed→403 model_requires_subscription、有→只路由 subscribed；每身份队列 rps=1 串行/异身份并行、queueLimit→429 queue_full、queueTimeoutMs→429 queue_timeout、queueStats/peakInFlight | 9 | ✅ |
| `tests/identity-pool-api.test.js` | **v2.4 identities Admin**：pool 摘要（total/enabled/subscribed/bindingCount/maxIdentities，无 salt）+ items 脱敏；generate/create/detail/PATCH/activate/rotate/export；DELETE 409 `?force=true` 清理绑定；bindings 分页 limit/offset + 手工绑定/解绑；routing/router 策略切换与非法值 400；subscription POST 绑定/DELETE 解除（422 token_invalid）；会话 identityId/identityLabel；healthz.identityPool；overview.identities；未注入 503 identity_pool_unavailable | 7 | ✅ |
| `tests/identity-routing.test.js` | **v2.4 路由集成**：`X-Session-Id` 相同多次→同一 identityId（upstream 日志/绑定验证）；不同 session 各自绑定；无 header 不写绑定；重启后同 session 映射不变；付费模型无订阅→403、绑定订阅身份后 200 且走该身份；测试会话（sess_xxx）创建即绑定 identityId/identityLabel | 4 | ✅ |
| `tests/context-guard.test.js` | **v2.4 上下文守卫**：发送前 maxMessages/maxInputChars 裁剪 → `context_trimmed:true`；`conversation_limit_reached` trim 模式自动激进裁剪重试一次成功、`onLimit=error` 不重试→409；`input_limit_reached` 同理 200/413；流式裁剪 | 6 | ✅ |
| `tests/identity-qr.test.js` | **v2.4 二维码/页面**：配对 URL 经 qrcode 生成 PNG data URL（签名/稳定性）；身份页源码含 qrcode/toDataURL/img[data:image] 与配对 URL；身份池页引用 /identities 及 generate/activate/rotate/bindings/routing；侧边栏/路由「身份池」入口；构建产物含身份池/二维码/identities API/绑定路由标记 | 5 | ✅ |
| `tests/concurrency.test.js` | **v2.5 会话并发（后端）**：两测试会话绑定不同身份并行（耗时≈max、mock maxInFlight≥2、done+日志带 identityId/queueWaitMs）；同身份两会话串行（≥1000ms、maxInFlight=1、queueWaitMs≥700）；同会话并发→409 session_busy；`/v1` 不同 X-Session-Id（不同身份）并行、同身份串行 | 4 | ✅ |
| `tests/pairing.test.js` | **v2.5 配对协议（src/duck/pairing.js，mock sync 服务）**：信封 RSA-OAEP-256+A256GCM 5 段 round-trip（两对密钥/错误 key 失败/SPKI 导入）；start→PUT 204+配对码/QR URL+waiting；PUT 404→write_channel_lost；hello 轮询→校验+回 hello（scanner 可解密）；self_scan/version_mismatch/sequence_gap/GET 404→failed+endReason；waitForPeer 超时；recovery_code_request 有/无 account→completed(host)/unavailable；**joiner：recovery_code_available 不回 unavailable→等待→response 解析 {recovery:{user_id,secret}}→completed(joiner)+status/onCompleted 暴露恢复码；request+本地官方码→response(base64 JSON 正确)+completed(host)；same_account→same_account；awaiting_confirmation→confirmed→completed、denied→failed(denied)**；status/stop/重复 start | 14 | ✅ |
| `tests/pairing-joiner-api.test.js` | **v2.5 joiner 端到端 + 冲突策略（真实 PairingHost + mock Sync + PairingStore + PairingService + createServer）**：start(accountAvailable 初始值)→hello→available(不回 unavailable,substate=joiner_awaiting)→response→completed(joiner)；官方码落盘（GET configured/hasCode/length、无明文、recoveryCodeReceived/recoveryUserId、status 剥离 recoveryCode）；**已有不同码默认不覆盖 / 相同码 no-op / sync.pairing.overwriteAccount=true 覆盖** | 4 | ✅ |
| `tests/pairing-api.test.js` | **v2.5 配对 Admin（mock PairingService）**：POST/GET/DELETE `/admin/api/sync/pairing`（启动字段/无会话 null/status 脱敏）；错误映射 sync_not_enabled 400、pairing_in_progress 409、network 503 sync_transport_unavailable+hint、其它 502 pairing_start_failed；未注入 503 pairing_unavailable；官方恢复码 GET 无明文/PUT 保存/缺 code 400/DELETE 清除 | 4 | ✅ |
| `tests/web-concurrency.test.js` | **v2.5 前端并发（jsdom + 真实构建产物）**：A 慢流时 B 可发送并先完成、切换会话不中断 A、A 完成后写回 A、列表「生成中」徽章；同会话重复发送提示「该会话正在生成中」且只启动一个流；无 console 报错 | 2 | ✅ |
| `tests/sync-client.test.js` | **v2.8 Sync 协议客户端（`src/duck/sync-client.js`，mock Sync 服务）**：`deriveSyncKeys` 与 node:crypto HKDF 独立复算一致（Main Key/Password）；login 体 user_id/hashed_password/device_id/scope 正确、device_name/type 为 5 段 JWE 且 scopedPassword 可解；`ensureAccountInfoKey` 缺失创建 RSA 3072 + 私钥 PKCS#8 DER JWE(kid=3party) + set-if-absent；`registerDevice` PATCH `{updates:[{id,info}]}`，info 用 account_info 公钥加密、私钥可解 `{name,type}`，GET devices 含本机；真实嵌套形状（entries + entries_v2）归一化；logoutDevice；错误映射 401/网络/418(httpStatus)/502；`createPairingAutoRegister` 仅 joiner 注册 | 8 | ✅ |
| `tests/sync-devices.test.js` | **v2.8 Sync 设备 Admin service**：`defaultDeviceName()`=DuckCPA@<4hex>、ensure 稳定/自定义 config 生效；无官方码 400 `recovery_code_not_configured`；注册成功持久化 `identity.sync.server`（userId/deviceName/devices/registeredAt）；list current 标记；delete 当前 400、其它 logout；autoRegister 成功/失败非致命；错误映射 401/503+hint/502；IdentityStore `setDeviceName/getDeviceName/setSyncServer`（校验/合并写/清空）；**旧名 DuckAI CPA→DuckCPA@xxxx 迁移并回写 config、自定义保持；token 仅内存（identity.json 无 token/jwt、二次 register 复用 session）；无 live session 时 server-devices 命中持久化缓存不打上游；418 → 429 sync_rate_limited + Retry-After:120 + hint，cooldown 内 register/list/delete 均 429 不打上游** | 10 | ✅ |
| `tests/sync-devices-api.test.js` | **v2.8 Admin HTTP**：未注入 503 `sync_transport_unavailable`+hint；register-device 无码 400 → 成功 200 `{ok,server}`；server-devices current/total/server、脱敏；DELETE 当前 400 invalid_device、其它 200；`GET /sync` deviceName DuckCPA@xxxx 稳定 + 自定义生效；rotate `identityLost:true`+note（无法恢复）；登录网络失败 503+hint；**418 → HTTP 429 sync_rate_limited/rate_limit_error + Retry-After:120，cooldown 内 register/server-devices/delete 均 429 且不再请求上游；直连 createServer 未 bootstrap 时 GET /sync 懒迁移旧设备名** | 8 | ✅ |
| `tests/pairing-auto-register.test.js` | **v2.8 joiner 自动注册（index glue，mock）**：真实 PairingService（真实 PairingHost + mock exchange）joiner 完成后 onCompleted → `syncDevices.autoRegister()` → login+registerDevice；设备名 DuckCPA@xxxx；pairing 保持 completed | 1 | ✅ |
| `tests/web-rotate-confirm.test.js` | **v2.8 前端（jsdom + 真实构建产物）**：轮换两步确认（第 1 / 2 步 → 确认轮换（不可恢复）/身份丢失）、取消不调 rotate API、确认仅调用一次（scope=all）并显示「身份已丢失」；设备列表显示 DuckDuckGo 设备/本机标记/当前设备不可删除，删除需确认且取消不调 DELETE；无 console 报错 | 2 | ✅ |
| `tests/sync-client-multidevice.test.js` | **v2.9 sync-client 多设备**：`registerDevices` 每设备单独 login+PATCH（N 次、每次 updates=1），info 可解 `{name,type}`，返回 items/devices；`listDevicesDetailed` 解密 name/type（HONOR）、失败 null 无 info/JWE、current 标记；`logoutDevices` 每 id 一次 POST、404 不计入 removed、results 完整 | 3 | ✅ |
| `tests/device-slots.test.js` | **v2.9/v2.10 设备槽/设备名/默认保护/自愈（Admin HTTP + 真实池）**：id_default=DuckAI@main、generate=DuckCPA@xxxx、PATCH deviceName；DELETE id_default 409（force 亦拒）；GET/PUT device-slots 默认含默认身份、批量注册/注销、slots 持久化/重启、PUT 必须含默认身份(400)、非法/禁用 400、418→429、serverDevices 解密+matchedIdentityId；**v2.10：DELETE 在 slots → 409 identity_in_device_slots（hint/identityId/deviceName、状态不变）→ force 注销+清 slots+删身份+removedDevice:true；PATCH enabled:false 409 → force 注销+移除+禁用；orphans 过滤/reconcile 清理** | 9 | ✅ |
| `tests/web-device-slots.test.js` | **v2.9 前端（jsdom + 真实构建产物）**：身份池「设备名称」列 DuckAI@main/DuckCPA@b2c4、默认身份「默认 · 不可删除」且删除 disabled；设备槽两栏拖拽加入/移除、`有未保存更改`、保存 PUT payload、保存后刷新/已保存、429「DuckAI Sync 限流中，请 5 秒后重试」；无 console 报错 | 2 | ✅ |
| `tests/web-device-protection.test.js` | **v2.10 前端（jsdom + 真实构建产物）**：设备列表独立卡片 `ddg-device-list-card`（含两栏设备槽）；身份池删除在 slots 身份 → 409 弹窗「该身份正在设备列表中」+「先去设备列表移除」/「移除设备并删除（force）」；force 确认后 `DELETE ?force=true`；orphans 横幅「发现 N 个已失效身份的设备」+「清理」→ `PUT ?reconcile=true` 后消失；无 console 报错 | 3 | ✅ |
| `tests/compact.test.js` | **v2.11/v2.12 compact 协议层**：buildSummaryPrompt 关键指令/maxSummaryChars clamp；serializeMessages 跳过 reasoning/空；estimateChars/estimateTokens/shouldCompact；summarizeMessages（单条 user、reasoningEffort=none、previousSummary 增量、字段/usage）；**原生 summarizeNative 优先（不调 chat，仅白名单模型；gpt-6-luna 跳过原生 fallbackReason=compaction_unsupported_model）**、原生失败回退 chat（native:false/fallbackReason）、原生 418/429 不回退；失败映射/截断/硬截断/signal；getModelCapabilities 与 getApiModelCatalog 上下文能力 | 14 | ✅ |
| `tests/compact-session.test.js` | **v2.11 compact 后端**：未超阈值不压缩；超 triggerChars 自动压缩（done.compacted/summary、请求含摘要+最近消息、session.summary 持久化）；摘要失败回退（不标记 compacted/不落库）；手动 compact 200/幂等/404/400；ERR_CONVERSATION_LIMIT 先 compact 重试成功；`/v1` X-Session-Id 自动压缩+summary 复用+重启保留（chat-summaries.json）；`/v1/models` 与 admin models 上下文能力字段 | 7 | ✅ |
| `tests/web-compact.test.js` | **v2.11 compact 前端（jsdom 真实产物）**：模型上下文行「上下文约 16,000 字符/估算 tokens」；手动压缩按钮 loading→成功 toast；summary 徽章「已压缩 · 覆盖 3 条」展开面板/复制摘要；自动压缩提示条「上下文已压缩（覆盖 2 条消息）」+toast；无 console 报错 | 1 | ✅ |
| `tests/recovery-code-reveal.test.js` | **v2.11 官方恢复码查看/下载**：GET 返回完整 code/source/length（真实 PairingStore）；未配置 configured:false/code:null；PUT 后 source=manual；download 200 + attachment 文件名 + text/plain + no-store + code+换行；未配置 404 `recovery_code_not_configured`；无 token 401；其它 /sync 响应/错误不含完整 code | 4 | ✅ |
| `tests/web-recovery-code.test.js` | **v2.11 官方恢复码前端（jsdom 真实产物）**：完整 code 展示（official-recovery-code-full）、复制、下载（调用 download）；二维码 Modal（official-code-qr-dialog/img data:image/code 文本/复制恢复码/下载 PNG/关闭）Esc 关闭；无 console 报错（jsdom canvas stub 渲染 QR） | 1 | ✅ |
| `tests/compact-semantics.test.js` | **v2.12 duck 触发语义**：COMPACTION_MODELS 白名单（gpt-6-luna false、gpt-5.4-mini true）、claude-haiku-5-5 internal-only（internalTier 才 true）；getActivationTargetPairCount；countPairs；shouldCompact object/messages 两种签名（activation target>covered 且 <=pairs；无 activation fallback pairs>=4 且新增>=4；triggerChars 兜底）；parseCompactMarkers（URL 编码 SUMMARY_REFRESH_HINT/thresholdTokens、SUMMARY_INVALID、LIMIT_CONVERSATION、FIXED_COST_WINDOW_USAGE、非法安全） | 10 | ✅ |
| `tests/compact-v212.test.js` | **v2.12 compact 后端**：gpt-6-luna 长会话不自动压缩；gpt-5.4-mini fallback pair>=4 触发；字符兜底（trigger=chars，不支持模型仍不压缩）；SUMMARY_REFRESH_HINT→done/session pendingCompaction（正文剥离）；SUMMARY_INVALID；conversation_limit_reached 任意模型压缩重试；手动 compact gpt-6-luna（trigger=manual）；summary PATCH/DELETE（校验/清除恢复/404）；模型能力 compaction_supported/activation_target_pair_count/input_char_limit 两 API 一致 | 9 | ✅ |
| `tests/web-compact-v212.test.js` | **v2.12 摘要折叠块前端（jsdom 真实产物）**：默认折叠→头部徽章联动展开→显示全文/复制→编辑 Dialog PATCH→清除确认 DELETE（折叠块/徽章消失）；模型「不支持自动压缩」（gpt-6-luna）与「支持自动压缩」（gpt-5.4-mini）标识；无 console 报错 | 2 | ✅ |
| **合计** | | **343** | **✅ 343 / 343（exit 0）** |

测试基础设施：`tests/helpers/test-server.js`（注入 `createServer({config,store,duck,logger,webDir})`，
固定 `API_KEY`/`ADMIN_TOKEN`，支持 `cleanup:false` 供持久化测试）、`tests/helpers/mock-duck.js`
（可编排行为 + 并发/开始时间观测，供 RPS 队列断言）。

---

## 4. v2 / v2.1 / v2.2 关键能力验证（mock 层，均为独立断言）

1. **强制鉴权**：`/v1/*` 无 key/错 key→401 `authentication_error/invalid_api_key`；静态 key 与 managed key 均可用；
   `/admin/api/*` 仅 adminToken（API key 不可用；`?token=` 仅 GET 生效）；`config.auth.required` 不再返回；
   `/healthz` 与 `/admin` 公开。
2. **RPS 队列**：mock DuckClient 记录并发与开始时间——默认 `rps=1/maxConcurrent=1` 时 3 个并发请求
   `maxInFlight===1`、开始间隔 ≥850ms（实际 ~1000ms）、总耗时 ≥2s、upstream 日志 `queueWaitMs` 递增；
   `PUT config {upstream:{rps:5,maxConcurrent:3}}` 后 `maxInFlight≥2` 且开始间隔显著缩短（实时生效）；
   `queueLimit:1` 下第 3 个并发→429 `queue_full`；`rps=0.5/queueTimeoutMs=1000` 下排队请求→429 `queue_timeout`；
   两者均带 `Retry-After`。
3. **日志/统计拆分**：upstream 日志只含 `source=v1|admin-test` 的上游调用（含 `queueWaitMs/rateLimited`），
   admin 日志只含 `/admin/api/*`（含 method）；`kind=upstream|admin` 分别分页、分别清空互不影响；
   `stats.upstream`/`stats.admin` 拆分，旧顶层 `requests/errors/avgLatencyMs/byModel` 删除；
   `overview.recentUpstream/recentAdmin` 存在。
4. **免费/付费模型**：免费 6 个 `paid:false,available:true`；付费 4 个默认 `paid:true,available:false,requires_subscription:true`；
   对付费模型 chat/responses/images 请求→403 `model_requires_subscription`（`param:"model"`）且不触达上游；
   `allowPaidModels=true` 放行至 mock 上游；上游 `ERR_ACCOUNT_LIMIT`→403 `upstream_subscription_required`。
5. **会话式连接测试**：`/admin/api/test/sessions` 全量 CRUD；连续 3 轮由服务端拼接历史
   （断言传给 DuckClient 的消息数组逐轮包含历史 user/assistant 文本）；SSE 事件
   `session→delta/reasoning/search/image→done`（done 含完整 assistant 消息/latencyMs/queueWaitMs）；
   自动标题取首条用户消息前 30 字符；重启后从 `data/testsessions.json` 恢复；100 会话淘汰最旧、
   每会话 200 条上限（第 201 条 400 `session_message_limit`）；旧 `POST /admin/api/test`→404 `not_found`。
6. **严格中断**：DuckClient 对非 SSE 成功响应、缺滚动挑战头、JSON 解析失败、未知 role、缺 `[DONE]` 立即
   abort 上游并抛 502 `upstream_protocol_mismatch`；图片模式缺 success 图片→502 `upstream_no_image`；
   server 层映射 `content_filter`/`upstream_anomaly_check`/`upstream_subscription_required`；
   已开始流式后失败：chat 发 `{"error":...}`+`[DONE]`、responses 发 `response.failed`+`error`、
   session 发 `{"type":"error"}`，均**不发完成事件**；首事件前失败一律 HTTP JSON（429/502/403）。
7. **v2.1 重新生成（retry）与推理加密标记**：
   - `POST /admin/api/test/sessions/:id/messages/:messageId/retry`：
     - 重试**最后一轮** → 替换该 assistant（新 id），SSE `session.retryOf` 与 `done.message.retriedFrom` 均指向旧 id；
     - 重试**中间轮** → 截断目标 assistant 及其后全部消息（断言 GET 详情序列，如 6 条→4 条），传给上游的历史仅到目标轮 user；
     - 重试**429 错误 assistant** → 成功并清理 `error/finishReason=error`（消息替换为正常回复）；
     - 错误分支：`404 message_not_found`、`409 message_not_assistant`、`400 invalid_history`（注入 store 构造
       "assistant 前无 user" 历史）、`404 session_not_found`、并发流式时 `409 session_busy`（消息 POST 流式中重试另一条
       assistant 被拒，且原流不受影响、历史不损坏）；
     - 失败语义：首事件前失败 → HTTP JSON（429）；流中失败 → SSE `error` 且无 `done`，会话记录 error assistant。
   - `reasoningEncrypted`：上游仅给加密摘要时 assistant 消息 `reasoning=""` 且 `reasoningEncrypted=true`
     （SSE done + GET 详情均透出）；明文 reasoning 时 `reasoning` 有值且 `reasoningEncrypted=false`。
8. **v2.2 稳定身份**（`identity-store.test.js` / `identity.test.js`）：
   - 同 `dataDir` 连续两次 `createIdentityStore` → `journeyId`（32 hex）/`deviceId`（uuid v4）/
     `durableStream.fingerprint` 完全一致；**重启服务后 GET /admin/api/identity 不变**（stable:true、source:file）；
   - `publicKeyJwk` 合法 RSA-OAEP-256（kty=RSA/e=AQAB/n/alg），`fingerprint === sha256(SPKI DER) 前 32 hex`；
   - 原子写（无 `.tmp` 残留）、文件损坏 → `identity.corrupt-<ts>.json` 备份并重建；
   - `GET /admin/api/identity` 脱敏（不含 `privateKeyJwk`/token 明文）；`export` 含完整私钥（附件下载），
     `import` 到新 dataDir 后身份一致；`reveal` 无 `confirm:true` 拒绝且限制字段；
   - `rotate` journey/device/all 生效并更新 `rotatedAt`；非法 scope → 400 `invalid_identity`；
   - `durableStream` 额外含运行态 `configured/enabled/degraded/rejectedCount`（来自 DuckClient.health；
     **默认配置 `identity.durableStream.enabled=true`**（Lead 裁决），纯 identity 注入场景字段可缺省）。
9. **v2.2 JWE（A256GCM/dir）**：`generateKey32()` 32B；`encryptJwe` → compact 5 段、
   `encrypted_key` 为空、protected=`{"alg":"dir","enc":"A256GCM","kid":"streams"}`；
   `decryptJwe` round-trip（含真实 RSA 私钥 JWK 大对象），错误 key 解密失败。
10. **v2.2 Sync & Backup**：
    - 配对码 `buildPairingCode` → `{code,url,payload:{version:"2",channel_id,public_key}}`，
      URL 前缀 `https://duckduckgo.com/sync/pairing/#&code2=`；`parsePairingCode` 支持 code/完整 URL、
      v1（`type:"v1-pairing"`）/recovery 识别、错误枚举（`PAIRING_ERRORS`/`PAIRING_ERROR_SET` + URL/空值 detail）；
    - `createRecoveryCode → decodeRecoveryCode` round-trip（mainKey/scopedPasswordSeed/encryptedPrivateKey 还原）；
    - `POST /sync/enable` 返回一次性 recoveryCode，状态持久（recoveryCode.present/preview、本机 device 标记）；
      `disable` 清空 sync 但 durableStream 指纹不变；未启用时 `GET /sync/recovery-code` → 200 `{recoveryCode:null}`；
    - `transport: blocked`（沙箱探测 duckduckgo.com 失败）时 `POST /sync/pair` → **503 `sync_transport_unavailable` + hint**，
      本地状态与 device 数不变；非法配对码在探测前 → 400 `invalid_pairing_code`；
    - 恢复码导入**另一个 identity 目录**后 `mainKey` 与源一致（AC5）；非法恢复码 400 `invalid_recovery_code`。
11. **v2.2 DuckDuckGo 订阅**：伪造三段 JWT（payload 可解析）→ activate 解析 `email/tier=plus/expiresAt`，
    `verified` 在线校验失败也不 500（200 + verified:false + verifyError）；过期 → **422 `token_expired`**、
    格式非法 → **422 `token_invalid`**；DELETE → free；GET 字段齐全（authenticated/tier/entitlements/expiresAt/
    activatedAt/verified/allowPaidModels）；pro 档解析；activate/identity 响应不泄漏 token 明文；
    **`verified` 语义为 `verifyScope:"reachability"`**（= token 本地解析通过 + 上游可达；duck.ai 匿名 `/status`
    不校验 Bearer），响应含 `verifyNote` 说明，`identity.auth.verifyScope` 同样为 reachability。
12. **v2.2 请求集成回归**：注入 identityStore 后 chat body 含
    `durableStream:{messageId(每请求随机 uuid),conversationId(稳定 uuid),publicKey(RSA-OAEP-256 JWK)}`，
    `x-ddg-journey-id` 来自 identity；`health().identity.stable=true`；`health().durableStream` 含
    `configured/enabled/degraded/rejectedCount`（显式开启时 configured/enabled=true、degraded=false）；
    未注入时降级（不发 durableStream，stable=false/source=volatile）。
13. **v2.2 rotate 校验**：合法 scope `journey|device|all`；非法 scope → **400 `invalid_identity`**
    （交给 identityStore 校验，与契约错误集一致）。
14. **v2.3 ProxyManager**（`proxy-manager.test.js`）：默认 `enabled:false` → `mode:"direct"`、无 dispatcher；
    `update()` 校验**原始 patch**（type∈http|https|socks4|socks5、port 整数 1–65535、host 合法 DNS/IP/`[IPv6]`、
    noProxy 字符串数组 ≤50、testUrl/ipCheckUrl http(s)）→ `ProxyError{status:400,code:"invalid_proxy",field}`；
    密码语义：省略=不变、`""`=清除、非空=设置，`getRedacted()` 仅 `hasAuth`（= username‖password）永不回显；
    `noProxy` 精确/`*.suffix`/hostname 后缀匹配；http/https → undici `ProxyAgent`，socks4/5 → `Agent` + 自定义 connector，
    direct → `undefined`；`getFetch()` 经进程内 mock HTTP CONNECT / SOCKS5 代理访问本地源站成功；
    代理不可达 → `test()` `ok:false` + `proxy_connect_failed|proxy_timeout|proxy_tls_failed` + `status.lastError`；
    `noProxy` 命中 → `fetch()` 与 `test()` 均直连（`bypassNoProxy:true`）；`test()` 对非法 overrides 不抛
    （`ok:false, code:"invalid_proxy", invalidField`）；`update()` 后新请求立即走新代理。
15. **v2.3 Admin 代理**（`proxy-api.test.js`）：`GET /admin/api/proxy` 字段完整/无 password/默认 direct；
    `PUT` 深合并、9 类非法值 400 `invalid_proxy` 且不改变已保存配置；密码不回显、省略不覆盖、空串清除；
    `POST /proxy/test` 成功（经 mock 代理 → `status:200/latencyMs/exitIp`，临时 dispatcher 不改保存值，
    但写回 `status.lastTest*`）与失败（不可达 → 200 + `ok:false` + `code` + `lastError`）以及禁用时直连；
    `/healthz.proxy` 含 enabled/mode/active 等且不泄漏密码；未注入 proxy → 502/503 `proxy_unavailable`（非 500）。
16. **v2.3 DuckClient 代理集成**：注入 `proxyManager` 后**所有上游请求**（首页/status/chat…）经
    `proxyManager.fetch`（测试计数 ≥3），`health().proxy` 透出（enabled/mode/active/lastTest*/exitIp）；
    未注入时 direct/disabled。
17. **v2.3 sync transport 解锁**：未启用代理 → `transport:blocked`（`reason:"proxy_disabled"`）、`pair` 503
    `sync_transport_unavailable`；mock 代理可用（探测 200）→ `transport:available` → `pair` **501
    `sync_handshake_unimplemented`**（握手未实现，符合 PROXY.md §6）。
18. **v2.4 身份池（`identity-pool.test.js`）**：
    - 首次 init：无 `identity-pool.json` 且有 `identity.json` → 作为 `id_default`（label「默认身份」、activeId 指向、
      **原 identity.json 保留**；无 manifest 则新建默认身份）；pool 文件原子写/损坏备份（`identity-pool.corrupt-*`）。
    - generate 3 个身份 → journeyId/deviceId/fingerprint 互不相同；list/get 脱敏（无 privateKeyJwk/token），
      含 queue 指标；`exportIdentity`（完整私钥/token）→ `importIdentity` 到新池后 journeyId/fingerprint 一致。
    - 删除被绑定或 activeId → **409 `identity_in_use`**；`force:true` 清理绑定并转移 activeId（无剩余则 null）。
    - bindings 持久化到 `identity-pool.json`，重启后 `getBinding/listBindings` 不变；unbind 后重新路由。
    - hash 公式严格：候选 enabled（付费再加 subscribed）按 id 升序，
      `idx = parseInt(sha256(sessionKey+':'+salt).slice(0,8),16) % candidates.length`（固定 salt 精确断言）；
      绑定后恒定、跨重启一致、salt 轮换只影响新绑定。
    - 付费模型：无 subscribed 候选 → **403 `model_requires_subscription`**；有则只路由 subscribed。
    - 每身份队列：`rps=1`（同身份两次开始 ≥1000ms、peakInFlight≤1）、不同身份并行；
      `queueLimit=1` 时第 3 个 → **429 `queue_full`**、排队超 `queueTimeoutMs` → **429 `queue_timeout`**；
      `queueStats(id)` 含 waiting/inFlight/requests/peakInFlight/totalWaitMs。
19. **v2.4 Admin identities（`identity-pool-api.test.js`）**：§5 全端点契约——pool 摘要（不含 salt）+
    items 脱敏；generate/create/detail/PATCH/activate/rotate/export；DELETE 409/force；bindings limit/offset 分页
    （上限 500）+ 手工绑定/解绑；routing/router（hash|least-loaded，非法 → 400）；subscription POST/DELETE
    （422 token_invalid）；会话 `identityId`/`identityLabel`；`/healthz.identityPool`；`overview.identities`；
    未注入 → 503 `identity_pool_unavailable`。
20. **v2.4 路由集成（`identity-routing.test.js`）**：`X-Session-Id`（body `session_id`/`conversation_id` 同源）
    相同 → 多次请求同一 identityId（响应头 `X-Duckai-Identity-Id` + upstream 日志 `identityId/identityLabel` +
    bindings 持久化）；不同 session 各自绑定；无 sessionKey → 单轮 least-loaded 不写绑定；重启后不变；
    付费模型无订阅 403 / 绑定订阅身份后 200 且路由该身份；测试会话 `sess_xxx` 创建即绑定。
21. **v2.4 上下文守卫（`context-guard.test.js`）**：发送前按 `context.maxMessages/maxInputChars` 裁剪
    （保留最近消息，丢弃超预算旧消息）→ `/v1` 响应顶层 `context_trimmed:true`；上游
    `conversation_limit_reached`（409 语义）在 trim 模式自动更激进裁剪重试一次成功、`onLimit:"error"` 不重试 → 409；
    `input_limit_reached` 同理（trim 重试 / error 413）；流式同样裁剪。
22. **v2.4 二维码与页面（`identity-qr.test.js`）**：配对 URL 经 `qrcode` 生成合法 PNG data URL（签名校验、
    同 URL 稳定、异 URL 不同）；`identity.tsx` 含 `QRCode.toDataURL` + `<img src=data:image>` + pairing URL；
    `identities.tsx` 引用 `/identities` 与 generate/activate/rotate/bindings/routing；
    侧边栏/路由含「身份池」；构建产物含身份池/二维码/identities API/绑定路由标记。
23. **v2.5 会话并发（后端 `concurrency.test.js`）**：测试会话消息/重试走 `identities.run(session.identityId)`：
    - 两会话绑定**不同身份** → 并行（总耗时≈max(500,500)、`duck.maxInFlight≥2`）、`done.message.identityId` 各自正确、
      `queueWaitMs` 数值存在、upstream 日志带 identityId/queueWaitMs；
    - 同身份两会话 → 串行（总耗时≥1000ms、`maxInFlight=1`、`totalWaitMs/queueWaitMs≥700`）；
    - 同会话并发第二个请求 → **409 `session_busy`**；
    - `/v1` 不同 `X-Session-Id`（不同身份）并行、同身份串行（预热请求占用的 rps 门控需等待后再计时）。
24. **v2.5 前端并发（`web-concurrency.test.js`，jsdom + 真实构建产物）**：Node 注入 jsdom globals 后直接 import
    `web/assets/index-*.js`（真实 React 构建产物），mock fetch/SSE 驱动页面：
    - 会话 A 慢流（700ms delta）时切到 B 发送并先完成（B完成），A 仍在生成（列表「生成中」徽章）；
    - 切回 A 等待完成，A完成 显示在 A 会话（切会话不中断后台流）；
    - 同一会话同一 tick 连按两次 Enter → toast「该会话正在生成中」且只启动 1 个上游流；
    - 全程 `console.error/jsdomError` 计数 0。
25. **v2.5 扫码配对协议（`pairing.test.js`，mock sync 服务）**：`createExitPairing`/`PairingHost` 契约——
    信封 5 段（header alg=RSA-OAEP-256/enc=A256GCM、RSA-OAEP 包裹 AES key、A256GCM+header AAD）两对密钥
    round-trip/错误 key 失败；`start()` → `PUT /v2/exchange/<uuid>` 204 + 配对码/`#&code2=` URL + state=waiting，
    PUT 404 → `write_channel_lost`；轮询 `hello` → 校验 channel/public_key/version → 回 hello（scanner 可解密）；
    `self_scan`/`version_mismatch`/`sequence_gap`/GET 404 → state=failed + endReason；`waitForPeer` 超时 →
    `PairingError{code:'timeout'}`；`recovery_code_request` 有 account → `recovery_code_response`+completed(host)，
    无 account → `recovery_code_unavailable`+failed(unavailable)；`status()/stop()` 语义。
26. **v2.5 配对 Admin（`pairing-api.test.js`，mock PairingService）**：`POST/GET/DELETE /admin/api/sync/pairing`
    （启动字段 channelId/pairingCode/url/qrUrl/state/expiresAt/accountAvailable、无会话 `pairing:null`、status 脱敏无 payload）；
    错误映射 `sync_not_enabled→400`、`pairing_in_progress→409`、`network/timeout→503 sync_transport_unavailable + hint`、
    其它→`502 pairing_start_failed`；未注入→`503 pairing_unavailable`；
    `GET/PUT/DELETE /admin/api/sync/official-recovery-code`（无明文、缺 code 400）。
27. **v2.5 joiner 分支（真实手机配对失败修复）**：27. **v2.5 joiner 分支（真实手机配对失败修复）**：
    - 根因：手机（leader，已有 DuckDuckGo 账号）在 hello 后发 `recovery_code_available`，旧实现错误回
      `recovery_code_unavailable` → host failed，手机端提示「绑定失败」。
    - 修复后：`recovery_code_available`（校验 name/kind/user_id）→ **不回任何消息**，`state=exchange`、
      `substate=joiner_awaiting`；随后 `recovery_code_response`（`recovery_code` = base64/base64url JSON
      `{recovery:{user_id,secret}}`，兼容顶层 `{user_id,secret}`）→ 解析、记录 `receivedRecoveryCode`、
      `completedAs='joiner'`、`endReason='completed'`；`status().recoveryCode` 与 `onCompleted(status)` 暴露该码
      （不回显明文到日志）。
    - `recovery_code_request`（对方无账号）且本地有官方码 → 回 `recovery_code_response`（码原样）→ completed(host)；
      本地无码 → `recovery_code_unavailable` → failed(unavailable)。
    - `same_account`（`account.userId === message.user_id`）→ completed、`endReason='same_account'`；
      `recovery_code_awaiting_confirmation` → 继续等待；`recovery_code_confirmed` → completed(joiner/host 按状态)，
      `recovery_code_denied` → failed `endReason='denied'`。
    - Admin 落盘：`PairingService.onCompleted(status)` 在 `completedAs!=='host'` 且 status 含恢复码时
      `pairingStore.setRecoveryCode(code)`（`data/pairing.json` 原子写 0600）；此后
      `GET /official-recovery-code` configured/hasCode/length（无明文）、`GET /sync/pairing` `accountAvailable:true`；
      后续 host 角色用 `account.getRecoveryCode()` 返回该码。
28. **v2.8 Sync 设备注册协议（`src/duck/sync-client.js`）**：官方恢复码 → `credentialsFromRecoveryCode` 取 `{userId,secret}`；
    `scopedPassword=HKDF-SHA256(secretBytes, salt=UTF8(userId), info="Main Key", 32)`，
    `hashed_password=base64url(HKDF-SHA256(..., info="Password", 32))`（与 node:crypto 独立复算一致）。
    `POST /login` body `{user_id,hashed_password,device_id,device_name:<JWE>,device_type:<JWE>,scope:"ai_chats"}`；
    JWE 为 compact 5 段 `alg=dir/enc=A256GCM/kid=3party`，AAD=protected header，scopedPassword 可解出设备名/browser。
    `GET /keys` 选 `purpose=account_info` 且 `encrypted_with=3party`；私钥 JWE 明文为 **PKCS#8 DER**（非 JSON JWK），
    缺失时生成 RSA 3072、`POST /keys/purpose/account_info/set-if-absent`（kid=uuid，JWE header kid=3party），失败/竞态重读。
    `PATCH /devices` body `{updates:[{id,info}]}`；`info=createEnvelope(JSON({name,type}), account_info.public_key, {kid,typ:"device"})`
    → 私钥可解 `{name,type}`；`GET /devices` 真实形状 `{devices:{entries,entries_v2}}` 归一化；`POST /logout-device {device_id}`。
29. **v2.8 设备名 / 服务端设备 Admin**：`deviceName` 默认 `DuckCPA@`+4 hex（首启生成并持久化 identity.json + 回写
    `config.identity.deviceName`；自定义即时生效，null 重新生成；rotate/重启保持）。服务端设备信息持久化在
    `identity.sync.server`（userId/deviceId/deviceName/serverDeviceId/registeredAt/lastLoginAt/devices/lastError），
    `GET /admin/api/sync.server` 返回该摘要；`POST /admin/api/sync/register-device`（无码 400 recovery_code_not_configured；
    代理不可用 503+hint；非法码 400 invalid_recovery_code；成功 200 `{ok,serverDevice,devices,server}`）；
    `GET /admin/api/sync/server-devices`（current/total、name 为 DuckCPA/自定义、**不回显 info 密文**）；
    `DELETE .../:id`（当前设备 400 invalid_device，其它 logout）。joiner 完成后 PairingService onCompleted 异步
    `autoRegister()`（失败只 warn + lastError，不影响 completed）。
    **v2.8 quick fix**：`identity.deviceName` 为空或匹配 `/^DuckAI CPA/i` → 自动迁移 `DuckCPA@<4hex>` 并回写
    identity + `config.identity.deviceName`（自定义名保持；直连 createServer 的 GET /sync 也会懒迁移）；Sync login token
    仅进程内存（不写 identity.json），`server-devices` 无 live session 时优先返回 `identity.sync.server.devices` 缓存；
    Sync `/login` HTTP 418（anti-abuse）→ **429 `sync_rate_limited`/`rate_limit_error` + `Retry-After:120` + hint**，
    并设 2 分钟进程级 cooldown（期间 register-device/server-devices/delete 直接 429、不再请求上游）；
    register 失败同样映射 429；其它错误映射不变（400/401/503/502）。
30. **v2.8 轮换二次确认**：`POST /admin/api/identity/rotate` 与 `/identities/:id/rotate` 返回 `identityLost:true` +
    `note:"轮换会丢弃当前 journeyId/durableStream 密钥，旧身份无法恢复"`（scope journey/device/all 语义一致）；前端两步
    Dialog（第 1/2 步 → 确认轮换（不可恢复），正文含「身份直接丢失/无法恢复」），取消/关闭不调用 rotate；成功后 toast
    「身份已丢失，原匿名身份不可恢复」+ 卡内联 note。`IdentityStore.setDeviceName/getDeviceName/setSyncServer` 提供
    校验（1–64 字符）、合并写与 `null` 清空。


---

## 5. 脚本验收结果

### 5.1 脚本能力（v2 / v2.1 / v2.2 / v2.3 更新）

- `smoke.js`：新增 **强制 API Key**（`--api-key` / `$DUCKAI_CPA_API_KEY` / `$OPENAI_API_KEY`）；live 模式缺 key
  直接以退出码 2 提示；`--mock` 自动注入测试 key；校验 v2 免费/付费模型字段、`stats.upstream/admin` +
  `upstream.queue`；`--no-upstream` 不触发上游。
- `build-check.mjs`：校验 `npm run build:web` 产物——index.html（#root/ESM/#admin/assets 引用）、
  资源存在非空、chunk 引用完整性、无外部 CDN、无 v1 手写残留、vite 配置契约（base=/admin/、outDir=../web）；
  **v2.1 retry UI 文案**；**v2.2 身份页文案**；**v2.3 代理页文案**（代理 / HTTP/HTTPS / SOCKS / 出口 IP /
  noProxy / proxy API 引用）；**v2.4 身份池/二维码文案**（身份池 / 二维码·扫码 / identities API / 绑定·路由 /
  QR data URL 生成）；**v2.5 并发/配对文案**（生成中徽章 / 同会话忙提示·session_busy / 并发流式 / 配对·扫码 /
  `/sync/pairing`·`official-recovery-code` / 停止生成）；`--build` 可直接执行构建。
- `page-check.mjs`：适配 React 产物——/admin 返回含 `#root` 的 React 页面、`/admin/assets/*.js|css`
  200 且类型正确、无外链、路径穿越拒绝、Admin API v2 契约（overview queue/stats 拆分、config 无 auth.required、
  logs kind、sessions、旧 test 404、未授权 401）；**v2.2 新增 identity/sync/subscription 契约检查**；
  **v2.3 新增 proxy 契约检查**；**v2.4 新增 identities 契约检查**；
  **v2.5 新增 pairing 契约检查**（GET 状态 pairing:null/status 脱敏、DELETE 停止、官方恢复码 GET 脱敏形状）。
- `proxy-live-check.mjs`（新增，v2.3）：对运行中网关验证本机代理（默认 127.0.0.1:10808）——保存原配置 →
  PUT 启用 HTTP/SOCKS5 → POST /proxy/test 断言 `ok/status/latencyMs/exitIp` → healthz.proxy.mode/active →
  sync transport=available → 恢复原配置并复核。环境守卫：默认不执行（BLOCKED），`--with-proxy` 或
  `QA_WITH_PROXY=1` 才实际改动；端口不可达 → BLOCKED（退出码 0），有 FAIL 才退出 1。

### 5.2 `smoke.js --mock --search`（v2.1，exit 0）

```
[PASS] healthz / v1/models(20, paid=gpt-5.6-terra) / v1/models/:id / chat 非流式 / chat 流式 /
       responses 流式 / images b64 / 联网搜索 annotations(2 citations) / admin overview(upstream=7, queue=0/0)
✔ smoke 通过: 9 passed, 0 failed, 0 skipped (4108ms)
```

### 5.3 `smoke.js --no-upstream`（对运行中 v2 网关，exit 0）

```
[PASS] healthz / v1/models / v1/models/:id / admin overview(queue=0/0 models=10)
[SKIP] chat 非流式 / chat 流式 / responses 流式 / images b64   （--no-upstream）
✔ smoke 通过: 4 passed, 0 failed, 4 skipped
```

### 5.4 `build-check.mjs`（exit 0，12/12）

```
[PASS] web/index.html        769 bytes, 3 refs（#root + ESM module）
[PASS] 引用资源完整性         favicon.svg(281B), index-<hash>.js(~602KB), index-<hash>.css(~35KB)
[PASS] chunk 引用完整性       checked 0 chunk refs（单 bundle）
[PASS] 无外部 CDN / 无 v1 手写残留
[PASS] v2.1 retry UI 文案     中文文案 + retry 逻辑（构建产物含「重新生成/重试」入口）
[PASS] v2.2 身份页文案        身份 + Sync/备份 + 订阅 文案/逻辑
[PASS] v2.3 代理页文案        代理 + HTTP/SOCKS + 出口 IP + noProxy 文案/逻辑
[PASS] v2.4 身份池/二维码文案   身份池 + 二维码/扫码 + identities API + 绑定/路由
[PASS] v2.5 并发/配对文案     生成中 + 同会话忙 + 并发流式 + 配对/扫码 + pairing API
[PASS] v2.8 设备列表/轮换警告文案  设备列表 + 注册/删除 + 设备名称 + server-devices API + 不可恢复/身份丢失 + 两步确认
[PASS] vite 配置契约          base=/admin/, outDir=../web
[PASS] v2.9 设备名/设备槽文案               设备名称 + 默认不可删除 + 设备槽拖拽 + 待加入/已注册 + DuckAI@main + 未保存/保存 + 限流
[PASS] v2.10 删除保护/孤儿文案              设备列表卡片 + 409 弹窗 + force + 孤儿提示/清理
[PASS] v2.11 compact/上下文/恢复码文案      上下文约 + 压缩会话 + 摘要徽章 + 自动压缩 + 官方恢复码/二维码
✔ build-check 通过: 15 passed, 0 failed
```

> 构建 hash 随每次 `npm run build:web` 变化（`index-<hash>.js|css`），检查按 index.html 的引用解析，不依赖固定文件名。

### 5.5 `page-check.mjs`（对 v2.8 mock 网关，exit 0，17/17）

```
[PASS] 构建产物存在 / /admin React 页面（#root + ESM module）/ 静态资源 200（1 js + 1 css）/ 路径穿越拒绝 / favicon
[PASS] admin 未授权 401
[PASS] overview 契约（v2）  queue=0/0 rps=1 models=10（stats.upstream/admin 拆分、recent 拆分）
[PASS] config 契约（v2）    rps=1 allowPaidModels=false（无 auth.required、adminToken 脱敏）
[PASS] keys/logs/models/health/sessions（kind=upstream/admin、sessions items）
[PASS] identity 契约（v2.2）      journey=… fp=… stable=true（无 privateKeyJwk/token 泄漏）
[PASS] sync 契约（v2.2）          transport=blocked、配对码 v2 结构 + code2 URL
[PASS] subscription 契约（v2.2）  tier=free authenticated=false verified=false
[PASS] proxy 契约（v2.3）         mode=direct enabled=false type=http healthz=direct（PUT 非法值 400 且不改配置）
[PASS] identities 契约（v2.4）     total=1 enabled=1 subscribed=0 bindings=0 strategy=hash（pool 无 salt）
[PASS] pairing 契约（v2.5）        pairing=null configured=false（GET/DELETE/官方恢复码）
[PASS] sync 设备契约（v2.8）        deviceName=DuckCPA@4d77 total=2 registered=true（server-devices/register-device/DELETE）
[PASS] 旧 /admin/api/test 404
[PASS] device-slots 契约（v2.9）           slots=2 defaultDuckAI@main + DuckCPA@xxxx；空列表 400；保护 409
[PASS] 设备删除保护/孤儿自愈（v2.10）            orphans/reconcile + DELETE 409(identityId/deviceName) + force removedDevice + 默认身份 409
[PASS] 模型上下文能力（v2.11）                 chars=16000 tokens=5333 output=4096 capabilities OK
[PASS] 手动 compact + 官方恢复码明文/下载（v2.11）  compact 200 + summary 持久化；recovery GET 明文/source/download 一致
✔ page-check 通过: 21 passed, 0 failed
```

> 浏览器交互（九个页面点击流、SSE 渲染、身份页二维码/代理页/身份池页操作、连接测试并发切换、主题切换）由 web-dashboard-2 自测 + Lead/人工验收；
> page-check 提供可复现的静态资源 + API 契约自动化检查。

### 5.6 `proxy-live-check.mjs --with-proxy`（真实本机代理 127.0.0.1:10808，exit 0，11/11）

```
[PASS] 代理端口可达                   127.0.0.1:10808
[PASS] 读取当前代理配置                enabled=false type=http 127.0.0.1:8080
[PASS] PUT 启用 http                  mode=http
[PASS] POST test http                 status=200 latency=1285ms exitIp=70.39.202.155 mode=http
[PASS] healthz proxy http             mode=http active=true
[PASS] PUT 启用 socks5                mode=socks5
[PASS] POST test socks5               status=200 latency=1662ms exitIp=70.39.202.155 mode=socks5
[PASS] healthz proxy socks5           mode=socks5 active=true
[PASS] sync transport                 transport=available
[PASS] 恢复原代理配置                  HTTP 200（enabled=false 等原值）
[PASS] 恢复后 healthz                 mode=direct
✔ proxy-live-check: 11 passed, 0 failed, 0 blocked (3.3s)
```

> 证据：`data/tmp/proxy-live-check-*.json`；网关为 QA 临时 mock 网关（`createServer({identity, proxy})`），
> 代理/网络链路与生产一致（真实 10808 出网、exitIp 变化、duckduckgo.com 可达）。
> 环境守卫：无 `--with-proxy`/`QA_WITH_PROXY=1` 或端口不可达 → 全部 BLOCKED、退出码 0（CI 安全）。
> 注：IdentityStore 的 sync transport 探测有 ~30s 缓存；代理切换后若 GET /sync 仍为旧 blocked，脚本会用
> `POST /sync/pair`（内部 force 重探测）判定——返回 501 视为 available，随后 GET /sync 应为 available。

### 5.7 v2.4 真实身份池联调（2 身份 × 2 会话真实消息，经 10808 代理）

```
[PASS] 生成 2 身份                        id_24d3d123,id_72181aa1
[PASS] healthz.identityPool           {"total":3,"enabled":3,"subscribed":0,"busy":0}
[INFO] chat #0 status=200 identity=id_24d3d123 bound=id_24d3d123 content="分身" error=null
[INFO] chat #1 status=200 identity=id_default bound=id_default content="分身1" error=null
[PASS] upstream 日志 identityId         ["id_default","id_24d3d123"]
[PASS] 绑定持久化                          ["sess_real_v24_1→id_default","sess_real_v24_0→id_24d3d123"]
[PASS] 2 身份各自真实会话                     distinct=2 (id_24d3d123,id_default)
[PASS] 真实消息 200                       2 条成功内容
```

> 执行方式：QA 临时真实网关（端口 18788，`createServer({identity, proxy, identities})`，默认真实 DuckClient runtime），
> 代理经 127.0.0.1:10808 出网；两个不同 `X-Session-Id` 分别命中/绑定不同身份，**各自收到真实 200 与内容**，
> 响应头 `X-Duckai-Identity-Id`、upstream 日志 `identityId`、bindings 持久化三者一致。
> 证据：`data/tmp/v24-real-integration.json`；脚本 `data/tmp/qa-v24-real-integration.mjs`（QA 临时，非生产脚本）。
> 注：两个会话 hash 结果可能相同（本 3 身份池同桶概率约 1/3），脚本在相同时会手工绑定第二个会话到另一身份再验证。

### 5.8 v2.5 真实联调（2 身份并行真实消息 + 配对真实 start，经 10808 代理）

```
[PASS] 生成 2 身份                        id_1c9c0513,id_f3451458
[INFO] 2 身份并行真实消息                    elapsed=4077ms（两请求均 200） [{"status":200,"identity":"id_1c9c0513","content":"并行"},{"status":200,"identity":"id_f3451458","content":"并行1"}]
[PASS] 两请求身份不同                       id_1c9c0513,id_f3451458
[PASS] pairing 真实 start                HTTP 200 channelId=51c5f370-05c2-43a9-ae1a-01607952a6d3 state=waiting code=-
[PASS] pairing 状态                      "waiting"
[PASS] pairing 停止                      HTTP 200
[PASS] 官方恢复码端点                       HTTP 200
```

> 执行方式：QA 临时真实网关（端口 18788，`createServer({identity, proxy, identities, pairing})`，真实 DuckClient runtime +
> 真实 PairingService），代理 127.0.0.1:10808；`X-Session-Id` 分别绑定两个不同身份，两请求**真实 200 且 identityId 不同**；
> `POST /admin/api/sync/pairing` 真实注册 Sync 频道（sync.duckduckgo.com 经代理）→ 200 `channelId`/`state=waiting`，
> GET 状态 waiting，DELETE 停止；官方恢复码端点 200。
> 证据：`data/tmp/v25-real-integration.json`；脚本 `data/tmp/qa-v25-real-integration.mjs`（QA 临时）。
> 复跑时可能遇到上游共享出口 **429**（某一并行请求）；该现象与网关并发无关（每身份独立队列），已记入 §6.8/§9。

### 5.9 v2.5 joiner 修复验收（真实手机配对失败 → 本地端到端复现与修复验证）

- 现象（Lead 真实手机日志）：hello 成功 → 手机发 `recovery_code_available` → 网关错误回
  `recovery_code_unavailable` → 手机提示「绑定失败」。
- 修复后本地端到端（`tests/pairing-joiner-api.test.js`，真实 PairingHost + mock Sync + PairingStore +
  PairingService + createServer，**1/1 PASS**）：
  ```
  start → 200 waiting / accountAvailable=false
  hello → exchange
  recovery_code_available → 不回 unavailable，state=exchange（joiner_awaiting）
  recovery_code_response({recovery:{user_id,secret}}) → completed / completedAs=joiner
  官方码落盘 → GET official-recovery-code configured=true/hasCode/length>0（无明文）
  pairing status → accountAvailable=true / completedAs=joiner
  ```
- 模块级 joiner 分支 4 项（`tests/pairing.test.js`）：available 不回 unavailable + response 解析 + status/onCompleted
  暴露恢复码；request+本地官方码→response(base64 JSON 正确)+completed(host)；same_account；awaiting_confirmation→
  confirmed→completed / denied→failed(denied)。
- 冲突策略（`tests/pairing-joiner-api.test.js` 3 项）：已有不同官方码且 `sync.pairing.overwriteAccount=false`（默认）→ 保留已有码；相同码 → no-op；`sync.pairing.overwriteAccount=true` → 覆盖为新码。`completedAs:"host"` 不保存（host 使用的就是本地码）。`GET /sync/pairing` 已剥离 `recoveryCode` 原文，仅保留 `recoveryCodeReceived/recoveryUserId/accountConflict`。
- 说明：真实手机端复测需 Lead 持设备执行（本次仅本地协议端到端复现修复路径）。
### 5.10 v2.8 真实联调（真实官方恢复码 → 注册设备，经 10808 代理）

```
[PASS] 官方恢复码存在                        len=191（复用 data/pairing.json 中真实码）
[PASS] GET /sync 设备名                  deviceName=DuckCPA@498a
[PASS] POST register-device           HTTP 200 ok=true userId=489adc11-ab46-4046-8411-c2ce3f0a18bf
[PASS] GET server-devices 含本机         total=5 current=ad9c87a3-… name=DuckCPA@498a
[PASS] sync.server registered         "DuckCPA@498a"
```

> 执行：QA 临时真实网关（端口 18789，真实 IdentityStore/PairingStore/SyncDeviceService/SyncClient + 代理 10808），
> 复制真实 `data/identity.json` + `data/pairing.json`（官方码）到临时目录；`POST /admin/api/sync/register-device` 真实走
> `sync.duckduckgo.com` login + keys + PATCH devices → **200**；`GET /admin/api/sync/server-devices` 返回服务端设备列表，
> 含本机 current `DuckCPA@498a`（total=5）；`GET /sync` 的 `sync.server.registered=true`。
> 证据：`data/tmp/v28-real-integration.json`；脚本 `data/tmp/qa-v28-real-integration.mjs`。
### 5.11 v2.9 真实联调（device-slots 双设备注册 → 注销，经 10808 代理）

```
[PASS] 官方恢复码                          len=191
[PASS] GET device-slots               HTTP 200 identityIds=["id_default"]
[PASS] 默认设备名                          deviceName=DuckAI@main
[PASS] 生成分身                           id=id_a8c7b838 deviceName=DuckCPA@70e7
[PASS] PUT slots 注册 2 台               HTTP 200 identityIds=["id_default","id_a8c7b838"]
[PASS] GET slots 复核                   identityIds=["id_default","id_a8c7b838"]
[PASS] serverDevices 解密               ["HONOR BRT-AN00", … ,"DuckCPA@70e7(本机)"]
[PASS] PUT slots 注销分身                 HTTP 200 identityIds=["id_default"]
```

> 执行：QA 临时真实网关（端口 18790，真实 IdentityStore/IdentityPool/PairingStore/SyncDeviceService/SyncClient + 代理 10808），
> 复制真实 `data/pairing.json` 官方码；`GET /admin/api/sync/device-slots` 200（默认 DuckAI@main）；生成分身（DuckCPA@70e7）后
> `PUT [id_default, 分身]` **200** 双设备注册（真实 PATCH /devices 每设备一次），服务端设备列表解密出 HONOR BRT-AN00 与 DuckCPA@70e7；
> 再 `PUT [id_default]` 注销分身 **200**。证据：`data/tmp/v29-real-integration.json`；脚本 `data/tmp/qa-v29-real-integration.mjs`。
### 5.12 v2.10 真实联调（slots 内身份删除保护 → force 删除，经 10808 代理）

```
[PASS] GET device-slots                 HTTP 200 identityIds=["id_default"]
[PASS] 生成分身                             id=id_3cac67ae name=DuckCPA@07ac
[PASS] 加入 slots                         HTTP 200 identityIds=["id_default","id_3cac67ae"]
[PASS] DELETE 409                       HTTP 409 code=identity_in_device_slots identityId=id_3cac67ae deviceName=DuckCPA@07ac
[PASS] force 删除                         HTTP 200 removedDevice=true {"ok":true,"id":"id_3cac67ae","removedDevice":true}
[PASS] slots 无残留                        identityIds=["id_default"] orphans=0
[PASS] 默认身份 force 409                   HTTP 409 code=default_identity_protected
```

> 执行：QA 临时真实网关（端口 18791，真实 IdentityStore/IdentityPool/PairingStore/SyncDeviceService/SyncClient + 10808），
> 复制真实官方码；分身加入 slots 后 DELETE 409（identityId/deviceName 正确）→ force 删除 200 removedDevice:true → slots 无残留；
> 默认身份 force 仍 409。证据：`data/tmp/v210-real-integration.json`；脚本 `data/tmp/qa-v210-real-integration.mjs`。
### 5.13 v2.11 真实联调（官方恢复码明文/下载 + 模型能力 + compact 额度）

```
[PASS] 官方恢复码存在                        len=191
[PASS] GET 恢复码明文                      HTTP 200 source=pairing len=191
[PASS] download 一致                    HTTP 200 disposition=attachment; filename="duckduckgo-official-recovery-code-2026...txt"
[PASS] 模型能力 API                       HTTP 200 chars=16000 tokens=5333 capabilities=true
[PASS] 创建会话                           HTTP 201 id=sess_...
[BLOCKED/INFO] 真实 compact                     HTTP 502 code=upstream_rate_limited
```

> 执行：QA 临时真实网关（端口 18792，真实 IdentityStore/PairingStore/chat-summaries/DuckClient + 代理 10808），
> 复制真实官方码；GET recovery code 明文与 download 内容一致（len=191/source=pairing）、模型能力字段正确；
> 真实 compact 因上游限流（429/418）BLOCKED（mock 层已覆盖自动/手动/limit 重试）。证据：`data/tmp/v211-real-integration.json`；
> 脚本 `data/tmp/qa-v211-real-integration.mjs`。
### 5.14 v2.12 真实联调（gpt-6-luna 不压缩 / gpt-5.4-mini 触发）

```
[PASS] 模型能力字段                             luna.supported=false mini.supported=true input_limit=16000
[BLOCKED/INFO] gpt-6-luna 长会话                     BLOCKED HTTP 403 upstream_anomaly_check (upstream 418)
[BLOCKED/INFO] gpt-5.4-mini 多轮                    BLOCKED HTTP 403 upstream_anomaly_check (upstream 418)
```

> QA 临时真实网关（端口 18794，真实 DuckClient + 10808），模型能力字段真实正确；真实会话因共享出口额度 418 BLOCKED，
> mock 层已覆盖 gpt-6-luna 不压缩 / gpt-5.4-mini pair 触发 / limit 压缩重试。证据：`data/tmp/v212-real-integration.json`；
> 脚本 `data/tmp/qa-v212-real-integration.mjs`。


---

## 6. 真实上游验收（BLOCKED by upstream quota）

### 6.1 现状

- 当前 duck.ai 匿名额度处于 **429 冷却期**（多 agent 共用出口 IP；api-core 真实 smoke 的 chat stream 返回 429 JSON，
  属预期限流）。真实上游 v2 端到端与 OpenAI SDK 真实兼容**均未执行**，由 Lead 统一安排额度窗口。
- v1 时代的真实上游记录（`docs/ACCEPTANCE.md`、`data/tmp/live-check-acceptance.json`）在 v2 BREAKING 后
  仅作历史参考：v2 强制 API Key、RPS 队列、付费模型、会话式测试、严格校验均改变了行为，需按 v2 重跑。

### 6.2 冷却后需执行的终验（命令已就绪）

```powershell
# 1) 直连协议链路（DuckClient，12s 间隔，418/429 等 60s 重试一次）
node scripts/live-check.mjs --interval 12000
# 2) v2 网关全链路（强制 API Key + 搜索 + admin）
node scripts/smoke.js --base-url http://127.0.0.1:8787 --api-key <key> --admin-token <token> --search
# 3) OpenAI 官方 SDK（chat 非流/流、responses；14s 间隔）
node scripts/sdk-check.mjs --base-url http://127.0.0.1:8787 --api-key <key>
```

终验关注点（v2 新增）：`/v1/*` 必须带 key；RPS 队列下并发请求 `queueWaitMs` 递增且 ≤1 inFlight；
付费模型默认 403；session 连续对话多轮上下文生效；上游异常（若有）严格中断为 502 且不伪造完成事件。
v2.2 追加：默认 `durableStream` 已开启（`identity.durableStream.enabled=true`），chat body 应带 durableStream
且上游 **200**（若上游 400 → 观察自动降级 `health().durableStream.degraded=true`、请求仍成功）；
journeyId 跨重启稳定（上游日志可见同一值）；真实 duck.ai 订阅 token 激活/verify（需真实登录态，预期 BLOCKED）。

### 6.3 结果

| 项目 | 状态 |
| --- | --- |
| 真实上游文本流式 / 多轮 / 搜索 / 图片 | ⏳ BLOCKED（429 冷却） |
| v2 网关 smoke 全链路（真实上游） | ⏳ BLOCKED（429 冷却） |
| OpenAI SDK 真实兼容（v2 强制 key） | ⏳ BLOCKED（429 冷却） |
| v2.2 durableStream 上游接受 / journeyId 稳定性 | ✅ **已实测**（§6.5：默认开启 + 真实 chat **200**、`durableStreamRejected=0/degraded=false`；重启身份稳定） |
| v2.2 真实订阅 token（activate/verify） | ⏳ BLOCKED（需真实 DuckDuckGo 登录态） |
| v2.3 本机代理（HTTP/SOCKS5）出站与 Sync 可达 | ✅ **已实测**（§5.6/§6.6：test exitIp=70.39.202.155、`/status` 200、duckduckgo.com 200、sync available） |
| v2.3 经代理的真实 chat | ⚠️ 部分：SOCKS5 曾 200（duck-protocol 实测）、HTTP 代理遇上游 418 额度软限流（非链路问题） |
| v2.4 身份池真实路由（2 身份 × 2 会话真实消息） | ✅ **已实测**（§5.7/§6.7：两个身份各 1 条真实 200「分身/分身1」，identityId 响应头/日志/绑定一致） |
| v2.4 上下文守卫真实超长会话 | ⏳ BLOCKED（需真实超长会话触发 ERR_CONVERSATION_LIMIT；mock 层已覆盖 trim 重试） |
| v2.5 会话并发（后端/jsdom） | ✅ **已实测**（§5.8/§6.8：2 身份并行真实消息双 200 且 identityId 不同；前端 jsdom 并发 2/2；mock 层 maxInFlight/串行断言） |
| v2.5 扫码配对真实 start | ✅ **已实测**（§5.8/§6.8：POST /admin/api/sync/pairing → 200 channelId/waiting，GET/DELETE 正常；经 10808 代理） |
| v2.9 device-slots 真实注册/注销（官方码+10808） | ✅ **已实测**（§5.11/§6.10：默认 DuckAI@main + 分身 DuckCPA@70e7 双注册 200、serverDevices 解密 HONOR、PUT 注销 200） |
| v2.10 slots 内身份删除保护（官方码+10808） | ✅ **已实测**（§5.12/§6.11：DELETE 409 identity_in_device_slots → force 200 removedDevice:true、slots 无残留、默认身份 force 409） |
| v2.11 官方恢复码明文/下载 + 模型能力 | ✅ **已实测**（§5.13/§6.12：GET 明文 len=191/source=pairing、download 一致；/v1/models chars=16000/tokens=5333） |
| v2.11 真实 compact | ⏳ **BLOCKED**（上游 rate limited/418；mock 层自动/手动/limit 重试已覆盖） |
| v2.5 joiner（手机有账号）真实配对 | ✅ mock 端到端 + 模块层 4 项；真实手机复测待 Lead（原「绑定失败」根因已修） |

### 6.5 api-core v2.2 真实原始证据（fresh dataDir，默认配置）

> 由 api-core 在真实 duck.ai 上执行并回传（同一代码/工作区，供 QA.md 交叉引用；非本报告独立复跑）。

1. **首启 identity**（日志）：
   `[duck:identity] identity ready {"source":"generated","journeyId":"360f205ce74460aac42f085ac1203755","fingerprint":"1f08ed366585b136aa0e891e82746eef"}`；
   启动日志含 `身份: durableStream=enabled`。
2. **GET /admin/api/identity**（默认配置）：`durableStream:{fingerprint:"1f08ed36…",hasPrivateKey:true,version:"0.2.0",
   enabled:true,configured:true,degraded:false,rejectedCount:0}`；`publicKeyJwk` 含
   `alg:"RSA-OAEP-256", use:"enc", key_ops:["encrypt"], ext:true`。
3. **真实 chat（/v1/chat/completions 非流式，默认 durableStream）——成功 200**：
   - 请求（网关内部组装上游 body，客户端 body 不含 durableStream）：
     `POST /v1/chat/completions` + `Authorization: Bearer <default key>`，
     body `{"model":"gpt-6-luna","messages":[{"role":"user","content":"只回复两个字：稳定"}]}`；
     上游 body 由 DuckClient 注入 `durableStream:{messageId,conversationId,publicKey}`（JWK：`kty:"RSA",
     alg:"RSA-OAEP-256", use:"enc", key_ops:["encrypt"], ext:true`）。
   - 响应 **HTTP 200**（7092ms）：`chat.completion`，`choices[0].message.content:"稳定"`、
     `finish_reason:"stop"`、`usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4,estimated:true}`。
   - `GET /healthz`：`upstream.durableStream={configured:true,enabled:true,degraded:false,rejectedCount:0}`；
     `upstream.health.stats={requests:3,success:1,failures:2,retries:2,challengeRetries:2,limitHits418:2,
     limitHits429:0,durableStreamRequests:3,durableStreamRejected:0,authRequests:0,authExpired:0,
     consecutiveFailures:0,lastStatus:200,lastModel:"gpt-6-luna"}`。
     前两次 attempt 为上游 `418 ERR_BN_LIMIT`（unsupported entrypoint）→ 传输层重试后第 3 次 200；
     `durableStreamRejected:0`、`degraded:false` → **上游接受 durableStream，无 400 降级**。
   - 随后 GET identity：durableStream 状态同上，指纹与重启前一致。
4. **重启同 dataDir**：`identity ready {"source":"file","journeyId":"360f205c…","fingerprint":"1f08ed36…"}`；
   GET identity 的 journeyId/deviceId/fingerprint/createdAt/rotatedAt 与重启前完全一致，`stable:true, source:"file"`。
5. **结论**：durableStream 默认开启下真实 chat 已取得 **200**，且 `durableStreamRejected=0/degraded=false`
   （上游未 400 拒绝）；跨重启身份稳定亦有真实证据。唯一仍 BLOCKED 的是真实 DuckDuckGo 订阅 token
   （需登录态）与上游日志中 journeyId 的直接比对（需端侧日志权限）。

### 6.6 v2.3 代理真实联调（QA 独立执行，127.0.0.1:10808）

- 网关：QA 临时 mock 网关（`createServer({identity, proxy})`，端口 18787；上游用 MockDuckClient，仅验证代理/Admin/网络链路）。
- 结果（`scripts/proxy-live-check.mjs --with-proxy`，11/11 PASS，§5.6）：
  - HTTP 代理：`POST /admin/api/proxy/test` → `ok:true, status:200, latencyMs=1285, exitIp=70.39.202.155`；
  - SOCKS5 代理：`ok:true, status:200, latencyMs=1662, exitIp=70.39.202.155`（与直连出口不同）；
  - `GET /healthz` → `proxy.mode=http|socks5, active=true`；关闭/恢复后 `mode=direct`；
  - `GET /admin/api/sync` → `transport:"available"`（代理可达 duckduckgo.com）；恢复原配置后回到 blocked。
- duck-protocol 独立实测（同 10808，真实 duck.ai）：`/duckchat/v1/status` 200 + 挑战头、`duckduckgo.com/sync/pairing` 200、
  SOCKS5 下真实 chat **200**（「代理」）；HTTP 代理下真实 chat 遇上游 `418 ERR_BN_LIMIT`（额度软限流，非代理链路问题）。
- 结论：v2.3 代理链路（HTTP CONNECT / SOCKS5）+ Admin 端点 + sync transport 解锁均真实可用；真实 chat 受额度限流影响，
  与代理无因果关系（§6.3 记录）。

### 6.7 v2.4 身份池真实联调（QA 独立执行，经 10808 代理，端口 18788 真实网关）

- 环境：临时 `data/tmp/qa-v24-real`，默认配置 + 代理 `127.0.0.1:10808`（HTTP），真实 DuckClient runtime（每身份独立）。
- 结果（脚本 `data/tmp/qa-v24-real-integration.mjs`，证据 `data/tmp/v24-real-integration.json`，§5.7）：
  - `POST /identities/generate {count:2}` → 2 个身份；`healthz.identityPool={total:3,enabled:3,subscribed:0,busy:0}`；
  - 两个不同 `X-Session-Id` 各发 1 条真实消息 → **均 HTTP 200**，内容「分身」「分身1」；
    响应头 `X-Duckai-Identity-Id` 分别 `id_24d3d123` / `id_default`；bindings 持久化为
    `sess_real_v24_0→id_24d3d123`、`sess_real_v24_1→id_default`；
  - `GET /admin/api/logs?kind=upstream` 条目 `identityId` 与上述一致（`["id_default","id_24d3d123"]`）；
  - 结论：**身份池 → 会话绑定 → 每身份 runtime → 真实上游 200** 全链路可用；hash 同桶时会话可能同身份（概率性，
    脚本在相同时手工绑定另一身份验证第二身份亦可真实 200）。
- 真实超长会话触发上游 `ERR_CONVERSATION_LIMIT` 的自动裁剪重试仍 **BLOCKED**（需构造超长真实会话，额度窗口可选测）。

### 6.8 v2.5 真实联调（QA 独立执行：2 身份并行 + 配对真实 start，经 10808 代理）

- 环境：临时 `data/tmp/qa-v25-real`，真实 DuckClient runtime（每身份独立）+ 真实 PairingService，代理
  `127.0.0.1:10808`（HTTP），端口 18788 真实网关。
- 结果（脚本 `data/tmp/qa-v25-real-integration.mjs`，证据 `data/tmp/v25-real-integration.json`，§5.8）：
  - 生成 2 身份并分别绑定 `sess_real_v25_a/b`；两请求 `X-Session-Id` 并行发出 → **均 HTTP 200**，
    内容「并行」「并行1」，响应头 `X-Duckai-Identity-Id` 为两个不同身份（首跑耗时 4077ms；复跑一次遇上游
    共享出口 **429 rate_limit_exceeded**，属额度限流，与网关并发无关）；
  - `POST /admin/api/sync/pairing` → **200** `channelId=<uuid>`、`state=waiting`（真实 `PUT sync.duckduckgo.com` 注册频道，
    经代理耗时约 <1s），`GET /admin/api/sync/pairing` → `state:"waiting"`，`DELETE` → 200 停止；
  - `GET /admin/api/sync/official-recovery-code` → 200（未配置时 `configured:false`，无明文）。
- 限界：官方 DuckDuckGo App 端扫码/账号加入（`joinAccount/exitAccount`、真实 recovery code 语义）不在本迭代范围；
  pairing 成功后**不写** `identity.sync`（保持本地扩展语义，见 `docs/PAIRING-IMPL.md`）。真实超长会话 trim 仍可选测。
### 6.9 v2.8 真实设备注册（QA 独立执行，真实官方恢复码 + 10808 代理）

- 环境：临时 dataDir（复制真实 `identity.json` + `pairing.json` 官方码），真实 IdentityStore/PairingStore/SyncDeviceService
  （lazy 真实 `sync-client.js`），代理 127.0.0.1:10808，端口 18789。
- 结果（`data/tmp/v28-real-integration.json`，§5.10）：`POST /admin/api/sync/register-device` **200 / ~3.3s**；
  `serverDevice {name:"DuckCPA@498a", current:true, credential_id:"3party"}`；`server.userId=489adc11-…`；
  `GET server-devices` total=5 含本机 current；`DELETE` 当前设备 → 400 invalid_device；`GET /sync.deviceName=DuckCPA@498a`。
- 限界：真实服务端设备列表可能含历史设备（本次 total=5），删除为 best-effort 且 logout 会使当前 token 失效（需重新 login）；
  真实官方 App 端完整账号数据同步仍属后续迭代。
### 6.10 v2.9 真实设备槽联调（QA 独立执行，真实官方码 + 10808）

- 环境：临时 dataDir（真实 identity.json + pairing.json 官方码），真实 IdentityPool（含 id_default）+ SyncDeviceService + 真实 sync-client，代理 10808，端口 18790。
- 结果（`data/tmp/v29-real-integration.json`，§5.11）：`GET device-slots` 200（默认 `DuckAI@main`，serverDevices 解密 HONOR/Chrome/Edge 等）；
  `PUT [id_default, 分身]` **200**（`DuckAI@main` + `DuckCPA@70e7` 双注册，serverDeviceId=identity.deviceId）；
  `PUT [id_default]` **200** 注销分身；`DELETE id_default` → 409（单独由 Admin 断言覆盖）。
- 限界：真实 Sync token 若被 logout 失效会自动重登；设备列表传播 best-effort（可能延迟）；官方 App 数据同步仍属后续迭代。
### 6.11 v2.10 真实删除保护联调（QA 独立执行，真实官方码 + 10808）

- 环境：临时 dataDir（真实 identity.json + pairing.json 官方码），真实 IdentityPool/SyncDeviceService/sync-client，代理 10808，端口 18791。
- 结果（`data/tmp/v210-real-integration.json`，§5.12）：分身（DuckCPA@07ac）加入 slots 200 → `DELETE` **409 `identity_in_device_slots`**
  （identityId/deviceName 正确）→ `DELETE ?force=true` **200 `{ok:true,id,removedDevice:true}`** → GET slots `identityIds:["id_default"]`、orphans=0；
  `DELETE id_default?force=true` → **409 `default_identity_protected`**。
- 限界：真实 logout 失败（429/503）时身份仍会删除（仅 warn），设备列表中可能残留服务端条目（best-effort 传播）；手机 App 复核需 Lead 持设备。
### 6.12 v2.11 真实联调（QA 独立执行，官方码 + 10808）

- 环境：临时 dataDir（真实 identity.json/pairing.json），真实 IdentityStore/PairingStore/ChatSummaryStore/DuckClient，代理 10808，端口 18792。
- 结果（`data/tmp/v211-real-integration.json`，§5.13）：GET official-recovery-code 200 完整 code（len=191、source=pairing）；download 200 attachment 且内容一致；
  `/v1/models` gpt-6-luna chars=16000/tokens=5333/capabilities=true；真实消息触发上游 **429/418 限流** → compact 502 `upstream_rate_limited`，标记 BLOCKED（mock 覆盖自动/手动/limit/回退）。
### 6.13 v2.12 真实联调（QA 独立执行，10808）

- 环境：临时 dataDir（真实 identity.json），真实 DuckClient/Pairing/ChatSummary，端口 18794；模型能力真实 200。
- 结果（`data/tmp/v212-real-integration.json`，§5.14）：`gpt-6-luna` compaction_supported=false、`gpt-5.4-mini`=true、input_char_limit=16000；
  真实长会话/多轮均被上游 **418 ERR_BN_LIMIT** 拦截（HTTP 403 upstream_anomaly_check），标记 BLOCKED（mock 覆盖全路径）。

### 6.4 OpenAI 官方 SDK × v2 网关（mock 上游，可离线复现）

- ✅ **4 / 4 PASS**（`node scripts/sdk-check.mjs --base-url http://127.0.0.1:18787 --api-key <test-key> --interval 100`）：
  - `models.list()`：20 models（10 canonical + 10 `duck-` 前缀），含 `gpt-6-luna`
  - `chat.completions.create()` 非流：`chat.completion`，content 非空
  - `chat.completions.create({stream:true})`：逐 chunk 消费，末帧 `finish_reason:"stop"`
  - `responses.create()`：`object:"response"`、`status:"completed"`、`output_text` 非空
- 证据：`data/tmp/sdk-check-v2-mock.json`（v2 强制 API Key + SDK v7 链路）。
- 真实上游 SDK 3 项：BLOCKED（见 §6.1），冷却后用 `--api-key` 复跑。

---

## 7. 验收对照

### 7.1 ARCHITECTURE §1 交付目标（v2 视角）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | `GET /v1/models` 返回 `gpt-6-luna` 等模型 | ✅ | `openai-models.test.js`；smoke；含 v2 免费/付费元数据 |
| 2 | 非流式 + 流式对话返回模型输出 | ✅（mock）/ ⏳（真实上游） | chat 17 项；smoke mock；真实上游待 §6 |
| 3 | `reasoning_effort` 体现于请求体 | ✅（mock） | chat 测试断言透传 `low` + `X-Duckai-Reasoning-Effort` |
| 4 | `web_search` 响应包含 citations | ✅（mock） | chat/responses `url_citation` 断言 |
| 5 | `/v1/images/generations` 返回 base64 | ✅（mock） | images 测试 b64 解码断言 |
| 6 | `/admin` 页面可打开并展示统计 | ✅ | React 产物 + build-check 11/11 + page-check 16/16 |
| 7 | `npm test` 通过 | ✅ | 250/250（exit 0） |

### 7.2 ADMIN_API_V2 §8 验收补充

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 无 API Key 访问 /v1 → 401；带 key 正常 | ✅ | `auth.test.js` |
| 2 | 并发 3 请求上游串行、queueWaitMs 递增、inFlight≤1 | ✅ | `queue.test.js`（mock 观测） |
| 3 | upstream/admin 日志互不混淆、清空互不影响 | ✅ | `logs-split.test.js` |
| 4 | 付费模型默认 403 `model_requires_subscription` | ✅ | `paid-models.test.js` |
| 5 | 会话：创建→3 轮→刷新保留→删除 | ✅ | `sessions.test.js` |
| 6 | 上游异常注入→立即中断 502、不输出完成事件 | ✅ | `strict-protocol.test.js` |
| 7 | React 后台 build 成功、/admin 打开、六页工作、免费/付费区分 | ✅（构建/静态/API 契约）/ ⏳（真实上游交互） | build-check + page-check；浏览器交互由人工验收 |
| 8 | **重新生成**：任意 assistant（含 429 错误消息）可重试、截断后重新请求、SSE 替换该轮 | ✅（mock） | `sessions.test.js` v2.1 retry 用例 6 项 |
| 9 | **推理内容**：明文 reasoning 可折叠显示；仅加密摘要时显示「推理已加密」而非空白 | ✅（mock 数据层） | `reasoningEncrypted` 透出用例；前端文案由 build-check 校验存在 |

### 7.3 IDENTITY-SYNC §5 验收标准（v2.2 共 9 条）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | identity.json 首次生成；重启后 journeyId/deviceId/durableStream 指纹不变 | ✅ | `identity-store.test.js` + `identity.test.js`（重启两次 GET 相同） |
| 2 | GET identity 不返回私钥/token 明文；export 含完整信息可 import | ✅ | `identity.test.js`（脱敏断言 + export→import 新 dataDir 一致） |
| 3 | rotate 后 identity 更新、rotatedAt 更新、新请求用新 journeyId | ✅（本地）/ ⏳（上游日志） | `identity.test.js` rotate journey/device/all；上游日志待额度窗口 |
| 4 | publicKeyJwk 合法 RSA-OAEP-256；真实 chat body 含 durableStream 且上游 200 | ✅ **200 实测** | `identity-store.test.js` + `duck-client.test.js`；§6.5：默认开启、真实 chat **HTTP 200**（content「稳定」）、`durableStreamRejected=0/degraded=false` |
| 5 | sync enable 生成 mainKey/scopedPasswordSeed/encryptedPrivateKey(JWE)/recoveryCode；恢复码跨 identity 还原同一 mainKey | ✅ | `sync.test.js`（enable、JWE 可解密、recovery 导入同 mainKey） |
| 6 | 配对码 v2 结构与 URL；transport blocked → pair 503 且不破坏状态 | ✅ | `sync.test.js`（配对码结构/URL、503+hint、状态不变） |
| 7 | subscription activate 解析 email/tier/entitlements；非法/过期明确错误；GET 字段；DELETE 回 free | ✅（mock JWT） | `subscription.test.js`（plus/pro、422 token_expired/invalid、DELETE→free、verify） |
| 8 | 前端「身份与订阅」页三卡片可用、敏感值掩码、无 console 报错 | ✅（构建/静态契约） | build-check v2.2 身份页文案 + page-check identity/sync/subscription 契约；浏览器交互人工验收 |
| 9 | v2.1 回归：队列/日志拆分/付费模型/会话 retry/严格中断不受影响 | ✅ | `npm test` 250/250（含全部 v2–v2.5 用例） |

### 7.4 PROXY §5 验收标准（v2.3 共 6 条）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | PUT 关闭/开启、四种类型切换；非法字段 → 400 `invalid_proxy`；密码不回显、空密码不覆盖 | ✅ | `proxy-api.test.js`（9 类非法值、密码语义、不发 password）；`proxy-manager.test.js` |
| 2 | POST /proxy/test：HTTP 10808 → ok/status=200/latency/exitIp 为代理出口；错误 host/port → ok:false+code+lastError；禁用时直连 ok | ✅ 真实 10808（§5.6/§6.6） | exitIp=70.39.202.155（http+socks5）；不可达端口 `ok:false`；直连测试分支 |
| 3 | 代理启用后 DuckClient 真实请求走代理；/status 200；chat 200（额度允许时）；healthz.proxy 正确；sync transport 变 available | ✅（链路）/ ⚠️（chat 受 418/429 限流） | `proxy-manager.test.js` 端到端 mock 代理；`duck-client.test.js` proxyManager.fetch 计数；§6.6 真实 `/status` 200、duckduckgo.com 200、sync available；真实 chat SOCKS5 200（duck-protocol）/HTTP 418 额度 |
| 4 | 代理关闭后行为与 v2.2 完全一致（回归全绿） | ✅ | `npm test` 250/250（v2.0–v2.5 全部用例） |
| 5 | 前端代理页可保存/测试/状态展示；身份页 Sync blocked 文案带代理引导；无 console 报错 | ✅（构建/静态契约） | build-check「v2.3 代理页文案」11/11；page-check proxy 契约 16/16；浏览器交互人工验收 |
| 6 | 自动化：npm test 全绿；build-check/page-check 覆盖代理页与端点 | ✅ | 250/250、build-check 11/11、page-check 16/16 |

### 7.5 IDENTITY-POOL §8 验收标准（v2.4 共 8 条）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 配对码生成后显示可扫描二维码（内容=配对 URL），可下载/复制；QR 与 code2 URL 一致 | ✅（数据层+源码/产物）/ ⏳（浏览器人工） | `identity-qr.test.js`（qrcode→PNG data URL、identity.tsx `QRCode.toDataURL`+`<img src=data:image>`、下载/复制按钮、构建产物标记）；浏览器点击由 Lead 人工验收 |
| 2 | 批量生成 3 身份 journeyId/deviceId/指纹互异；列表正确；导出→导入新池一致 | ✅ | `identity-pool.test.js` generate/export-import；`identity-pool-api.test.js` generate/list |
| 3 | 创建 4 个测试会话各自绑定（hash 分布合理）；同会话多轮 identityId 不变；重启后不变 | ✅（mock+真实） | `identity-routing.test.js`（X-Session-Id/无 header/重启）；§5.7/§6.7 真实 2 身份 200；4 会话分布见 module hash 用例 |
| 4 | 同身份并发串行（queueWaitMs 递增/inFlight≤1）；不同身份并行 | ✅ | `identity-pool.test.js` 队列 2 项（rps=1、peakInFlight、queue_full/queue_timeout） |
| 5 | 付费模型无订阅→403；绑定订阅身份后路由该身份 | ✅ | `identity-pool.test.js` 付费过滤；`identity-routing.test.js` 403/200+绑定；Admin subscription 用例 |
| 6 | 导入/导出/删除/禁用/轮换/会话手工绑定解绑正确；删除被绑定默认 409 | ✅ | `identity-pool.test.js` CRUD/rotate/delete 409+force；`identity-pool-api.test.js` bindings/delete force |
| 7 | 长会话/`ERR_CONVERSATION_LIMIT` 自动裁剪重试（或按配置映射），会话标记 contextTrimmed | ✅（mock）/ ⏳（真实超长） | `context-guard.test.js` 6 项（trim 重试、onLimit=error 409/413、context_trimmed、maxInputChars/maxMessages）；真实超长会话 BLOCKED |
| 8 | 回归：npm test 全绿；build-check/page-check 含身份池页与二维码；浏览器无 console 报错 | ✅（自动化）/ ⏳（浏览器） | 250/250；build-check 11/11；page-check 16/16；浏览器人工验收 |

### 7.6 v2.5 并发 / 扫码配对验收（Lead 任务口径，4 组）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 后端并发：不同身份会话并行（≈max）、同身份串行（≈sum、peakInFlight=1）、同会话 409 `session_busy`、日志/done 带 identityId/queueWaitMs、`/v1` 不同 X-Session-Id 并行/同身份串行 | ✅ | `tests/concurrency.test.js` 4 项（含 `X-Duckai-Identity-Id`/日志/done 断言）；真实双 200（§5.8） |
| 2 | 前端 jsdom：A 慢流时 B 可发送、切会话不中断 A 且写回 A、同会话重复发送提示忙、列表「生成中」徽章、无 console 报错 | ✅ | `tests/web-concurrency.test.js` 2 项（真实构建产物 + jsdom + mock SSE；console 0 报错） |
| 3 | 配对：信封 round-trip、start→PUT 204+QR、hello、404/sequence gap/超时、status 状态机；**joiner（available 不回 unavailable→response→completed(joiner)）**、host(same_account/awaiting/confirmed/denied)、Admin 与官方恢复码落盘 | ✅（模块+Admin+joiner 端到端）/ ⏳（真实手机复测） | `tests/pairing.test.js` 14 项；`tests/pairing-api.test.js` 4 项；`tests/pairing-joiner-api.test.js` 4 项（含冲突策略）；真实 start 200/waiting（§5.8/§5.9） |
| 4 | 脚本与真实联调：build-check 并发/配对文案、page-check pairing 契约、真实 2 身份并行消息 + 配对真实 start（代理 10808） | ✅ | build-check 11/11（v2.5 项）；page-check 16/16（pairing 项）；§5.8/§6.8 真实数据 |

### 7.7 v2.8 设备注册 / 设备名 / 轮换确认验收（Lead 任务口径，5 组）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | sync-client：HKDF（scopedPassword/hashed_password）、login device_name/type JWE 可解、account_info 缺失创建（RSA3072+DER JWE+set-if-absent）、PATCH updates id+info 可解 {name,type}、GET devices 含本机、错误映射 | ✅ | `tests/sync-client.test.js` 8 项（含独立 HKDF 复算、JWE 解密、DER 3072、嵌套 devices）；真实 login/keys/PATCH 见 §6.9 |
| 2 | Admin：register-device 400/503+hint/200/418→429+Retry-After、server-devices 脱敏/current/缓存、DELETE（当前 400）、`GET /sync.server`、joiner 自动注册、deviceName 默认 DuckCPA@xxxx 稳定/自定义/旧名迁移 | ✅ | `tests/sync-devices-api.test.js` 8 项 + `tests/sync-devices.test.js` 10 项 + `tests/pairing-auto-register.test.js` 1 项；page-check v2.8 契约 |
| 3 | 轮换：rotate 响应 identityLost:true+note；前端 jsdom 两步确认、第二步含不可恢复/身份丢失、取消不调 API | ✅ | `tests/web-rotate-confirm.test.js` 2 项（真实构建产物；含设备列表删除确认）；`tests/sync-devices-api.test.js` rotate 断言 |
| 4 | 构建/脚本：build-check 设备列表/轮换警告、page-check server-devices/register-device | ✅ | build-check 12/12；page-check 17/17（sync 设备契约） |
| 5 | 真实联调：register-device 200、server-devices 含本机 DuckCPA@xxxx | ✅ | §5.10/§6.9（真实官方码 + 10808，total=5 current DuckCPA@498a） |

### 7.8 v2.9 设备名 / 设备槽验收（Lead 任务口径，5 组）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 每身份设备名：id_default=DuckAI@main、其它 DuckCPA@<4hex>（create/generate 持久化）；PATCH deviceName；池 items；DELETE id_default → 409 default_identity_protected | ✅ | `tests/device-slots.test.js`（池设备名/PATCH/默认保护 409 force 亦拒） |
| 2 | device-slots：GET 默认含 id_default；PUT 增量注册/注销（批量调用次数、`identity.sync.slots` 持久化/重启）；空列表；非法/禁用 400；418→429；serverDevices 解密 name/type + matchedIdentityId | ✅ | `tests/device-slots.test.js` 6 项（stateful fake 验证 registerDevices/logoutDevices 各一次） |
| 3 | sync-client 多设备：registerDevices 批量（真实每设备 login+PATCH）、listDevicesDetailed 解密、logoutDevices 批量（404 容忍/自动重登） | ✅ | `tests/sync-client-multidevice.test.js` 3 项（updates=1×N、HONOR 解密、404 removed 排除） |
| 4 | 前端 jsdom：身份池设备名/默认删除 disabled、两栏拖拽、未保存提示、保存 PUT payload、保存后刷新、429 文案；build-check/page-check 契约 | ✅ | `tests/web-device-slots.test.js` 2 项（真实产物 + DragEvent 模拟）；build-check 13/13、page-check 18/18 |
| 5 | 真实联调：GET device-slots → PUT [id_default,分身] → My Devices 出现 DuckAI@main+DuckCPA@xxxx → PUT [id_default] 注销 | ✅（协议/接口）/ ⏳（手机 My Devices 人工复核） | §5.11/§6.10：双设备注册 200、serverDevices 解密 HONOR/DuckCPA@70e7、注销 200；手机端可见性需 Lead 持设备复核 |

### 7.9 v2.10 删除/禁用保护 + 孤儿自愈验收（Lead 任务口径，5 组）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 删除保护：在 slots 身份 DELETE 409 `identity_in_device_slots`（hint/identityId/deviceName、状态不变）；force → logoutDevices+slots 清理+删除+removedDevice:true；默认身份 force 仍 409 | ✅ | `tests/device-slots.test.js` 删除保护用例（真实池 + fake logout）；page-check 409/force 契约；§5.12 真实 409→force 200 |
| 2 | 禁用：enabled:false 在 slots → 409；force → 注销+移出 slots+禁用 | ✅ | `tests/device-slots.test.js` 禁用保护用例 |
| 3 | 自愈：GET 过滤不存在/禁用并返回 orphans；?reconcile=true 清理；PUT 不存在 400、重复去重、默认身份缺失 400；DELETE 后 slots 全量清理 | ✅ | `tests/device-slots.test.js` 孤儿用例 + 旧 PUT 用例更新（PUT []/缺默认身份 400）；page-check orphans/reconcile |
| 4 | 前端 jsdom：独立设备列表卡、409 弹窗两操作、force ?force=true、orphans 提示+清理、默认身份无 force；build-check/page-check 契约 | ✅ | `tests/web-device-protection.test.js` 3 项（真实产物）；build-check 14/14、page-check 19/19 |
| 5 | 真实联调：分身加入 slots → 删除 409 → force 成功、slots 无残留 | ✅（接口）/ ⏳（手机设备消失人工复核） | §5.12/§6.11（407 双设备注册、真实 409/force 200、orphans=0） |

### 7.10 v2.11 compact / 模型上下文验收（Lead 任务口径，5 组）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | compact 协议层：buildSummaryPrompt 指令、serializeMessages 跳过 reasoning、增量 previousSummary、模型能力字段 | ✅ | `tests/compact.test.js` 13 项（含原生 summarizeNative 优先/回退/418-429 不回退） |
| 2 | 后端：未超阈值不压缩；超 triggerChars 自动压缩（summary+最近 N、持久化、done.compacted）；ERR_CONVERSATION_LIMIT 压缩重试；失败回退 trim；手动端点；X-Session-Id 复用；重启保留 | ✅ | `tests/compact-session.test.js` 7 项；page-check 手动 compact 契约 |
| 3 | 模型能力：/v1/models 与 /admin/api/models 字段一致 | ✅ | compact-session 能力用例 + page-check v2.11 |
| 4 | 前端 jsdom：模型下拉上下文、压缩按钮 loading/成功、summary 徽章展开/复制、自动压缩提示条、无报错；build/page 契约 | ✅ | `tests/web-compact.test.js`（真实产物）；build-check 15/15、page-check 21/21 |
| 5 | 真实联调：多轮触发自动压缩并继续对话 | ⏳ BLOCKED（上游 429/418 额度；mock 覆盖全路径） | §5.13/§6.12 |

### 7.11 v2.11 官方恢复码查看/下载验收（Lead 任务口径，5 组）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | GET 返回完整 code/source/length；未配置 null | ✅ | `tests/recovery-code-reveal.test.js`；page-check |
| 2 | download 200 + Content-Disposition + 内容等于 code；404/401 | ✅ | 同上（text/plain/no-store/code+换行） |
| 3 | 脱敏边界：其它 /sync/error/日志不含完整 code | ✅ | 脱敏边界用例 |
| 4 | 前端 jsdom：完整展示/复制/下载/配对后自动刷新/未配置提示；build/page 契约 | ✅ | `tests/web-recovery-code.test.js`（QR Modal 含 data:image/复制/下载 PNG/关闭；未配置提示由 page-check/build-check 覆盖） |
| 5 | 真实账号：GET/download 一致 | ✅ | §5.13/§6.12（len=191、source=pairing、内容一致） |

### 7.12 v2.12 compact 触发语义 + 摘要折叠块验收（Lead 口径，4 组）

| # | 标准 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | duck 语义：isCompactionSupported（白名单/gpt-6-luna false）、shouldCompact（activation/fallback pair>=4/covered 边界）、parseCompactMarkers（URL 编码 JSON/thresholdTokens/INVALID/LIMIT/FIXED_COST） | ✅ | `tests/compact-semantics.test.js` 10 项 |
| 2 | 后端：gpt-6-luna 长会话不压缩；gpt-5.4-mini 达 activation/4 pairs 才压缩；SUMMARY_REFRESH_HINT→pendingCompaction；LIMIT_CONVERSATION 压缩重试；手动任意模型；summary PATCH/DELETE；能力字段两 API 一致 | ✅ | `tests/compact-v212.test.js` 9 项 + page-check v2.12 |
| 3 | 前端 jsdom：折叠块默认收起/展开全文/复制/编辑 PATCH/清除 DELETE、头部徽章联动、模型支持/不支持标识、自动压缩提示；build/page 契约 | ✅ | `tests/web-compact-v212.test.js` + `tests/web-compact.test.js`（v2.11 更新为折叠块）；build 16/16、page 22/22 |
| 4 | 真实联调：gpt-6-luna 长回答不触发；gpt-5.4-mini 多轮触发 | ⏳ BLOCKED（上游 418，§5.14/§6.13；mock 覆盖） | 模型能力真实 200 |

---

## 8. v2 契约差异与裁决记录（实现最终态）

1. **旧 `POST /admin/api/test` 已删除 → 404 `not_found`**（task-5/用户要求；`docs/ADMIN_API_V2.md` §5.2 中
   "兼容保留"一句为旧残留，以 404 为准）。
2. **418 ERR_CHALLENGE**：映射为 `upstream_anomaly_check`（403），但**保留传输层 418 重试**
   （刷新挑战后重试；耗尽后抛 anomaly）。测试覆盖两条路径。
3. **429**：OpenAI 层归一化为 `rate_limit_exceeded`（type/code 一致），带 `Retry-After`/`X-Duckai-Retry-At`。
4. **SSE 数组 payload** 在 v2 严格模式下视为 `unknown` 帧（不再展开）；无 role 帧按 assistant keep-alive
   （`text-empty`）处理；未知 role → `unknown-event`（严格模式中断）。
5. **首事件前失败**：/v1 chat/responses 与 session messages 一律 HTTP JSON（429/502/403），不写 SSE 头；
   流开始后失败才发 error 事件。
6. **默认 API Key** 由 `src/index.js` 启动流程创建（`createServer` 不创建）；keys 为空时自动重建 default。
7. **队列参数**：`queueTimeoutMs` 最小夹取 1000ms；`queueLimit=0` 表示不允许排队；队列配置实时生效。
8. **会话上限**：最多 100 会话（淘汰最旧）；每会话 200 条消息，第 201 条返回 400 `session_message_limit`
   （拒绝而非静默丢弃）。
9. **v2.1 retry 语义**：`messageId` 必须是 assistant；服务端**先校验** session/message/role/历史，
   **后加流式锁**（`beginStream`）；随后截断该 assistant 及其后消息、保留目标轮 user、重调上游并以新 assistant 替换。
   SSE `session.retryOf` / `done.message.retriedFrom` 指向被替换的旧消息 id。
   错误码：`404 session_not_found` / `404 message_not_found` / `409 message_not_assistant` /
   `400 invalid_history`（目标 assistant 前无 user）/ `409 session_busy`（同会话已有流式请求）。
   ⚠️ 注意顺序：若目标消息已被前一次 retry 截断，则并发 retry 得到 `404 message_not_found` 而非 busy——
   这是"先校验后加锁"的预期行为，测试按此断言。
10. **v2.1 reasoningEncrypted**：assistant 消息新增 `reasoningEncrypted` 布尔字段（GET/SSE 均透出）；
    上游仅返回加密摘要时 `reasoning=""` + `reasoningEncrypted=true`；明文时 `false` 且 `reasoning` 有值。
11. **v2.2 identity 文件与稳定性**：`data/identity.json`（同目录 `identity.json.tmp-*` → rename 原子写、权限尽力 0600）；
    损坏文件备份为 `identity.corrupt-<ts>.json` 后重建；`journeyId` 32 hex、`deviceId` uuid v4 跨重启不变。
12. **v2.2 durableStream 默认开启**：`identity.durableStream.enabled` 默认 **true**（DEFAULT_CONFIG/normalize/migration
    与 `config/config.example.json` 一致，Lead 实测裁决；上游公共 JWK 现已接受）。DuckClient 仍保留自动降级：
    上游 400 → 去 durableStream 重试 1 次 + `durable_stream_rejected` 计数 + `health().durableStream.degraded=true`；
    `config.durableStream.enabled=false` 可显式关闭。未注入 identityStore 的旧用法降级为 volatile
    （随机 journeyId、不发 durableStream、health stable=false）。
13. **v2.2 身份脱敏边界**：`GET /admin/api/identity` 与 `/admin/api/subscription` 永不返回
    `privateKeyJwk` / token 明文；仅 `GET /identity/export`（附件下载）与 `POST /identity/reveal`（必须 `confirm:true`，
    且仅允许 `token`/`mainKey`）可获取敏感值。
14. **v2.2 sync 恢复码**：`createRecoveryCode` 产物含 JWE 包裹的 RSA-2048 私钥 JWK（实测 ~3.3KB），
    解析上限按恢复码放宽到 64KB（配对码仍 2048）；`decodeRecoveryCode` 返回 `{ok,recovery:{user_id,main_key,
    scoped_password_seed,encrypted_private_key}}`。
15. **v2.2 sync 传输与错误**：`detectSyncTransport()` 探测 duckduckgo.com（默认 3s 超时）→ 本沙箱 `blocked`；
    `POST /sync/pair` 在 blocked 时 **503 `sync_transport_unavailable` + error.hint**，本地状态/设备数不变；
    未启用 sync 时 `GET /sync/recovery-code` → 200 `{recoveryCode:null}`（不抛 409）。
16. **v2.2 订阅**：activate 仅解析 JWT payload（HS256 签名不校验，符合匿名网关用途）；过期 → **422 `token_expired`**、
    格式非法 → **422 `token_invalid`**；在线 verify 失败仍 200 `{ok:true,subscription:{verified:false,verifyError}}`；
    `verified` 的语义是 `verifyScope:"reachability"`（本地解析 + 上游可达；匿名 `/status` 不校验 Bearer），
    响应带 `verifyNote`，`identity.auth.verifyScope` 同值。
    `expiresAt` 在部分响应中为 ISO 字符串、部分为秒级时间戳，测试统一换算后断言。
17. **v2.3 代理配置与即时生效**：`config.proxy` 由 ProxyManager 持有；`PUT /admin/api/proxy` 深合并 → manager.update
    校验原始 patch（失败 400 `invalid_proxy` + field）→ 重建 dispatcher（旧实例 30s 宽限后关闭，进行中请求用旧实例完成）；
    `GET /admin/api/proxy` 永远不含 `password`，只给 `hasAuth`（= username‖password；`password:""` 只清密码，
    要 `hasAuth:false` 需同时清 username）。
18. **v2.3 代理类型与 dispatcher**：`http/https` 用 undici `ProxyAgent`（https=到代理的 TLS）；`socks4/socks5` 用
    `Agent` + 自定义 connector（`socks` 包；https 目标由 connector 自行 TLS）；`enabled:false` → 无 dispatcher（direct）。
    `noProxy` 仅精确/`*.suffix`/hostname 后缀匹配（`*.internal` 写法；`.internal` 不匹配）。
19. **v2.3 `test()` 语义**：用临时 dispatcher，**不改保存配置**（但会写回 `status.lastTest*`）；`test()` 同样应用
    `noProxy`（命中 → `mode:"direct"`、`bypassNoProxy:true`）；非法 overrides 不抛，返回
    `{ok:false, code:"invalid_proxy", invalidField}`；`exitIp` 在 `ipCheckUrl` 可达时返回。
20. **v2.3 代理不可用兜底**：未注入 proxyManager 时 `GET/PUT /admin/api/proxy`、`POST /proxy/test` 返回
    502/503 `proxy_unavailable`（明确不可用，不 500、不泄漏）；`healthz.proxy` 仍给出 direct/disabled 概要（注入后）。
21. **v2.3 sync 与代理**：代理启用（`enabled:true`）时 `detectSyncTransport` 走 `proxyManager.fetch` 探测
    duckduckgo.com → `transport:"available"`，`POST /sync/pair` 返回 **501 `sync_handshake_unimplemented`**
    （PROXY.md §6，跨设备握手仍未实现）；代理关闭/不可达 → blocked（`reason:"proxy_disabled"`）+ 503。
    `IdentityStore._transport` 支持 `sync.transport` 手动覆盖（测试/运维用），生产不设置。
22. **v2.3 `/proxy/test` 非法 overrides 统一语义（最终态）**：`POST /admin/api/proxy/test` 对**所有**非法
    overrides（type/port/host/noProxy/testUrl/ipCheckUrl/enabled 等）统一返回 **HTTP 200**
    `{ok:false, code:"invalid_proxy", invalidField:"<字段>", error, status:null, exitIp:null, testedAt}`
    （契约 §3.3「测试失败也用 200」）；`PUT /admin/api/proxy` 仍为 **400 `invalid_proxy` + param**（契约 §3.2）；
    连接失败仍为 200 `{ok:false, code:"proxy_connect_failed|proxy_timeout|proxy_tls_failed"}`；
    成功响应透出 `bypassNoProxy`。`tests/proxy-api.test.js` 已按统一语义断言（8 类非法字段 + PUT 仍 400）。
23. **v2.4 身份池数据与迁移**：`data/identity-pool.json`（version 1、activeId、随机 salt、identities、bindings，原子写；
    损坏 → `identity-pool.corrupt-<ts>.json` 后重建）。首次 init 无 pool 文件但有 `identity.json` → 迁移为
    `id_default`（label 默认身份、activeId 指向、**原文件保留**）；`pool.maxIdentities` 默认 20（1–100），
    bindings 上限 5000（超出按 updatedAt 淘汰最旧）。
24. **v2.4 路由策略**：`hash`（默认）严格公式 `parseInt(sha256(sessionKey+':'+salt).slice(0,8),16) % candidates.length`，
    候选 = enabled（付费再过滤 subscribed）按 id 升序；绑定写 `bindings[sessionKey]` 后固定（跨重启一致）；
    `least-loaded` 按每身份 inFlight/waiting 选；`PATCH /identities/router` 可切策略/轮换 salt（只影响新绑定）；
    sessionKey 来源：`X-Session-Id` > body `session_id`/`conversation_id`；测试会话用 `sess_xxx`；无 → 单轮
    least-loaded 且不写绑定。绑定身份禁用/删除 → 503 `identity_unavailable`。
25. **v2.4 每身份队列**：每身份 `rps=1`、`maxConcurrent=1`；`pool.queueLimit`（默认 50，`waiting.length>=limit` 拒绝）、
    `pool.queueTimeoutMs`（默认 300000，**配置最小 clamp 1000ms**）；队列满/超时 → 429 `queue_full`/`queue_timeout`
    （带 retryAfterMs）；不同身份互不影响；每身份独立 runtime（DuckClient 实例，懒加载/空闲回收），
    `queueStats(id)` 暴露 waiting/inFlight/requests/peakInFlight/totalWaitMs。
26. **v2.4 订阅绑定与付费路由**：`PATCH {subscribed}` 或 `POST /identities/:id/subscription {token}`（JWT 解析 +
    reachability 语义同 v2.2）绑定；付费模型请求（`allowPaidModels=true` 且模型 paid）**只路由
    subscribed && enabled**，无候选 → 403 `model_requires_subscription`（type `model_unavailable`）；
    会话已绑定未订阅身份 → 同 403；免费模型不受影响。`DELETE` 解除。
27. **v2.4 上下文守卫（server 层）**：`config.context={maxInputChars:12000,maxMessages:40,onLimit:'trim'|'error'}`
    （maxInputChars clamp 1000–200000）；发送前从最新往前累计保留最近消息 + system，超限丢弃旧消息 →
    `/v1` 顶层 `context_trimmed:true`；上游 `conversation_limit_reached`（409）/`input_limit_reached`（413）在
    trim 模式再激进裁剪（保留最近一半）**重试一次**；`onLimit:"error"` 不重试直接 409/413；会话 assistant
    消息 `contextTrimmed` 由 sessions store 记录。**不做真正摘要生成**（无额外模型调用），仅裁剪保可用性。
28. **v2.4 日志与观测**：upstream 日志新增 `identityId`/`identityLabel`（v1 与 admin-test 均写）；`/healthz.identityPool`
    = `{total,enabled,subscribed,busy}`；`/admin/api/overview.identities` = `{pool,items:[identitySummary+queue]}`；
  `/v1` 响应附加 `X-Duckai-Identity-Id` 头（路由后）。`GET /admin/api/identities` 不返回 salt；列表/详情不含私钥/token，
  仅 `export` 返回完整身份。
29. **v2.5 会话并发路由（最终态）**：测试会话 messages/retry 在 `session.identityId` 存在时**只走**
    `identities.run(identityId)`（每身份 rps=1、maxConcurrent=1）：不同身份会话并行、同身份会话串行；
    同会话同时只允许一个流（`beginStream` 锁）→ 第二个 `409 session_busy`（带 `Retry-After:1`、
    `X-Duckai-Retriable:true`）；非零排队时响应头 `X-Duckai-Queue-Wait`；SSE done 顶层与 `done.message` 均含
    `identityId`/`queueWaitMs`；upstream 日志同样带 identityId/queueWaitMs。
30. **v2.5 扫码配对协议**：`PairingHost.start()` → `PUT {syncBase}/v2/exchange/<uuid>`（2xx 视为成功；404→write_channel_lost）
    → 返回 `{channelId,pairingCode,url/qrUrl,publicKeyBase64Url,createdAt,expiresAt}`，state=waiting 并轮询
    `GET .../messages?after=<seq>`；信封 5 段 `[headerB64,encKeyB64,ivB64,ctB64,tagB64]`（header alg=RSA-OAEP-256、
    enc=A256GCM、typ/kid/iat；AES-256-GCM、AAD=headerB64；encKey=RSA-OAEP-256(peerPub, AESkey)）。
    hello 校验 channel_id/public_key/version(2.x)→回 hello 到 scanner 频道→state=exchange；错误：
    `read_channel_lost`(GET 404)/`write_channel_lost`(POST 404)/`network`/`sequence_gap`(seq 必须连续)/`self_scan`/
    `version_mismatch`/`peer_key_changed`/`protocol_violation`；`waitForPeer` 超时→`PairingError{code:'timeout'}`。
    exchange 分支（**task-26b 修复后最终态**）：
    - `recovery_code_available`（对方/手机已有账号）→ **不回任何消息**，`state='exchange'`、
      `substate='joiner_awaiting'`、记录 `peerUserId`；随后 `recovery_code_response`（`recovery_code` 为
      base64/base64url JSON `{recovery:{user_id,secret}}`，兼容裸 JSON/顶层 `{user_id,secret}`）→ 解析、
      `completedAs='joiner'`、`endReason='completed'`；`status().recoveryCode`（原文）/`recoveryUserId`/
      `recoveryCodeReceived=true`/`accountConflict`，`onCompleted(status)` 顶层同样带这些字段。
    - `recovery_code_request`（对方无账号）+ 本地官方码（`account.getRecoveryCode()` 或 `{userId,secret}`
      现场编码）→ 回 `recovery_code_response`（原始字符串）→ completed(host)；本地无码 →
      `recovery_code_unavailable` → failed(unavailable)。
    - `same_account`（`account.userId === message.user_id`）→ completed、`endReason='same_account'`；
      `recovery_code_awaiting_confirmation` → `substate='awaiting_confirmation'`（不回）；`recovery_code_confirmed`
      → completed；`recovery_code_denied` → failed `endReason='denied'`；`recovery_code_unavailable` →
      failed `endReason='unavailable'`。新增导出 `encodeOfficialRecoveryCode({userId,secret,format})` /
      `parseOfficialRecoveryCode(code)`。
31. **v2.5 配对 Admin 契约**：`POST/GET/DELETE /admin/api/sync/pairing`（POST 需 sync 已启用，否则 **400 sync_not_enabled**；
    已有活动会话→409 `pairing_in_progress`；network/timeout→**503 `sync_transport_unavailable` + hint**；其它→502
    `pairing_start_failed`；GET 无会话 `{pairing:null}`，有则脱敏状态（含 `accountAvailable`、`completedAs`，
    **不返回恢复码明文**）；DELETE 停止）；未注入→503 `pairing_unavailable`。
    `GET/PUT/DELETE /admin/api/sync/official-recovery-code`（GET 仅 `{configured,hasCode,updatedAt,preview,length}`，
    不回显明文；PUT body `{code}`；存储 `data/pairing.json` 原子写 0600）。
    **joiner 落盘**：`PairingService.onCompleted(status)` 中 `completedAs!=='host'` 且 `status.recoveryCode` 存在 →
    `pairingStore.setRecoveryCode(code)`；此后 GET 官方码 `configured:true`、`GET /sync/pairing`
    `accountAvailable:true`、`state='completed'`、`completedAs='joiner'`，且 `account.getRecoveryCode()` 返回该码。
    pairing 成功后**不写** `identity.sync`。
32. **v2.5 OpenAIError 透出 hint/detail**：`errorPayload` 会输出 `error.hint/detail`（构造器保存 + toOpenAIError
    再包装保留），identity/proxy/pairing 等 503 均带 hint；测试按 strict 断言。
33. **v2.5 前端并发实现**：连接测试按会话独立 SSE 缓存 + 每会话 AbortController；列表「生成中」徽章；停止只停当前会话；
    同会话重复发送命中 409 `session_busy`/守卫 → toast「该会话正在生成中」且只发一个请求；身份页扫码配对接真实
    `/admin/api/sync/pairing`（注册成功后才显示二维码、1.5s 轮询、关闭 DELETE、实验性标注/官方恢复码）。
    前端并发由 `tests/web-concurrency.test.js` 在 jsdom 中对**真实构建产物**断言。
34. **v2.8 Sync 加密细节（以真实 duck.ai 为准）**：login 的 device_name/type 用 `scopedPassword` 作 KEK 的 JWE
    （kid=3party）；`account_info.encrypted_private_key` 明文是 **PKCS#8 DER 字节**（不是 JWK JSON），必须 `decryptJwe`
    拿 Buffer 后用 `crypto.createPrivateKey({key,format:"der",type:"pkcs8"})`；设备 info 用 account_info **公钥**加封（
    RSA-OAEP-256+A256GCM，kid=account kid），私钥可解 `{name,type}`。
35. **v2.8 设备名策略**：默认 `DuckCPA@<4hex>`（首启生成、持久化 identity.json + 回写 config）；`deviceName` 自定义
    1–64 字符即时生效、`null` 重新生成；rotate 不改变 deviceName；`register-device` 使用服务端 deviceName（body 不覆盖）。
36. **v2.8 服务端设备与错误码**：未注入 syncDevices → 设备端点 503 `sync_transport_unavailable`+hint；无官方码
    400 `recovery_code_not_configured`；非法码 400 `invalid_recovery_code`；401 `sync_unauthorized`；其它 login/register
    失败 502 `sync_login_failed`/`sync_register_failed`；删除当前设备 400 `invalid_device`；server-devices 不返回 info 密文。
37. **v2.8 rotate identityLost**：rotate 响应 `identityLost:true` + note（旧身份无法恢复），前端必须两步确认；
    第二步取消/关闭不调用 API。该字段为前端警告依据（服务端语义不变）。
38. **v2.8 joiner 自动注册**：PairingService onCompleted 异步触发 `syncDevices.autoRegister()`（失败只 warn/lastError，
    不改变 pairing completed），成功后 `sync.server.registered=true`；pairing status 不新增 deviceRegistration 字段。
39. **v2.8 quick fix（限流/缓存/迁移）**：Sync `/login` 418 → Admin 429 `sync_rate_limited`（`rate_limit_error`）+
    `Retry-After:120` + hint，并进入 2 分钟进程级 cooldown（register/list/delete 直接 429、不请求上游；到期自动恢复）；
    Sync token 仅进程内存；`server-devices` 无 live session 时用 `identity.sync.server.devices` 缓存；旧设备名
    `DuckAI CPA …` 自动迁移为 `DuckCPA@<4hex>`（写 identity + config，GET 懒迁移）。
40. **v2.10 slots 删除/禁用保护顺序**：`id_default` 优先（force 也无条件 409 `default_identity_protected`）；非默认在 slots → 409 `identity_in_device_slots`；force 时 logout 失败不阻塞（身份仍删、removedDevice:true、warn 日志）。
41. **v2.10 默认身份必须在 device-slots**：PUT 不含 `defaultIdentityId` → 400 `invalid_identity`（hint 说明默认身份不可移除）；前端拖拽区保留默认身份（不可保存移除）。
42. **v2.10 自愈语义**：GET/PUT `?reconcile=true`；missing 孤儿仅清理 slots（无 deviceId 不误删设备），disabled 孤儿先 logout 再清理；PUT 对已删除 saved slot 跳过（不 404），持久化合法列表。
43. **v2.10 前端设备列表独立卡片**：Sync & Backup 卡不再含拖拽区，独立 `ddg-device-list-card`；删除 409 弹窗两操作（先去移除/force），force 二次确认「强制删除并注销设备」；orphans 横幅「清理失效设备」→ `PUT ?reconcile=true`。
44. **v2.11 compact 原生优先**：`summarizeMessages` 优先 `client.summarizeNative`（`/duckchat/v1/summarize`），不调用 chat；原生非 418/429 失败回退 chat（native:false/fallbackReason），418/429 原样抛出；返回 native/summaryVersion/coveredPairCount/fixedCostWindowUsage 等字段。
45. **v2.11 compact 阈值与配置**：`context.compact.triggerChars` 最小 1000（config 归一化 clamp）；`maxSummaryChars` 最小 200；PUT config 即时生效；摘要作为 `[对话摘要]` 初始上下文并入 system prompt。
46. **v2.11 手动 compact**：`POST /admin/api/test/sessions/:id/compact`；404 `session_not_found`、400 `nothing_to_compact`；重复调用以 previousSummary 再摘要（幂等不报错）。
47. **v2.11 官方恢复码明文**：仅 GET `/sync/official-recovery-code`（admin token）与 `/download` 返回完整 code；其它 /sync 响应/错误/日志保持脱敏（preview/present）；download 文件名 `duckduckgo-official-recovery-code-<ISO>.txt`、body=code+换行、no-store。
48. **v2.12 模型白名单**：duck.ai 仅 9 个白名单模型自动压缩，`gpt-6-luna` 永不自动压缩（手动 compact 仍可用）；`claude-haiku-5-5` internal-only（internalTier=true 才 true）。
49. **v2.12 pair 触发**：activePairs=floor(assistant active 消息/2)；有 `activation_target_pair_count>0` 时 `activePairs>=它`；否则 `activePairs-coveredPairCount>=4 && activePairs>=4`；`triggerChars` 默认 200000 仅安全兜底（0=禁用）。
50. **v2.12 pendingCompaction/summaryInvalid**：`[SUMMARY_REFRESH_HINT:<urlencoded JSON>]` 写入 `session.pendingCompaction`（done/assistant/session 透出，正文剥离）；`[SUMMARY_INVALID]`→summaryInvalid；手动/自动摘要成功/编辑 summary 后清空。
51. **v2.12 summary 管理**：`PATCH .../sessions/:id/summary` body `{text,version?,coveredPairCount?,coveredMessageCount?,anchorId?,savedChars?,tokenThreshold?}`（text 非空<=20000，trigger=manual；非法 400 invalid_summary）；`DELETE .../summary` → `{ok,cleared:true,summary:null}`，后续请求恢复全量历史。
31. **v2.9 每身份设备名**：`id_default` 的设备名固定/迁移为 **`DuckAI@main`**（旧默认 DuckAI CPA/空/v2.8 DuckCPA@xxxx → 迁移；自定义保留）；其它身份 `DuckCPA@<4hex>`（create/generate 生成并持久化、池内尽量唯一，可自定义）。`PATCH /admin/api/identities/:id {deviceName}`（1–100 字符）持久化并出现在池 items；`GET /identities` items 含 deviceName/deviceId。
32. **v2.9 默认身份保护**：`DELETE /admin/api/identities/id_default` → **409 `default_identity_protected`** + hint（`?force=true` 同样拒绝）；默认身份不可删除。
33. **v2.9 设备槽（`GET/PUT /admin/api/sync/device-slots`）**：GET 默认 `identityIds=["id_default"]`，返回 slots（identityId/deviceId/deviceName/registered/matchedIdentityId）、serverDevices（解密 name/type、matchedIdentityId）、server 摘要；PUT `{identityIds}` 去重、增量：新增→batch `registerDevices`、移除→`logoutDevices`；持久化 `identity.sync.slots`（主 identity 原子写，重启保留）；空数组合法（移除全部设备槽，账号/配对 key 保留）；非法/禁用身份 400 `invalid_identity`；418→429 `sync_rate_limited`+Retry-After；成功后返回最新 slots/serverDevices。`registerDevices` 真实服务每设备单独 login+PATCH（N 次、每次 1 update）。
34. **v2.10 删除保护**：身份在设备槽时 `DELETE /admin/api/identities/:id` → **409 `identity_in_device_slots`**，`error` 顶层含 `hint/identityId/deviceName`，状态不变；`?force=true` → best-effort `logoutDevices([deviceId])`（失败仅 warn、不阻塞）→ 清理 `identity.sync.slots` → 删除身份 → `{ok:true,id,removedDevice:true}`；默认身份优先级最高，即使 force 仍 **409 `default_identity_protected`**。
35. **v2.10 禁用保护**：`PATCH /identities/:id {enabled:false}` 在 slots → 409 `identity_in_device_slots`；`?force=true` 或 body `{force:true}` → 注销设备 + 移出 slots + 禁用（响应 `{identity,removedDevice:true}`）。
36. **v2.10 设备槽自愈/独立卡片**：GET device-slots 过滤不存在/禁用身份并返回 `orphans:[{identityId,deviceId,deviceName,reason:"missing"|"disabled"}]`；`?reconcile=true`（GET 与 **PUT 空 body**）注销可注销孤儿设备并持久化清理 slots，返回 `reconciled:{loggedOut,cleaned}`；PUT 含不存在/禁用 400、重复去重、**必须含默认身份否则 400**；DELETE 后防御性清理该 id 的所有 slots 引用；前端设备列表拆为独立卡片 `ddg-device-list-card`（Sync & Backup 不再含拖拽区），409 弹窗提供「先去设备列表移除」/「移除设备并删除（force）」，orphans 横幅支持一键清理。
37. **v2.11 compact 协议层**：`buildSummaryPrompt({maxSummaryChars,previousSummary})`（关键指令/语言/长度/merge 指令）、`serializeMessages`（role 行、跳过 reasoning/空）、`estimateChars/estimateTokens(ceil(chars/3))/shouldCompact`；`summarizeMessages(client,messages,{model,maxSummaryChars,systemPrompt,previousSummary,signal,inputCharsLimit})` **优先 `client.summarizeNative`**（`POST /duckchat/v1/summarize`，body model/previousSummary{text,version}/targetPairCount/newMessages；不调用 chat）→ 原生失败（非 418/429）回退 chat（native:false+fallbackReason）；418/429 原样抛不回退；返回 `{ok,text,summary,model,inputChars,outputChars,coveredMessageCount,coveredPairCount,previousSummaryUsed,previousSummaryVersion,summaryVersion,fixedCostWindowUsage,native,fallbackReason,usage,finishReason}`；空摘要/失败映射 DuckError。
38. **v2.11 compact 后端**：`config.context.compact={enabled:true,triggerChars:12000,keepRecentMessages:6,maxSummaryChars:4000,model:null}` 可 PUT 即时生效；历史字符（含 system）>trigger 或上游 ERR_CONVERSATION_LIMIT → 摘要「除最近 keepRecent 条」历史 → 摘要作为初始上下文并入 system prompt（`[对话摘要]…[/对话摘要]`），只发最近 N 条+当前问题；SSE done 顶层 `compacted/summaryChars/coveredMessageCount/summary`（assistant 消息同字段），JSON 顶层 `compacted/summary_chars/covered_message_count/summary`；`session.summary={text,version,coveredMessageCount,coveredPairCount,model,updatedAt}` 持久化；摘要失败 warn+回退 trim（不标记 compacted）；手动 `POST /admin/api/test/sessions/:id/compact` → `{ok,summary,summaryChars,coveredMessageCount,session}`（404 session_not_found/400 nothing_to_compact/重复幂等）；`/v1` 带 X-Session-Id 用 `data/chat-summaries.json` summary（超阈值更新、重启保留）。
39. **v2.11 模型上下文能力**：模型目录每个模型含 `contextWindowChars=16000`、`maxInputChars`、`maxOutputTokens=4096`、`maxOutputTokensEstimated`、`capabilities{webSearch,imageGeneration,reasoningEfforts,tier,contextWindowChars,maxInputChars,maxOutputTokens,maxOutputTokensEstimated}`；`/v1/models` 映射 `context_window/context_window_chars/max_input_tokens/max_input_chars/max_output_tokens/max_output_tokens_estimated/capabilities`（与 `/admin/api/models` 一致；token 为 chars/3 估算）。
40. **v2.11 官方恢复码查看/下载**：`GET /admin/api/sync/official-recovery-code` 返回完整 `code`（与 data/pairing.json 一致）、`source`（pairing/manual）、`length`、`preview`、`updatedAt`（未配置 configured:false/code:null）；`GET .../download` 200 `text/plain`+`Cache-Control:no-store`+`Content-Disposition: attachment; filename="duckduckgo-official-recovery-code-<ts>.txt"`，body=code+换行（支持 HEAD），未配置 404 `recovery_code_not_configured`，无 admin token 401；仅这两个端点回显明文，其它 /sync/error/日志不含完整 code（前端展示完整 code+复制+下载+二维码 Modal（本地 qrcode，内容=完整 code，可复制/下载 PNG/关闭））。
41. **v2.12 duck compact 触发语义**：`COMPACTION_MODELS` 9 个白名单（claude-haiku-4-5/haiku-5-5/sonnet-4-6/sonnet-5-5/opus-4-8/opus-5-5/gpt-5.4-mini/gpt-5.6-terra/gpt-5.6-sol；gpt-6-luna 不在内）；`isCompactionSupported(model,{internalTier}|boolean)`（claude-haiku-5-5 internal-only）；`getActivationTargetPairCount`（number/对象 capabilities/modelConfig）；`countPairs`（assistant active 消息对数）；`shouldCompact`（object：activation>covered 且 target<=pairCount；无 activation：pairCount-covered>=4 且 pairCount>=4；triggerChars 仅旧网关兜底）；`parseCompactMarkers`（URL 编码 `[SUMMARY_REFRESH_HINT:...]` → {baseCoveredPairCount?,targetPairCount,trigger:"tokens",thresholdTokens?}；`[SUMMARY_INVALID]`/`[LIMIT_CONVERSATION]`/`[FIXED_COST_WINDOW_USAGE:...]` 等，非法忽略）。
42. **v2.12 自动压缩后端**：仅白名单模型自动压缩；`gpt-6-luna` 长会话不压缩（summary=null）；`gpt-5.4-mini` 无 activation 时 pair>=4 才压缩，字符 triggerChars 默认 200000 仅兜底；`SUMMARY_REFRESH_HINT` → `session.pendingCompaction={baseCoveredPairCount,targetPairCount,thresholdTokens,trigger,updatedAt}`（SSE done/assistant/session 透出，正文剥离）；`[SUMMARY_INVALID]`→summaryInvalid；`[LIMIT_CONVERSATION]`/conversation_limit_reached → 先 compact 重试一次（任意模型）再 trim；手动 compact 任意模型（trigger=manual）；`PATCH /admin/api/test/sessions/:id/summary`（text 非空<=20000，清 pending/invalid）与 `DELETE .../summary`（cleared/summary=null，恢复全量消息）。
43. **v2.12 模型压缩能力 + 摘要折叠块**：`/v1/models` 与 `/admin/api/models` 一致含 `compaction_supported`（gpt-6-luna=false、gpt-5.4-mini=true）、`activation_target_pair_count`、`input_char_limit`、`context_window_chars`，`capabilities` 内同步；前端消息流顶部摘要折叠块 `summary-card`（默认折叠，标题「上下文摘要 · 覆盖 N 条消息」，展开/收起、全文、复制摘要、编辑摘要 PATCH、清除压缩 DELETE 确认），头部徽章 `summary-badge` 联动展开+高亮，模型标识 `model-compaction-supported`「支持自动压缩 · 约 N 轮后」/`model-compaction-unsupported`「不支持自动压缩」；无 pendingCompaction 前端展示（web 明确未实现，后端字段已透出）。

---

## 9. 已知观察项 / 风险

1. **真实上游限流**：匿名额度按出口 IP 共享，当前 429 冷却；v2 真实终验需在额度窗口执行（Lead 统一安排）。
   网关侧已实现：RPS 队列限速、429 冷却、`Retry-After` 透传。
2. **前端交互**：page-check 覆盖构建产物与 API 契约；九个页面（含身份与订阅、代理、身份池、连接测试并发切换）的真实
   点击流/SSE 渲染建议 Lead 在额度窗口做一次浏览器验收（v2 UI 为 React SPA，无构建步骤外的运行时依赖）。
3. **`/v1/models` duck- 前缀**：v2 仍同时暴露 canonical 与 `duck-` 前缀（兼容 OpenAI 客户端的模型别名习惯）；
   配置别名可解析。若后续要求只列 canonical，需同步更新 smoke/models 断言。
4. **沙箱运行**：`npm test` 依赖 `--test-isolation=none`；`build-check --build` 使用 stdio=inherit spawn 以兼容沙箱。
5. **v2.2 durableStream 上游行为**：默认 `identity.durableStream.enabled=true`（Lead 裁决）；真实 chat 已取得
   **HTTP 200**，且 `durableStreamRejected=0`、`degraded=false`（§6.5）→ 上游接受 durableStream；
   若某次上游 400 拒绝，DuckClient 自动降级一次且请求仍成功，不影响其它请求路径。
6. **v2.2 身份私钥落盘**：`data/identity.json` 含 durableStream 私钥与（激活后的）订阅 token 明文，仅依赖
   文件权限（尽力 0600）与 `.gitignore`；部署时请确保 `data/` 目录权限受控，且不要提交到仓库。
7. **v2.2 sync 传输**：本沙箱无法访问 `duckduckgo.com`，跨设备配对/同步不可用（`transport:blocked` + pair 503 已优雅处理）；
   本地密钥生成/配对码/恢复码/导入导出均可用；**v2.3 起可启用代理解锁 `transport:available`**（pair 仍 501 握手未实现）。
8. **v2.3 代理作用域**：仅影响**网关服务端出站**（DuckClient/sync 探测/订阅 verify/`/proxy/test`），
   不影响浏览器或调用方；`noProxy` 规则只看 hostname（精确/`*.suffix`/后缀），不解析路径。
9. **v2.3 真实 chat 经代理**：代理链路已实测（`/status` 200、duckduckgo.com 200、SOCKS5 chat 200），
   HTTP 代理下真实 chat 偶发上游 `418 ERR_BN_LIMIT` 属额度软限流（与代理无关，§6.6）。
10. **v2.3 代理凭据落盘**：`data/config.json` 的 `proxy.password` 为明文（与 admin token 同级），
    `GET` 脱敏但文件层面需 `data/` 权限受控且勿提交仓库。
11. **v2.4 身份池私钥集中落盘**：`data/identity-pool.json` 含**所有**身份的完整 `identity`（含 durableStream 私钥与
    订阅 token 明文），敏感度高于 v2.2 单文件；仅 `export` 接口返回、列表/详情脱敏。部署需 `data/` 权限受控 + 勿入库；
    池大小上限默认 20（`pool.maxIdentities`），bindings 上限 5000（按 updatedAt 淘汰）。
12. **v2.4 hash 分布**：hash 路由对小池可能让多个会话落到同一身份（概率性，非 bug）；需均匀分布时用
    `least-loaded` 或增大身份数；同身份并发会按 rps=1 排队（响应延迟增加），属预期。
13. **v2.4 上下文守卫局限**：只做**裁剪**（丢旧消息/保留最近），不做真正摘要压缩；单条消息超过 `maxInputChars`
    时无法再裁剪（会原样发出，交由上游 16k 限制）；真实 `ERR_CONVERSATION_LIMIT` 触发路径未在真实上游验证。
14. **v2.4 每身份 runtime 资源**：每身份一个 DuckClient（challenge/会话状态），池 20 身份时内存/连接数上升；
    实现有空闲回收（10 分钟懒加载重建），长时间高并发需关注。
15. **v2.4 sync transport 缓存**：IdentityStore 对 duckduckgo.com 探测结果缓存 ~30s；在代理页切换启用/关闭后，
    身份页 Sync 状态可能最多滞后 30s（`pair`/`refreshTransport` 会 force 重探测）。UI 可提示「刷新后重试」，
    或后续在代理更新时主动 refresh（非阻塞）。
16. **v2.5 配对为实验性握手（joiner 已修复，真实手机复测待执行）**：已实现频道注册（PUT）、hello 交换、
    **joiner（手机有账号）/ host（本地有官方码）**、same_account、awaiting_confirmation/confirmed/denied；
    手机侧真实账号加入所需的官方 App 交互已在本机协议层复现（mock Sync + 真实 PairingHost），但**尚未用真实手机复测**；
    pairing 成功后**不写** `identity.sync`（数据同步仍属后续迭代）。身份页二维码旁保留「实验性」提示。
17. **v2.5 官方恢复码语义与冲突**：`/admin/api/sync/official-recovery-code` 存储的是从手机 joiner 流程收到的官方码
    （或用户手工 PUT），仅返回脱敏状态；未配置时 host 角色 exchange 走 `recovery_code_unavailable`（failed）属预期。
    `GET /admin/api/sync/pairing` 已剥离恢复码明文（敏感），仅 `onCompleted`/内部 store 持有。
18. **v2.5 真实并行消息遇共享出口 429**：两个身份并行真实 chat 时上游仍可能按出口 IP 限流（复跑一次出现 1×429）；
    属上游额度行为，非身份队列 bug（每身份独立 rps=1 队列）；额度窗口可改用单请求间隔复核。
19. **v2.5 前端并发测试依赖构建产物**：`tests/web-concurrency.test.js` 在 Node 注入 jsdom globals 后 import
    `web/assets/index-*.js`（真实 ESM 产物），需先 `npm run build:web`；若产物结构变化（入口/单 bundle 改变）需同步更新。
20. **v2.5 jsdom 全局污染风险**：该用例会临时覆盖 Node 全局（window/document/fetch 等）并在 finally 关闭 JSDOM；
    `--test-isolation=none` 单进程运行下，后续新增依赖这些全局的用例需注意顺序/副作用（当前全绿）。
21. **v2.8 服务端设备删除为 best-effort**：`logout-device` 会使当前 Sync token 失效（需重新 login），且真实服务端列表
    传播有延迟；删除后 GET 仍可能看到旧设备（真实观察），UI/接口不保证即时消失。当前设备禁止删除（400 invalid_device）。
22. **v2.8 真实设备列表可能含历史设备**：真实联调 total=5（含旧设备/手机），`current` 由 identity.deviceId 标记；
    历史设备名可能为 null（服务端未回显加密 name），UI 显示「未命名设备」。
23. **v2.8 Sync token 内存态与缓存**：SyncClient token 仅内存（不落盘），网关重启/rotate 后需重新 login；
    `server-devices` 在无 live session 时返回 `identity.sync.server.devices` 缓存（可能略滞后，非实时上游列表）；
    register-device 首次登录后会复用 session，重复调用一般不再打上游。真实官方 App 数据同步仍不在本迭代范围。
24. **v2.8 Sync 418 限流 cooldown**：DuckDuckGo 对 `/login` 有 418 anti-abuse；网关映射 429 + `Retry-After:120` 并
    进程级 cooldown 2 分钟（期间不再请求上游，到期自动恢复）。若真实注册在 cooldown 内被 429，属上游限流预期，
    需等待窗口后重试（真实 200 证据在 fix 前采集；fix 后接口行为由 mock 覆盖）。
25. **v2.9 registerDevices 真实约束**：DuckDuckGo `PATCH /devices` 每次仅 1 条 update 且 token 只能 patch 本机，
    因此 sync-client 对 N 台设备内部执行 N 次 login+PATCH（一次调用对外）；401/forbidden_device 多为「用错 token」而非上限。
26. **v2.9 device-slots 增量为「服务端设备」驱动**：remove 判断基于 `serverDevices.matchedIdentityId`（id 或解密 name 匹配），
    若服务端列表传播延迟/名称为 null，可能暂时无法匹配（不影响已保存 identity.sync.slots；刷新后重试）。
27. **v2.9 My Devices 可见性**：真实联调已确认接口返回双设备注册 200 与解密列表，但手机 App「My Devices」显示需 Lead 持设备人工复核；
    设备删除/注销在服务端传播 best-effort（可能延迟）。
28. **v2.10 force 删除为 best-effort**：logout 失败（429/503）时身份仍删除、`removedDevice:true`，服务端设备可能残留（仅 warn）；
    需在限流窗口后清理或依赖 GET slots 的 orphans/reconcile。
29. **v2.10 默认身份不可从设备列表移除**：PUT 必须含默认身份（400）；默认身份删除/禁用保护优先于 slots 检查。
30. **v2.10 orphans 判定局限**：按保存的 slots + 身份存在/启用状态判定；服务端设备列表延迟/名称不可解密时不影响 slots 清理，但 matchedIdentityId 可能为 null（不影响 reconcile）。
31. **v2.11 原生 summarize 依赖**：`/duckchat/v1/summarize` 真实可达但匿名额度可能 418/429（不回退、原样抛）；成功 200 样例待额度恢复；失败回退 chat 摘要可用但无 pair/version 语义（文档已注明）。
32. **v2.11 token 为估算**：`estimateTokens=ceil(chars/3)`，模型能力 `max_input_tokens` 为 chars/3 取整估算，非精确 tokenizer；文档/UI 均标「估算」。
33. **v2.11 jsdom QR 渲染依赖 canvas stub**：`web-recovery-code.test.js` 用最小 canvas stub 让 qrcode 产出 data:image（jsdom 无 canvas）；未配置提示分支改由 page-check/build-check 覆盖（jsdom 下该分支页面挂起/内存异常）。
34. **v2.12 pendingCompaction 前端未展示**：web task-49 明确「无 pendingCompaction 字段实现」，前端暂不显示「摘要待刷新」提示；后端/接口已透出，后续前端补齐后可加 jsdom 断言。
35. **v2.12 真实 compact 仍受额度限制**：共享出口 418 ERR_BN_LIMIT/429 时真实自动压缩无法验证（gpt-6-luna 与 gpt-5.4-mini 会话均 BLOCKED）；duck-protocol 已用 gpt-5.4-mini 原生 summarize 拿到 200，待额度窗口补真实证据。

---

## 10. 证据与复现

- 测试证据：`npm test` 输出 250/250（本文件 §3）；所有测试数据写 `data/tmp/qa-*` 并自动清理。
- 脚本证据：`smoke --mock --search` 9/9、`smoke --no-upstream` 4P/4S、`build-check` 11/11、`page-check` 16/16、
  `proxy-live-check --with-proxy` 11/11（§5）。
- 构建产物：`web/index.html` + `web/assets/index-*.js|css`（由 `npm run build:web` 生成，webapp/ 源码）。
- 真实上游历史证据（v1，仅参考）：`docs/ACCEPTANCE.md`、`data/tmp/live-check-acceptance.json`、`data/tmp/sdk-check-mock.json`。
- v2.2 证据：`data/tmp/sdk-check-v2-mock.json`（SDK×mock）；identity/sync/subscription 证据内嵌在 `npm test` 断言与
  `page-check` 输出；**真实上游 durableStream 200 / 重启稳定原始报文见 §6.5（api-core 实测回传）**。
- v2.3 证据：`data/tmp/proxy-live-check-*.json`（真实 10808 HTTP+SOCKS5 联调，§5.6/§6.6）；
  mock 代理辅助 `tests/helpers/mock-proxy.js`（HTTP CONNECT/SOCKS5，随机端口；单测不访问外网）；
  mock 网关脚本（临时）`data/tmp/qa-mock-server-v2.mjs` 演示 identity+proxy 注入方式。
- v2.4 证据：`data/tmp/v24-real-integration.json` + `data/tmp/qa-v24-real-integration.mjs`（真实 2 身份 × 2 会话 200，§5.7/§6.7）；
  QR/身份池页静态断言在 `tests/identity-qr.test.js`；身份池数据/队列/路由在 `tests/identity-pool*.test.js` 与
  `tests/identity-routing.test.js`；上下文守卫在 `tests/context-guard.test.js`。
- v2.5 证据：`data/tmp/v25-real-integration.json` + `data/tmp/qa-v25-real-integration.mjs`（真实 2 身份并行消息双 200 +
  配对真实 start 200/waiting，§5.8/§6.8）；并发后端 `tests/concurrency.test.js`、前端 jsdom `tests/web-concurrency.test.js`、
  配对协议 `tests/pairing.test.js`（mock sync 服务 `tests/helpers/mock-sync-service.js`）、配对 Admin `tests/pairing-api.test.js`；
  **joiner 修复端到端 `tests/pairing-joiner-api.test.js`（真实 PairingHost + PairingService + store，§5.9）**；
  构建产物断言以 `web/index.html` 引用解析（hash 无关）。- v2.5 证据：`data/tmp/v25-real-integration.json` + `data/tmp/qa-v25-real-integration.mjs`（真实 2 身份并行消息双 200 +
  配对真实 start 200/waiting，§5.8/§6.8）；并发后端 `tests/concurrency.test.js`、前端 jsdom `tests/web-concurrency.test.js`、
  配对协议 `tests/pairing.test.js`（mock sync 服务 `tests/helpers/mock-sync-service.js`）、配对 Admin `tests/pairing-api.test.js`；
  **joiner 修复端到端 `tests/pairing-joiner-api.test.js`（真实 PairingHost + PairingService + store，§5.9）**；
  构建产物断言以 `web/index.html` 引用解析（hash 无关）。
- v2.8 证据：`data/tmp/v28-real-integration.json` + `data/tmp/qa-v28-real-integration.mjs`（真实官方码注册设备 200，§5.10/§6.9；该 200 采集于 418 限流 fix 前，fix 后 418→429/cooldown 行为由 mock 用例覆盖）；
- v2.9 证据：`data/tmp/v29-real-integration.json` + `data/tmp/qa-v29-real-integration.mjs`（真实 device-slots 双设备注册 + 注销 200，§5.11/§6.10）；
- v2.10 证据：`data/tmp/v210-real-integration.json` + `data/tmp/qa-v210-real-integration.mjs`（真实 409 identity_in_device_slots → force 200，§5.12/§6.11）；
- v2.11 证据：`data/tmp/v211-real-integration.json` + `data/tmp/qa-v211-real-integration.mjs`（真实恢复码明文/下载一致 + 模型能力；compact BLOCKED，§5.13/§6.12）；
- v2.12 证据：`data/tmp/v212-real-integration.json` + `data/tmp/qa-v212-real-integration.mjs`（模型能力真实 200；会话 418 BLOCKED，§5.14/§6.13）；
  `tests/compact-semantics.test.js`、`tests/compact-v212.test.js`、`tests/web-compact-v212.test.js`；page-check 22 项含 v2.12 能力+summary PATCH/DELETE。
  `tests/compact.test.js`、`tests/compact-session.test.js`、`tests/web-compact.test.js`、`tests/recovery-code-reveal.test.js`、`tests/web-recovery-code.test.js`；page-check 21 项含模型能力/手动 compact/恢复码下载。
  `tests/device-slots.test.js`（删除/禁用/孤儿）、`tests/web-device-protection.test.js`（jsdom 409 弹窗/force/orphans）；page-check 19 项含 v2.10 契约。
  `tests/device-slots.test.js`（真实池 + fake sync-client）、`tests/sync-client-multidevice.test.js`、`tests/web-device-slots.test.js`（jsdom 拖拽）；
  page-check 的 mock 网关已注入 v2.9 fake sync-client（registerDevices/logoutDevices/listDevicesDetailed + identities pool）。
  `tests/sync-client.test.js`（mock Sync API `tests/helpers/mock-duck-sync.js`）、`tests/sync-devices.test.js`、
  `tests/sync-devices-api.test.js`、`tests/pairing-auto-register.test.js`、`tests/web-rotate-confirm.test.js`（jsdom 真实产物）；
  page-check 的 mock 网关已注入 fake SyncDeviceService（`data/tmp/qa-mock-server-v2.mjs`）。
- 复现命令见 §2 与 §6.2。

---

## 11. 待办（真实上游终验）

- [ ] 额度冷却后：`live-check.mjs`（协议直连 6 项）→ 网关 `smoke.js --search`（真实全链路）→ `sdk-check.mjs`（SDK 3 项）。
- [ ] 真实上游 v2.1 harness：会话消息 → 重试该轮（验证真实上游 retry 链路）→ 会话详情确认截断/替换；
      以及真实「推理已加密（匿名档）」时 `reasoningEncrypted=true` 的透出。
- [x] v2.2 durableStream：默认开启下真实 chat **HTTP 200**、`durableStreamRejected=0/degraded=false`、
      重启 identity 稳定（§6.5，api-core 实测）。
- [x] v2.3 代理真实联调：本机 10808 HTTP/SOCKS5 `proxy/test` ok + exitIp、`/status` 200、duckduckgo.com 200、
      sync transport available（§5.6/§6.6；HTTP 代理下 chat 418 属额度软限流）。
- [x] v2.4 身份池真实路由：2 身份 × 2 会话真实消息均 200（identityId 响应头/日志/绑定一致，§5.7/§6.7）。
- [x] v2.5 真实联调：2 身份并行真实消息双 200（identityId 不同）+ 配对真实 start 200/waiting/stop（经 10808，§5.8/§6.8）。
- [x] v2.5 joiner 修复：`recovery_code_available` 不再回 unavailable → 等待 response → completed(joiner)，
      官方码落盘并暴露 `accountAvailable`（§5.9 端到端；模块级 14 项含 same_account/awaiting/confirmed/denied）。
- [ ] 真实手机复测扫码配对（用真实 DuckDuckGo App 扫码，验证原「绑定失败」已修复；需 Lead 持设备）。
- [x] v2.8 真实注册设备：真实官方恢复码 + 10808 → register-device 200、server-devices 含本机 `DuckCPA@498a`（§5.10/§6.9）。
- [ ] v2.8 余项：真实手机端「My Devices」可见性复核（注册后手机 App 查看本机，需 Lead 持设备）；
- [x] v2.9 真实 device-slots：双设备注册 200（DuckAI@main + DuckCPA@70e7）、serverDevices 解密 HONOR、PUT 注销 200（§5.11/§6.10）。
- [ ] v2.9 余项：手机 My Devices 实际可见性人工复核（需 Lead 持设备）；多设备注销后的列表传播延迟观察。
- [x] v2.10 真实删除保护：slots 内分身 DELETE 409 → force 200 removedDevice、slots 无残留、默认身份 force 409（§5.12/§6.11）。
- [ ] v2.10 余项：手机 My Devices 中设备实际消失的人工复核；force 时 logout 失败后的服务端残留清理（依赖 window/orphans）。
- [x] v2.11 真实恢复码明文/下载：GET 完整 code（len=191/source=pairing）与 download 一致；模型能力 API 200（§5.13/§6.12）。
- [ ] v2.11 余项：真实 compact 多轮自动压缩并继续对话（上游额度 429/418，待窗口）；原生 summarize 200 成功样例待额度恢复。
- [x] v2.12 duck 触发语义 + 后端 pendingCompaction/summary PATCH-DELETE + 摘要折叠块前端：343/343、build 16/16、page 22/22（§4.41-43、§7.12）。
- [ ] v2.12 余项：真实 gpt-6-luna 不压缩/gpt-5.4-mini 多轮触发的线上证据（上游 418 BLOCKED）；pendingCompaction 前端展示（web 未实现）。
      真实删除设备后列表传播（best-effort，可能延迟）；官方 App 聊天/书签数据同步不在本迭代范围；
      真实 register-device 在 418 cooldown 窗口解除后复测 200（fix 后行为已由 mock 覆盖：429+Retry-After/缓存/迁移）。
- [ ] 真实上游 v2.2 余项：`x-ddg-journey-id` 在上游日志侧的跨重启比对（需端侧日志权限）；
      真实 DuckDuckGo 订阅 token 的 activate/verify（需登录态，预期 BLOCKED）。
- [ ] 真实上游 v2.3 余项：代理开启下真实 chat 稳定 200（需额度窗口）。
- [ ] 真实上游 v2.4 余项：真实超长会话触发 `ERR_CONVERSATION_LIMIT` → 裁剪重试 200（需额度窗口）；
      多身份高并发下的每身份串行/异身份并行真实观测。
- [ ] 真实上游 v2.5 余项：2 身份并行真实 chat 在额度窗口内稳定双 200（复跑偶发 1×429 属共享出口限流）；
      官方 App 完整账号加入后的数据同步仍属后续迭代（当前 pairing 不写 `identity.sync`）。
- [ ] 浏览器人工验收：身份页二维码（扫码/下载/复制/实验性提示）、身份池页面操作、连接测试并发切换（A 慢流/B 发送/
      切会话/生成中徽章）、会话页 identityLabel 展示、代理页与身份页 Sync 提示跳转。
- [ ] 将结果回填 §6.3，并把 §7.1 第 2/3/4/5 条、§7.2 第 7 条、§7.3 第 3 条的剩余真实上游证据补齐
      （可引用 Lead 的 `docs/ACCEPTANCE.md` v2/v2.1/v2.2/v2.3/v2.4/v2.5 版本）。

---

## 12. v2.21 独立复核（QA，2026-11-03）

> 复核对象：模型配置 API/页面、会话上限 409 + 客户端 `POST /v1/compact`、入口检测修复。
> 环境：网关已运行于 `http://127.0.0.1:8787`（**未重启**）；本复核只读 + 临时覆盖后重置，
> 未修改 `src/`、`tests/`、`scripts/`、`webapp/`、`web/`。

### 12.1 验证矩阵

| # | 项目 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 全量测试 | `npm test` | ✅ **366 / 366 PASS**（exit 0；含 `--test-concurrency=1`） |
| 2 | 构建产物契约 | `node scripts/build-check.mjs` | ✅ **16 / 16 PASS**（`index-BPrXrbkO.js` 736736B / `index-DA5DFkfO.css` 38460B） |
| 3 | 真实网关页面/API | `node scripts/page-check.mjs --admin-token <ADMIN> --api-key <KEY>` | ✅ **22 passed, 0 failed**（v2.10 orphan 注入用例按设计 SKIP：需 `--inject-orphan` + 隔离 dataDir） |
| 4 | 手工 spot-check | `node data/tmp/qa-v221-spotcheck.mjs` | ✅ **7 / 7 PASS**（见 §12.2） |

### 12.2 Spot-check 明细（真实网关 8787）

| 检查 | 实际结果 |
| --- | --- |
| `GET /admin/api/models/config` | HTTP 200；`object=model_config`；`items=10` 个模型；`defaults={context_window_chars:20000, max_input_chars:19500, max_output_tokens:4096, session_limit_behavior:"new_chat"}`；`limits` 三段齐全 |
| `PUT` 覆盖 gpt-6-luna=32000/30000/8192 | HTTP 200；`GET /v1/models` 的 gpt-6-luna 立即为 `context_window_chars=32000 / max_input_chars=30000 / max_output_tokens=8192` |
| `PUT {overrides:{"gpt-6-luna":null}}` 重置 | HTTP 200；`/v1/models` 恢复 `20000/19500/4096` |
| `POST /v1/compact`（9 条消息、`keep_recent_messages=2`） | HTTP 200；`kept_messages` 数组长度 **2**；`summary.covered_message_count=7`、`covered_pair_count=3`、`trigger="client"`、`summary.text` 非空；`usage={input_chars,summary_chars}` |
| 未知模型覆盖 | HTTP **400** `invalid_model_override`（message：未知模型: not-a-real-model） |
| `max_input_chars=999999` | HTTP **400** `invalid_model_override`（越界） |
| `context_window_chars=1000,max_input_chars=2000` | HTTP **400** `invalid_model_override`（关系校验：max_input_chars>context_window_chars） |

测试结束后已再次 PUT `{overrides:{"gpt-6-luna":null}}`，`/v1/models` 确认为默认值（20000/19500/4096），未残留测试覆盖。

### 12.3 复现命令

```powershell
cd duckai-cpa
npm test
node scripts/build-check.mjs
node scripts/page-check.mjs --admin-token <ADMIN> --api-key <KEY>
node data/tmp/qa-v221-spotcheck.mjs
```

### 12.4 结论 / 观察项

- ✅ 三项 v2.21 改动（模型配置 API、409+客户端压缩、入口检测）在现有自动化与真实网关上**未发现回归**。
- ℹ️ `GET /admin/api/models/config` 的模型清单字段是 `items`（非 `models`）；文档 §25.1 示例以实际返回为准。
- ℹ️ page-check 的 v2.10「设备删除保护/孤儿自愈」用例现为 **SKIP**（避免对真实设备/身份文件做破坏性写），
  该能力仍由 `tests/device-slots*.test.js` 等单测覆盖。
- ℹ️ 本次复核未调用真实上游会话（仅 `/v1/compact` 的摘要走现有链路），未触发 429/418。
