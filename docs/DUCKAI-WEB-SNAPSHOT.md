# duck.ai Web 源码快照与更新检查

> 目标：把当前部署的 duck.ai 前端静态资源抓取到 **本地** `recon/duckai-web/`，
> 用于人工 diff / 版本变化判断。`recon/` 已在 `.gitignore` 中，**不会提交到仓库**。

## 为什么不在仓库里追踪

- duck.ai 前端是第三方版权内容，不适合作为源码 vendoring 提交；
- bundle 体积大且频繁变化，会污染 git 历史；
- 我们只需要“当前部署版本”的本地基准，用于协议分析/升级检查。

因此：

```text
recon/duckai-web/        ← 本地快照（gitignored）
scripts/pull-duck-web.mjs
scripts/compare-duck-web.mjs
```

## 抓取

```bash
npm run recon:pull
```

默认：

```text
入口:     https://duck.ai/
输出:     recon/duckai-web/
manifest: recon/duckai-web/manifest.json
```

需要代理时（推荐，duck.ai 在部分网络下会 451）：

```bash
npm run recon:pull -- --proxy=http://127.0.0.1:10808
```

或者使用环境变量（Windows npm 对 CLI 参数转发较严格，环境变量更稳）：

```powershell
$env:DUCKAI_RECON_PROXY = "http://127.0.0.1:10808"
npm run recon:pull
```

### 抓取内容

从 `https://duck.ai/` HTML 开始递归同源：

- `<script src>` / `<link href>` / `modulepreload`；
- JS 静态/动态 `import`；
- CSS `url(...)` 资源；
- `sourceMappingURL`（如存在）；
- 入口 HTML。

默认最多 **500 个资源**、单资源 **50 MB**、请求间隔 100ms。

### 常用选项

```bash
node scripts/pull-duck-web.mjs --base-url=https://duck.ai/
node scripts/pull-duck-web.mjs --out=recon/duckai-web --proxy=http://127.0.0.1:10808
node scripts/pull-duck-web.mjs --include-external
node scripts/pull-duck-web.mjs --max-assets=1000 --delay-ms=200
```

| 选项 | 说明 |
| --- | --- |
| `--proxy=<url>` | 代理；也可用 `DUCKAI_RECON_PROXY` / `HTTPS_PROXY` |
| `--no-proxy` | 忽略环境代理 |
| `--out=<dir>` | 快照目录 |
| `--base-url=<url>` | 入口地址 |
| `--max-assets=<n>` | 资源上限 |
| `--max-bytes=<n>` | 单资源大小上限 |
| `--delay-ms=<n>` | 请求间隔 |
| `--include-external` | 同时抓第三方域名（默认只抓同源） |
| `--tolerant` | 资源失败继续（HTML 失败仍中止） |

## 比对

```bash
npm run recon:diff
```

行为：

1. 读取 `recon/duckai-web/manifest.json`；
2. 在不写盘的情况下重新抓取线上快照；
3. 比较 HTML/资源 sha256：
   - `version` 是否变化；
   - `changed` / `added` / `removed`；
4. 完全一致 → exit 0；有差异或 baseline 缺失 → exit 1。

输出示例：

```text
baseline: recon/duckai-web/manifest.json (...)
live:     2026-11-11T...
version:  v1 -> v2  CHANGED
status:   DIFFERENT

changed: 4
  ~ https://duck.ai/assets/...
added: 0
removed: 0

[recon] run `npm run recon:pull` to update the local snapshot
```

JSON 输出：

```bash
npm run recon:diff -- --json
```

需要代理/自定义入口时建议直接运行：

```bash
node scripts/compare-duck-web.mjs --proxy=http://127.0.0.1:10808
```

## 维护建议

- 每次协议分析前先 `recon:diff`；有变化再 `recon:pull`；
- 在 CI 中不要运行真实抓取（网络/版权/稳定性），仅在本地或维护者机器运行；
- `manifest.json` 里记录 `fetchedAt`、`version`、每个资源 sha256，可用于人工核对；
- 不要把 `recon/duckai-web/` 复制进 `docs/` 或提交到 Git。
