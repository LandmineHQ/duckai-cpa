# duck.ai `x-vqd-hash-1`（JSA）源码级深度分析与「偶发 418」根因修复

> 版本：v2.62（环境探针修复）+ v2.63（残余 418 路径修复） · 取证日期：2026-11-06 · 上游部署：`serp_20261105_231819_ET` / `entry.duckai.9eb647a002c7954fd3aa.js`
> 结论分级：**[已验证]** 真机/真实上游实测 · **[分析结论]** 代码级推断 · **[待确认]** 证据不足 · **[BLOCKED]** 无法完成
> 相关专项报告：`recon/2026-11-06/analysis/frontend-challenge.md`（前端 bundle）、`challenge-payload.md`（挑战载荷逆向）、`gateway-418-audit.md`（网关状态机审计）

---

## 0. 结论摘要（TL;DR）

1. **`x-vqd-hash-1` 是什么**：duck.ai 的 JSA 反爬挑战。`GET /duckchat/v1/status` 用 `x-vqd-hash-1: initial` 换回一个 base64 混淆 async IIFE；浏览器在页面内隐藏的 `<iframe id="jsa">` 里执行它，得到 `{server_hashes, client_hashes, signals, meta}`，再对 `client_hashes` 做 SHA-256+base64、补 `meta.origin/stack/duration`，`btoa(JSON.stringify(...))` 后作为后续 `/duckchat/*` 请求头。每个响应头下发下一个挑战（滚动）。**[已验证]**

2. **偶发 418 的根因（本次新发现）**：挑战每次随机抽一组「环境探针 suite」（42 个唯一样本中 4 类，配比 `pxjzr` 11 / `h8jbt` 12 / `q7klm` 12 / `vz95n` 7）。其中两类会读取 **duck.ai 页面自身状态**，旧网关在「空的 jsdom 顶层 window」里求解，算出的 `client_hashes` 环境指纹是错的：
   - **page-state suite**（`vz95n`，约 17%）：检查 `window.top.document.querySelector('#jsa')` 的 sandbox/srcdoc CSP meta，以及 `window.top.__DDG_BE_VERSION__` / `__DDG_FE_CHAT_HASH__` 是否存在 → 浏览器算 `seed+4`，旧实现 `seed+0`；
   - **layout suite**（`q7klm`，约 29%）：检查 `offsetWidth/offsetHeight/getBoundingClientRect/scrollHeight > 0` → 浏览器 `seed+5`，jsdom 无布局引擎恒为 0，旧实现 `seed+1`。
   上游在**真实 chat 请求阶段精确校验**这些值，偏差即 `418 {"type":"ERR_CHALLENGE"}`。裸 jsdom 在 42/42 样本中只有 23 个（55%）与真实 Chrome 一致，**其余 19 个（45%）必然 418**——所以表现接近「一半概率失败 + 重试后偶现」。**[已验证：同一挑战，旧实现 418 / 新实现 200；真实 Chrome 控制组 200；仿真环境 42/42 与 Chrome 指纹逐字节一致]**

3. **修复**：`src/duck/challenge.js`（v2.62）把求解环境从「空 jsdom 顶层 window」改为 **真实页面仿真**：构造 `#jsa` sandbox iframe（srcdoc 带 CSP meta）、注入 `__DDG_BE_VERSION__`/`__DDG_FE_CHAT_HASH__`（取首页 `data-version-tag`/`data-version-sha`）、为元素布局指标提供 shim，并**在 iframe realm 内 eval 挑战表达式**。`legacyChallengeEnv` 保留旧行为作对照。**[已验证：`npm test` 493/493；真实上游 fresh + rolling 两次 chat 均 200]**

4. **次要问题（非本次主因，仍建议修）**：挑战无签发时间 TTL、`/capabilities` 挑战跨链覆盖、continuation 头覆盖等状态机问题（详见 `gateway-418-audit.md` 与本文 §6）。**[分析结论]**

---

## 1. 取证方法与证据来源

| 手段 | 内容 | 产物 |
| --- | --- | --- |
| Chrome 真机抓包 | 隔离上下文打开 duck.ai，抓 `/status`、`/chat` 全量请求/响应头，并在页面内用真实 `#jsa` iframe 解挑战 | `recon/2026-11-06/browser-probe*`、本文 §2.2 |
| 前端 bundle 静态分析 | 下载当前部署 4 个 JS，按 webpack module 切分、prettier 美化、关键字定位 | `recon/2026-11-06/entry.duckai.9eb647a002c7954fd3aa.js`、`recon/2026-11-06/modules/` |
| 挑战 JS 去混淆 | 自研通用 deobfuscator（字符串数组+rotation+decoder 还原、调用点替换） | `recon/2026-11-06/scratch-lead/deobfuscate.mjs`、`variants/*.pretty.js` |
| 真实上游差分实验 | 以「有效模型 + 真实 `/chat`」为 oracle：`418`=挑战被拒，`200`=通过；`invalid-model` 探针只做粗校验 | `scratch-lead/probe.mjs`、`verifyfix.mjs`、`fix-validate.mjs` |
| 批量变体扫描 | 44+ 个实时挑战，逐个 plain(旧) vs emulated(新) 求解对比，按 suite 分类统计 | `scratch-lead/variant-scan*.json`、`fix-scan/` |
| 单元/回归测试 | 新增 `tests/challenge-env.test.js`（page-state/layout/legacy 对照） | `npm test` 493/493 |

**环境事实 [已验证]**：本沙箱 Node 原生 `fetch` 可直连 duck.ai（无需 AGENTS.md 所述代理）；校验实验使用匿名会话，无 cookie、`x-duckai-client-tools` 可省略、`x-fe-signals` 空 events 也可被接受——这些都不是本次 418 的判别因素。

---

## 2. duck.ai 前端实现（源码级还原）

### 2.1 模块地图（当前部署）

| 位置 | 作用 | 证据（bundle 偏移 / module） |
| --- | --- | --- |
| module `30012`（FraudProvider/JSA 上下文） | 创建 `#jsa` iframe：`sandbox="allow-scripts allow-same-origin"`、CSP-only `srcDoc`、`-9999px` style；context 暴露 `{jsa,setJsa,refreshJsa,awaitJsa,…}`；`setJsa` 求解、`awaitJsa` 等待、**每 5 分钟主动 `/status` 刷新** | offset `1884825`；iframe JSX @`1888104`–`1888260`；5min 定时 @`1887782` |
| module `29329`（`useAwaitJsa`） | 等待已解 JSA 的封装：**默认 15s 超时** + `dc_jsa_wait` 遥测 | offset `2046748` |
| module `35488`（2.9KB，JSA 求解器） | `X-Vqd-Hash-1` 常量、向传入的 iframe 注入 `<script>`、`window.__jsaCallbacks`、SHA-256+btoa、meta 后处理、异常回退（`btoa(raw::err::stack::origin)`） | offset `2169844`；求解 `l()` @`2170830` |
| module `80521`（149KB，API/状态层） | `/status` 抓取器（`x-vqd-accept`、读挑战头、错误对象带 `initialJsa`）、SWR 轮询、JSA 触发 | `it()` @`1740700`；挑战头 @`1740928` |
| module `39544`（聊天请求层） | `/chat` 请求头组装、SSE **`onopen` 即求解响应头挑战**、continuation、418 `ERR_CHALLENGE` 分支 | 头 @`2015000`；onopen @`2016411`；418 @`2025134` |
| module `58935`（summarize） | `/summarize` 同样的「取挑战→求解→滚动」模式 | 请求头 @`2148300`；响应挑战 @`2148534` |
| module `12262`（应用引导） | `window.__DDG_BE_VERSION__ = data-version-tag`、`__DDG_FE_VERSION__`、`__DDG_FE_CHAT_HASH__ = data-version-sha || "hash"`；anomaly 弹窗等 | offset `268622` |
| module `18118` | `useAntiBotAnomalyChallenge`：把 418 的 `cd` 交给 anomaly tile 视图 | offset `2044505` |

> 完整模块表与逐条偏移见 `recon/2026-11-06/analysis/frontend-challenge.md`（bundle-traffic）。

浏览器端求解器（module 35488）关键逻辑（旧版对照 `recon/jsa-solver-pretty.txt` 一致）：

```js
// 1) 把解码后的挑战表达式写进 iframe 的 <script>，回调把结果传回顶层
s.textContent = `try{ window.parent.__jsaCallbacks[${n}](null, ${e}); }
                catch(e){ window.parent.__jsaCallbacks[${n}](e, null); }`;
// 2) 失败时也返回一个 header（原始挑战 + 错误信息 + stack + origin），交给上游判定
btoa(`${atob(e)}::${t.message}::${u(t)}::${d()}`)
// 3) 成功后：client_hashes 逐个 SHA-256+base64，meta 补 origin/stack/duration
btoa(JSON.stringify({ ...result, client_hashes: {...}, meta: { ...result.meta, origin, stack, duration } }))
```

### 2.2 浏览器真机链路（2026-11-06 捕获）

1. `GET /duckchat/v1/status`（带 `x-vqd-accept: 1`、`x-vqd-hash-1: initial`、`x-ddg-journey-id`、anon cookies）→ `200`，body `{"status":"0","secondaryStatus":"0","statusV2":0,"grant":null}`，响应头 `x-vqd-hash-1` = 7468 字符 base64 挑战。
2. 页面内 `#jsa` iframe 求解后，`POST /duckchat/v1/chat` 携带 **1620 字符** 的已解 `x-vqd-hash-1`；同请求还带 `x-fe-version`、真实事件 `x-fe-signals`（`{"start":…,"events":[{"name":"startNewChat_free","delta":344},{"name":"action","delta":63550,"trusted":true}],"end":71740}`）、`x-duckai-response-id`、`x-ddg-journey-id`、`x-duckai-continuation/tool-approval/consent-purposes` 与 `durableStream` body 字段。
3. 响应 `200 text/event-stream`（模型回复正常），**响应头再次下发新挑战**（滚动）。
4. 解码请求头中的 solved payload，可见其 `meta.debug` 为 2 个不可打印字符（`\u0019\u0018`），`meta.stack` 指向当前 `entry.duckai.9eb647….js` 的两帧，`meta.duration:"38"`。

#### 2.2.1 滚动消费与 418 的浏览器语义（bundle-traffic，[已验证]）

- **滚动消费**：聊天响应头在 SSE `onopen`（读 body 之前）就交给 `setJsa` 求解；下一次请求发出前用 `awaitJsa`（最多 15s）取「当前已解值」。浏览器**没有锁/队列**，只有 latest-wins 的已解值覆盖；**不校验 TTL**；每 5 分钟无请求会主动重取 `/status` 刷新。
- **continuation**：续传请求同样发送**已解值**（不是响应头原始 base64 挑战 JS）——网关当前发原始挑战属 P0 偏差。
- **418 处理**：418 `ERR_CHALLENGE` 且 body 带 `cd` 时**不自动重试聊天**，而是弹 anomaly 点选验证码，通过后才重发原 prompt；浏览器**不会因为 418 去 `GET /status`**（错误响应头里的新挑战会被照常求解，供下一次尝试使用）。429 只提供 UI 重试按钮。
- `/status` 的浏览器请求头很精简（`x-vqd-accept: 1` + `x-vqd-hash-1: initial` + journey id + cookies），**不带** `x-fe-version`/`x-fe-signals`；`/capabilities` 的响应挑战头浏览器**完全不消费**。

### 2.3 一个被忽视的事实：挑战表达式在 **iframe** 内执行

module 35488 的入参是一个 iframe 元素；调用方传入的正是 `#jsa`。因此挑战里的 `window`/`document` 是 iframe realm，`window.top` 是 duck.ai 顶层页面。**这是本次 418 的根源**：旧网关把表达式 `eval` 在 jsdom 顶层空 window 中，页面状态探针必然失败。

---

## 3. 挑战载荷语义（服务端生成的随机化探针）

### 3.1 返回结构

```json
{
  "server_hashes": ["<3 个 base64>"],
  "client_hashes": ["<原始字符串 1>", "<原始字符串 2>", "<原始字符串 3>"],
  "signals": {},
  "meta": { "v": "4", "challenge_id": "<64hex>+<5字符后缀>", "timestamp": "<epoch ms>", "debug": "<XOR 后的 JSON>" }
}
```

- `challenge_id` 后缀（`pxjzr` / `h8jbt` / `vz95n` / `q7klm` / `i3jp0`）与挑战内部 string 表 / 检查表 key 同源，每次随机。
- `debug` = `XOR(JSON.stringify(检查表 map), <每挑战随机 16 hex key>)`。**当前所有观察到的 suite 检查表第二列恒为 false，map 恒为空 `{}`**，故 debug 恒为 2 字符且每挑战不同（浏览器与网关都原样透传，不构成判别）。**[已验证，n>20]**
- `server_hashes` 每个挑战不同，`client_hashes[0]` 恒为 `navigator.userAgent` 原始字符串。

### 3.2 随机化环境探针 suite（核心发现，n=42 个唯一挑战样本）

| suite(tag) | `client_hashes[1]` 计算（去混淆后） | 真实 Chrome | 旧 jsdom | 新仿真 | 样本数 |
| --- | --- | --- | --- | --- | --- |
| **JS_API**（`pxjzr`）：`window.parseInt.toString().includes('[native code]')`、`class extends Array`、`Object.prototype.toString.call(window)`、`Error`/`captureStackTrace`、`isSealed(Math)`、body.children 活集合、`NodeList`、`HTMLDivElement/HTMLElement/Element` instanceof 链（13 项） | `String(seed + 12)`（13 项中 12 项为真） | `seed+12` | ✅ 正确（11/11） | ✅ | 11 |
| **INNER_HTML**（`h8jbt`）：随机畸形 HTML 解析/序列化指纹（`<p><div></p><p></div` 等 4 种字面量） | `seed + len(innerHTML) × count(querySelectorAll('*'))` | 见 challenge-payload §5 | ✅ 正确（12/12，parse5 与 Blink 一致） | ✅ | 12 |
| **LAYOUT**（`q7klm`）：渲染 `display:inline-block;padding:8px;position:absolute;visibility:hidden` 的 div，检查 `offsetWidth>0`、`offsetHeight>0`、`getBoundingClientRect().width/height>0`、`getComputedStyle(div).display.length>0`、`scrollHeight>0` | `String(seed + 通过项数)`（真实 Chrome 5 项全过；jsdom 只能过 computed-style 1 项） | `seed+5` | ❌ `seed+1`（0/12 正确） | ✅ `seed+5` | 12 |
| **PAGE_STATE_JSA**（`vz95n`）：`window.top.document.querySelector('#jsa')` 的 sandbox + srcdoc `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline';">` + `window.top.hasOwnProperty('__DDG_BE_VERSION__')` + `__DDG_FE_CHAT_HASH__` | `String(seed + 通过项数)`（真实 duck.ai 页 4 项全过） | `seed+4` | ❌ `seed+0`（0/7 正确） | ✅ `seed+4` | 7 |

> `client_hashes[2]` 是固定 `i3jp0` 套（webdriver===true / srcdoc iframe 的 `self.get` 探针 / `window.top` 别名全局探测），42/42 中 Chrome = jsdom = `seed2+0`。
> 每挑战随机生成两个十进制 seed（以十六进制字面量出现在载荷里），**server 生成挑战时知道 seed 与「浏览器应通过项数 k」**，因此能精确重算期望 `client_hash` 原文（如 `5454+12="5466"`）并比对客户端回传的 SHA-256。**[分析结论；42/42 一致性支持]**
> suite tag 同时是 `meta.challenge_id` 的 5 字符后缀（`pxjzr`/`h8jbt`/`q7klm`/`vz95n`），可用于日志归因。**[已验证 42/42]**

**旧实现的失败概率**：42 个唯一样本中裸 jsdom 仅 23 个（55%）与 Chrome 一致 → 约 **45%** 的上游请求被 418（另一组 13 样本独立抽样为 46% 通过/54% 失败，量级一致）。配合 `src/duck/index.js` 默认 `humanize.retries=3`（共 4 次尝试），单次 chat 的可见失败率约 **4%~8.5%**；但一次用户会话会发多次上游请求、continuation 重发不经过 `_executeChat` 重试、image/summarize 等路径也各自消耗挑战 → 用户感知为「偶现 418」。**[分析结论 + 已验证重试代码]**

### 3.3 上游校验模型（本次实测推断）

| 结论 | 证据 | 等级 |
| --- | --- | --- |
| 真实 chat 阶段**精确校验** `client_hashes` | 同一挑战：旧实现头 → `418 ERR_CHALLENGE`；仿真头 → `200 SSE`（多轮、跨 4 类 suite） | 已验证 |
| `invalid-model` 请求只做**粗校验**（存在/签名/时效），不校验环境指纹 | 旧实现头 + invalid model → `404 ERR_MODEL_UNAVAILABLE`；`initial` → `418`。所以健康探针/404 路径无法暴露偏差 | 已验证 |
| `meta.origin/stack/duration/debug` 当前**不严格校验** | 真实 Chrome 控制组用 chrome-devtools 的 `file:///…chrome-devtools-mcp…` 垃圾 stack 仍 `200`；duration 14ms 与 305ms 均可 | 已验证 |
| `418` 的 `overrideCode` 与失败 suite 对应：`f741` ↔ `q7klm`(LAYOUT)（4/4 相关），`d78d` ↔ `vz95n`(PAGE_STATE)（4/4 相关），`975b` 为缺失/`initial` 类；`d0aa` 仅 Lead 页面实验出现一次，未复现 | `418` body `cd`/`overrideCode` 采样；42 样本审计 | 已验证（f741/d78d），d0aa 待确认 |
| `server_hashes` 为每挑战随机的 32B nonce，**不是** client_hashes 的哈希（SHA-256/编码/HMAC 变体穷举均不匹配），客户端只需原样回显 | `challenge-payload.md` §4.1 | 已验证 |
| `debug` = XOR(JSON.stringify(检查表 map), 每挑战随机 16-hex key)；42/42 解码后均为 `"{}"`（2 字节），当前无信息量 | `challenge-payload.md` §4.4 | 已验证 |
| `challenge_id` = 64 hex + **suite tag**（后缀）；`timestamp` = 服务端生成时刻（与响应 `date` 对齐） | 42/42 样本 | 已验证 |
| 挑战有时效，但窗口 >72s | 浏览器 08:43:15 获取的挑战 08:44:27 用于 chat 仍 `200`；网关 `challengeTtlMs=90s` 在窗口内 | 已验证 |
| 错误响应（404）也会带新滚动挑战，且该挑战可被下一次请求使用 | 404 响应头挑战求解后真实 chat `200` | 已验证 |
| 同一 solved header 可被**非真实请求**重复校验通过；真实 chat 的一次性/链语义未完全确定 | invalid-model 探针复用同一 header 两次均 404 | 待确认（需专门的消费实验） |
| 无 cookie / 无 `x-duckai-client-tools` / 空 `x-fe-signals` 均可 200 | 本次多轮真实 chat | 已验证 |
| 浏览器不会在 418 后重新 `/status`；418 响应头的挑战仍会被求解供下次使用；真正的 anomaly 才弹验证码 | bundle module `39544` @`2025134`、`18118`（frontend-challenge §6） | 已验证（源码） |
| 浏览器继续请求发送「已解值」；网关 continuation 发送响应头原始挑战 base64 | 真机抓包 + `frontend-challenge.md` §6；网关 `index.js:1352,1359,1636-1653` | 已验证（偏差确证） |

> 之前 `docs/PROTOCOL-ERRORS.md` §3.1.1 把 429 `ERR_BN_LIMIT` 归因于 `meta.stack` 的 `file:///` 帧。本次无法复现该 429（含故意使用原生栈的对照）；当前 418 主因是环境指纹而非 stack。历史结论保留但需降级为「特定 tier/部署下可能生效」。**[待确认]**

---

## 4. 修复设计（v2.62，已落地）

### 4.1 改动点（`src/duck/challenge.js`）

| 改动 | 说明 |
| --- | --- |
| `JSA_IFRAME_SRCDOC` / `JSA_PAGE_HTML`（L46–56） | 复刻真实 `#jsa`：`sandbox="allow-scripts allow-same-origin"`、srcdoc 内 CSP meta、`position:absolute; left/top:-9999px` |
| `installLayoutShims(win)`（L64+） | jsdom 无布局引擎：为 `Element.prototype.getBoundingClientRect/getClientRects` 与 `HTMLElement.prototype.offset*/client*/scroll*` 提供「有盒模型」语义（已连接且 `display!=="none"` → 1，否则 0；`visibility:hidden` 仍算有布局），与真实浏览器对 challenge 探针的判定一致；`documentElement` 尺寸与 `outerWidth/outerHeight/devicePixelRatio` 同步 |
| `_createChallengeRealm()`（L659） | 新建 jsdom 时使用页面 HTML（`legacyChallengeEnv` 时仍用旧空页面） |
| `_evaluateChallenge()`（L683） | 注入 `window.__DDG_BE_VERSION__ = data-version-tag`、`__DDG_FE_CHAT_HASH__ = data-version-sha`；确保 iframe `contentDocument` 有 CSP meta/body；安装布局 shim；**在 `iframe.contentWindow` 内 `eval` 挑战表达式** |
| `_ensureVersionLocked()`（L511） | 版本缓存同时保存 `tag`/`sha`（页面全局变量的真实值） |
| `legacyChallengeEnv`（L274） | 诊断开关（`DUCKAI_LEGACY_JSA_ENV=1`），可复现旧行为用于对照 |

后处理（SHA-256、`meta.origin/stack/duration`、`btoa`）与滚动状态机**不变**，因此对 `pending/solved/lease/mutex` 语义零影响。

### 4.2 设计理由

- **必须在 iframe realm 内执行**：page-state suite 读取的是「挑战运行所在 realm 的 `window.top` 页面」，而不是某个字符串参数；在顶层 eval 即使伪造 DOM 也无法让 `window !== window.top`。
- **布局 shim 只影响 jsdom 缺失的测量**：挑战只做 `>0` 判定，浏览器对已渲染元素恒真；不伪造具体像素值。
- **保守回退**：若 iframe 缺失（jsdom 版本差异），退回旧路径以保留通用 suite 的可用性，而不是直接失败。

### 4.3 可观测性建议（未实现，后续)

挑战源文本（base64 解码后）可直接分类 suite（包含 `#jsa` / `offsetWidth` / `innerHTML` 关键字）。建议在 `stats()` 增加 `lastChallengeSuite` 与 `clientHashDeltas`（emulated vs legacy 求解差），把「抽到会失败的 suite」变成可监控指标，而不是等 418。

### 4.4 v2.63 残余 418 路径修复（已落地，详见 `docs/ACCEPTANCE.md` §2.54）

按 `gateway-418-audit.md` §11 的 E 系列与 P0/P1 建议修复：

| 修复 | 说明 | 代码位置 |
| --- | --- | --- |
| continuation 发**已解值** | 删除 `extraHeaders` 中的原始挑战覆盖；`_attemptChat → acquire()` 消费 commit 的滚动挑战并求解（浏览器语义） | `index.js` `_resumeContinuation` |
| continuation 418 重试 | 418 → `invalidate` + 换新挑战重试一次（`continuationRetries`）；持续失败才暴露 | 同上 |
| summarize 418/429 重试 | 每次重新 `acquire`，最多 3 次（`summaryRetries`），并记录 `overrideCode` | `index.js` `summarizeNative` |
| `overrideCode` 归因 | `DuckError.overrideCode` + `stats.lastOverrideCode` + `stats.overrideCodes`（按 `code:type` 计数，health 可见） | `index.js` `_noteOverrideCode` |
| suite 可观测 | `challenge.stats()` 新增 `lastChallengeSuite`（challenge_id 后缀）、`lastClientHashes`（明文指纹）、`envFallbacks`、`externalChallengeSkips`、`stalePendingDropped`、`versionRefreshes` | `challenge.js` |
| pending TTL | 未求解滚动挑战 > `pendingTtlMs`（默认 120s）丢弃并重新 `/status` | `challenge.js` `_ensureSolvedLocked` |
| 版本新鲜度 | `versionTtlMs` 30min→5min，并在 `_solveLocked` 前按需刷新首页 | `challenge.js` `_refreshVersionIfStaleLocked` |
| capabilities 挑战 | 改为 idle-only 采纳，不再覆盖进行中的滚动链（浏览器不消费该头） | `challenge.js` `noteChallengeFromHeader` |
| `x-fe-signals.end` | 改为浏览器语义：相对 `start` 的毫秒差 | `challenge.js` `buildFeSignals` |

新增回归 8 项：`tests/challenge-lifecycle-v262.test.js`（5）、`tests/summarize-retry-override.test.js`（2）、`tests/continuation.test.js`（+1）。

---

## 5. 验证矩阵

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| `npm test`（含新增 4 个环境仿真用例 + v2.63 的 8 个残余路径用例） | **501/501 pass** | `duckai-cpa/tests/challenge-env.test.js`、`challenge-lifecycle-v262.test.js`、`summarize-retry-override.test.js`、`continuation.test.js` |
| v2.63 continuation 修复 | 续传 header 为**已解值**（不再是原始挑战）；418 后自动重试成功 | `tests/continuation.test.js`（新增断言/用例） |
| v2.63 overrideCode 归因 / summarize 重试 | `d78d`/`f741` 归因到 `error.overrideCode` 与 `stats.overrideCodes`；summarize 418→200 | `tests/summarize-retry-override.test.js` |
| v2.63 continuation 真实上游验证 | **BLOCKED**：出口 IP 触发上游临时 `451 ERR_COUNTRY_NOT_SUPPORTED` 软限流（手动同头请求亦复现，非代码回归）；额度恢复后可跑 `scratch-lead/live-continuation-check.mjs` | `recon/2026-11-06/scratch-lead/diag-*.mjs` |
| 真实上游 live（修补后的 `ChallengeManager`）：fresh `/status` 挑战 + 滚动挑战各一次真实 chat | **200 / 200**，`solves=2`、`solveErrors=0`、`envFallbacks=0`；最终复测的第二条与滚动挑战恰好是 **`q7klm` 布局 suite**（`lastChallengeId` 后缀），说明布局仿真在真实上游生效 | `recon/2026-11-06/scratch-lead/live-module-check.mjs` 输出 |
| 差分验证：旧实现 vs 仿真实现（同一挑战） | page-state：旧 418 / 新 200；layout：旧 418 / 新 200 | `verifyfix` / `fix-validate` 日志 |
| 四类 suite 的仿真头真实 chat | generic / innerHtml / layout / pageState 全部 **200**（5/5 次） | `fix-validate.mjs` 输出 |
| **42/42 挑战样本仿真指纹 == 真实 Chrome** | 队友用隐藏 srcDoc iframe + 本地 HTTP harness 在真实 Chrome 156 中执行 42 个原始载荷，与仿真环境求解结果逐字节比对：42/42 一致（裸 jsdom 仅 23/42） | `recon/2026-11-06/analysis/challenge-payload.md` §3、`scratch-challenge/chrome-ground-truth.json` |
| 真实 Chrome 控制组 | 页面内真实求解 → 200（尽管 stack 是 pptr 垃圾帧） | `evaluate_script` 抓包 |
| 旧实现对照 | 旧扁平环境确定性地产出 `seed+0`/`seed+1` 指纹 | `tests/challenge-env.test.js` legacy 用例 |
| v2.62 后状态机未变（只读复核） | 原竞态脚本在新代码上重跑 6/6 pass；新增残余路径脚本 5/5 pass；418 重试仍 invalidate+重新 `/status` | `recon/2026-11-06/analysis/gateway-418-audit.md` §11、`scratch-gateway/results.txt` |

---

## 6. 残余风险与后续建议

> 交叉验证依据：`recon/2026-11-06/analysis/gateway-418-audit.md` §0.5/§11（gateway-audit 在 v2.62 代码上只读复跑原竞态脚本 6/6、新增残余路径脚本 5/5）。

| 优先级 | 项目 | 状态 / 说明 |
| --- | --- | --- |
| — | 未知第 5+ 类 suite | **观测已加**：`challenge.stats().lastChallengeSuite`（challenge_id 后缀）+ `lastClientHashes`（明文指纹）+ `stats.overrideCodes`（按 418 overrideCode 计数）；出现新码即有新 suite。仍无法预防性修复（上游新增探针需要重新仿真）。 |
| ✅ P0 | continuation 发原始挑战 + 无 418 重试 | **v2.63 已修**：续传改为已解值、418 换挑战重试一次；离线用例锁定。真实上游验证 BLOCKED（451 软限流，见 §5）。 |
| ✅ P0 | 环境回退可观测 | **v2.62+v2.63 已加**：`envFallbacks` + warn；`stats()` 暴露 `environment`/`versionAgeMs`。 |
| ✅ P1 | 版本新鲜度 | **v2.63 已修**：`versionTtlMs` 5min + `_solveLocked` 前按需刷新首页（`versionRefreshes`）。 |
| ✅ P1 | 挑战 pending TTL | **v2.63 已修**：`pendingTtlMs`（默认 120s），过旧丢弃并重新 `/status`（`stalePendingDropped`）。 |
| ✅ P1 | `/capabilities` 挑战跨链覆盖 | **v2.63 已修**：idle-only 采纳，滚动链进行中被跳过（`externalChallengeSkips`）。 |
| ✅ P2 | 布局 shim 常量 / `x-fe-signals.end` | 布局 shim 已是「有盒模型」语义（连接且非 `display:none`）；`x-fe-signals.end` 已改为毫秒差。 |
| — | 多身份并发 / admin 旁路 `/status` | **未修（设计级）**：`identity-pool` 每身份队列、admin usage 轮询与 prod `/status` 的关系需要产品/架构决策；当前作为已知放大器记录（`gateway-418-audit.md` E8）。 |
| — | 未知新 overrideCode 的盲目重试 | 仍为 4 次重试；已可按已知环境类码（f741/d78d）在后续版本做「最多 1 次」快速失败。 |
| ✅ P2 | 文档同步 | `PROTOCOL.md`/`PROTOCOL-ERRORS.md`/`ARCHITECTURE.md`/`ACCEPTANCE.md`/`AGENTS.md` 已同步。 |

**gateway-audit 残余路径（E1–E11）摘要**：E1 未知 suite；E2/E2b 版本 tag/sha 过期与滚动链期间不刷新（离线复现，条件性）；E3 iframe 缺失静默回退（已加计数）；E4 布局 shim 常量；E5 陈旧 pending/solved；E6 capabilities 覆盖；E7 continuation 原始头；E8 多身份并发/旁路 `/status`；E9 418 盲目重试 4 次；E10 `legacyChallengeEnv` 误留生产；E11 `meta.stack`/`duration` 陈旧。完整表格与验证方法见 `gateway-418-audit.md` §11.3。

---

## 7. 复现与证据索引

| 文件 | 用途 |
| --- | --- |
| `recon/fresh-fetch.mjs` | 抓取当前部署 HTML/bundle/一个实时挑战 |
| `recon/2026-11-06/scratch-lead/deobfuscate.mjs` | 通用挑战去混淆（字符串数组 + rotation + 别名替换） |
| `recon/2026-11-06/scratch-lead/solver.mjs` | 仿真求解器（#jsa + CSP meta + 页面全局 + 布局 shim） |
| `recon/2026-11-06/scratch-lead/probe.mjs` | 上游语义探针（invalid-model oracle、滚动、复用、时效、header 变体） |
| `recon/2026-11-06/scratch-lead/variant-scan.mjs` | 批量挑战变体扫描（plain vs emulated，含 suite 分类） |
| `recon/2026-11-06/scratch-lead/verifyfix.mjs` / `fix-validate.mjs` | 修复前后真实 chat 差分验证 |
| `recon/2026-11-06/scratch-lead/live-module-check.mjs` | 用真实 `src/duck/challenge.js` 直连上游的 live 验证 |
| `recon/2026-11-06/scratch-lead/variants/` | 去混淆后的随机 suite 样本（00–14） |
| `duckai-cpa/tests/challenge-env.test.js` | 回归测试（page-state/layout/legacy） |
| `duckai-cpa/tests/challenge-lifecycle-v262.test.js` | v2.63：旁路挑战 idle-only、pending TTL、版本刷新、诊断字段、signals 语义 |
| `duckai-cpa/tests/summarize-retry-override.test.js` | v2.63：summarize 418 重试、overrideCode 归因 |
| `duckai-cpa/tests/continuation.test.js` | v2.63：续传已解值/418 重试用例 |
| `recon/2026-11-06/scratch-lead/live-continuation-check.mjs` | continuation 真实上游验证脚本（本次被 451 软限流 BLOCKED） |
| `recon/2026-11-06/scratch-lead/diag-*.mjs` | 451 归因诊断（请求头/同进程对照，证明为上游软限流） |
| `recon/2026-11-06/analysis/frontend-challenge.md` | 前端 bundle 源码专项报告（bundle-traffic） |
| `recon/2026-11-06/analysis/challenge-payload.md` | 挑战载荷逆向专项报告：42 样本 suite 目录、Chrome ground truth、仿真清单（challenge-reverse） |
| `recon/2026-11-06/scratch-challenge/suite-catalog.mjs` | 42 样本批量去混淆/分类/plain-vs-仿真求解 |
| `recon/2026-11-06/scratch-challenge/jsdom-sim-env-test.mjs` | 完整仿真环境 vs 真实 Chrome 逐样本回归（42/42） |
| `recon/2026-11-06/scratch-challenge/harness.html` + `local-server.mjs` | 在真实 Chrome 的隐藏 srcDoc iframe 中执行 42 个原始载荷，采集 ground truth |
| `recon/2026-11-06/analysis/gateway-418-audit.md` | 网关状态机审计 + v2.62 后交叉验证（gateway-audit） |
| `recon/2026-11-06/scratch-gateway/` | 竞态复现/残余路径脚本（`challenge-race.test.mjs`、`env-residual.test.mjs`、`results.txt`） |
| `recon/2026-11-06/scratch-frontend/` | 前端 bundle 模块抽取、挑战反混淆、13 样本 plain/simPage 双环境求解与 `samples/summary.jsonl` |

---

## 8. 结论分级汇总

**已验证**
- 挑战由服务端随机 suite 生成（42 样本 4 类：`pxjzr`/`h8jbt`/`q7klm`/`vz95n`，配比 11/12/12/7）；page-state / layout 两类在旧 jsdom 环境中必然算错；上游在真实 chat 阶段精确校验 `client_hashes`；42/42 样本的仿真求解与真实 Chrome 指纹逐字节一致（裸 jsdom 仅 23/42）；旧实现 → 418、仿真实现 → 200；`npm test` **501/501**；真实上游 fresh/rolling 均 200。
- `meta.origin/stack/duration/debug` 当前不严格；无 cookie/无 client-tools/空 signals 均可 200；错误响应也携带可用的滚动挑战；挑战时效 >72s；`server_hashes` 原样回显即可；`debug` 恒为 XOR("{}")；`challenge_id` 后缀即 suite tag。
- v2.63 残余修复：continuation 发送已解值 + 418 重试；summarize 418/429 重试；`overrideCode` 归因（error/stats/health）；pending TTL；版本 5min 刷新；capabilities 挑战 idle-only；`x-fe-signals.end` 浏览器语义（均有离线用例）。

**分析结论**
- 旧实现约 45% 请求会抽到失败 suite；重试把可见失败率压到 ~4%，但 continuation/image/summarize 等路径缺少同等重试，故表现为「偶现 418」。
- debug 恒为 `XOR("{}")`；overrideCode `f741↔q7klm`、`d78d↔vz95n`；server_hashes 为服务端随机 nonce；challenge_id 前缀为服务端密钥派生值。
- TTL/跨链/continuation 头是放大器而非本次主因。

**待确认**
- overrideCode ↔ suite 的完整映射；真实 chat 的挑战一次性/消费语义；`ERR_BN_LIMIT` 在其它 tier 下的触发条件；时间窗口的精确上界；是否存在第 5+ 类 suite。
- v2.63 continuation/真实续传的**在线**验证被上游临时 `451 ERR_COUNTRY_NOT_SUPPORTED` 软限流阻断（手动同头请求亦复现），额度恢复后跑 `scratch-lead/live-continuation-check.mjs` 即可补齐。

**BLOCKED**
- v2.63 continuation 真实上游实机验证（原因同上；离线用例已覆盖行为）。

---

## 9. 附：关键时间线（2026-11-06，本地时区）

| 时间 | 事件 |
| --- | --- |
| 08:39–08:43 | 抓取当前部署 bundle（2.5MB，entry `9eb647…`）与首个挑战 |
| 08:43–08:44 | Chrome 真机完整对话成功（`/status` → 求解 → `/chat` 200），抓到滚动挑战与 solved header |
| 08:47 | 页面内独立求解 → invalid-model 探针 404 / `initial` 418（发现粗校验阶段） |
| 08:52–08:59 | 真实 chat 差分：旧 jsdom 头 → 418；仿真头 → 200（page-state） |
| 09:04–09:10 | 四类 suite 批量验证：layout suite 被识别（fallback 值 seed+1），补布局 shim |
| 09:11–09:15 | 仿真头在 generic/innerHtml/layout/pageState 上全部 200（5/5） |
| 09:20+ | 落地 `src/duck/challenge.js` v2.62 + 新增测试；`npm test` 493/493；live 复测 200/200（其中滚动挑战为 `q7klm` 布局 suite） |
