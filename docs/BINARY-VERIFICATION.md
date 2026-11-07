# 单文件二进制端到端验证（scripts/verify-exe.mjs）

> 最后更新：2026-11-06（`platform-binaries` 分支）
> 相关文件：`scripts/verify-exe.mjs`、`scripts/build-exe.mjs`、`docs/BINARY-BUILDS.md`。

## 1. 这个脚本验证什么

`node scripts/verify-exe.mjs` 对 **bun 编译出来的单文件二进制**做离线端到端检查：
把二进制复制到独立临时目录（故意不依赖仓库里的 `src/`、`web/`、`config/`、`node_modules/`），
用随机空闲端口和独立数据目录启动，通过真实 HTTP 断言验证「单文件分发 + 首次启动 + 重启持久化」。

脚本是跨平台的（`node:http`/`child_process`，无第三方依赖），Windows / Linux / macOS 原生 runner
都可直接使用；**不能**在 glibc runner 上运行 musl/arm64 产物（交叉产物需在目标平台验证）。

它不访问真实 duck.ai（本仓库测试/验证一律离线）。上游不可达时网关按设计降级启动，
`/healthz` 仍返回 200、`upstream.ok=false`——脚本只断言 HTTP 状态与本地功能，不把上游故障当失败。

## 2. 前置条件

1. 已构建二进制：`node scripts/build-exe.mjs [--target=<target>]`（产物在 `dist/<target>/`）；
2. 运行脚本的机器能执行该二进制（原生平台；musl/arm64/macOS 交叉产物需要对应平台）；
3. Node.js 24（或 >= 20）用于运行验证脚本；
4. 端口 18000–18999 至少有一个空闲（可用 `--port` 指定）；
5. 不需要目标机安装 Bun（只有构建二进制时才需要 Bun >= 1.4.4）。

## 3. 用法

```bash
# 验证默认产物（dist/windows-x64/duckai-cpa.exe；Linux/macOS 一般显式传 --exe）
node scripts/verify-exe.mjs

# 验证指定平台产物
node scripts/verify-exe.mjs --exe dist/linux-x64/duckai-cpa --port 18787 --timeout 30000
node scripts/verify-exe.mjs --exe dist/darwin-arm64/duckai-cpa
node scripts/verify-exe.mjs --exe dist/windows-x64/duckai-cpa.exe

# 保留临时目录与进程，便于排障（结束后手动清理）
node scripts/verify-exe.mjs --keep

# 同一数据目录重复运行（验证“非首次启动”路径：从 config.json 回退读取 token）
node scripts/verify-exe.mjs --data-dir data/tmp/exe-verify-reuse

# 脚本自测：改为验证 node 入口（同一套断言，不需要先构建二进制）
node scripts/verify-exe.mjs --node src/index.js
```

| 参数 | 说明 |
| --- | --- |
| `--exe <path>` | 待验证 exe，默认 `dist/windows-x64/duckai-cpa.exe`（相对路径按仓库根解析） |
| `--node [entry]` | 改为验证 node 入口（默认 `src/index.js`），用于脚本自测 |
| `--port <port>` | 监听端口；默认 18000–18999 随机空闲端口，显式指定时被占用直接报错 |
| `--data-dir <dir>` | 数据目录；默认 `data/tmp/exe-verify-<时间戳>-<随机>`，相对路径按仓库根解析 |
| `--timeout <ms>` | 单次启动/重启就绪超时，默认 90000（范围 1000–600000） |
| `--keep` | 保留子进程、数据目录与日志（默认终止进程并清理临时目录） |
| `-h, --help` | 显示帮助 |

退出码：`0` = 全部 PASS；`1` = 存在 FAIL；`2` = 用法/环境错误（参数、exe 缺失、端口占用等）。

## 4. 执行流程

1. 校验目标文件存在，挑选空闲端口，创建 `data/tmp/exe-verify-*` 运行目录；
2. **exe 模式**：把 exe 复制到 `<runDir>/app/` 并从该目录启动（证明单文件可独立运行）；
3. 注入环境：`DUCKAI_CPA_PORT=<port>`、`DUCKAI_CPA_HOST=127.0.0.1`、
   `DUCKAI_CPA_DATA_DIR=<runDir|--data-dir>`；子进程 stdout/stderr 写文件（不用管道）；
4. 轮询 `GET /healthz` 直到 2xx（超时 `--timeout`）；
5. 从 stdout 解析首次启动打印的 adminToken / 默认 API Key（解析失败回退读 `config.json`，报告只显示脱敏前缀）；
6. 依次执行断言 a–h；
7. 停止进程、等待端口释放，用**同一数据目录**重启，执行重启断言 g/h；
8. 输出 PASS/FAIL 表、退出码；默认清理临时目录（失败时保留日志路径并打印诊断）。

## 5. 断言清单

| # | 断言 | 期望 |
| --- | --- | --- |
| a | `GET /healthz` | 200，JSON `ok=true`；`upstream.ok=false` 属离线降级，不算失败 |
| b | `GET /admin/` | 200、`text/html`，HTML 含 ≥1 个 `/admin/assets/` 引用 |
| c | `/admin/` 引用的静态资源 | 全部 200；`.js` → `javascript`、`.css` → `text/css`；favicon 为 `image/svg+xml` |
| d | `GET /admin/api/overview?token=…` | 200，JSON 含 `service.name` / `service.version` |
| e | `GET /v1/models`（Bearer API Key） | 200，`data` 数组非空（当前 20 个模型） |
| f | 数据目录 | 存在 `config.json` 与 `duckai.db`（bun:sqlite 兼容层正常建库） |
| g | 重启后 | 同一数据目录启动成功；`/admin/` 仍 200；adminToken 与首次启动一致 |
| h | 重启后（附加） | 首次启动的默认 API Key 仍可用于 `/v1/models`（已持久化） |

## 6. 本次验收结果（2026-11-06）

### Windows x64

环境：Windows x64、Node 24.12.0、Bun 1.4.4 编译的
`dist/windows-x64/duckai-cpa.exe`（148,691,968 字节）。

```powershell
node scripts/verify-exe.mjs --exe dist/windows-x64/duckai-cpa.exe --timeout 30000
```

```text
结果: PASS 8/8（总耗时 16.6s）
  PASS  a) GET /healthz 200 且 JSON ok=true（upstream.ok=false，离线降级）
  PASS  b) GET /admin/ 200 且含 3 个 /admin/assets/ 引用
  PASS  c) 静态资源全部 200 且 content-type 合理（favicon.svg / index-*.js / index-*.css）
  PASS  d) /admin/api/overview 200（service.version=0.1.0）
  PASS  e) /v1/models 200（20 个模型）
  PASS  f) 数据目录存在 config.json + duckai.db
  PASS  g) 重启后 adminToken 一致、/admin/ 仍 200
  PASS  h) 重启后默认 API Key 仍可用
退出码: 0
```

### Linux x64（glibc，WSL/Ubuntu 24.04 实机）

`dist/linux-x64/duckai-cpa`（142,543,024 字节）在 WSL Ubuntu 24.04 上运行独立 bash 冒烟
（启动、healthz、admin、静态资源、adminToken、overview、`/v1/models` 401/200、
`config.json`+`duckai.db`、重启后 adminToken 持久、重启后 `/admin/` 200）：
**PASS 13 / FAIL 0**（详见 `docs/ACCEPTANCE.md` §2.57）。

### Linux x64（musl，Alpine 3.20 chroot 实机）

`dist/linux-x64-musl/duckai-cpa`（136,132,008 字节）在 Alpine 3.20 minirootfs + 
`ca-certificates`/`libstdc++`（与 `Dockerfile.binary` 运行层一致）chroot 中冒烟：
**PASS 10 / FAIL 0**（含 admin/静态资源/overview/`/v1/models`/SQLite/重启持久化）。

### macOS / arm64

- `dist/darwin-x64/duckai-cpa`、`dist/darwin-arm64/duckai-cpa`、`dist/linux-arm64*/duckai-cpa`
  已在本机构建并通过文件头/`file` 格式校验（Mach-O / ARM aarch64 ELF）；
- **运行验证 BLOCKED**：本机只有 Windows x64 + WSL x64，无法执行 macOS/arm64 产物；
  由 `.github/workflows/build-binaries.yml` 的原生 macOS/arm64 runner 冒烟覆盖（CI 未在本机实际运行）。

同一 exe 的其它验收（见 `docs/ACCEPTANCE.md` §2.56/§2.57）：`npm test` 全绿、
`build-check` 16/16、`page-check` 22/22（对 exe 网关）、`smoke --mock --search` 9/9、
浏览器 MCP 实机打开概览/设置页且 console 无 error/warn。

## 7. 已知限制与排障

- **平台限制**：`verify-exe.mjs` 只能运行「当前机器可执行的」产物。musl 产物需 Alpine/musl 环境，
  arm64 需 arm64 机器，macOS 需 macOS；交叉编译产物请用对应平台或 CI 验证（见 §6 的 BLOCKED 说明）。
- **代理**：本脚本不测试出站代理（离线断言优先）。HTTP/HTTPS 代理行为（Bun 原生
  `fetch(url,{proxy})` 路径）另见 `docs/ACCEPTANCE.md` §2.56.7；需要本机代理
  `127.0.0.1:10808` 才能复现 `POST /admin/api/proxy/test` 的通过结果。
- **离线**：不访问真实 duck.ai；聊天/生图的上游链路由 Node 单测与 mock smoke 覆盖，
  exe 内真实上游验收需要可访问 duck.ai 的网络（本沙箱为 `451 ERR_COUNTRY_NOT_SUPPORTED`，BLOCKED）。
- **node 模式**（`--node`）用于脚本自测；在受限沙箱里它比 exe 模式慢，偶发长时间不退出。
  自测时建议外层加超时（PowerShell `Start-Job` + `Wait-Job -Timeout`，或 `timeout 90 node …`），
  验证产物请优先用默认 exe 模式。
- **端口占用**：`EADDRINUSE` 时换 `--port`，或先结束占用 18000–18999 的进程
  （`netstat -ano | findstr :18787`）。
- **首次启动较慢**（约 3–8s）：exe 需要映射内嵌资源并初始化 SQLite/身份（生成 RSA 密钥），属正常。
- **`--keep` 之后**：脚本会打印运行目录；确认不再需要后手动删除 `data/tmp/exe-verify-*`，
  其中的 `data/config.json` 含本次生成的临时 token，不要提交或外传。
- **失败诊断**：脚本会打印子进程日志尾部（`logs/server-*.stdout.log|stderr.log`）；
  常见原因：exe 未构建、`web/` 未内嵌（`--no-assets` 构建）、端口被占用、杀软拦截 exe。
