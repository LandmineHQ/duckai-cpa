# 代理能力实现说明（v2.3，`src/duck/proxy.js`）

> 对应契约：`docs/PROXY.md`。本文记录 **协议层实现**（ProxyManager + DuckClient/sync/auth 集成）、
> API 形状、SOCKS 踩坑点与 **真实联调结果**（本机 `127.0.0.1:10808`，同时支持 HTTP CONNECT 与 SOCKS5，
> exit IP `203.0.113.10`）。
>
> Admin API（`/admin/api/proxy*`）、配置持久化、前端「代理」页由 网关后端 / 管理后台 实现；
> 协议层只暴露 manager，不直接暴露 HTTP 端点。

---

## 1. 模块与导出（`src/duck/proxy.js`）

```js
import { ProxyManager, ProxyError, createProxyManager, PROXY_TYPES, DEFAULT_PROXY_CONFIG, isValidProxyHost }
  from './duck/proxy.js';
```

| 导出 | 说明 |
| --- | --- |
| `class ProxyManager` | 代理状态机 + dispatcher 生命周期 |
| `class ProxyError extends Error` | `{ status:400, code:'invalid_proxy', field?, hint? }` |
| `async createProxyManager({ config, logger, fetchImpl })` | `new ProxyManager(...)` + `await init()` |
| `PROXY_TYPES` | `['http','https','socks4','socks5']` |
| `DEFAULT_PROXY_CONFIG` | 默认配置（enabled:false, 127.0.0.1:**8080**（契约 §1 默认值）, noProxy 本机…）；本机测试代理 10808 由 `config.proxy` / 后台「填入本机代理」显式传入 |
| `isValidProxyHost(host)` | 域名 / IPv4 / `[IPv6]` 校验 |

### 1.1 构造

```js
new ProxyManager({ config, logger, fetchImpl })
```

- `config`：可传**完整 config**（自动读 `config.proxy`），也可直接传 proxy 配置对象。
- `fetchImpl`：**仅用于直连路径**的可替换 fetch（测试 mock 用）；代理路径固定使用 undici。
- 依赖：`undici@8.12.3`、`socks@2.8.10`（已由 验收执行者 安装，未新增依赖）。

### 1.2 方法

| 方法 | 同步/异步 | 说明 |
| --- | --- | --- |
| `init()` | async | 校验配置 + 构建 dispatcher（enabled=false → direct） |
| `getRedacted()` | sync | 配置 + `hasAuth` + `status`，**不含 password** |
| `getRaw()` | sync | 含 password（仅供持久化/内部） |
| `getStatus()` | sync | `{active,mode,lastTestAt,lastTestOk,lastTestLatencyMs,lastTestStatus,exitIp,lastError,updatedAt}` |
| `getSummary()` | sync | `{enabled,mode,active,lastTestOk,lastTestLatencyMs,exitIp}`（healthz/DuckClient.health 用） |
| `update(patch)` / `apply(patch)` | async | **先校验原始 patch** → 合并 → 重建 dispatcher（立即生效） |
| `shouldBypass(url)` | sync | noProxy 精确/后缀/`*.` 通配/`*`；禁用时恒 true |
| `getDispatcher()` | sync | undici Dispatcher；direct 时 `undefined` |
| `getFetch()` / `fetch(url, init)` | sync / async | 自动注入 dispatcher 的 fetch（noProxy 命中走直连） |
| `test(overrides?)` | async | 临时 dispatcher 测试 `testUrl` + `ipCheckUrl`；**不抛**，结果写 `status` |
| `close()` | async | 关闭 dispatcher |

### 1.3 校验与错误（契约 §3.2）

`update()` / `test()` 对**原始字段**校验（避免被 normalize 静默兜底，QA v2.3 bug #1）：

| 字段 | 规则 | 错误 |
| --- | --- | --- |
| `type` | ∈ `http/https/socks4/socks5` | `ProxyError{400, invalid_proxy, field:"type"}` |
| `port` | 整数 1–65535 | `field:"port"` |
| `host` | 非空 + `isValidProxyHost()`（DNS/IPv4/`[IPv6]`，拒绝空格/`://`/凭据/路径） | `field:"host"` |
| `noProxy` | 字符串数组 ≤50 | `field:"noProxy"` |
| `testUrl`/`ipCheckUrl` | `http(s)://` | `field:"testUrl"|"ipCheckUrl"` |
| `enabled` | boolean | `field:"enabled"` |
| `username`/`password` | string | `field:"username"|"password"` |
| `timeoutMs` | 正数 | `field:"timeoutMs"` |

- `init()` 对**配置文件**校验，但容忍 `enabled=false` 时 `host:""`（UI 清空字段不阻塞启动）；`enabled=true` 必须合法 host/port。
- 密码语义：`update({ password: undefined })`（省略）=不变；`{ password: "" }`=清除；非空=设置。
- `hasAuth = Boolean(username || password)`；清空密码后 username 仍在则 `hasAuth:true`（Basic 认证仍会发 `user:`）。
- `test()` 返回新增 `bypassNoProxy` 与（非法 overrides 时）`invalidField`；失败 `code ∈ proxy_connect_failed | proxy_timeout | proxy_tls_failed | invalid_proxy`。

---

## 2. 连接实现（关键技术点）

### 2.1 HTTP / HTTPS 代理

```js
new ProxyAgent({ uri: `http(s)://[user:pass@]host:port`, timeout })
```

- `http`：https 目标用 CONNECT 隧道，http 目标用 absolute-form。
- `https`：TLS 直连代理端口。
- 用户名/密码会 URL-encode 进 uri。

### 2.2 SOCKS4 / SOCKS5 代理（自定义 undici connector）

```js
new Agent({ connect: customConnector, timeout })
```

connector 内部：

```js
SocksClient.createConnection({
  proxy: { host, port, type: 4|5, userId?, password? },
  command: 'connect',
  destination: { host: hostname, port },
  timeout
});
```

**三个必须注意的点**（实测踩坑）：

1. **`opts.port` 对默认端口是空字符串**：undici 传入 `port: ''`（而非 443/80），必须
   `Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80)`，否则 SOCKS 目标端口为 0。
2. **https 目标要自己 TLS**：`socks` 只返回 raw socket，必须
   `tls.connect({ socket, servername, ALPNProtocols:['http/1.1'] })`，并在 **`secureConnect`** 后才
   `callback(null, tlsSocket)`；`servername` 为 IP 时传 `undefined`（避免 SNI 校验失败）。
3. **超时/错误必须回调**：connector 里任何异常都要 `callback(error, null)`，否则 undici 请求挂起。

### 2.3 切换与退役

`update()` 后立即重建 dispatcher；旧 dispatcher 延迟 **30s** `close()`，让进行中的请求完成。
direct 时 `getDispatcher()` 返回 `undefined`，`fetch()` 走注入的 `fetchImpl`（默认 undici fetch）。

### 2.4 noProxy

- 规则：精确匹配、后缀匹配（`example.com` 命中 `api.example.com`）、`*.suffix`、`*`（全部直连）。
- `fetch()`：命中 → 直连（不注入 dispatcher）。
- `test()`：**同样应用 noProxy**（QA 确认语义）：`testUrl` 命中 → `mode:"direct"` 且 `bypassNoProxy:true`；
  exit-IP 检查也按 noProxy 决定直连/代理。

---

## 3. DuckClient / sync / auth 集成

| 位置 | 行为 |
| --- | --- |
| `DuckClient({ proxyManager })` | 也支持第二参数 `{ proxyManager }`；只给 `config.proxy` 时自动 `new ProxyManager` |
| `ChallengeManager` | 注入 `fetchImpl: this._fetch` → 首页版本、`/status`、challenge 刷新、`/capabilities` 全走代理 |
| `/duckchat/v1/chat` | 走 `this._fetch`（代理） |
| `identityStore` | `DuckClient.init()` 里自动 `setProxyManager()` + `setFetchImpl()` → sync transport 探测、订阅 verify 走代理 |
| `sync.detectSyncTransport({ proxyManager })` | 代理关闭 → `{status:'blocked', reason:'proxy_disabled'}`（不浪费网络超时）；代理开启 → 经代理探测 `https://duckduckgo.com/sync/pairing` |
| `IdentityStore.refreshTransport()` | 清缓存并强制重探测（代理切换后调用） |
| `pair()` | transport blocked → `503 sync_transport_unavailable`（hint 提示去「代理」页启用）；transport available → `501 sync_handshake_unimplemented`（握手仍未实现，契约 §6） |
| `health().proxy` | `{enabled,mode,active,lastTestOk,lastTestLatencyMs,exitIp}` |
| `recentErrors[].proxyMode` | 记录出错时的出站路径 |

> 订阅 verify 走代理：`verifySubscriptionOnline` 由 identityStore 传入 `fetchImpl`（DuckClient 注入）；
> 若网关后端 在 DuckClient 初始化前调用 `activateSubscription`，则使用 identityStore 创建时传入的
> `sync.fetchImpl`（可在 `createIdentityStore({ sync:{ fetchImpl: proxy.getFetch() } })` 提前注入）。

---

## 4. 真实联调结果（2026-11-02，本机代理 `127.0.0.1:10808`）

脚本：`data/tmp/verify-proxy-live.mjs`（http + socks5 全链路）、`data/tmp/verify-proxy-chat.mjs`（SOCKS5 真实 chat）、
`data/tmp/verify-proxy-sync.mjs`（sync transport/pair）、`data/tmp/proxy-unit.mjs`（离线单测）。
原始结果：`data/tmp/proxy-live.json`、`proxy-chat.json`、`proxy-sync.json`。

### 4.1 直连基线（对照）

| 目标 | 结果 |
| --- | --- |
| `https://duckduckgo.com/sync/pairing`（直连） | ❌ `fetch failed`（~10.7s 超时）——当前环境原本不可达 |
| `https://duck.ai/...`（直连） | ✅ 可达（原有行为） |

### 4.2 HTTP 代理（`type:"http"`）

| 项 | 结果 |
| --- | --- |
| `POST proxy/test`（= `manager.test()`） | `{ok:true, mode:"http", status:200, latencyMs:~1.6–2.2s, exitIp:"203.0.113.10", ipError:null}` |
| `GET https://duck.ai/duckchat/v1/status`（经代理，带挑战头） | ✅ 200，`x-vqd-hash-1` 下发（len 5388–7496），body `{"status":"0",...}`，~0.8–1.0s |
| `GET https://duckduckgo.com/sync/pairing`（经代理） | ✅ 200 |
| exit IP（ipify 经代理） | ✅ `203.0.113.10` |
| 真实 chat（经 HTTP 代理） | ⚠️ 上游 `418 ERR_BN_LIMIT`（`overrideCode:8e04`，映射 429 `upstream_rate_limited`）——该出口 IP 处于匿名额度软限流；**非代理链路问题**（status/挑战/DDG 均正常） |

### 4.3 SOCKS5 代理（`type:"socks5"`）

| 项 | 结果 |
| --- | --- |
| `manager.test()` | `{ok:true, mode:"socks5", status:200, latencyMs:~0.7–1.4s, exitIp:"203.0.113.10"}` |
| `GET /duckchat/v1/status` | ✅ 200 + 挑战头（len 5456–7540） |
| `GET duckduckgo.com/sync/pairing` | ✅ 200 |
| **真实 chat（完整 DuckClient：挑战求解→chat SSE）** | ✅ **200**，内容「代理」，事件 `title → reasoning → text → done`，`requests=1 / retries=0 / limitHits418=0`，`health().proxy.mode="socks5"`，journeyId/指纹来自持久 identity |

> 结论：HTTP CONNECT 与 SOCKS5 两条路径都可用；chat 成功与否取决于该出口 IP 的匿名额度，
> 与代理链路本身无关（SOCKS5 那次 chat 一次通过）。

### 4.4 Sync transport（代理联动）

| 场景 | 结果 |
| --- | --- |
| 代理关闭 | `transport:"blocked", transportReason:"proxy_disabled"`；`pair()` → `503 sync_transport_unavailable`，hint=`enable the outbound proxy in the Proxy page to reach duckduckgo.com` |
| 代理开启（http） | `transport:"available", transportReason:"http:200"`；`pair(code)` → `501 sync_handshake_unimplemented`；`refreshTransport()` → `available` |

---

## 5. 离线单元测试（`data/tmp/proxy-unit.mjs`，9/9 通过）

- 默认 direct：`getRedacted()` 不含 password、`getDispatcher()===undefined`、`shouldBypass()` 恒 true。
- `update()` 原始字段校验：`type/port/host(空格|URL|凭据)/noProxy/testUrl/ipCheckUrl/enabled/username/timeoutMs`
  → `ProxyError{400, invalid_proxy, field}`；合法更新立即生效（`status.active`）。
- 密码语义：省略保留、`''` 清除、赋值替换；`hasAuth` 语义（username 在则 true）。
- noProxy：精确/后缀/`*.` 通配/禁用恒 bypass。
- `fetch()`：direct 用注入 fetch；noProxy 命中走 direct。
- `test()`：noProxy 命中 → `mode:"direct"`/`bypassNoProxy:true`；exit-IP 在 dispatcher 关闭前获取（已修复 QA bug）；
  非法 overrides → resolve `{ok:false, code:'invalid_proxy', invalidField}`。
- `init()` 对非法配置文件报 `ProxyError`；`close()` 后 dispatcher 清空。

---

## 6. 已知边界 / 风险

1. **匿名额度与出口 IP 绑定**：经代理 chat 仍可能 418/429（同一出口被多人/多 agent 共用）；协议层已有
   418 退避重试与 429 冷却，代理本身不改变额度规则。
2. **HTTPS 代理未真实验证**（本机 10808 只提供 HTTP CONNECT / SOCKS5）；实现按 undici `ProxyAgent`
   `https://` uri 支持，属未测路径。
3. **SOCKS 认证未真实验证**（本机代理无认证）；connector 已传 `userId/password`（socks5）。
4. **跨设备 Sync 握手仍未实现**：代理可用后 `pair()` 返回 501 而非 503，跨实例迁移仍建议 identity export/import。
5. **代理仅影响网关出站**；浏览器/客户端流量不受影响。
6. **配置热更新**：`update()` 立即重建 dispatcher；DuckClient 持有的 `_fetch` 是闭包，始终读 manager 最新
   dispatcher，无需重启（但 `config.duck.proxy` 只在 DuckClient 构造时读取，改 config 文件需重启）。
7. `test()` 的 `ok` 定义为 `status < 500`（对端 4xx 也视为链路可达），与契约 §3.3 一致。
