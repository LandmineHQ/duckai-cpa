# DuckAI CPA v2.3：代理（Proxy）能力契约

> 需求：新增「代理」标签页，支持 HTTP(S) 与 SOCKS4/SOCKS5 代理，全部上游/外部请求可走代理；
> 本机代理 `127.0.0.1:10808` 同时支持 HTTP CONNECT 与 SOCKS5，用于联调。
> 本轮为增量特性，不破坏 v2.2；默认关闭（不影响现有直连行为）。

---

## 1. 配置（`config.proxy`）

```json
"proxy": {
  "enabled": false,
  "type": "http",              // http | https | socks4 | socks5
  "host": "127.0.0.1",
  "port": 8080,
  "username": "",
  "password": "",
  "noProxy": ["127.0.0.1", "localhost"],
  "testUrl": "https://duck.ai/duckchat/v1/status",
  "ipCheckUrl": "https://api.ipify.org?format=json"
}
```

- `http`：HTTP CONNECT 代理（对 https 目标用 CONNECT 隧道，对 http 目标用 absolute-form）。
- `https`：TLS 连接到代理（`ProxyAgent` 的 https uri）。
- `socks4/socks5`：SOCKS 代理（`socks` 包 + undici 自定义 connector；https 目标由 connector 自行 TLS，端口缺省 443/80）。
- `noProxy`：按 hostname 后缀/精确匹配直连（`localhost`、`127.0.0.1`、`*.internal` 等）。
- 修改后**立即生效**（重建 dispatcher），无需重启；进行中的请求使用旧 dispatcher 完成。
- 密码只落盘/内部使用：`GET /admin/api/proxy` 返回 `hasAuth:true` 但不回显密码；PUT 时省略 password 表示保持不变，传空字符串表示清除。

## 2. 生效范围

代理启用后，**所有对外请求**统一走代理：
1. DuckClient 的全部请求（首页版本、`/duckchat/v1/status`、`/chat`、`/capabilities`、`/auth/*`）；
2. `sync.js` 的 transport 探测（`duckduckgo.com/sync/pairing`）；
3. 订阅 token 的在线校验；
4. `POST /admin/api/proxy/test` 的测试请求。

> 说明：沙箱原本只允许 `duck.ai`，本机代理已验证可访问 `duckduckgo.com` 与任意外网（exit IP 会变化）。
> 因此**启用代理后 Sync 的 `transport` 应变为 `available`**（跨设备配对握手机制本身仍待实现，见 §6）。

## 3. Admin API

### 3.1 `GET /admin/api/proxy`

```json
{
  "proxy": {
    "enabled": true, "type": "http", "host": "127.0.0.1", "port": 10808,
    "hasAuth": false, "username": "", "noProxy": ["127.0.0.1", "localhost"],
    "testUrl": "https://duck.ai/duckchat/v1/status",
    "ipCheckUrl": "https://api.ipify.org?format=json",
    "status": {
      "active": true, "mode": "http", "lastTestAt": 1793, "lastTestOk": true,
      "lastTestLatencyMs": 210, "lastTestStatus": 200, "exitIp": "70.39.202.155",
      "lastError": null, "updatedAt": 1793
    }
  }
}
```
- `mode`: `direct` | `http` | `https` | `socks4` | `socks5`（`active=false` 时 `mode:"direct"`）。
- 不返回 `password`。

### 3.2 `PUT /admin/api/proxy`

body 为部分配置（深合并）：`{ enabled?, type?, host?, port?, username?, password?, noProxy?, testUrl?, ipCheckUrl? }`
→ `{ ok: true, proxy: {...}, applied: true }`；校验失败 `400 invalid_proxy`（附 `error.message` 说明哪个字段）。

校验规则：
- `type ∈ {http,https,socks4,socks5}`；`port` 整数 1–65535；`host` 非空字符串（允许域名/IP）；
- `noProxy` 字符串数组（≤50 项，去重）；
- `testUrl/ipCheckUrl` 必须 `http(s)://`。

### 3.3 `POST /admin/api/proxy/test`

body 可选覆盖：`{ type?, host?, port?, username?, password?, noProxy?, testUrl?, ipCheckUrl? }`（未提供则用已保存配置）。
- 用**临时 dispatcher**测（不改保存值），若 `enabled=false` 且未显式提供 host/port → 测试直连。
- 返回 200（测试失败也用 200，便于前端展示）：
```json
{ "ok": true, "mode": "http", "target": "https://duck.ai/duckchat/v1/status",
  "status": 200, "latencyMs": 214, "exitIp": "70.39.202.155", "ipError": null,
  "testedAt": 1793, "error": null, "code": null }
```
- 失败：`{ ok:false, mode:"http", latencyMs: 8000, status:null, error:"...", code:"proxy_connect_failed"|"proxy_timeout"|"proxy_tls_failed"|"invalid_proxy" }`。
- 无论成功失败都把结果写入 `status`（lastTestAt/Ok/Latency/Status/exitIp/lastError）。

### 3.4 `GET /healthz`

新增：`proxy: { enabled, mode, active, lastTestOk, lastTestLatencyMs, exitIp }`（不泄漏密码）。

---

## 4. 前端「代理」页（`#/proxy`）

侧边栏新增 **代理**（Icon: Network / Globe），放在「身份」之后：

1. **状态卡**：当前模式（直连 / HTTP / HTTPS / SOCKS4 / SOCKS5）、最近测试时间/延迟/HTTP 状态/出口 IP、最近错误（红色）。
2. **配置卡**：
   - 启用开关（关闭时其余字段禁用但可编辑）；
   - 类型下拉（HTTP / HTTPS / SOCKS5 / SOCKS4）；
   - 主机 + 端口（并排）；用户名/密码（可选，password 输入 + 显示切换，占位提示「留空表示不修改已保存密码」）；
   - 不走代理（noProxy）文本框：逗号/换行分隔；
   - 高级：测试地址（默认 duck.ai status）、出口 IP 检查地址（默认 ipify）；
   - 按钮：**保存并应用**（PUT）、**测试连接**（POST test，显示延迟/状态码/出口 IP/错误）；
   - 快捷按钮：**填入本机代理**（127.0.0.1:10808 + HTTP）。
3. 提示文案：代理用于让网关访问外部网络（含 `duckduckgo.com`，Sync/订阅相关）；仅影响服务端出站，不影响浏览器。
4. 身份页「Sync & Backup」的 blocked 提示改为「当前环境无法访问 duckduckgo.com；可在『代理』页启用代理后重试」，并提供跳转链接。

UI 要求与现有控制台一致（shadcn 卡片/表单/Toast），敏感字段掩码，保存/测试有 loading 与结果反馈；`npm run build:web` 通过。

---

## 5. 验收标准

1. `PUT /admin/api/proxy` 关闭/开启、四种类型切换；非法字段 → 400 `invalid_proxy`；密码不回显、空密码不覆盖。
2. `POST /admin/api/proxy/test`：
   - 启用 HTTP 代理 `127.0.0.1:10808` → `ok:true, status:200, latencyMs>0, exitIp` 为代理出口（≠ 直连 IP）；
   - 错误 host/port → `ok:false` 且 `code` 合理、`status.lastError` 记录；
   - 禁用代理 → 直连测试仍 `ok:true`（duck.ai 可达）。
3. 代理启用后，DuckClient 的真实请求走代理：
   - `/duckchat/v1/status` 200；真实 chat 200（额度允许时）；
   - `GET /healthz` 的 `proxy.active/mode` 正确；
   - `sync` transport 探测变为 `available`（本机代理可访问 duckduckgo.com）。
4. 代理关闭后行为与 v2.2 完全一致（回归全绿）。
5. 前端「代理」页可保存/测试/状态展示；身份页 Sync blocked 文案带代理引导；无 console 报错。
6. 自动化：`npm test` 全绿（新增代理单测/契约测试），`build-check`/`page-check` 覆盖代理页与端点。

---

## 6. 已知边界

- 跨设备 Sync **配对握手**（WebRTC/PAKE via duckduckgo.com）仍未实现：代理可用后 `transport:"available"`，
  `POST /admin/api/sync/pair` 返回 **501 `sync_handshake_unimplemented`**（不再是 503），后续可作为独立迭代。
- HTTP(S) 代理的 CONNECT 隧道**不识别 `noProxy` 之外的域名规则**（仅精确/后缀匹配）。
- 代理仅作用于网关出站请求，浏览器/客户端流量不受影响。
