# DuckDuckGo 订阅绑定流程：源码分析 + 网关「免复制 JWT」登录（v2.25）

> 分析对象：`recon/entry.duckai.2d2656b1fcd20ced62d9.js`（2026-11-02 抓取）+ 本仓库实现。
> 结论先行：**订阅 token 依赖 DuckDuckGo 的登录 cookie，Node 侧无法凭空获得**；
> 网关通过「一次性登录会话 + 书签脚本」让**已登录的浏览器**代为取 token 并回传，
> 从而实现「点一下书签即完成绑定，不用手动复制 JWT」。

---

## 1. 源码里的订阅状态模型

bundle（模块 `37490` / `88710`）里访问档位是枚举 `ac`：

| 值 | 含义 |
| --- | --- |
| `Free` | 未订阅（可登录也可匿名） |
| `Plus` | DuckDuckGo Plus（含 Duck.ai 高级模型） |
| `Pro` | DuckDuckGo Pro（含 Pro 专属模型） |
| `Internal` | 内部员工，不参与订阅 |

派生状态（`getAuthStateFromToken`）：

```
accessTier            = entitlements → Free / Plus / Pro
isAuthenticated       = 是否存在有效 token
isEligibleForSubscription = 账号是否可购买（地区/账号资格）
isDuckAiPaidEnabled / isProTierEnabled = 功能开关（承担 Plus/Pro 是否开放）
```

UI 分支（bundle `lH`）：`Pro/Plus → 已订阅卡片`、`Free 且已登录 → 未订阅卡片（含购买/管理）`、
`Free 未登录 → 登录/购买引导`、`Internal → 不可购买提示`。

相关文案 key（可用于判断产品语义）：

| key | 文案 |
| --- | --- |
| `DUCKCHAT_MANAGE_SUBSCRIPTION_LABEL` | Manage Subscription |
| `DUCKCHAT_UNLOCK_WITH_SUBSCRIPTION_BUTTON` | Unlock With a DuckDuckGo Subscription |
| `DUCKCHAT_UPGRADE_WITH_SUBSCRIPTION_TITLE` | Upgrade Duck.ai With a DuckDuckGo Subscription |
| `DUCKCHAT_DUCKDUCKGO_SUBSCRIPTION_NOT_AVAILABLE_DESCRIPTION` | 当前地区不可购买 |
| `DUCKCHAT_ERROR_MODEL_RESTRICTED` | `%s is only available with a DuckDuckGo subscription.` |
| `DUCKCHAT_ERROR_MODEL_RESTRICTED_PRO_ONLY` | Pro 专属：`Upgrade your DuckDuckGo subscription in this browser again…` |

> 注意 `MODEL_RESTRICTED_PRO_ONLY` 的措辞是 **“in this browser again”** ——
> 说明订阅是**按浏览器会话**生效的：token 存在浏览器侧，换浏览器/清 cookie 就会掉回 Free。

---

## 2. token 从哪里来（两条路径）

bundle 模块 `@1590840`（`duck-chat-auth` 的 `token` journey）：

```js
// Web（非 Electron）
GET https://quack.duckduckgo.com/api/auth/v2/token
      ?grant_type=refresh_token
      &client_id=fb417741-decf-4b1d-a614-32898aa8ecca
    credentials: 'include'        // ← 关键：带 duckduckgo.com 的登录 cookie
→ 200 { access_token }
→ 401 未登录（unauthenticated）
→ 其它 !ok 走错误归一化

// Electron 应用
GET /duckchat/v1/auth/token      // 同源 cookie
→ 200 { access_token } / 401 未登录
```

要点：

1. **没有 refresh token 字符串参与**：`grant_type=refresh_token` 只是端点名，
   真正的凭据是 **cookie**（DDG 登录态）。
2. 拿到的 `access_token` 就是 JWT（三段 base64url），后续请求带
   `Authorization: Bearer <access_token>`。
3. 网关侧 `src/duck/auth.js::parseSubscriptionToken()` 校验的字段与之对应：
   `api` / `email` / `exp` / `entitlements[{product:"Duck.ai", name:"plus"|"pro"}]`。
4. 匿名会话调用返回 `{}`（无 token），我们在浏览器里实测确认（`/duckchat/v1/auth/token` → `{}`）。
5. **在 duck.ai 页面内，只能用同源 `/duckchat/v1/auth/token`**：实测 duck.ai 的 CSP `connect-src` 不含 `duckduckgo.com`（只有 `*.duck.ai`、`sync.duckduckgo.com/sync/` 等），所以书签里 fetch `quack.duckduckgo.com` 会直接 `Failed to fetch`。
6. token 响应形如 `{ access_token, expires_in, token_type }`；实测 `expires_in=14400`（**4 小时**），到期后 tier 会回退为 free，需要重新捕获（订阅本身不会失效）。

---

## 3. 交互式登录（PKCE）流程

bundle 模块 `@1583082`：

```js
const i = { authorize:'/duckchat/v1/auth/authorize',
            token:'/duckchat/v1/auth/token',
            logout:'/duckchat/v1/auth/logout',
            callback:'/duckchat/v1/auth/callback' };
const s = 15e3;  // 所有 auth 请求 15 秒超时

// 1) 生成 PKCE verifier + challenge
codeVerifier = base64url(crypto.randomUUID())
codeChallenge = base64url(SHA-256(codeVerifier))

// 2) 申请授权会话
GET /duckchat/v1/auth/authorize?code_challenge=<codeChallenge>   (credentials: include; 15s 超时)
→ { authorization_session_id }

// 3) 把 verifier 存进 cookie，供回调端点取用
document.cookie = `ddg_auth_code_verifier=${codeVerifier}; path=/duckchat/v1/auth/callback; secure; samesite=lax`

// 4) 浏览器完成 DuckDuckGo 登录（外部页面）→ 回调 /duckchat/v1/auth/callback
// 5) 换 access_token：GET /duckchat/v1/auth/token（带 cookie）
```

**等待语义（回答「操作完成后会进行怎么样的等待」）**：

| 阶段 | 等待内容 | 是否有轮询 |
| --- | --- | --- |
| 授权（authorize） | 一次 HTTP 往返，**15 秒 AbortController 超时**；埋点 journey 超时 30 秒 | ❌ 无 |
| 用户登录 | 页面跳转到 DuckDuckGo 登录（可含邮箱验证码/密码/Apple/Google）→ 回跳 callback | ❌ 无固定轮询，靠浏览器导航回调 |
| 取 token | 每次调用 `getAuthAccessToken()`：同一时刻**合并并发请求**（in-flight promise 复用），支持 `forced` 强制刷新 | ❌ 无定时轮询 |
| 订阅变更 | `subscribeToAuthUpdate()` 监听；token/entitlement 变化后 UI 重新渲染档位 | 事件驱动，非轮询 |
| 购买 | `purchase('settings')` → 打开 DDG 订阅页（浏览器/原生支付通道）；成功后回到 duck.ai，token 更新即生效 | — |

> 失败模拟：URL 参数 `?willerror=oauth.getsessionid` / `oauth.logout` 会让前端故意等待 3 秒后报错（仅测试用）。

---

## 4. 为什么网关不能「自己」拿到 token

- token 的凭据是 **`duckduckgo.com` 的登录 cookie**（HttpOnly，JS 也读不到明文）；
- 我们的网关是 Node 进程，只有自己的匿名会话 cookie（`ddg_auth_session_id` 匿名态），
  调用 `/duckchat/v1/auth/token` 返回 `{}`（实测）；
- Sync（配对）拿到的是 **DuckDuckGo Sync 的账号密钥**，与 web 登录会话是两套体系，
  不能直接换取 `access_token`；
- 因此：**必须由「已经登录 DuckDuckGo 的浏览器」代取 token**。

---

## 5. 网关实现（v2.25）：一键书签 / 免复制 JWT

### 5.1 流程

1. 管理台「订阅」页点 **生成登录链接** → `POST /admin/api/subscriptions/login-session`
   → 返回 `sessionId`（24B 随机 hex）、`expiresAt`（**5 分钟 TTL**）、`bookmarklet`（书签脚本）、
   `captureUrl`、`tokenEndpoint`、`relayUrl`。
2. 用户在**已登录 DDG 的浏览器**打开 `https://duck.ai/`，执行书签脚本；
3. 书签脚本（在 duck.ai 源内运行）：
   ```js
   fetch('https://quack.duckduckgo.com/api/auth/v2/token?...', { credentials:'include' })
     → { access_token }
   fetch('<gateway>/admin/api/subscriptions/capture', { method:'POST', body:{ sessionId, token } })
   ```
4. 网关 `POST /admin/api/subscriptions/capture`（**无需 admin token，但有 CORS 白名单**）：
   校验会话（存在/未过期/未使用）→ `parseSubscriptionToken()` → 写入 `data/subscriptions.json` →
   会话变为 `completed`；
5. 管理台每 **2 秒轮询** `GET /admin/api/subscriptions/login-session/:id` → 显示「已绑定」并刷新订阅列表。

### 5.2 为什么书签脚本能跨域回传

- 浏览器把 `http://127.0.0.1` / `http://localhost` 视为 **可信来源**，https 页面可以请求它（不受混合内容限制）；
- 网关只为 capture 端点放开 CORS，且**只允许** `https://duck.ai`、`https://duckduckgo.com`、
  `null`、本机来源；其它站点会被浏览器按 CORS 拒绝。

### 5.3 安全边界

| 项 | 措施 |
| --- | --- |
| 会话 ID | 24 字节随机 hex，**5 分钟 TTL**，单次使用（重复提交 409） |
| token 暴露面 | capture 只回脱敏订阅视图（`maskedToken`），不返回明文 token |
| 存储 | `data/subscriptions.json`（0600），明文 token 仅服务端使用 |
| 会话内存 | 进程内 Map，重启即失效；最多 50 个会话 |
| CORS | 白名单来源；不返回 `Access-Control-Allow-Credentials` |

### 5.4 接口

```
POST   /admin/api/subscriptions/login-session            (admin)  → { sessionId, expiresAt, bookmarklet, captureUrl, relayUrl, steps }
GET    /admin/api/subscriptions/login-session/:id        (admin)  → { status: waiting|completed|failed|expired|cancelled, result }
DELETE /admin/api/subscriptions/login-session/:id        (admin)  → 取消
POST   /admin/api/subscriptions/capture                  (public + CORS) ← { sessionId, token }
```

`status=completed` 时 `result = { subscriptionId, tier, email }`。

### 5.5 已验证（2026-11-03，真实网关 8787）

| 步骤 | 结果 |
| --- | --- |
| 创建会话 | 200，`relayUrl` / `bookmarklet` / `tokenEndpoint` 正确 |
| 轮询等待 | `status=waiting`，`remainingMs≈300000` |
| CORS 预检（Origin: duck.ai） | 204 |
| capture（带 Origin: duck.ai） | 200，`Access-Control-Allow-Origin: https://duck.ai`，tier/email 正确入池 |
| 轮询变为 completed | 200，`result={subscriptionId,tier:"plus",email}` |
| 重复提交 | 409 `login_session_not_pending` |
| 未知会话 | 404 `login_session_not_found` |
| 非法 token | 422 `token_invalid`，会话变 `failed` |
| 管理页 | 「生成登录链接」→ 引导步骤 + 复制脚本 + 状态徽章「等待授权…」→ 自动变「已绑定」并刷新列表 |

> ⚠️ **诚实说明**：本次验证用的是**合成 JWT**（`parseSubscriptionToken` 不验签，只解析 claims），
> 因为当前 Chrome 环境未登录 DuckDuckGo，无法取到真实 `access_token`。
> 真实链路只差「用户在自己已登录的浏览器里点一次书签」这一步；
> 书签脚本与 duck.ai 自身使用的取 token 请求**完全一致**（同 URL、同 `credentials:include`）。

---

## 6. 已知限制 / 后续可做

1. **token 过期需要重新授权**：JWT 的 `exp` 到期后需再点一次书签（会话 5 分钟内可复用）。
   若要免维护，可在网关保存 token 到期时间并在概览页提示「即将过期」。
2. **无法自动续期**：web 路径不提供 refresh token 字符串，只有 cookie；cookie 不在网关手里。
3. **手机端**：书签在移动浏览器上不便；可改为「把 `relayUrl` 发到手机 → 在手机浏览器登录 DDG →
   用地址栏执行脚本」。若后续要做真正的二维码登录，需要中间人可控的 OAuth 回调域（当前 duck.ai 不支持自定义
   `redirect_uri`，源码中无该参数）。

---

## 6.5 自刷新（v2.27）：源码里的 refresh token 机制

v2.25 时以为「web 路径只给 access token、无法自刷新」，**这是错的**。补测发现：

`GET https://duck.ai/duckchat/v1/auth/token` 的响应头会 **Set-Cookie 轮换**：

```
set-cookie: ddg_auth_refresh_token=<JWT scope=refresh>; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Strict
```

用 Node 直接验证（带代理）：

| 请求 | 结果 |
| --- | --- |
| `Cookie: ddg_auth_session_id=…` → `/duckchat/v1/auth/token` | 200 但 **无 access_token** |
| `Cookie: ddg_auth_refresh_token=…` → `/duckchat/v1/auth/token` | ✅ 200 + `access_token`（email/Duck.ai:pro）+ 轮换新 refresh token |
| `Cookie: ddg_auth_refresh_token=…` → `quack.duckduckgo.com/api/auth/v2/token` | ❌ fetch failed（代理/DNS 不通，浏览器侧也被 CSP 拦） |

结论：**refresh token 是 HttpOnly cookie（JS 读不到），但值可以手动从 DevTools 复制**；
拿到后网关可在服务端无限续期（30 天有效，每次续期轮换）。

### 6.5.1 网关实现（v2.27）

- 订阅实体新增 `refreshToken`（仅服务端，视图只暴露 `autoRefresh/refreshCount/refreshedAt/refreshError`）；
- `POST /admin/api/subscriptions/:id/refresh-token` 保存；`DELETE` 关闭；
- `POST /admin/api/subscriptions/:id/refresh?force=` 立即续期；
- 后台每 **5 分钟**巡检：`expiresAt - now <= 30min` 的订阅自动续期，并把新 token **同步到绑定了该订阅的所有身份**（`identity.auth` 是绑定时的快照，不同步会继续用过期 token）；
- 续期成功后自动更新 `tier/email/entitlements/expiresAt` 并持久化轮换后的 refresh token。

### 6.5.2 实测（真实 Pro 账号）

| 步骤 | 结果 |
| --- | --- |
| 保存 refresh token | 200，`autoRefresh=true` |
| 立即续期 | 200 `{refreshed:true, rotated:true, tier:"pro", expiresAt:"2026-11-03T21:00:39Z", refreshCount:3}` |
| 校验 | 200 `tier=pro verified=true` |
| 绑定身份后再次续期 | 身份 `authExpiresAt` 从 20:57:50 → 21:00:39，**token 已同步** |
| 删除绑定订阅的身份 | 409 `identity_has_subscription`（提示需先解绑） |
| 解绑后删除 | 成功（若仍在设备槽/会话绑定则按原有 409 流程处理） |

### 6.5.3 获取 refresh token 的步骤（一次性，30 天有效）

1. 打开已登录的 duck.ai；
2. F12 → Application → Storage → Cookies → `https://duck.ai`；
3. 复制 `ddg_auth_refresh_token` 的 Value；
4. 管理台「订阅」→ 对该订阅点 **自动续期** → 粘贴 → 保存。

之后网关会自动续期；每次续期都会轮换 refresh token 并写回本地，因此只要网关持续运行，就不会再过期。

---

## 7. v2.26 修正（书签为什么不能用 / 现在的正确流程）

### 7.1 三个真实障碍（都已修复）

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 地址栏输入 `javascript:...` 变成 Google 搜索 | Chrome 在**粘贴**时会剥离 `javascript:` 前缀（安全策略） | UI 改为「拖到书签栏 / 右键添加到书签」，并给出 Console 方式；**明确提示不要粘贴到地址栏** |
| 书签点了没反应（`Failed to fetch`） | duck.ai 的 CSP `connect-src` 不含 duckduckgo.com | 脚本改用同源 `/duckchat/v1/auth/token` |
| 同源 fetch 拿到 token 后回传网关仍 `Failed to fetch` | Chrome **Local Network Access**：公网页面 → `127.0.0.1` 的 fetch 会被拦截 | 脚本先尝试 POST 网关；失败则 **`window.open` 打开管理台**并把 token 放在 hash 里（顶层导航不受 LNA 限制），由管理台同源提交 |

### 7.2 现在的完整流程

1. 管理台「订阅」→ **生成登录链接**（会话 5 分钟有效）；
2. 把「捕获订阅」链接**拖到书签栏**（或右键 → 添加到书签）；不方便时用「复制控制台脚本」在 duck.ai 的 Console 执行；
3. 在 duck.ai（已登录 DuckDuckGo、已订阅 Plus/Pro）点击该书签：
   - 脚本读取同源 `/duckchat/v1/auth/token` → `access_token`；
   - 先尝试直接 POST 网关 capture；
   - 被浏览器拦截时 → `window.open('http://127.0.0.1:8787/admin/#/subscriptions?...&token=...')`；
4. 管理台识别 hash 里的 `sessionId` + `token` → 立即同源提交 capture → 提示「已绑定」→ 刷新列表，
   并把 token 从地址栏清掉（`history.replaceState`）；
5. 订阅列表显示 tier（Plus/Pro）、邮箱、**token 到期时间**（约 4 小时）。

### 7.3 实测（2026-11-03，真实 Pro 账号）

| 步骤 | 结果 |
| --- | --- |
| duck.ai 同源 `/duckchat/v1/auth/token` | 200，返回 `{access_token, expires_in:14400, token_type}` |
| 直接 POST 网关 capture（duck.ai 页面内） | ❌ `Failed to fetch`（Local Network Access 拦截） |
| `window.open` 管理台 relay（带 token） | ✅ 新标签打开，管理台同源提交成功 |
| 订阅入库 | tier=pro、email=user@example.com、source=login、verified=true |
| token 到期 | 2026-11-03T19:11:02Z（约 4 小时后，UI 显示「token 到期 …」） |

### 7.4 已知限制

- **token 4 小时后过期**：web 端点只发 access token（无 refresh token 字符串），到期需再点一次书签；
- 若浏览器仍拦截「公网页面打开 localhost」，可改用 Console 方式（脚本同样先 fetch 再 window.open）；
- 手机端建议用「复制会话链接」在手机浏览器打开管理台，再在手机 duck.ai 执行 Console 脚本。
