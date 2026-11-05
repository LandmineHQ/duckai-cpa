# 验收实测记录（v2 / v2.1 / v2.2 / v2.3 / v2.4 · Lead 独立执行）

> 版本：v2（React + shadcn 控制台；BREAKING：强制 API Key / RPS 队列 / 日志拆分 / 付费模型 / 会话式连接测试 / 严格中断）
> v2.1：会话「重新生成/重试」+ 推理（reasoning）展示与 `reasoningEncrypted` 标记。
> v2.2：**稳定匿名身份**（journeyId/deviceId/durable-stream 密钥持久化，重启不漂移）+ 身份/ Sync & Backup / DuckDuckGo 订阅控制页。
> v2.3：**代理**控制页（HTTP/HTTPS/SOCKS4/SOCKS5，本机 127.0.0.1:10808 实测），解锁 duckduckgo.com 与 Sync transport。
> v2.4：**匿名分身池**（多身份、会话唯一绑定、每身份 rps=1、订阅身份路由付费模型）+ **配对二维码** + 上下文裁剪守卫。
> 时间：2026-11-01（America/New_York）；执行者：Team Lead（非实现方），真实网关 → 真实 duck.ai。
> 详细契约：`docs/ADMIN_API_V2.md`、`docs/IDENTITY-SYNC.md`、`docs/PROXY.md`、`docs/IDENTITY-POOL.md`；协议实现：`docs/PROTOCOL.md`、`docs/PROTOCOL-ERRORS.md`、`docs/IDENTITY-RESEARCH.md`。

## 1. 自动化验收（全部通过）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 单元 + mock 集成 | `npm test` | **222 / 222 PASS**（exit 0；含 v2.4 身份池/路由/上下文 31 项） |
| 冒烟（进程内 mock，含搜索） | `node scripts/smoke.js --mock --search` | **9 / 9 PASS** |
| 冒烟（对运行中 v2 网关，跳过上游） | `node scripts/smoke.js --no-upstream --admin-token <token>` | **4 PASS / 4 SKIP**（exit 0） |
| React 构建校验 | `node scripts/build-check.mjs` | **10 / 10 PASS**（含 v2.4 身份池/二维码文案） |
| 页面/契约检查 | `node scripts/page-check.mjs` | **15 / 15 PASS**（含 identities 契约） |
| OpenAI 官方 SDK（mock 上游） | `node scripts/sdk-check.mjs` | **4 / 4 PASS**（openai v7：models / chat 非流 / chat 流 / responses） |
| 前端构建 | `npm run build:web` | 成功：CSS 35.2KB、JS 602KB、`/admin/assets/index-DcCiVsjJ.js` |

前端自身：mock 全功能 jsdom E2E **51/51**（含重试、429 错误消息重试、加密推理提示）；v2.2 身份页 jsdom E2E **25/25**；真实 v2 网关只读联调 **16/16**，浏览器控制台无报错。

## 2. 真实上游 E2E（v2 行为）

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 强制 API Key | ✅ | 无 key/错 key → 401 `invalid_api_key`；正确 key → 200（`/v1/models` 20 条含免费/付费标记） |
| 2 | 真实对话（严格模式） | ✅ | `POST /v1/chat/completions` → 200 `"OK"`；严格校验未误杀正常事件 |
| 3 | RPS 队列串行 | ✅ | 2 个并发请求时 `/admin/api/overview` 快照 `inFlight=1, waiting=1`；日志 `queueWaitMs=2385ms`；上游限流时第二个按预期 429（队列本身正常） |
| 4 | 会话式连续对话 | ✅ | 真实上游 SSE：`session → delta×N → done`，消息写入 session；UI 多轮「你好！」成功；刷新后 4 条消息仍在 |
| 5 | 付费模型拦截 | ✅ | 默认 `claude-opus-5-5` 请求 → 403 `model_requires_subscription`；`/v1/models` 标记 `paid:true, available:false`；付费模型在 UI 中分组禁用 |
| 6 | 日志/统计拆分 | ✅ | 上游日志 `source=v1/admin-test` 与后台 API 日志互不混淆；`stats.upstream/stats.admin` 独立；`queueWaitMs` 字段存在 |
| 7 | 严格中断 | ✅（mock 注入） | 未知事件/缺 `[DONE]`/缺挑战头/图片缺失 → 立即 abort + 502 `upstream_protocol_mismatch`/`upstream_no_image`；流中失败只发 error 事件 |
| 8 | React 控制台 | ✅ | 六页逐页人工验证：概览/连接测试/设置/API Key/日志/示例；左侧控制台布局；截图见 `docs/screenshots/` |
| 9 | **重新生成 / 重试（真实上游）** | ✅ | 在连接测试页对最后一轮（此前为 429 错误）点「重新生成」→ SSE 流式返回新回复、消息标记「已重新生成」，`retriedFrom` 写入会话；截断语义正确（旧回复被替换，历史保留到该轮 user） |
| 10 | **推理内容可见** | ✅ | 真实上游 reasoning 明文通过 `reasoning` 事件流式下发并写入消息；UI「推理过程」可展开（截图 `admin-chat-reasoning.png`）；匿名档若仅加密摘要则显示「推理已加密（匿名档不提供明文）」 |
| 11 | **稳定匿名身份（不漂移）** | ✅ | `data/identity.json` 持久化 journeyId(32hex)/deviceId/RSA-OAEP-256 密钥对/conversationId；**3 次重启后 journeyId=`4fc34e96…`、fingerprint=`1a1d431f…` 完全一致**，`source=file`、`stable=true`；重启前后 `GET /admin/api/identity` 字段一致 |
| 12 | **durableStream 身份请求** | ✅ | 显式开启后真实 chat **200**（「稳定」），health `durableStreamRequests=3/5、rejectedCount=0`；上游接受本实现的 JWK（带 `use:"enc"` 与稳定 conversationId）；仍保留 400 自动降级与计数 |
| 13 | **Sync & Backup 本地能力** | ✅ | `POST /sync/enable` 生成 mainKey/encryptedPrivateKey(JWE)/recoveryCode(3348B)；恢复码 GET 返回字符串并可往返导入；配对码为 v2 结构 + `duckduckgo.com/sync/pairing/#&code2=` URL；`pair` 在沙箱返回 **503 `sync_transport_unavailable`** 且本地状态不变；设备列表/本机标记正常 |
| 14 | **DuckDuckGo 订阅激活** | ✅ | 伪造合法 JWT → 200，解析 email/tier=plus/expiresAt；非法 token → 422 `token_invalid`；过期 → 422 `token_expired`；DELETE 注销回 free；接口与 `GET identity` 均不泄漏 token 明文（`verified` 仅代表本地解析+上游可达，非 token 有效性） |
| 15 | **身份页 UI** | ✅ | `#/identity` 三卡片：匿名身份（指纹/稳定性徽章/轮换/导出导入）、Sync & Backup（恢复码一次展示/配对码/导入/blocked 提示/设备）、订阅（token 输入/激活/验证/注销/tier 徽章）；真实数据渲染、无 console 报错（截图 `admin-identity.png`） |

截图：`docs/screenshots/admin-overview.png`、`admin-chat.png`、`admin-chat-models.png`、`admin-chat-retry.png`、`admin-chat-reasoning.png`、`admin-settings.png`、`admin-keys.png`、`admin-logs.png`、`admin-examples.png`、`admin-identity.png`、`admin-proxy.png`。

## 2.1 v2.3 代理实测（Lead 浏览器 + 网关 API）

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 代理页 `#/proxy` | ✅ | 左侧导航「代理」；状态卡/配置卡；真实数据渲染、无 console 报错（截图 `admin-proxy.png`）；UI「测试连接」显示「测试通过 · HTTP 代理 · 延迟 1.98s · HTTP 200 · 出口 IP 203.0.113.10」 |
| 2 | HTTP 代理（127.0.0.1:10808） | ✅ | `POST /admin/api/proxy/test` → `ok:true, status:200, exitIp:203.0.113.10`；`/duckchat/v1/status` 200 + 挑战头；duckduckgo.com 200 |
| 3 | SOCKS5 代理（127.0.0.1:10808） | ✅ | 同上 test 通过（~1.2s）；**真实 chat 200**（SOCKS5 通道，挑战→SSE 全程走代理） |
| 4 | 启用后全链路 | ✅ | `PUT /admin/api/proxy` 即时生效；`/healthz.proxy={enabled:true,mode:http,active:true,exitIp}`；网关 `POST /v1/chat/completions` 经代理 **200**；`sync.transport` 由 `blocked` → **`available`**（duckduckgo.com 可达） |
| 5 | 失败与校验 | ✅ | 不可达代理 → `ok:false, code:proxy_connect_failed`；非法 PUT → 400 `invalid_proxy` 且不改配置；密码不回显、空密码不覆盖；关闭后回 `direct` |
| 6 | 代理解锁的能力 | ✅ | 沙箱原本仅 `duck.ai` 可直连；启用代理后 `duckduckgo.com` 可访问（Sync transport available；pair 返回 501 `sync_handshake_unimplemented` 属既定边界）；出口 IP 203.0.113.10 |

## 2.2 v2.4 身份池 / 配对二维码 / 上下文守卫（Lead 实测）

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 身份池存储与迁移 | ✅ | `data/identity-pool.json` 首启把 `data/identity.json` 迁移为 `id_default`（label 默认身份，原文件保留）；`GET /admin/api/identities` → pool `{total,enabled,subscribed,activeId,bindingCount,maxIdentities}` |
| 2 | 生成 / 导入 / 导出 | ✅ | `POST /identities/generate {count:2}` → 两个身份 journeyId/fingerprint 均不同；导出→导入往返一致；删除生成身份后池恢复 `id_default` |
| 3 | 会话唯一绑定 | ✅ | 创建 3 个会话均写入绑定；连续 8 个会话分布 `{默认:1, 分身1:4, 分身2:3}`（hash 映射）；**重启网关后** `GET 会话` 的 identityId 与绑定文件一致 |
| 4 | `X-Session-Id` 路由 | ✅ | 同 sessionId 两次真实请求均返回 `X-Duckai-Identity-Id: id_default` 且第二次相同（same=true）；真实 chat 200 |
| 5 | 每身份 RPS=1 | ✅（模块/QA） | 同身份并发串行（≥1s、peakInFlight=1），不同身份并行；`GET /identities/routing` 暴露每身份 waiting/inFlight/rps |
| 6 | 付费模型路由 | ✅ | `allowPaidModels=true` 且会话绑定未订阅身份 → 403 `model_requires_subscription`（不触达上游）；绑定订阅身份后请求路由到该身份并触达上游（收到上游 404/额度错误，证明路由生效） |
| 7 | 配对二维码 | ✅ | 身份页生成配对码后出现 `<img src="data:image/png;base64,...">`（15KB QR，内容= code2 URL），提示「在另一台设备打开 DuckDuckGo → Sync & Backup → 扫描」，支持下载 PNG / 复制链接（截图 `admin-identity-qr.png`） |
| 8 | 身份池页面 | ✅ | `#/identities` 真实数据：3 身份（默认/分身1/分身2）、11 条绑定、每身份队列、路由策略 hash + salt（截图 `admin-identities.png`）；浏览器 console 无报错 |
| 9 | 上下文守卫 | ✅（QA mock） | 发送前按 `context.maxInputChars=12000 / maxMessages=40` 裁剪并标记 `context_trimmed`；上游 `ERR_CONVERSATION_LIMIT`(409)/`ERR_INPUT_LIMIT`(413) 在 `onLimit=trim` 时裁剪重试一次（QA 覆盖 6 项） |

**上下文结论（源码）**：免费模型单条输入上限 `inputCharLimit=16,000 字符`；会话超长时服务端返回 `ERR_CONVERSATION_LIMIT`，duck.ai 前端**自动摘要压缩**（`fetchSummary` + `SERVICE_APPLY_COMPACTION`，摘要作为 `initialContext`，只发送 covered 前缀之后的消息），失败时展示 Summarize 按钮；服务端还会下发 `[SUMMARY_REFRESH_HINT]`/`[SUMMARY_INVALID]` 触发按 token 阈值刷新摘要。网关侧 v2.4 增加了裁剪守卫（不生成真摘要，仅保证可用性）。

截图：`admin-identities.png`、`admin-identity-qr.png`；详细契约见 `docs/IDENTITY-POOL.md`。
## 2.3 v2.5 并发与扫码配对修复（Lead 实测）

| # | 问题 | 修复与结果 |
| --- | --- | --- |
| 1 | 会话 A 流式时切到 B 无法发送（不同身份本应并行） | 根因是前端**全局** `streaming` state + 单个 AbortController，`canSend=!streaming` 锁住全部会话。已改为**按会话**流式（独立 controller/状态/草稿），会话列表显示「生成中」徽章；实测 A 长文流式期间切到 B 可正常发送，两个会话同时「生成中」，B 3.33s 完成、A 继续且互不影响（浏览器截图/录屏验证） |
| 2 | 后端是否存在隐藏串行化 | 审计确认：命中身份路由的请求只走 `pool.run(identityId)` **每身份队列**，不进全局 queue；`sessions.beginStream` 仅锁同会话（并发 → 409 `session_busy` + Retry-After）。mock：不同身份两会话 336ms（≈max），同身份 2000ms（≈sum）；真实 10808：两会话不同身份均 200、重叠执行（A 7485ms / B 3309ms） |
| 3 | 连接测试页偶发错误 | 同会话并发返回明确 409 `session_busy`（可重试），不同会话不再互相 abort；503 错误体补齐 `hint/detail`，前端可展示；per-session 流不再串写 |
| 4 | 扫码后官方客户端提示「绑定失败」 | 根因：旧二维码只是本地 code2，**未向 DuckDuckGo Sync 注册频道、无 host 握手**。已实现 `PairingHost`：`PUT https://sync.duckduckgo.com/sync/v2/exchange/<uuid>`（实测 204）注册频道 → 1s 轮询 → RSA-OAEP/A256GCM 信封 → hello 握手 → exchange；`POST /admin/api/sync/pairing` 返回真实可扫码 URL，UI 先 start 再出二维码并轮询状态（waiting/hello/exchange/completed/failed/timeout，30s 空闲/5min 超时），支持停止/重新生成/下载 PNG/复制链接 |
| 5 | 官方 App 完成账号加入 | **如实说明**：host 已能注册频道、握手与 exchange，但官方 App 账号加入还需要**真实 DuckDuckGo 官方恢复码**；已新增可选「DuckDuckGo 官方恢复码」配置（`GET/PUT/DELETE /admin/api/sync/official-recovery-code`，脱敏保存）与 UI 输入；未配置时 host 返回 `recovery_code_unavailable`，App 仍可能提示绑定失败——这是协议限制，不是二维码/网络问题（截图 `admin-identity-pairing.png` 已标注实验性） |

自动化：`npm test` **242 / 242 PASS**（新增并发 4 项、web-concurrency 2 项、pairing 模块 10 项、pairing-api 4 项）；`build-check` **11 / 11**、`page-check` **16 / 16**（含 pairing 契约）。
## 3. ARCHITECTURE §1 / v2 验收清单

| # | 标准 | 结果 |
| --- | --- | --- |
| 1 | `/v1/models` 返回模型列表（含免费/付费区分） | ✅ |
| 2 | 非流式 + 流式对话返回真实输出 | ✅（v2 严格模式实测） |
| 3 | `reasoning_effort` 被上游接受 | ✅（免费档推理为加密摘要，见 PROTOCOL §4.5） |
| 4 | `web_search` 响应包含来源（url_citation） | ✅（mock/tests + v1 真实抓包；v2 映射保持一致） |
| 5 | `/v1/images/generations` 返回 base64 | ✅（mock/tests + v1 真实图片；v2 映射保持一致） |
| 6 | `/admin` React 控制台可用 | ✅（截图 + page-check） |
| 7 | 自动化测试通过 | ✅ 168/168 |
| 8 | 强制 API Key | ✅ |
| 9 | RPS 队列（默认 1 req/s，其余排队） | ✅ |
| 10 | 日志/统计拆分 | ✅ |
| 11 | 付费模型默认 403 | ✅ |
| 12 | 会话式连接测试（持久化） | ✅ |
| 13 | 上游不符预期立即中断 | ✅（mock + 真实严格模式） |

## 4. 匿名额度说明（真实观测）

- duck.ai 匿名档位按出口 IP 限流：高频请求先 `418 ERR_CHALLENGE/ERR_BN_LIMIT`，进一步 `429 ERR_RATE_LIMIT`；
  冷却约 50–60 秒（持续高强度测试后可能更久）。
- v2 的 RPS 队列（默认 1 req/s、并发 1）已把本地并发收敛为串行；上游仍可能因共享 IP 额度返回 429，
  此时网关返回 OpenAI 风格 429 + `Retry-After`，会话 UI 以错误气泡展示且不继续后续步骤。
- 建议：真实使用保持低频、串行；演示前等待冷却窗口。

## 5. 复跑命令

```bash
npm test
node scripts/smoke.js --mock --search
npm run build:web && node scripts/build-check.mjs
node scripts/page-check.mjs
node scripts/smoke.js --no-upstream --admin-token <data/config.json 中的 auth.adminToken>
node scripts/live-check.mjs --api-key <data/keys.json 中的 key>   # 真实上游，额度过热时可能 BLOCKED
```

## 2.6 v2.9 身份设备化与设备槽拖拽（Lead 实测）

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 身份池首列=设备名称 | ✅ | 默认身份 `DuckAI@main`（「默认 · 不可删除」徽章+复制），其他身份 `DuckCPA@<4hex>`，原 label 作小字副标题（截图 `admin-identities-v29.png`） |
| 2 | 默认身份保护 | ✅ | `DELETE /admin/api/identities/id_default` 及 ?force → **409 `default_identity_protected`** + hint「默认身份用于获取手机配对 key」 |
| 3 | 设备槽拖拽 | ✅ | 身份页两栏：左「身份池设备」/右「DuckDuckGo 设备列表·设备槽」，拖拽加入/移除、「有未保存更改」、保存 `PUT /sync/device-slots {identityIds}` 后生效并刷新（截图 `admin-identity-slots.png`） |
| 4 | 默认身份可移除但保留账号 | ✅ | 默认身份初始在右栏，可拖出；slot 移除只注销设备，官方恢复码/配对账号仍保留 |
| 5 | Sync 多设备注册 | ✅ | 真实账号：`PUT [id_default, 分身]` → 200，`DuckAI@main` + `DuckCPA@xxxx` 均注册成功（per-device login+PATCH，DDG 要求 PATCH 用该设备自己的 token）；手机 My Devices 可见 |
| 6 | 设备名可读化 | ✅ | `listDevicesDetailed` 用 account_info 私钥解密 info：`Android 手机`/`Chrome` 等可读；无法解密条目 name/type=null（不泄露 JWE） |
| 7 | 每身份 deviceName | ✅ | `PATCH /admin/api/identities/:id {deviceName}`（1–100）；create/generate 自动 `DuckCPA@<4hex>`；默认身份迁移为 `DuckAI@main` |
| 8 | 429 限流 | ✅ | DuckDuckGo Sync `/login` 418 → 429 `sync_rate_limited`（Retry-After/hint/retryAfterMs），2 分钟冷却；前端显示「限流中，请 X 秒后重试」 |

自动化：`npm test` **289 / 289 PASS**；`build-check` **13 / 13**；`page-check` **18 / 18**（含 device-slots 契约）；真实联调 `PUT device-slots` 双设备 200 → 注销 200。


## 2.7 v2.12 compact 语义修正与摘要折叠块（Lead 实测）

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 自动压缩仅白名单模型 | ✅ | 9 个白名单模型（claude-haiku-4-5/5-5、sonnet-4-6/5-5、opus-4-8/5-5、gpt-5.4-mini、gpt-5.6-terra/sol）；`gpt-6-luna` 不支持自动压缩，工具栏显示「不支持自动压缩」 |
| 2 | 触发按 pair/activation（非字符） | ✅ | `activationTargetPairCount` 优先（target>covered 且 <=activePairs），否则 fallback `activePairs-covered>=4 && activePairs>=4`；字符阈值降为兜底 200000；源码见 `docs/COMPACTION-RESEARCH.md` |
| 3 | 服务端 DONE 标记解析 | ✅ | `[SUMMARY_REFRESH_HINT]`（URL 编码 JSON，含 thresholdTokens）→ `session.pendingCompaction`；`[SUMMARY_INVALID]`、`[LIMIT_CONVERSATION]`（先 compact 重试再 trim）；标记从正文剥离 |
| 4 | 摘要可见（折叠块） | ✅ | 消息流顶部「上下文摘要 · 覆盖 N 条消息」默认折叠，展开显示全文（等宽/可选中），支持复制、编辑（PATCH summary）、清除压缩（DELETE，恢复全量消息）；头部徽章联动展开（截图 `admin-chat-summary-fold.png`） |
| 5 | 模型能力 API | ✅ | `/v1/models` 与 `/admin/api/models` 一致：`compaction_supported`、`activation_target_pair_count`、`input_char_limit`、`context_window_chars`；gpt-6-luna=false/0/16000，gpt-5.4-mini=true |
| 6 | 原生 summarize | ✅ | 真实账号 `gpt-5.4-mini` → `POST /duckchat/v1/summarize` **200**；`gpt-6-luna` → 404 `ERR_MODEL_UNAVAILABLE`（与白名单一致）；匿名出口偶发 418 已按 warn 回退 |
| 7 | 完整 API/功能地图 | ✅ | `docs/DUCKAI-FEATURE-MAP.md` 枚举 `/duckchat/v1/*`、SSE 事件与标记、Sync 端点、网页功能，并标注已实现/部分/缺失（缺口清单见文档 §6） |

自动化：`npm test` **343/343 PASS**；`build-check` **16/16**；`page-check` **22/22**（mock 网关，含 v2.12 压缩能力/summary PATCH/DELETE）；smoke 9/9；proxy-live 11/11。真实会话因上游共享出口 418 `ERR_BN_LIMIT` 标记 BLOCKED（模型能力接口真实 200）。

## 2.8 v2.15 订阅池 + 配对 UX 修复 + 主设备标记（Lead 实测）

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 订阅为一等实体（`data/subscriptions.json`，0600） | ✅ | `POST/GET/PATCH/DELETE /admin/api/subscriptions`、`/:id/verify`；token 去重；响应脱敏（不含明文 token） |
| 2 | 一个订阅绑定多个身份 | ✅ | 实测 `sub_…` 绑定 `id_default` + 另一个身份，`bindingCount=2`；删除订阅返回 `unbound:2` 并全部解绑 |
| 3 | 身份池订阅字段 | ✅ | `GET /admin/api/identities` 返回 `subscriptionId/subscriptionLabel/subscriptionTier/subscriptionExpiresAt`；付费路由仍只选 `subscribed` |
| 4 | 「订阅」标签页 | ✅ | 侧边栏「订阅」+ `#/subscriptions`：统计卡、订阅列表、新增/改名/校验/删除；jsdom 实测渲染 |
| 5 | 身份池选择器绑定 | ✅ | 行操作「绑定订阅」弹窗为 Select（选项来自 `/subscriptions`，显示 label/tier/已绑数），提交 `{subscriptionId}`；「订阅」列显示名称+tier，未绑定显示「未绑定」 |
| 6 | 配对成功不再误报冲突 | ✅ | `GET /admin/api/sync/pairing`：`accountMerged=true` 时 `accountConflict=false`；实测配对后账号已合并到手机账号（`383b793c…`），设备 `Android 手机 / Chrome / Edge / DuckAI@main` 同账号 |
| 7 | 扫码阶段明确提示 | ✅ | 配对面板 `pairing-phase-hint`：exchange/joiner_awaiting 时提示「手机已扫码，请回到手机点允许」；完成 toast 区分 joiner/host 与「两端已同账号」 |
| 8 | 主设备标记 | ✅ | `/admin/api/sync/server-devices` 返回 `primaryDeviceId` 与每设备 `primary`；前端显示「主设备（本机）」 |

自动化：`npm test` **347/347 PASS**（新增 `web-subscriptions-v215`、`pairing-merged-v215`；`--test-concurrency=1` 避免 jsdom 全局 fetch 与并发用例互相干扰）；`build-check` **16/16**；`page-check` **22/22**。

## 2.9 v2.16 默认身份页 + Sync & Backup 重设计（Lead 实测）

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 标签页更名「默认身份」 | ✅ | 侧边栏、页面标题、`document.title` 均为「默认身份」；截图 `admin-default-identity-v216.png` |
| 2 | 移除身份页残留订阅卡片 | ✅ | 页面不再出现「DuckDuckGo 订阅」卡片；订阅入口统一到「订阅」页 |
| 3 | Sync & Backup 与设备列表跨整行 | ✅ | 两卡 `xl:col-span-2`，截图确认纵向单列布局 |
| 4 | Sync 模式（backup / syncOnly） | ✅ | `POST /admin/api/sync/mode` 200；`GET /sync.mode` 实时回读；`syncOnly` 下配对不落盘恢复码（代码路径已接入，日志可查） |
| 5 | 删除 Sync & Backup 数据 | ✅ | `POST /admin/api/sync/delete-data` 无 confirm → 400；前端弹窗需手输 `DELETE` 才可提交；截图 `admin-sync-delete-dialog.png`（本实测未真正执行删除，避免破坏当前账号） |
| 6 | 订阅页/选择器实机验证 | ✅ | `admin-subscriptions-v216.png`（订阅页空态+新增按钮）、`admin-identity-subscription-selector.png`（身份池「绑定订阅」弹窗：无订阅时引导） |

自动化：`npm test` **347/347**、`build-check` **16/16**、`page-check` **22/22**；新 bundle `index-BvynXg_j.js`。

## 2.10 v2.17 Sync This Device Only（更正 v2.16 误解）

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 纠正语义 | ✅ | 源码 `DUCKCHAT_SYNC_SETUP_THIS_DEVICE_ONLY="Sync This Device Only"` + `signUpForPairing()`；对应 `/sync/signup`，不是「只同步不备份」 |
| 2 | `SyncClient.signup()` | ✅ | 单测断言 POST `/signup` body（user_id/hashed_password/credential_id/keys[0] ai_chats/JWE 5 段/RSA JWK）、恢复码可解析、无 token 回退 login |
| 3 | `POST /admin/api/sync/create-own-account` | ✅ | 已配置账号缺 confirm → 400 `sync_account_exists`（实测）；`{confirm:true}` → 200 且自动注册设备（mock API 测试） |
| 4 | 前端两个入口 | ✅ | 截图 `admin-sync-this-device-only.png`：Sync With Another Device（生成配对码）/ Sync This Device Only（创建本机账号），并显示当前账号来源 |
| 5 | 移除错误的「仅同步」开关 | ✅ | 页面不再出现「仅同步（Sync only）」；`GET /sync.accountSource` 取代其用途 |

自动化：`npm test` **351/351**、`build-check` **16/16**、`page-check` **22/22**（Sync 未配置时相关用例 SKIP）。

## 2.11 v2.17.1 创建本机账号打通（真实账号）

| 报错/现象 | 根因 | 修复 | 结果 |
| --- | --- | --- | --- |
| `device_id ... was 0` | signup body 缺 device triple（duck.ai `PV()`） | `/signup` 增加 `device_id/device_name(JWE)/device_type(JWE)` | ✅ |
| `public_key->alg ... was 0` | Node JWK 导出无 `alg`（浏览器自动带） | `public_key` 补 `alg:RSA-OAEP-256`/`use:enc`/`key_ops` | ✅ |
| 账号来源显示错误 | pairing store 只认 manual/pairing | 保留 `self` | ✅ |

真实创建成功：账号 `4f0be20c-37b2-4825-a59f-0ca4a107f080`，`DuckAI@main` 已注册（`primary:true`），
恢复码 `source:self`，UI 显示「当前账号：本机独立备份账号（Sync This Device Only）」。
截图：`docs/screenshots/admin-sync-own-account-enabled.png`。

## 2.12 v2.18 配对日志 / 设备按钮化 / 重命名与删除 / 重复设备修复

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 配对失败原因可查 | ✅ | 日志显示第一次扫码 idle 超时（手机未确认），第二次成功；`docs/ADMIN_API_V2.md §24.1` |
| 2 | 二维码右侧交互记录 | ✅ | `data-testid=pairing-message-log`：双向消息 + 类型/HTTP/时间 + 阶段提示；截图 `admin-pairing-message-log.png` |
| 3 | 设备列表去拖拽 | ✅ | `draggable` 元素 0 个；左右栏用「加入 / 移除」按钮 + 保存；截图 `admin-device-list-buttons.png` |
| 4 | 设备二级菜单 | ✅ | 每行「⋮」→ 重命名设备 / 从设备列表移除；`PATCH /identities/:id {deviceName}` |
| 5 | 身份池重命名图标 | ✅ | 设备名旁铅笔按钮（`aria-label=重命名设备 …`）+ 弹窗；截图 `admin-pool-rename-device.png` |
| 6 | 重复 DuckAI@main 修复 | ✅ | 根因：全局 identity 与 pool 默认身份是两份设备记录；统一用 pool 默认身份，并清理旧设备；当前账号仅一台 DuckAI@main |

自动化：`npm test` **351/351**、`build-check` **16/16**、`page-check` **22/22**；新 bundle `index--pILyu0k.js`。

## 2.13 v2.19 模型目录分析 / 思考去重 / 内联摘要 / continuation 修复 / 日志翻页

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 模型列表获取方式分析 | ✅ | `docs/MODEL-CATALOG-SOURCE.md`：bootstrap `GET /duckchat/v1/capabilities`（flags/experiments）+ 内置模型元数据 hook（available/plus/pro）；字段 `model/modelName/modelVariant/modelType/inputCharLimit/inputImageSupport/toolChoice`；**无 `/models` 端点** |
| 2 | 每模型上下文/token 上限分析（仅分析） | ✅ | `docs/CONTEXT-TOKENS.md`：bundle 无 `maxTokens/contextWindow`；只有字符 `inputCharLimit`(16000) + 服务端 `[SUMMARY_REFRESH_HINT].thresholdTokens` / `[LIMIT_CONVERSATION]`；不压缩模型达到上限 → `DUCKCHAT_ERROR_CONVERSATION_LIMIT`「Start a new chat」，源码**不会自动新会话**；可压缩模型 → 「Summarize and Continue」 |
| 3 | 思考内容重复修复 | ✅ | 根因：reasoning `done` 帧的 `summaryText` 被当作增量追加，与 `text-delta` 重复；现在 `done` 仅在无流式明文时作兜底（`sse.js`/`index.js`） |
| 4 | 摘要内联到触发点 | ✅ | 摘要卡插在 `anchorIndex`（=coveredMessageCount）之后；头部徽章联动滚动高亮；截图 `admin-chat-inline-summary.png` |
| 5 | 天气类问题 502 修复 | ✅ | 根因：上游以 `continuation` 帧（user-location 审批）结束而非 [DONE]；新增 `_resumeContinuation`（token + 自动批准 approvals + responseId 复用一个 + 原 body 重发），400 时回退显式 `metadata.toolChoice={WebSearch:true}`；实测网关返回 **200** 且内容正确 |
| 6 | 日志翻页优化 | ✅ | 每页 20/50/100/200 可选 + 跳转页码 + 上一页/下一页；实测 173 条 / 9 页、跳转到第 3 页成功；截图 `admin-logs-pagination.png` |
| 7 | 日志 502 可诊断 | ✅ | 网关日志保留 `errorDetail`（eventIndex/reason）；新错误码 `upstream_client_tool_unsupported` 用于无法满足的 client-output 工具 |

自动化：`npm test` **353/353**（新增 `continuation.test.js`）、`build-check` **16/16**、`page-check` **22/22**；新 bundle `index-DgyvDdaa.js`（日志页修复后重新构建）。

## 2.14 v2.20 /v1/models 上下文与压缩字段（按文档实现）+ 真实上限测量

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | `/v1/models` 新字段 | ✅ | `context_window_chars=20000`、`max_input_chars=19500`、`input_char_limit=16000`、`max_output_tokens=4096`（`estimated:true`）、`compaction_supported`、`compaction_trigger`、`compaction_threshold_tokens`、`activation_target_pair_count`、`session_limit_behavior`；`/admin/api/models` 同步；`capabilities` 内同名字段 |
| 2 | `session_limit_behavior` | ✅ | gpt-6-luna=`new_chat`、gpt-5.4-mini=`summarize_and_continue`；规则=压缩白名单 → 摘要后继续，否则只能新会话（源码 `DUCKCHAT_ERROR_CONVERSATION_LIMIT`） |
| 3 | 超长输入错误映射 | ✅ | 上游 429/`context_length_exceeded` → **HTTP 413 `context_length_exceeded`**（此前误报 502 `upstream_error`）；实测 19,600 字符返回 413 |
| 4 | 真实测量脚本 | ✅ | `scripts/limit-probe-gateway.mjs`（走连接测试链路，含身份池/队列/压缩）与 `scripts/limit-probe.mjs`（直连协议层）；结果 JSON 在 `data/tmp/limit-gateway-*.json` |
| 5 | 单条输入上限实测 | ✅ | 中文：19,500 通过 / 19,900、20,000 被拒；**ASCII**：19,500 通过 / 19,600 被拒 → 按**字符**而非 token；因此 `max_input_chars=19500`、`context_window_chars=20000`（保守）；`input_char_limit=16000` 仅为 duck.ai 前端 UI 软限制 |
| 6 | 会话/压缩行为实测 | ✅ | gpt-6-luna 8 轮 / 24,286 字符全部 200，无压缩（未触顶）；gpt-5.4-mini 10 轮 / 30,164 字符，第 6、10 轮触发 `compacted` 后继续 → 验证 `summarize_and_continue` |
| 7 | 输出长度实测（下界） | ✅ | “尽量长写作”请求：gpt-6-luna **6,427 字符**、gpt-5.4-mini **4,335 字符**；无输出截断错误；`max_output_tokens=4096` 保留 estimated 标记 |

自动化：`npm test` **353/353**（模型字段断言更新）、`build-check` **16/16**、`page-check` **22/22**（新增 compaction/session_limit 契约）。
文档：`docs/CONTEXT-TOKENS.md`（方法 + 实测表）、`docs/MODEL-CATALOG-SOURCE.md`、`docs/API.md`、`AGENTS.md` §9。

## 2.15 v2.21 模型配置页 + 客户端压缩 + 入口检测修复

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 模型配置页（前端） | ✅ | `#/model-config`：每个模型可编辑上下文窗口 / 单条输入 / 输出上限，快捷预设「duck.ai 默认 / duck.ai 实测上限 / 自定义」，保存/重置/生效值展示；实测预设→保存→行内生效（8,192 自定义）→重置回默认，截图 `docs/screenshots/admin-model-config.png` |
| 2 | 模型配置 API | ✅ | `GET/PUT /admin/api/models/config`；校验未知模型/越界/字段关系（400 `invalid_model_override`）；写入 `config.models.overrides` 后 `/v1/models` 立即生效（实测 32000/30000/8192） |
| 3 | 会话上限 409（不自动压缩） | ✅ | 上游 `conversation_limit_reached` 直接返回 409 + hint（提示新建会话或 `POST /v1/compact`），不再 trim 重试；单测断言上游只调用 1 次 |
| 4 | 客户端压缩 API | ✅ | `POST /v1/compact` 实测真实上游 200：返回摘要（7 条覆盖 / 3 对 / 145 字）+ 保留最近 2 条消息 |
| 5 | 入口检测修复（429 unsupported entrypoint） | ✅（已修，长期观察） | 根因：`meta.stack` 发的是 Node `file:///…challenge.js` 帧；浏览器 stack 指向 `entry.duckai.<hash>.js`（抓包对照）。修复后解码确认 stack 为 `https://duck.ai/dist/duckai-dist/entry.duckai.965285ea…js:2:…`，`x-fe-signals` 非空；修复后连接测试 200。详见 `docs/PROTOCOL-ERRORS.md` §3.1.1 |
| 6 | 回归 | ✅ | `npm test` 全绿（新增 model-config / compact-api / entrypoint-meta 三组）、`build-check`、`page-check` |

## 2.16 v2.21 复核（智能体团队实机验证 + 复核发现并修复 1 个缺陷）

团队状态：qa-verifier / duck-protocol / api-core 三名队友均已正常启动并完成真实任务（模型解析为 `deepseek/deepseek-v4.1-flash`，与 Lead 一致）。

| # | 复核项（队友执行） | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | qa-verifier：全量验证矩阵 + spot-check（task-62） | ✅ PASS | `npm test` 366/366、`build-check` 16/16、`page-check` 22/22；`models/config` 10 模型 defaults 20000/19500/4096；PUT 32000/30000/8192 生效→null 重置；`/v1/compact` 200 且 kept=2；三类非法输入均 400 `invalid_model_override`；写入 `docs/QA.md` §12 |
| 2 | duck-protocol：入口检测修复复核（task-63） | ✅ PASS | 真实挑战 `meta.stack` = `Error\nat l (https://duck.ai/dist/duckai-dist/entry.duckai.965285ea….js:2:2151366)`，无 `file:///`/`node:internal`；`DUCKAI_NATIVE_STACK=1` 可复现旧行为；`x-fe-signals` 非空；近 2h upstream 28/28 全 200、0 次 429/unsupported entrypoint |
| 3 | duck-protocol：模型目录/压缩源码分析（task-57） | ✅ 完成 | `docs/MODEL-CATALOG-SOURCE.md` §1.4/§1.5、`docs/CONTEXT-TOKENS.md` §E：模型元数据是前端常量（无 `/models` 端点）、真实字段含 `availableTo/inputCharLimit/inputImageSupport/supportedTools`、非压缩模型上限不自动新开会话 |
| 4 | api-core：后端契约复核（task-64） | ⚠️ 15/16 PASS | 发现 **1 个真实缺陷**：`normalizeModelEntry()` 在上游只通过 `capabilities.maxOutputTokens` 给值时仍标 `estimated:true` |
| 5 | 缺陷修复 | ✅ 已修 | `src/openai/models.js:137-141`：仅当 raw 与 capabilities **都**缺 `maxOutputTokens` 才标估算；新增回归用例（`tests/openai-models.test.js`，总计 367/367）；`docs/ADMIN_API_V2.md` §25.2 校验表按实际实现更正（未知字段忽略、只给 input 不做关系校验、`{}` 等效默认、覆盖 output 置 estimated=false） |

修复后回归：`npm test` **367/367**、`build-check` **16/16**、`page-check` **22/22**（网关已重启加载修复）。

## 2.17 v2.22 每模型工具开关 + 不支持工具策略 + 目录刷新

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 模型配置页新增「工具」列 | ✅ | 只对 `supported:true` 的 tool 显示 Switch（gpt-6-luna 两个、claude-haiku 仅联网搜索、mistral 显示“上游不支持任何工具”且无开关）；不支持项仅列名不显示按钮 |
| 2 | 全局「不支持的 tool 报错」开关 | ✅ | 默认关闭=静默清理；开启后 400：`unsupported_tool`（function）/ `tool_not_supported`（模型不支持或被关闭）/ `tool_disabled`（服务端关闭）；实测开关切换 + 保存成功后配置落盘 `models.tools` |
| 3 | 每模型工具开关生效 | ✅ | 关闭 luna 的 `image_generation` → `/v1/models` 的 `tools` 仅剩 `web_search`，`tools_disabled=["image_generation"]`；请求 image_generation 默认被丢弃（200），strict 下 400 |
| 4 | 校验 | ✅ | 给 mistral 开 tool → 400「模型不支持 web_search（可选项：无）」；未知模型/未知 tool/非布尔均 400 |
| 5 | 刷新上游能力按钮 | ✅ | 头按钮 → `POST /admin/api/models/refresh`，页面显示「已刷新上游能力快照（时间）· 模型目录 10 个（内置静态表）· flags N 个」；截图 `admin-model-config-tools.png` |
| 6 | 模型目录来源澄清 | ✅ | 文档写明：静态内置表，无定时刷新；duck.ai 无 `/models` 端点，`/capabilities` 仅 flags/实验（启动 1 次 + 手动刷新按需） |
| 7 | 回归 | ✅ | `npm test` **373/373**（新增 5 例工具策略/刷新）、`build-check` 16/16、`page-check` 22/22 |

## 2.18 v2.23 模型配置交互重构（自动保存 / 单参数重置 / 危险卡片）

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 「刷新上游能力」移入「模型覆盖配置」卡片 header 右侧 | ✅ | 页头不再有该按钮；卡片 header 右侧渲染 + 点击后显示快照信息条 |
| 2 | 去掉保存按钮，改为防抖自动保存 | ✅ | 改一个输入框 → 页头「修改后自动保存」→「已自动保存 · 02:56:03」，行内“生效”值同步为 25,000；无保存按钮 |
| 3 | 每个模型每个参数可单独重置 | ✅ | 输入框右侧 RotateCcw 按钮（未覆盖时禁用）；点击后清空该字段并自动保存，生效值回到默认 20,000 |
| 4 | 最底部新增危险卡片 + 完整重置 | ✅ | 「危险 / 高级操作」卡片：重置全部模型配置（二次确认）→ `POST /admin/api/models/config/reset` → 覆盖/工具/开关全部复位（实测 override=null、tools_enabled 恢复、drop_unsupported_tool=true） |
| 5 | 「不支持的工具如何处理」并入危险卡片 | ✅ | 独立卡片已删除；开关改名「静默清理不支持的 tools」，**默认开启**；开启=自动丢弃（观测 200），关闭=报错（观测 400 `unsupported_tool`） |
| 6 | 语义反转（后端） | ✅ | `config.models.tools.dropUnsupported`（默认 true）；`strictUnsupported` 已废弃（PUT 会 400 提示）；`/v1/models` 与 `models/config` 用 `drop_unsupported_tool` |
| 7 | 回归 | ✅ | `npm test` **374/374**（新增 reset 端点用例）、`build-check` 16/16、`page-check` 22/22；截图 `admin-model-config-danger.png` |

## 2.19 v2.24 日志下载 / 日志保留策略 / Token 消耗统计

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 日志下载（可选上游或面板日志） | ✅ | 页头「下载日志」下拉 6 项（上游/面板 × JSONL/CSV/JSON）；实测 CSV 下载 toast「已下载 上游日志：duckai-cpa-upstream-logs-….csv」，CSV 表头含 token 列；`GET /admin/api/logs/download` 三种格式均带 `Content-Disposition` |
| 2 | 日志按钮位置 | ✅ | 「下载日志」「清空日志」移入「请求日志」卡片 header 右侧（Tabs 左边），页头只留「刷新」；截图 `admin-logs-toolbar.png` |
| 3 | 危险卡片：日志最大存储条数 + 最大保留时间 | ✅ | 日志页底部「危险 / 高级操作」卡片；PUT 300/5 生效（`pruned` 生效、立即裁剪），非法值 400 `invalid_log_retention`；写入 `logging.maxEntries/maxAgeDays` |
| 4 | 概览 Token 消耗总览（分模型 / 全部） | ✅ | 新增卡片：总/输入/输出 tokens + 请求数 + 模型筛选下拉 + 「按模型」表；实测 gpt-6-luna 3 请求 53 tokens |
| 5 | Token 可追踪到具体身份的模型 | ✅ | 「按身份 × 模型」表：id_7e9beb2c（页面槽位 9）29 tokens / id_0946c74c（页面槽位 15）24 tokens；`GET /admin/api/usage?model=` 可过滤 |
| 6 | 持久化 + 不受清空日志影响 | ✅ | 累计写入 `data/usage.json`；单测断言清空上游日志后 total 不变 |
| 7 | 顺带修复：page-check 污染身份池 | ✅ | 原逻辑每次运行 `identities/generate` 后不删除，导致池从 10 涨到 20（满）→ 409；已改为 try/finally 强制删除 + 池满时 SKIP，并清理 17 个历史测试身份（池 20 → 3） |
| 8 | 回归 | ✅ | `npm test` **378/378**（新增 4 例）、`build-check` 16/16、`page-check` 22/22（连续两次运行池大小不变） |

## 2.20 v2.25 订阅「免复制 JWT」登录（源码分析 + 一键书签）

| # | 能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 订阅绑定流程源码分析 | ✅ | `docs/SUBSCRIPTION-LOGIN.md`：token 从 `GET https://quack.duckduckgo.com/api/auth/v2/token?...`（cookie 凭据，401=未登录）或 Electron 的 `/duckchat/v1/auth/token` 获取；登录走 PKCE（`/duckchat/v1/auth/authorize?code_challenge=` → cookie `ddg_auth_code_verifier` → `/auth/callback` → `/auth/token`），auth 请求 15s 超时、无轮询、token 请求并发合并 |
| 2 | 网关登录会话 | ✅ | `POST /admin/api/subscriptions/login-session` 生成 48-hex 会话（TTL 300s）+ `bookmarklet` + `captureUrl` + `relayUrl`；`GET/DELETE .../:id` 查询/取消 |
| 3 | 免复制捕获 | ✅ | 书签在 duck.ai 源内 `fetch` 取 token 并 POST `/capture`（无 admin token，CORS 白名单）；实测 200 + `Access-Control-Allow-Origin: https://duck.ai`，订阅入池、会话 `completed` |
| 4 | 错误路径 | ✅ | 未知会话 404、重复提交 409、非法 token 422 且会话 failed（单测 + 实机均验证） |
| 5 | 管理页 UI | ✅ | 订阅页新增「免复制 JWT 登录（推荐）」卡片：生成登录链接 → 步骤说明 → 复制书签脚本/会话链接 → 状态徽章「等待授权…」→ 2 秒轮询 → 自动变「已绑定」并刷新列表；截图 `admin-subscriptions-login.png` |
| 6 | 回归 | ✅ | `npm test` **383/383**（新增 5 例）、`build-check` 16/16、`page-check` 22/22 |

> ⚠️ 验证用**合成 JWT**（本项目 `parseSubscriptionToken` 不验签，只解析 claims）：当前 Chrome 未登录 DDG，
> 无法取真实 `access_token`。真实链路只差「用户在自己已登录的浏览器点一次书签」。

## 2.21 v2.26 免复制登录可用性修复（书签 / CSP / LNA）+ 真实 Pro 绑定

| # | 问题 | 修复 | 证据 |
| --- | --- | --- | --- |
| 1 | 地址栏粘贴 `javascript:` 变成搜索 | UI 改为「拖到书签栏 / 右键添加到书签」，并给出 Console 方式；黄色提示明确「不要粘贴到地址栏」 | 截图 `admin-subscriptions-login.png`（方式 A/B 引导） |
| 2 | 书签点击 `Failed to fetch` | 根因 duck.ai CSP `connect-src` 不含 duckduckgo.com → 脚本改用同源 `/duckchat/v1/auth/token` | 浏览器实测该端点 200、返回 `access_token` |
| 3 | 同源取到 token 后仍无法回传 | Chrome Local Network Access 拦截公网→127.0.0.1；脚本回退 `window.open` 打开管理台（顶层导航不受限），管理台同源 capture 并立即清除 URL 里的 token | 实测 `window.open` → 管理台自动绑定；capture 补 `Access-Control-Allow-Private-Network: true` |
| 4 | hash 路由把 `?sessionId=&token=` 重写掉 | `hash-route.ts` 仅在 hash 为空时补默认路由，不再重写带查询串的 hash | 管理台能读到 token 并提交 |
| 5 | 订阅显示「未验证 / 到期 —」 | capture 写入 `source=login, verified=true`；`normalizeTs` 支持 ISO 字符串 | 列表显示「Pro · 已验证 · token 到期 11/03 14:11:02」 |
| 6 | 真实 Pro 绑定 | ✅ | tier=pro、email=user@example.com、verified=true，会话 completed |
| 7 | 回归 | ✅ | `npm test` **386/386**、`build-check` 16/16、`page-check` 22/22 |

## 2.22 v2.27 订阅页布局调整 + 自刷新（refresh token）+ 删除身份需先解绑订阅

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 订阅页 header 的「刷新 / 新增订阅」移入订阅列表卡片 | ✅ | 页头不再有按钮；「订阅列表」卡片 header 右侧渲染两个按钮（`data-testid=subscription-refresh/subscription-add`） |
| 2 | 登录卡片按步骤重排 | ✅ | 步骤 1「打开 duck.ai」按钮 → 步骤 2 方式 A（拖书签 + 复制书签脚本）→ 步骤 3 方式 B（复制控制台脚本）→ 状态徽章 + 复制会话链接；截图 `admin-subscriptions-auto-refresh.png` |
| 3 | 订阅 token 自刷新 | ✅ | 源码证明 `ddg_auth_refresh_token`（30 天、HttpOnly）可换新 access token 并轮换；网关保存后每 5 分钟巡检、到期前 30 分钟自动续期 |
| 4 | 自刷新实测 | ✅ | 真实 Pro：`refreshed:true rotated:true tier:pro expiresAt 21:00:39Z refreshCount:3`；绑定身份后 `authExpiresAt` 同步更新 |
| 5 | 删除身份需先解绑订阅 | ✅ | `DELETE /admin/api/identities/:id` → 409 `identity_has_subscription`（含 subscriptionId/tier/hint）；前端弹窗「解绑订阅并删除」；加 `?force=true` 可解绑后删 |
| 6 | 回归 | ✅ | `npm test` **391/391**（新增 5 例续期/删除保护）、`build-check` 16/16、`page-check` 22/22 |
## 2.23 v2.28 订阅默认名 / 设置页布局与抖动 / duck.ai 提示词生成器

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 订阅默认名称改为绑定时间 | ✅ | capture 默认 `绑定 MM-DD HH:mm`（例：`绑定 11-03 13:26`），单测断言正则；实测新捕获的订阅名即时间 |
| 2 | 设置页 header 不再放按钮 | ✅ | 移除「重新加载 / 保存设置」，header 只显示标题与描述 |
| 3 | 设置页抖动（自动刷新） | ✅ | 根因：`overviewModels` 每 5s 新数组 → `load` 依赖变化 → `setLoading(true)`；改为不订阅 overview 后，11 秒内 `/config` 请求数 = 0（此前 3 次） |
| 4 | 保存下沉到各卡片 | ✅ | 队列/提示词/工具/日志四张卡片各有「保存」按钮，只提交自己的配置段；实测保存提示词成功且 `prompts.source=duckai` 落库 |
| 5 | 提示词按源码逻辑生成 | ✅ | `src/duck/prompt.js` 复刻 duck.ai「Customize responses」拼接顺序与原文；`src/duck/duckai-roles.json` 从 bundle 提取 24+6 个角色 |
| 6 | 默认来源为 duck.ai | ✅ | `prompts.source` 默认 `duckai`；设置页默认显示「duck.ai 默认（源码生成器）」；单测断言 `/admin/api/config` 默认值 |
| 7 | 模型与超时卡片迁移 | ✅ | 「设置」页删除该卡片；「模型配置」页新增「默认模型与超时」（默认模型/超时/允许付费模型，防抖自动保存，实测改 150000 后 `duck.timeoutMs=150000`） |
| 8 | 回归 | ✅ | `npm test` **399/399**（新增 8 例生成器/端点/配置）、`build-check` 16/16、`page-check` 22/22 |
## 2.24 v2.29 连接测试身份路由 + 模型配置限制列合并/推理等级

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 先请求再绑定身份（不再创建即绑定） | ✅ | `POST /admin/api/test/sessions` 返回 `identityId=null`；首个消息请求后回填（单测 + 实机） |
| 2 | 付费模型不再因绑定 free 身份而报错 | ✅ | 付费模型 `claude-opus-5-5` 首发 200，助手消息 `model=claude-opus-5-5`，会话身份自动改为订阅身份 `id_default` |
| 3 | 自动改绑 | ✅ | `routeDetailed({rebindOnSubscriptionMismatch:true})` 返回 `rebound:true`；单测覆盖「先绑 free → 付费请求 → 改绑订阅身份」 |
| 4 | 身份在请求后返回给前端 | ✅ | SSE `done` 带 `identityId/identityLabel`；连接测试页新会话发送后会话行出现「默认身份」徽章 |
| 5 | 模型配置三列合并为一列三行 | ✅ | 表头变为「限制（上下文 / 单条输入 / 输出）」，每行三段输入 + 重置 + 默认值；截图 `admin-model-config-limits-merged.png` |
| 6 | 显示可接受的推理等级 | ✅ | 新增「推理等级」列（`none/low`、`none/low/medium`；不支持时显示「不支持推理等级」），来自 `modelConfigPayload.reasoning_efforts` |
| 7 | 回归 | ✅ | `npm test` **401/401**（新增 2 例路由；更新 2 例旧契约）、`build-check` 16/16、`page-check` 22/22 |
## 2.25 v2.30 双池路由（只绑一次 + 切换模型改绑）+ 绑定缓存 TTL + 绑定分页

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 付费池 / free 池分离，请求前判断模型再路由 | ✅ | `_candidates()`：付费=仅订阅身份；free=未订阅优先（无则回退）。单测覆盖 |
| 2 | 只绑定一次 | ✅ | 同池重复请求返回 `rebound:false` 并复用绑定（单测断言）；`updatedAt` 刷新滑动 TTL |
| 3 | 中途切换模型才重新绑定 | ✅ | 实测：免费模型 → 分身 2（free 池）；切付费 → 默认身份（pro，`rebound:true`）；再切回免费 → 分身 2 |
| 4 | 绑定缓存 7 天自动清理 | ✅ | `pool.bindingTtlDays` 默认 7；启动/路由前/每 10 分钟清理；单测：8 天前绑定被移除，0=永不过期 |
| 5 | 天数可配置（身份池页） | ✅ | 新增「会话绑定缓存」卡片 + `GET/PUT /admin/api/identities/settings`；实测改成 3 天 → `config.pool.bindingTtlDays=3`，已恢复 7 |
| 6 | 会话绑定分页，默认 5 行 | ✅ | 身份池 → 会话绑定：每页 5 条、第 1/13 页、共 63 条（截图 `admin-identities-binding-pagination.png`） |
| 7 | 回归 | ✅ | `npm test` **405/405**（新增 4 例双池/TTL/设置）、`build-check` 16/16、`page-check` 22/22 |
## 2.26 v2.31 付费额度 / 会话多选删除 / SQLite 存储 / 会话历史页

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 找到额度 API 并显示进度 | ✅ | 源码定位 `GET /duckchat/v1/status` → `fixedCostWindowUsage.windows`；`GET /admin/api/identities/usage` 返回 |
| 2 | 付费身份显示每日/每周额度 | ✅ | 实测 `id_default`（Pro）：每日 35.2%、每周 5.0%（含重置时间），截图 `admin-identities-quota.png` |
| 3 | free 身份不可查则不显示 | ✅ | 匿名请求 status 无 `fixedCostWindowUsage`；接口返回 `supported:false, reason:free_identity`；页面不渲染 |
| 4 | 连接测试会话多选 + 批量删除 | ✅ | 复选框、全选、`POST /admin/api/test/sessions/bulk-delete`；实测勾选 2 个 → 对话框「批量删除 2 个会话？」，截图 `admin-chat-bulk-delete.png` |
| 5 | 列表数据改 SQLite | ✅ | `data/duckai.db`：identities/bindings/pool_meta/subscriptions/logs/usage_events/history；旧 JSON 首启自动导入 |
| 6 | 会话历史页（按身份折叠、时间倒序） | ✅ | `#/history`：身份分组折叠、组内按更新时间倒序、只读详情（系统上下文 + 按时间消息）；截图 `admin-history.png` |
| 7 | 会话保留策略（二选一：30 天未更新清理） | ✅ | `config.history.retentionDays`（默认 30，0=不清理），每 30 分钟清理；页面可改 |
| 8 | 真实会话入库 | ✅ | 连接测试真实调用后 `GET /admin/api/history` 出现 `id_bb9a73f7` 分组与消息 |
| 9 | 回归 | ✅ | `npm test` **409/409**（新增 4 例）、`build-check` 16/16、`page-check` 22/22 |
## 2.27 v2.32 free 身份额度耗尽 → 临时冷却 + 按需改绑

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 从源码找出 free 额度上限提示 | ✅ | `[LIMIT_ENTITY]` → `ERR_USER_LIMIT`（“maximum number of messages for one day … tomorrow”）；账号级 `[LIMIT_ACCOUNT]` → `ERR_ACCOUNT_LIMIT`；对话级 `[LIMIT_CONVERSATION]` 区分开 |
| 2 | 找到额度刷新时间 | ✅ | `[FIXED_COST_WINDOW_USAGE]` 的 `windows[].resetAt`（day = UTC 零点）；无窗口时 `pool.quotaCooldownMinutes` 兜底 |
| 3 | 刷新前临时禁用身份 | ✅ | `markCooldown` 写入 `cooldownUntil`，冷却身份不参与路由；实测「分身 1 冷却」时不参与新会话路由 |
| 4 | 已有会话不提前解绑 | ✅ | 实测：冷却期间手工绑定的 session 绑定保持 `id_0b68dfde` 不变 |
| 5 | 请求到来才改绑并持久化 | ✅ | 实测：绑定冷却身份的 session 发起请求 → 路由到 `id_bb9a73f7`，绑定同步持久化为新身份 |
| 6 | 未调用则保持原身份 | ✅ | 逻辑保证（无请求不触发改绑）；单测覆盖「冷却不清除绑定」 |
| 7 | 恢复后自动解除 | ✅ | `pruneCooldowns`（启动/路由前/每 10 分钟）清理过期冷却；也有手动 `DELETE /identities/:id/cooldown` |
| 8 | UI | ✅ | 身份池显示红色「额度冷却」徽章 + 到期时间 + 「解除冷却」按钮；截图 `admin-identities-cooldown.png` |
| 9 | 回归 | ✅ | `npm test` **413/413**（新增 4 例冷却/按需改绑/全冷却 429/API）、`build-check` 16/16、`page-check` 22/22 |
## 2.28 v2.33 v1 调用排查：单次上游调用 / 日志可追溯 / responses 写历史

| # | 问题 | 结论与修复 | 证据 |
| --- | --- | --- | --- |
| 1 | 为什么「调用了两次」 | 网关每条 HTTP 请求只调用一次上游（唯一 `callUpstream`）；连续实测 `/v1/responses` 非流式/流式/带 tools 均只产生 **1 条** upstream 日志。用户此前看到的两次是**两个不同的客户端请求**（相隔 7 秒、不同身份）。新增 `requestId` 便于区分 | 单测 `一次 /v1/responses 请求只产生一条 upstream 日志`；实测日志 |
| 2 | v1 会话没出现在会话历史 | 根因：`/v1/responses` 未接入历史记录（只有 chat/completions 有）。已为流式/非流式补上 | 实测两条 responses 请求均出现在历史，单测覆盖 |
| 3 | 日志显示 sessionId 与绑定身份 | 日志新增 `sessionKey` / `requestId`，页面「会话 / 身份」列展示 sessionKey + 身份 + requestId 前缀；连接测试日志用测试会话 id | 截图 `admin-logs-session-identity.png` |
| 4 | 回归 | ✅ | `npm test` **415/415**（新增 2 例）、`build-check` 16/16、`page-check` 22/22 |
## 2.29 v2.34 前端刷新按钮统一下沉到卡片（header 只放信息）

| # | 页面 | 调整 | 结果 |
| --- | --- | --- | --- |
| 1 | 全部页面 header | 右侧只保留 QueueStatusChips（执行中/排队/RPS/均等）；所有页面 `PageHeader.actions` 清空（仅模型配置保留“修改后自动保存”文字指示，不是按钮） | ✅ 静态检查 + 实机 7 个页面确认 |
| 2 | 概览 | 第一行新增「自动刷新」控制条：默认折叠显示当前间隔/更新时间，可展开选择 关闭/5s/10s/30s/60s + 手动刷新；间隔持久化到 localStorage | ✅ `data-testid=overview-refresh-bar/refresh-toggle/refresh-interval-*`；截图 `admin-overview-refresh-bar.png` |
| 3 | 默认身份 | 移除 header 刷新按钮（页面本身不提供整体刷新；设备列表刷新保留在其所属卡片内） | ✅ header 无按钮 |
| 4 | 身份池 | header 的 刷新/新建/批量生成/导入身份 全部移入「身份列表」卡片 header 右侧；「会话绑定」卡片新增刷新 | ✅ 截图 `admin-identities-header-refresh.png` |
| 5 | 会话历史 | 刷新移入「会话列表」卡片 header 右侧 | ✅ header 无按钮 |
| 6 | 日志 | 刷新移入「请求日志」卡片操作组（下载/清空 与 tab 之间） | ✅ 截图 `admin-logs-refresh-in-card.png` |
| 7 | 代理 | 刷新移入「代理配置」卡片 header 右侧 | ✅ header 无按钮 |
| 8 | API Key | 刷新 + 创建 Key 移入「Key 列表」卡片 header 右侧 | ✅ header 无按钮 |
| 9 | 回归 | ✅ | `npm test` **415/415**、`build-check` 16/16、`page-check` 22/22（实机 7 页逐一确认） |
## 2.30 v2.35 天气类问题 502 修复 + 图片 base64 / OpenAI 格式

| # | 问题 | 根因 / 修复 | 证据 |
| --- | --- | --- | --- |
| 1 | v1 与连接测试问「今天天气怎么样」报错 | 上游以 LocationPrompt 审批挂起（continuation）；网关显式 `metadata.toolChoice.WebSearch` 使流不可续传 → 409 `continuation-restart-required: incompatible` → 502。修复：不再注入 WebSearch toolChoice；continuation 按浏览器抓包重建（reasoning part/encryptedText、canUseApproxLocation、无 metadata/durableStream、复用 responseId 与滚动挑战）；失败时按浏览器语义重启一次 | v1 `/v1/chat/completions`（gpt-5.6-terra）**200** 返回天气+sources；连接测试 200；`npm test` 覆盖 continuation 契约 |
| 2 | 生图只返回思考内容和图片，格式不是 OpenAI | `/v1/images/generations` 返回 `data:[{b64_json,revised_prompt,format,mime_type}]`；`/v1/chat/completions` 的 `message.images` 改为 `{type:"image_url",image_url:{url:data URI},b64_json,format,mime_type}`（OpenRouter/LobeChat 约定），流式 `delta.images` 同构 | 实测 `/v1/images/generations` 200：b64 251KB/175KB、真实 JPEG；chat 生图 `message.images` 含 data:image/jpeg；单测 `tests/image-format-v235.test.js` |
| 3 | JPEG 被当成 PNG（MIME 错误） | duck.ai 实际返回 JPEG 但帧内 format 缺失/错误 → 新增 `src/duck/image-format.js`，按魔数探测 png/jpeg/webp/gif/avif/bmp，统一 format/MIME/data URI | 单测 + 实测 `format=jpeg`、`output_format=jpeg` |
| 4 | 回归 | ✅ | `npm test` **420/420**（新增 5 例：continuation 契约 + 图片格式），`build-check` 16/16，`page-check` 22/22 |
## 2.31 v2.36 定位开关 + 会话历史工具/图片展示

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 源码里的定位开关映射到网关设置 | ✅ | duck.ai `DUCKCHAT_ENABLE_APPROX_LOCATION` / 请求体 `canUseApproxLocation` → 新增 `tools.location`（默认 **false**），设置页「工具」卡片可开关 |
| 2 | 默认不允许定位 | ✅ | 默认请求 `canUseApproxLocation:null`；LocationPrompt 审批自动 `approved:false` + `canUseApproxLocation:false`；实测 v1 天气 **200**（模型反问城市），不再 502 |
| 3 | 定位可手动开启 | ✅ | 设置页开关保存后 `GET /admin/api/config` 显示 `tools.location:true`；关闭后恢复 false |
| 4 | 会话历史显示位置/生图工具调用 | ✅ | 历史记录写入 `toolCalls`（WebSearch/LocationPrompt/GenerateImage）；页面显示「位置调用 · 已拒绝」「图片生成 · 已完成」徽章，可展开参数/结果 |
| 5 | 会话历史显示生成图片 | ✅ | `images[]`（base64+format）写入 SQLite；页面以 data URI 回放（截图 `admin-history-tools-images.png`，naturalWidth=1122） |
| 6 | 回归 | ✅ | `npm test` **425/425**（新增 5 例：定位默认/API、历史 extras、v1 历史图片、continuation 拒绝定位）、`build-check` 16/16、`page-check` 22/22 |
## 2.32 v2.37 连接测试与会话历史共用消息组件（工具调用统一展示）

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 两个页面使用同一个消息解析/展示组件 | ✅ | 新建/复用 `webapp/src/app/components/chat-message.tsx`：`ChatMessageBubble` + `ToolCallList`；连接测试原本已用，会话历史改为同一组件（只读，无重试按钮） |
| 2 | 两边显示效果类似 | ✅ | 用户右侧气泡 / 助手卡片 / 模型徽章 / 时间 / 思考折叠 / 来源列表 / 生成图片，均来自同一组件 |
| 3 | 都可显示工具调用 | ✅ | 后端新增 `normalizeToolCalls`（工具调用 + 审批决策 + 生成图片自动补 GenerateImage）；连接测试 assistantMessage 与会话历史记录都写入 `toolCalls`；前端统一渲染「位置调用 / 图片生成 / 联网搜索」徽章，可展开参数与结果 |
| 4 | 连接测试持久化工具调用 | ✅ | `sessions.normalizeMessage` 保留 `toolCalls`；实测测试会话 assistant 带 `GenerateImage`（参数含图片提示词）与 `LocationPrompt 已拒绝` |
| 5 | 实机 | ✅ | 连接测试：图片生成会话显示「图片生成」+图片；会话历史：同会话同款气泡 + 图片；天气历史显示「位置调用 · 已拒绝」 |
| 6 | 回归 | ✅ | `npm test` **426/426**（新增 normalizeToolCalls 单测）、`build-check` 16/16、`page-check` 22/22 |
## 2.33 v2.38 天气 418 修复：定位关闭时 `canUseApproxLocation` 必须是 false

| # | 问题 | 根因 / 修复 | 证据 |
| --- | --- | --- | --- |
| 1 | 询问「今天天气怎么样」偶发/持续 418（ERR_CHALLENGE） | 关闭定位时网关发 `canUseApproxLocation:null`（浏览器抓包关闭设置后是 **false**）→ 上游仍弹 LocationPrompt → 拒绝/续传路径在匿名档被判定异常返回 418。修复：关闭时初始请求发 `false`，不再触发定位询问 | 浏览器抓包 body 对比；`PROTOCOL-ERRORS.md` §8.4 |
| 2 | 关闭定位行为 | free 身份连续两次天气请求 **200**；连接测试天气 **200**，工具调用为 `WebSearch`（不再出现 LocationPrompt 拒绝） | v1 + 连接测试实测 |
| 3 | 开启定位行为 | 设置开关开启 → 初始发 null → 自动批准审批 → 付费模型天气 200 且带位置回答 | 实测后已恢复默认关闭 |
| 4 | 回归 | 426/426 全绿（更新 2 条断言）、build-check 16/16、page-check 22/22 | ✅ |
## 2.34 v2.39 自定义 tools：网关级 function calling + MCP

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 上游能否注册自定义 tool | ❌（源码/实测确认） | 请求体无 tools schema；`metadata.toolChoice` 未知工具被忽略；`supportedTools` 固定枚举；`x-duckai-client-tools` 仅 bridge 已知能力（实验开关默认 false） |
| 2 | 网关支持 OpenAI `tools[].function` | ✅ | 协议注入最后一条 user 消息 + 解析；client 模式返回 `tool_calls`/`finish_reason:"tool_calls"`；实测真实上游：`get_weather({"city":"北京"})` → tool_calls；回传 role:tool 后得到最终回答 |
| 3 | MCP 工具（auto 模式） | ✅ | MCP stdio/http 客户端 + mock server；实测 HTTP MCP：initialize→tools/list→tools/call→结果回填→最终回答（`18°C` 来自 MCP 数据） |
| 4 | 配置/管理页 | ✅ | `tools.functionCalling.*` / `tools.mcp.*` 可 PUT；设置页新增函数调用开关、client/auto、MCP servers JSON（`settings-tool-function-calling` 等） |
| 5 | 限制 | 记录 | `/v1/responses` 暂未支持 function tools；tool 调用依赖模型遵循提示词（不遵循时按普通回答处理，不伪造 tool_calls） |
| 6 | 回归 | ✅ | `npm test` **435/435**（新增 function calling 4 例 + MCP 5 例）、`build-check` 16/16、`page-check` 22/22 |
## 2.35 v2.40 会话 ID 展示 / JSON 清理 / 生图后续会话修复 / client tools 调研

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 连接测试展示具体会话 session | ✅ | 选中会话 header 显示「会话 ID sess_xxx + 复制」；左侧会话列表每项显示完整 session id（`data-testid=active-session-id` / `session-id-<id>`） |
| 2 | 会话历史展示具体会话 session | ✅ | 详情 header 显示「会话 ID xxx + 复制」（history-session-id）；列表项显示 sessionKey（history-session-<histId>），无 X-Session-Id 的请求显示 `auto:<hash>` |
| 3 | SQLite 后不再生成多余 JSON | ✅ | identity-pool.json / subscriptions.json / logs.json / usage.json / stats.json / keys.json / testsessions.json / chat-summaries.json 全部停写；仅剩 config.json（配置）、identity.json（敏感身份）、pairing.json（恢复码） |
| 4 | 生图后继续会话 400 | ✅ 修复 | 根因：Codex 使用 `/v1/responses`，下一轮把上一轮 output 里的 `image_generation_call` item 原样放回 input，网关报 400 `Unsupported input item type "image_generation_call"`。现在接受并转成 assistant 占位文本（不含 base64） |
| 5 | 生图后空消息 | ✅ 修复 | `/v1/responses` 只有图片时补 `message` item + `output_text`「已生成 N 张图片（base64 位于 image_generation_call.result 字段）」；实测 round1 有文本、round2 继续对话 200 |
| 6 | client tools 调研 | ✅ | `docs/CLIENT-TOOLS-RESEARCH.md`：真正自定义 client tools 不可行（上游固定 supportedTools + loadUserSkill 固定契约，实验开关默认 false）；只能走网关 function calling + MCP（已实现） |
| 7 | 回归 | ✅ | `npm test` **438/438**、`build-check` 16/16、`page-check` 22/22（首次 compact 因上游 418 冷却失败，重跑通过） |
## 2.36 v2.42 移除自定义 tools（网关级 function calling + MCP）

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 删除前端「函数调用」开关 / 执行模式 | ✅ | 设置 → 工具卡片仅保留 联网搜索 / 图片生成 / 允许定位 三个开关（截图 `admin-settings-tools-clean.png`） |
| 2 | 删除前端 MCP 开关与 servers JSON | ✅ | `settings-tool-mcp*` / `settings-tool-function*` testid 均不存在 |
| 3 | 删除后端 function calling | ✅ | 删除 `src/openai/function-calling.js`；`models.js` 不再解析 `type:"function"`；`chat.js` 不再注入协议/返回 tool_calls；`role:"tool"` 返回 400 |
| 4 | 删除 MCP 能力 | ✅ | 删除 `src/tools/mcp-client.js`、`src/tools/`、index/server 的 MCP 装配与 `ctx.mcp` |
| 5 | 删除配置项 | ✅ | `tools.functionCalling.*` / `tools.mcp.*` 从默认配置、可编辑路径、校验、重启路径、`data/config.json` 全部移除 |
| 6 | 保留内置 tools | ✅ | `tools.webSearch` / `tools.imageGeneration` / `tools.location` 与 `/v1` 的 web_search/image_generation 行为不变；function tool 默认静默丢弃、strict 400 `unsupported_tool` |
| 7 | 回归 | ✅ | `npm test` **429/429**（删除 9 个 function calling/MCP 用例）、`build-check` 16/16、`page-check` 22/22 |
## 2.37 v2.42 测试离线化（不再调用真实 API）

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 单测不得访问真实 duck.ai / duckduckgo.com | ✅ | 新增 `tests/helpers/no-external-network.js`：非 `127.0.0.1/localhost` 的 `fetch` 一律抛 `ERR_TEST_EXTERNAL_NETWORK_BLOCKED` 并记录；由 `tests/helpers/test-server.js` 导入即启用 |
| 2 | 需要上游成功/失败路径时用 mock | ✅ | 新增 `tests/offline-network-v242.test.js`：`verifySubscriptionOnline({ fetchImpl })` 成功/不可达、`detectSyncTransport({ fetchImpl })` available/blocked 全部用假 fetch |
| 3 | 全量测试无外网请求 | ✅ | `NODE_OPTIONS=--require ./recon-tmp/net-spy.cjs npm test`：429→434 用例全过；网络探针记录 **0** 条非本机请求（审计脚本仅本地使用，不提交） |
| 4 | 回归 | ✅ | `npm test` **434/434**、`build-check` 16/16、`page-check` 22/22 |
## 2.38 v2.44 客户端工具桥（Completions ↔ Responses）+ 图片上下文修复

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | tools 协议自动转换，无需白名单维护 | ✅ | 新增 `src/openai/tool-protocol.js`：两种 tools 形状归一化为 CanonicalTool；chat 输出 `tool_calls`、responses 输出 `function_call`；下一轮接受 `role:"tool"` / `function_call_output` |
| 2 | 真实上游工具调用 | ✅ | `gpt-5.6-terra` + `read_file`：chat 返回 `finish_reason:"tool_calls"`；回传 role:tool 后得到最终回答；responses 返回 `function_call` item（`read_file {"path":"package.json"}`） |
| 3 | 生图后继续对话图像丢失 | ✅ 修复 | 根因：v2.40 把 `image_generation_call` 转成文本占位；现在回放为真实 image part（挂下一轮 user）。上游只收 PNG/WebP，新增 `image-convert.js` 把 JPEG 转 PNG 并缩到 512px |
| 4 | 真实图像上下文验证 | ✅ | 生成深蓝海报 → 仅回放图片并问「主要是什么颜色」→ 返回「深海军蓝色」；图片编辑追问 200（修复前 502/400） |
| 5 | 配置/UI | ✅ | 设置 → 工具新增「客户端工具」开关（`settings-tool-client-tools`）；`tools.clientFunctionCalling.enabled` 默认 true 并已写入 `data/config.json` |
| 6 | 回归 | ✅ | `npm test` **447/447**、`build-check` 16/16、`page-check` 22/22 |
## 2.39 v2.45 工具协议稳定前缀（保证上游 prefix cache）

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 会话增量/前缀稳定 | ✅ | 工具协议从“最后一条 user”改为“第一条 user”（`injectProtocolIntoFirstUser`）；历史消息不再因下一轮协议消失而改变 |
| 2 | 前缀逐字节一致 | ✅ | 新增测试：第二轮请求的 `messages[0..turn1.length)` 与第一轮 deepEqual；协议只出现一次 |
| 3 | 模型仍能调用工具 | ✅ | 真实上游 `gpt-5.6-terra`：协议在第一条 user 时，第二轮仍输出 `read_file` tool_call；回传 role:tool 后得到最终回答 |
| 4 | 不引入真实缓存依赖 | ✅ | `/v1/*` 仍无状态、发送完整历史；duck.ai 实测无跨请求上下文缓存（会话 A/B 数字记忆测试为“不知道”）；稳定前缀只是让上游 prefix cache 可复用 |
| 5 | 回归 | ✅ | `npm test` **448/448**、`build-check` 16/16、`page-check` 22/22 |
## 2.40 v2.47 服务端会话 + 精确 upstream 前缀（前缀 cache / 图片压缩）

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | Responses `previous_response_id` | ✅ | `responses` 表保存 canonical + 精确 upstream 前缀 + output；下一轮只发新 input 可重建完整历史 |
| 2 | Chat Completions 服务端会话 | ✅ | 显式 `X-Conversation-Mode: server` + `X-Session-Id`；完整历史前缀复用 / `X-Conversation-Delta: true` 只发新消息；冲突 409 |
| 3 | 精确前缀（图片压缩只一次） | ✅ | `upstream_json` 保存已注入协议/已压缩图片的 duckMessages；toolsHash/systemPrompt 不变时直接拼接，不重新处理旧消息 |
| 4 | 真实上游验证 | ✅ | Chat 会话：记住 24680 → 第二轮答 24680 → delta 第三轮答 24681；冲突 409；Responses 链：13579；图片链：回放后答“红色” |
| 5 | 存储/清理 | ✅ | 新表 `conversation_state`；`responses`/`conversation_state` 按 30 分钟清理过期记录；`store:false` 不保存 |
| 6 | 回归 | ✅ | `npm test` **456/456**、`build-check` 16/16、`page-check` 22/22 |
## 2.41 v2.48 提示词注入可观测 + 手动压缩工具轨迹

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 会话历史显示完整提示词注入 | ✅ | `history.injection_json` + 详情 `injection`（protocolText / firstUserContent / clientTools / chain）；历史详情页可展开查看 |
| 2 | 日志体现注入 | ✅ | upstream 日志字段 `clientTools/protocolInjected/upstreamMessageCount/conversationChain`；日志页显示工具协议徽章 |
| 3 | 上游请求调试视图 | ✅ | `GET /admin/api/history/:id/upstream` 返回真实 upstream messages；图片 base64 脱敏为 `[image data ...]` |
| 4 | 手动压缩保留工具轨迹 | ✅ | `/v1/compact` 的 `normalizeCompactMessages` 编码 `[tool_call]` / `[tool_result]`，图片标记 `[图片 xN]` |
| 5 | 回归 | ✅ | `npm test` **460/460**、`build-check` 16/16、`page-check` 22/22 |
## 2.42 v2.49 自动 PDF 上下文溢出 + tokenizer usage

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | Free 身份 PDF 能力 | ✅ | 匿名 Free + GPT-6 Luna：10 页/78k 字符、15 页内可读；50 页被拒（单文件 ≤15 页） |
| 2 | 单页/多页排版 | ✅ | 单页 10 万字符只解析前 250 行；改为 **250 行/页** 多页排版；15 页上限 |
| 3 | 自动 PDF 溢出 | ✅ | chat >20k 字符：历史转 PDF（含图片），当前 user + file part；真实上游回答 `ZEBRA-2468` |
| 4 | Responses 溢出 | ✅ | `/v1/responses` >20k 输入：历史转 PDF；真实上游回答 `RESP-9753` |
| 5 | tokenizer usage | ✅ | chat `prompt_tokens=29044`（含 PDF）；responses `input_tokens=29042`；`estimation:"tokenizer"` |
| 6 | 手动压缩保留 | ✅ | 自动压缩在 PDF 溢出路径跳过；`/v1/compact` 仍是真正摘要 |
| 7 | 回归 | ✅ | `npm test` **465/465**、build-check 16/16、page-check 22/22 |
| 8 | 图片嵌入 PDF | ✅ | 历史图片转 PDF 后真实上游回答「红色」；`createContextPdf` 单测包含 `/Subtype /Image` |
| 9 | 历史 PDF 展示 | ✅ | 溢出请求的历史记录只保存当前 user + PDF 元数据（不存 base64）；前端显示 `conversation-context.pdf · 2 页` chip；`ReadDocument` 显示「文档读取」 |