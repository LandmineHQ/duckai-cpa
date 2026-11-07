# 多平台单文件二进制构建（Windows / Linux / macOS）

> 最后更新：2026-11-06（`platform-binaries` 分支，基于 `windows` 分支）
> 相关文件：`scripts/build-exe.mjs`、`package.json`（`build:bin`）、`Dockerfile`、
> `.github/workflows/build-binaries.yml`、`.github/workflows/build-docker-image.yml`。

## 1. 分支目的

main 分支以「源码 + node_modules」方式分发（Node 24 / Docker 部署）。`windows` 分支先提供了
Windows 单文件 exe；`platform-binaries` 分支把它扩展为 **多平台单文件二进制**：

| 目标 | Bun target | 产物 | 运行环境 |
| --- | --- | --- | --- |
| Windows x64 | `bun-windows-x64` | `duckai-cpa.exe` | Windows 10/11 x64 |
| Linux x64（glibc） | `bun-linux-x64` | `duckai-cpa` | Debian/Ubuntu 等 glibc 系统 |
| Linux arm64（glibc） | `bun-linux-arm64` | `duckai-cpa` | ARM64 Linux（glibc） |
| Linux x64（musl） | `bun-linux-x64-musl` | `duckai-cpa` | **Alpine / 极简 Docker 镜像** |
| Linux arm64（musl） | `bun-linux-arm64-musl` | `duckai-cpa` | ARM64 Alpine |
| macOS x64（Intel） | `bun-darwin-x64` | `duckai-cpa` | macOS（Intel） |
| macOS arm64（Apple Silicon） | `bun-darwin-arm64` | `duckai-cpa` | macOS（M 系列） |

- 用 Bun `bun build --compile` 把 `src/index.js` 的完整依赖图（含 jsdom、undici、pdf-lib 等）编译进一个文件；
- 用 `--asset` 把管理后台产物 `web/`、默认配置 `config/`、`package.json` 嵌入二进制的只读虚拟根
  （Windows `B:\~BUN\root\`，Linux/macOS `/$bunfs/root`）；
- 目标机器 **不需要安装 Node.js、Bun 或 node_modules**，双击/`./duckai-cpa` 即可启动；
- 运行时数据默认写到 **二进制同目录的 `data/`**（便携模式），可用 `DUCKAI_CPA_DATA_DIR` 覆盖。

## 2. 依赖

| 依赖 | 版本要求 | 用途 |
| --- | --- | --- |
| 构建机 | Windows / Linux / macOS | 默认目标=构建机；跨平台目标会自动下载对应 Bun 运行时 |
| Node.js | >= 20，推荐 **24** | 运行构建脚本、执行 `npm run build:web`（Vite + React） |
| npm | 随 Node 提供 | `npm ci` 安装依赖 |
| Bun | **>= 1.4.4** | `bun build --compile`；`--trim` / `--asset` 需要新版（1.3.x 不支持） |

> 构建机 ≠ 运行机：目标机只需要二进制本身。跨平台编译（如 Windows 上构建 Linux/macOS 产物）
> 需要网络让 Bun 下载对应运行时；产物**不能在本机运行**，需在目标平台或 CI 验证。

Bun 的定位优先级（`scripts/build-exe.mjs`）：

1. 环境变量 `BUN_BIN`（显式指定，必须 >= 1.4.4，否则直接报错）；
2. 脚本由 Bun 运行时（`bun scripts/build-exe.mjs`）的 `process.execPath`；
3. `PATH` 里的 `bun` / `bun.exe`。

## 3. 构建步骤

### 3.1 本地构建

```powershell
# Windows（PowerShell）
npm ci
npm run build:web
node scripts/build-exe.mjs                 # 默认 Windows x64 → dist/windows-x64/duckai-cpa.exe
node scripts/build-exe.mjs --target=bun-linux-x64        # 交叉编译 Linux glibc
node scripts/build-exe.mjs --target=bun-linux-x64-musl   # Alpine/Docker 用
```

```bash
# Linux / macOS
npm ci
npm run build:web
node scripts/build-exe.mjs                 # 默认本机目标
node scripts/build-exe.mjs --target=bun-linux-x64-musl
node scripts/build-exe.mjs --target=bun-darwin-arm64
```

若 `web/` 已构建过，可跳过重复构建：

```bash
node scripts/build-exe.mjs --skip-web-build --target=bun-linux-x64
```

构建脚本依次执行 4 步：

1. **检查构建环境**：解析/校验 `--target`（默认=构建机）；定位 Bun 并校验 `>= 1.4.4`；
   跨平台构建会打印警告；Windows 目标额外换算 `package.json` 版本的 4 段版本号。
2. **检查管理后台产物**：`web/index.html` 不存在时自动执行 `npm run build:web`
   （`--skip-web-build` 跳过、`--force-web-build` 强制重建）。
3. **应用 node_modules 补丁（幂等，跨机器/跨平台必需）**：
   - `css-tree/lib/data-patch.js`、`version.js`：`createRequire` → 静态 JSON import；
   - `css-tree/lib/data.js`：mdn-data 三个 JSON → 静态 JSON import；
   - `jsdom/.../computed-style.js`：内联 `default-stylesheet.css`（Bun 会把 CJS `__dirname`
     固化为**构建机绝对路径**，换机器运行会 ENOENT）；
   - `jsdom/.../XMLHttpRequest-impl.js`：`require.resolve` 同步 XHR worker 改为懒解析
     （同上，避免启动即报构建机路径找不到）。
4. **编译并校验**：执行 `bun build ... --compile --trim --target=<target> --asset=web --asset=config
   --asset=package.json --outfile=<dist>/duckai-cpa[.exe]`，校验文件头（PE/ELF/Mach-O），
   生成同目录 `RUN-README.txt`（运行方式/数据目录/管理后台地址）。

> 补丁只改本地 `node_modules`（不入库）。`npm ci` 后重新构建时脚本会自动再打补丁。

### 3.2 构建脚本参数

| 参数 | 说明 |
| --- | --- |
| `--target=<bun-target>` | 目标（默认=当前构建机）；见 §1 表格 |
| `--skip-web-build` | 跳过 `web/` 检查（CI/多目标构建时只构建一次 web） |
| `--force-web-build` | 强制重新执行 `npm run build:web` |
| `--skip-trim` | 不传 `--trim`（产物更大，仅排障用） |
| `--no-assets` | 不嵌入 `web/`、`config/`、`package.json`（仅调试用） |
| `--outfile=<path>` | 自定义输出路径（默认 `dist/<target>/duckai-cpa[.exe]`） |
| `-h, --help` | 显示帮助 |

`package.json` 还提供 `build:bin` 与各平台快捷脚本（`build:linux-x64`、`build:linux-x64-musl`、
`build:darwin-x64`、`build:darwin-arm64`、`build:linux-arm64`）。

### 3.3 CI 手动构建

`.github/workflows/build-binaries.yml`（仅 `workflow_dispatch`）用 matrix 在原生 runner 上构建并冒烟：

| job | runner | target | 本机冒烟 |
| --- | --- | --- | --- |
| windows-x64 | `windows-latest` | `bun-windows-x64` | `verify-exe.mjs` |
| linux-x64 | `ubuntu-latest` | `bun-linux-x64` | `verify-exe.mjs` |
| linux-x64-musl | `ubuntu-latest` | `bun-linux-x64-musl` | 只校验 ELF（glibc runner 不能跑 musl） |
| darwin-x64 | `macos-13` | `bun-darwin-x64` | `verify-exe.mjs` |
| darwin-arm64 | `macos-14` | `bun-darwin-arm64` | `verify-exe.mjs` |

`.github/workflows/build-docker-image.yml`（仅 `workflow_dispatch`）构建 `Dockerfile`、
启动容器做 HTTP 冒烟（`/healthz`、`/admin/`、`/admin/api/overview`、`/v1/models`）并输出镜像大小。

发布（均仅手动触发）：

- `.github/workflows/publish-binaries.yml`：原生矩阵构建全部平台 → 打包为
  `duckai-cpa-<platform>.zip|tar.gz` → 创建/更新 GitHub Release（非 prerelease 即成为
  `/releases/latest`，README Option B 的下载入口）。
- `.github/workflows/publish-docker-image.yml`：构建 `Dockerfile` 并推送极简镜像到 GHCR
  （`:version`，可选 `:latest`；README Option A 的镜像来源）。

## 4. 产物位置

```
dist/
├─ windows-x64/duckai-cpa.exe
├─ linux-x64/duckai-cpa
├─ linux-arm64/duckai-cpa
├─ linux-x64-musl/duckai-cpa
├─ linux-arm64-musl/duckai-cpa
├─ darwin-x64/duckai-cpa
└─ darwin-arm64/duckai-cpa
```

每个目录都有 `RUN-README.txt`。`dist/` 已在 `.gitignore` 中忽略，不会入库。
参考大小（Bun 1.4.4，`--trim` 开启）：Windows 148.7 MB、Linux glibc 142.5 MB、Linux musl 136.1 MB、
macOS 122.8–131.6 MB；gzip 压缩后约 52–56 MB。

## 5. 运行方式

### 5.1 直接运行二进制

**下载（推荐）**：到 [GitHub Releases 最新页](https://github.com/LandmineHQ/duckai-cpa/releases/latest)
下载对应平台压缩包（`duckai-cpa-<platform>.zip|tar.gz`），无需构建。发布由
`.github/workflows/publish-binaries.yml` 手动完成（见 §3.3）。

1. 把二进制放到一个**可写目录**（不要放 `C:\Program Files`、只读挂载点）；
2. 运行：
   - Windows：双击 `duckai-cpa.exe`（控制台窗口常驻前台，首次启动打印 adminToken/API Key）；
   - Linux/macOS：`chmod +x duckai-cpa && ./duckai-cpa`；
   - 后台运行：`nohup ./duckai-cpa >duckai-cpa.log 2>&1 &`（或用 systemd）。
3. 首次启动会：
   - 从内嵌的 `config/config.example.json` 生成运行时配置 `data/config.json`；
   - 生成 adminToken 并打印到控制台；
   - 创建默认 API Key 并打印一次；
   - 启动 HTTP 服务。
4. 管理后台：<http://127.0.0.1:8787/admin/>；OpenAI 兼容接口：<http://127.0.0.1:8787/v1>。

默认数据目录是二进制同目录的 `data/`；二进制移动位置后请把 `data/` 一起带走，或通过
`DUCKAI_CPA_DATA_DIR` 指定固定目录。数据目录包含 adminToken / API Key，请勿提交或外传。

### 5.2 极简 Docker 镜像（推荐用于服务器）

**推荐直接使用 GHCR 预构建镜像**（无需克隆源码/构建；发布见 §3.3 的 `publish-docker-image`）：

```bash
docker run -d --name duckai-cpa -p 8787:8787 \
  -v duckai-cpa-data:/data \
  -e DUCKAI_CPA_ADMIN_TOKEN=replace-with-a-strong-token \
  ghcr.io/landminehq/duckai-cpa:latest
# 或仓库内 compose（同一镜像）
docker compose -f docker-compose.ghcr.yml up -d
```

镜像实现：`Dockerfile` 多阶段构建，运行层只有 Alpine + 单文件 musl 二进制（无 Node.js、无 node_modules）。
开发者本地构建：

```bash
docker build -f Dockerfile -t duckai-cpa:binary .
# 或
docker compose up -d --build
```

| 项目 | 说明 |
| --- | --- |
| 基础镜像 | `alpine:3.20` |
| 运行层依赖 | `ca-certificates`（HTTPS 必备）+ `libstdc++`（Bun musl 运行时依赖） |
| 镜像体积 | 未压缩 ≈ **150 MB**、gzip 压缩后 ≈ **56 MB**（Bun 运行时占主体） |
| 数据卷 | `/data`（`DUCKAI_CPA_DATA_DIR=/data`），非 root 用户 `duckai`（UID 10001） |
| 中文 PDF | 默认不装字体；需要上下文 PDF 中文时加 `--build-arg INSTALL_CJK_FONTS=true`（+16 MB） |
| 健康检查 | `wget -q -O /dev/null http://127.0.0.1:8787/healthz` |

> 「最精简」的上限由 Bun 单文件二进制决定（musl 二进制约 136 MB，压缩后 51.6 MB）；
> 镜像能省掉 Node 运行时和 node_modules，但不会是几 MB 级别。若需要更小，只能等 Bun 运行时瘦身
> 或改用非单文件方案（如裁剪 Bun/JSC 的自定义构建，维护成本高，未纳入本分支）。

## 6. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DUCKAI_CPA_DATA_DIR` | `<二进制同目录>/data` | 数据目录（config、SQLite、身份、日志等） |
| `DUCKAI_CPA_CONFIG_PATH` | `<数据目录>/config.json` | 运行时配置文件路径 |
| `DUCKAI_CPA_HOST` | `127.0.0.1` | 监听地址（容器/局域网用 `0.0.0.0`，注意鉴权） |
| `DUCKAI_CPA_PORT` | `8787` | 监听端口 |
| `DUCKAI_CPA_ADMIN_TOKEN` | 首次启动随机生成 | 覆盖管理后台 token |
| `DUCKAI_CPA_VERSION` | 构建时 package.json | 展示用版本号（Dockerfile 里由 `APP_VERSION` 写入） |

相对路径按**二进制所在目录**解析（源码模式运行时按仓库根解析）。例如：

```bash
DUCKAI_CPA_DATA_DIR=/var/lib/duckai-cpa DUCKAI_CPA_PORT=8788 ./duckai-cpa
```

## 7. `--trim` / `--asset` 说明

- `--trim`（Bun >= 1.4.4）：Bun 的「裁剪未使用的 Bun/Node API」开关，理论上可缩小单文件体积。
  **本项目实测收效很小**：完整导入图约 **1630 个模块**，开启/不开启的产物都约
  136–149 MB（差约 0.5 KB）——体积主要来自 Bun 运行时与 jsdom/undici/pdf-lib 等依赖。
  构建脚本默认仍开启（Bun 后续版本可能改进），`--skip-trim` 仅用于排查误裁。
- `--asset=<文件或目录>`：把文件/目录按相对路径嵌入二进制的只读虚拟根，
  运行时 `node:fs` 与 `Bun.file` 都能读取。本项目嵌入 `web/`、`config/`、`package.json`。
  因此分发时**不需要**携带 `web/`、`config/`；但 `data/` 必须是外部真实可写目录。
  以后新增「运行时必须从磁盘读取的资源」时，要在构建脚本的 `--asset` 列表里补上，
  并确保没有依赖构建机路径（见 §3.1 的 node_modules 补丁）。

### 7.1 代理在 Bun / 二进制下的行为（重要）

- **HTTP / HTTPS 代理**：Bun 运行时（含编译后的二进制）下，undici 的 `ProxyAgent` 连接行为异常
  （CONNECT/TLS 不一致，实测 `ECONNRESET` / timeout）。`src/duck/proxy.js` 已做运行时切换：
  Bun 下改用 **Bun 原生 `fetch(url, { proxy })`**，Node 源码模式仍使用 undici。
- 实测（编译产物 + `127.0.0.1:10808` HTTP 代理）：`POST /admin/api/proxy/test` → HTTP 200 /
  出口 IP 正；`/healthz` → `upstream.ok=true`；`/v1/chat/completions` 非流式与流式均 200。
- **SOCKS4/SOCKS5** 在 Bun 下仍走 undici + `node:net/tls`，未验证可靠性；异常时请改用 HTTP/HTTPS 代理。
- `noProxy` 规则（精确/后缀/通配）在两条路径上都生效；代理配置保存后立即生效、无需重启。

## 8. 已知限制

- **体积**：单文件约 **123–149 MB**（Bun 运行时 + jsdom/undici/pdf-lib 等依赖）；gzip 后约 52–56 MB。
  启动时要映射内嵌资源，首次启动约 3–8s（含身份 RSA 生成），属正常。
- **平台**：未做 Windows 图标、代码签名、macOS 公证；Windows SmartScreen / macOS Gatekeeper
  可能拦截（Windows「更多信息→仍要运行」；macOS 右键打开或 `xattr -d com.apple.quarantine`）。
- **交叉编译**：跨平台产物无法在构建机运行，必须用目标平台/CI 验证；Bun 会下载对应运行时
  （本机可能在仓库根生成 `.bun-cache/`，已忽略，可删）。
- **运行库**：Linux glibc 目标需要 glibc；Alpine 必须用 musl 目标。macOS 产物为未签名 Mach-O。
- **node_modules 补丁不随仓库分发**：`npm ci` 后需要重新打补丁，构建脚本会自动完成。
- **Bun 内联 `__dirname`**：Bun 会把 CJS 依赖里的 `__dirname` 固化成构建机路径；本分支已修补
  已知的 jsdom / css-tree 读取点（§3.1 第 3 步）。若升级 jsdom/css-tree 后构建/启动报
  “Cannot find … from <构建机路径>”，需要更新构建脚本里的补丁。
- **Docker 镜像**：未做镜像签名/多架构 manifest（arm64 镜像可基于 `bun-linux-arm64-musl` 自行构建）。

## 9. 排障

### 9.1 启动报 `Cannot find module/package '<构建机绝对路径>'`

Bun 把 CJS `__dirname`/`require.resolve` 固化成构建机路径（典型：jsdom、css-tree）。
确认用 `node scripts/build-exe.mjs` 构建（会自动打补丁），不要手工 `bun build`。
升级 jsdom/css-tree 后若补丁匹配失败，脚本会报错并指明文件，更新补丁后重试。

### 9.2 `bun build` 报 EPERM / `Cannot read file "C:\Users\<user>": EPERM`

老版本 Bun（1.3.x）在受限环境/沙箱下会以 home 为缓存并报 EPERM，且不支持 `--trim`/`--asset`。
升级到 Bun >= 1.4.4，或用 `BUN_BIN` 指向新版。

### 9.3 构建成功但 `/admin/` 404 / 页面白屏

`web/` 未构建或未嵌入。先 `npm run build:web` 并确认 `web/index.html` 存在；不要用
`--skip-web-build` 掩盖问题。二进制模式下 `web/` 来自 `--asset`。

### 9.4 端口被占用（`EADDRINUSE`）

```bash
ss -ltnp | grep 8787              # Linux
lsof -i :8787                     # macOS
netstat -ano | findstr :8787      # Windows
DUCKAI_CPA_PORT=8788 ./duckai-cpa
```

### 9.5 首次启动写 `data/` 失败 / 权限错误

二进制所在目录不可写（Program Files、只读挂载、容器内非 root）。移动到可写目录，
或设置 `DUCKAI_CPA_DATA_DIR` 到可写路径；Docker 用 `/data` 卷。

### 9.6 双击闪退 / 看不到报错

Windows 用 PowerShell 前台运行；Linux/macOS 在终端运行，或查看 `nohup` 日志。

### 9.7 构建日志与验证

```bash
node scripts/build-exe.mjs --target=bun-linux-x64 --skip-web-build
file dist/linux-x64/duckai-cpa                    # ELF 校验
node scripts/verify-exe.mjs --exe dist/linux-x64/duckai-cpa   # 本平台 HTTP 冒烟（原生 runner）
```

产物无法在本机运行时（musl/arm64/macOS 交叉编译），用 CI 或目标机器验证；
Docker 镜像用 `build-docker-image.yml` / `docker-compose.yml` 验证。

## 10. 验证清单（构建后自检）

- [ ] `node scripts/build-exe.mjs --target=<target>` 退出码 0，打印 `构建成功。`；
- [ ] `file dist/<target>/duckai-cpa[.exe]` 是 PE / ELF / Mach-O；
- [ ] 目标平台运行后控制台打印 adminToken 与默认 API Key；
- [ ] `http://127.0.0.1:8787/admin/` 可打开，`/healthz` 200；
- [ ] 数据目录生成 `config.json` + `duckai.db`，重启后 adminToken 不变；
- [ ] 代理场景：`POST /admin/api/proxy/test` 通过（HTTP/HTTPS 代理）。

## 11. 相关文件

| 文件 | 作用 |
| --- | --- |
| `scripts/build-exe.mjs` | 多平台构建脚本（目标解析/Bun 校验/web/node_modules 补丁/`bun build`/产物校验/RUN-README） |
| `package.json` | `build:bin` + 各平台快捷脚本 |
| `src/platform.js` | 编译态资源根 / 默认数据目录判定（Windows `~BUN`、POSIX `$bunfs`） |
| `src/platform/sqlite-bun.js` | Bun 无 `node:sqlite` 时的 `bun:sqlite` 兼容层 |
| `Dockerfile` / `docker-compose.yml` | Alpine + musl 二进制的极简镜像（本地构建）；`docker-compose.ghcr.yml` 用 GHCR 预构建镜像 |
| `.github/workflows/build-binaries.yml` | 多平台二进制 CI（原生 runner + 冒烟 + artifact） |
| `.github/workflows/publish-binaries.yml` | 手动构建并发布二进制到 GitHub Release（`/releases/latest` 下载入口） |
| `.github/workflows/build-docker-image.yml` | 极简镜像 CI（构建 + 容器 HTTP 冒烟 + 体积） |
| `.github/workflows/publish-docker-image.yml` | 手动发布极简镜像到 GHCR（唯一镜像发布入口，替代旧 Node 镜像流水线） |
| `docs/BINARY-VERIFICATION.md` | 二进制端到端验证脚本与记录 |
| `docs/ACCEPTANCE.md` | 验收记录（§2.56/§2.57） |
