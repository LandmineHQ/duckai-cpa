# Windows 单文件 exe 构建（windows 分支）

> 最后更新：2026-11-06（windows 分支）
> 相关文件：`scripts/build-exe.mjs`、`package.json`（`build:exe`）、`.github/workflows/build-windows-exe.yml`。

## 1. 分支目的

主分支以「源码 + node_modules」方式分发（Node 24 / Docker 部署）。`windows` 分支在此之外
提供 **Windows x64 单文件可执行程序** `duckai-cpa.exe`：

- 用 Bun 的 `bun build --compile` 把 `src/index.js` 的完整依赖图（含 jsdom、undici、pdf-lib 等）
  编译进一个 exe；
- 用 `--asset` 把管理后台产物 `web/`、默认配置 `config/`、`package.json` 嵌入 exe 的只读虚拟根；
- 目标机器 **不需要安装 Node.js、Bun 或 node_modules**，双击即可启动。

运行时行为与源码模式一致（默认监听 `http://127.0.0.1:8787`，OpenAI 兼容接口 + `/admin` 管理后台），
区别只在资源根：编译版从 exe 内部虚拟根读取 `web/`、`config/`、`package.json`；数据默认写在
**exe 同目录的 `data/`**。

## 2. 依赖

| 依赖 | 版本要求 | 用途 |
| --- | --- | --- |
| Windows x64 构建机 | Windows 10/11 | 构建脚本只支持 `win32`（代码见 `scripts/build-exe.mjs`） |
| Node.js | >= 20，推荐 **24** | 运行构建脚本、执行 `npm run build:web`（Vite + React） |
| npm | 随 Node 提供 | `npm ci` 安装依赖 |
| Bun | **>= 1.4.4** | `bun build --compile`；`--trim` / `--asset` 需要新版（1.3.x 不认识，构建失败） |

> 构建机 ≠ 运行机：运行 exe 的 Windows 机器只需要该 exe 文件本身。

Bun 的定位优先级（`scripts/build-exe.mjs`）：

1. 环境变量 `BUN_BIN`（显式指定，必须 >= 1.4.4，否则直接报错）；
2. 脚本由 Bun 运行时（`bun scripts/build-exe.mjs`）的 `process.execPath`；
3. `PATH` 里的 `bun`（Windows 为 `bun.exe`）。

## 3. 构建步骤

### 3.1 本地构建

```powershell
git checkout windows
npm ci
npm run build:web            # 构建管理后台 → web/

# 可选：PATH 里的 bun 低于 1.4.4 时，指向新版 Bun
$env:BUN_BIN = "C:\Tools\bun-1.4.4\bun.exe"

npm run build:exe            # 等价于 node scripts/build-exe.mjs
```

若 `web/` 已构建过，可以跳过重复构建：

```powershell
node scripts/build-exe.mjs --skip-web-build
```

构建脚本依次执行 4 步：

1. **检查构建环境**：平台必须为 `win32`；定位 Bun 并校验 `--version >= 1.4.4`；
   读取 `package.json` 版本并换算 Windows 4 段版本号（如 `0.1.0` → `0.1.0.0`）。
2. **检查管理后台产物**：`web/index.html` 不存在时自动执行 `npm run build:web`
   （`--skip-web-build` 跳过、`--force-web-build` 强制重建）。
3. **幂等应用 node_modules 补丁**：把 `node_modules/css-tree/lib/data-patch.js`、
   `node_modules/css-tree/lib/version.js` 从 `createRequire(import.meta.url)` 形式改为
   `import ... with { type: 'json' }`。原因：Bun 打包成 exe 后无法在运行时解析 `require` 的
   JSON 模块。只改本地 `node_modules`（不入库），内容已正确时跳过并打印提示。
4. **编译并校验**：执行

   ```
   bun build src/index.js --compile --trim --target=bun-windows-x64 \
     --asset=web --asset=config --asset=package.json \
     --outfile=dist/windows-x64/duckai-cpa.exe \
     --windows-title "DuckAI CPA" --windows-publisher "duckai-cpa" \
     --windows-version 0.1.0.0 --windows-description "DuckAI CPA - OpenAI-compatible gateway for Duck.ai"
   ```

   保留控制台（不带 `--windows-hide-console`），因为首次启动需要打印 adminToken 与 API Key；
   最后校验产物存在并打印路径、大小、耗时。

### 3.2 构建脚本参数

| 参数 | 说明 |
| --- | --- |
| `--skip-web-build` | 跳过 `web/` 检查（CI 中已单独 `npm run build:web`） |
| `--force-web-build` | 强制重新执行 `npm run build:web` |
| `--skip-trim` | 不传 `--trim`（产物明显变大，仅排障用） |
| `--no-assets` | 不嵌入 `web/`、`config/`、`package.json`（仅调试用，exe 缺少管理后台/默认配置） |
| `--outfile=<path>` | 自定义输出路径（默认 `dist/windows-x64/duckai-cpa.exe`） |
| `-h, --help` | 显示帮助 |

通过 npm 透传参数：`npm run build:exe -- --force-web-build`。

### 3.3 CI 手动构建

`.github/workflows/build-windows-exe.yml` 只支持 **手动触发**（`workflow_dispatch`，不配置 push）：

1. `actions/checkout@v4`；
2. `actions/setup-node@v4`（Node 24，`cache: npm`）；
3. `oven-sh/setup-bun@v2`（`bun-version: "1.4.4"`）；
4. `npm ci` → `npm run build:web` → `node scripts/build-exe.mjs --skip-web-build`；
5. 生成 `dist/windows-x64/RUN-README.txt`，与 exe 一起上传 artifact
   `duckai-cpa-windows-x64`（保留 30 天）。

使用方式：GitHub → Actions → `build-windows-exe` → Run workflow。

## 4. 产物位置

```
dist/windows-x64/duckai-cpa.exe     # ~148–150 MB，单文件
```

`dist/` 已在 `.gitignore` 中忽略，不会入库。压缩后体积变化不大（Bun 运行时与依赖占主要部分），
分发时建议直接发 exe 或打 zip。

## 5. 运行方式

1. 把 `duckai-cpa.exe` 放到一个**可写目录**（不要放 `C:\Program Files`，首次启动要写 `data/`）；
2. 双击 exe（或在 PowerShell 里执行 `.\duckai-cpa.exe`）；
3. 首次启动会：
   - 从内嵌的 `config/config.example.json` 生成运行时配置 `data/config.json`（Windows 下权限受限，
     含 adminToken 与 API keys，不要外传）；
   - 生成 adminToken 并打印到控制台；
   - 创建默认 API Key 并打印一次；
   - 启动 HTTP 服务。
4. 管理后台：<http://127.0.0.1:8787/admin/>
5. OpenAI 兼容接口：<http://127.0.0.1:8787/v1>（Bearer API Key 鉴权）

程序运行期间请勿关闭控制台窗口；`Ctrl+C` 或直接关窗口即停止。默认数据目录是 exe 同目录的
`data/`，exe 移动位置后请把 `data/` 一起带走，或通过 `DUCKAI_CPA_DATA_DIR` 指定固定目录。

## 6. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DUCKAI_CPA_DATA_DIR` | `<exe 同目录>\data` | 数据目录（config、SQLite、身份、日志等） |
| `DUCKAI_CPA_CONFIG_PATH` | `<数据目录>\config.json` | 运行时配置文件路径 |
| `DUCKAI_CPA_HOST` | `127.0.0.1` | 监听地址（局域网访问可设 `0.0.0.0`，注意鉴权） |
| `DUCKAI_CPA_PORT` | `8787` | 监听端口 |
| `DUCKAI_CPA_ADMIN_TOKEN` | 首次启动随机生成 | 覆盖管理后台 token |

相对路径按 **exe 所在目录**解析（源码模式运行时按仓库根解析）。例如：

```powershell
$env:DUCKAI_CPA_DATA_DIR = "D:\duckai-cpa-data"
$env:DUCKAI_CPA_PORT = "8788"
.\duckai-cpa.exe
```

## 7. `--trim` / `--asset` 说明

- `--trim`（Bun >= 1.4.4）：Bun 的「裁剪未使用的 Bun/Node API」开关，理论上可缩小单文件体积。
  **本项目实测收效很小**：完整性导入图约 **1630 个模块**，开启 `--trim` 与不开启的产物都约
  **148.7 MB**（差值约 0.5 KB）——因为体积主要来自 Bun 运行时与 jsdom/undici/pdf-lib 等依赖，
  而网关几乎用满了文件系统、HTTP、crypto 等内置能力，可裁剪项很少。构建脚本默认仍开启
  `--trim`（Bun 后续版本可能改进），`--skip-trim` 仅用于排查「某内置模块被动态使用时是否被误裁」。
- `--asset=<文件或目录>`：把文件/目录按相对路径嵌入 exe 的只读虚拟根 `B:\~BUN\root\`，
  运行时 `node:fs` 与 `Bun.file` 都能读取。本项目嵌入：
  - `web/`：管理后台静态产物（Vite 构建结果）；
  - `config/`：默认配置模板 `config.example.json`；
  - `package.json`：版本号、描述等元数据（`getPackageMeta()` 使用）。

  因此 exe 分发时**不需要**携带 `web/`、`config/`；但 `data/` 必须是外部真实可写目录。
  如果以后新增「运行时必须从磁盘读取的资源」，需要在 `scripts/build-exe.mjs` 的 `--asset` 列表中补上。

## 8. 已知限制

- **体积**：单文件约 148–150 MB（Bun 运行时 + jsdom/undici/pdf-lib 等依赖）。首次启动需要把
  内嵌资源映射/解压，启动速度比源码模式慢，属正常现象。
- **未签名**：没有代码签名证书，Windows SmartScreen 可能拦截：点「更多信息 → 仍要运行」。
  企业环境可能被 AppLocker/杀软策略直接阻断。
- **杀软误报**：单文件自解压型 exe 容易被启发式扫描误报，可加白名单或自行签名。
- **无图标**：构建未传 `--windows-icon`，文件/任务栏显示默认 Bun 图标。
- **仅 Windows x64**：`--target=bun-windows-x64`，不支持 arm64 / 32 位；构建也必须在 Windows 上进行
  （脚本有平台校验，不做 Linux 交叉编译）。
- **node_modules 补丁不随仓库分发**：`npm ci` 后需要重新打补丁，构建脚本会自动完成；不要提交
  `node_modules/`，也不要手工改完就以为别的机器也能构建。
- **exe 元数据版本**取自 `package.json`（`0.1.0` → `0.1.0.0`），只影响文件属性显示，与运行无关；
  发版前确认版本号再构建。

## 9. 排障

### 9.1 `bun build` 报 EPERM / `Cannot read file "C:\Users\<user>": EPERM`

老版本 Bun（1.3.x）在受限环境或沙箱下会把用户 home 当作缓存路径，被拒绝后报 EPERM；
同时 1.3.x **不支持** `--trim` / `--asset`，即使能启动也无法用于本项目。处理：

```powershell
bun --version                        # 必须 >= 1.4.4
$env:BUN_BIN = "C:\path\to\bun-1.4.4\bun.exe"   # 或升级 PATH 里的 bun
node scripts/build-exe.mjs
```

### 9.2 构建成功但 `/admin/` 404 / 页面白屏

`web/` 未构建或构建失败，exe 里没有管理后台资源。先 `npm run build:web`，确认
`web/index.html` 存在后再重新构建 exe；不要用 `--skip-web-build` 掩盖问题。

### 9.3 端口被占用（`EADDRINUSE`）

```powershell
netstat -ano | findstr :8787
# 结束占用进程，或换端口：
$env:DUCKAI_CPA_PORT = "8788"
.\duckai-cpa.exe
```

### 9.4 首次启动写 `data/` 失败 / 权限错误

exe 所在目录不可写（如 Program Files、只读共享盘）。把 exe 移到用户目录，或指定可写数据目录：

```powershell
$env:DUCKAI_CPA_DATA_DIR = "D:\duckai-cpa-data"
.\duckai-cpa.exe
```

### 9.5 exe 双击闪退 / 看不到报错

在 PowerShell 中前台运行以保留控制台输出：

```powershell
cd <exe 所在目录>
.\duckai-cpa.exe
```

### 9.6 手工 `bun build` 后 exe 运行时报模块找不到

未执行构建脚本的 css-tree 补丁。直接使用 `node scripts/build-exe.mjs`（或 `npm run build:exe`）
构建，脚本会自动幂等打补丁。

### 9.7 构建日志与验证

```powershell
Get-Item dist/windows-x64/duckai-cpa.exe | Select-Object Length, LastWriteTime
.\dist\windows-x64\duckai-cpa.exe          # 首次启动：记录 adminToken / API Key
Invoke-RestMethod http://127.0.0.1:8787/healthz
```

## 10. 验证清单（构建后自检）

- [ ] `node scripts/build-exe.mjs` 退出码为 0，打印 `构建成功。`；
- [ ] `dist/windows-x64/duckai-cpa.exe` 存在且约 148–150 MB；
- [ ] 双击/前台运行 exe，控制台打印 adminToken 与默认 API Key；
- [ ] `http://127.0.0.1:8787/admin/` 可打开登录页；
- [ ] `http://127.0.0.1:8787/healthz` 返回 200；
- [ ] `data/config.json` 生成在 exe 同目录 `data/` 下，且包含生成的 adminToken。

## 11. 相关文件

| 文件 | 作用 |
| --- | --- |
| `scripts/build-exe.mjs` | 构建脚本（Bun 定位/版本校验、web 构建、node_modules 补丁、`bun build`、产物校验） |
| `package.json` → `scripts.build:exe` | `node scripts/build-exe.mjs` |
| `.github/workflows/build-windows-exe.yml` | 手动 CI：windows-latest 构建并上传 artifact |
| `.gitignore` | 已忽略 `dist/`、`web/`、`data/` |
| `src/platform.js` | exe 模式下的资源根 / 默认数据目录判定 |
| `docs/ACCEPTANCE.md` | 验收记录（由 Lead/QA 维护） |
