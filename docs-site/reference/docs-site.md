# 文档站部署

本站使用 **VitePress + Markdown + 自定义主题**，通过 GitHub Actions 构建并发布到 GitHub Pages。

## 本地开发

```bash
cd docs-site
npm install
npm run dev
```

默认开发地址：`http://localhost:5173/duckai-cpa/`。

构建：

```bash
npm run build
npm run preview
```

## 目录

```text
docs-site/
  .vitepress/
    config.mts          # 导航、侧边栏、搜索、base
    theme/
      index.js          # 扩展默认主题
      custom.css        # 后台同款橙色/奶油色主题
      components/       # 首页自定义组件
  guide/                # 安装、使用、功能、FAQ
  api/                  # API 文档
  reference/            # 配置、架构、安全
  public/               # logo、截图等静态资源
```

## GitHub Pages

工作流：

```text
.github/workflows/deploy-docs.yml
```

触发：

- push 到 `main`，且修改了 `docs-site/**`；
- 手动 `workflow_dispatch`。

发布地址（项目站点）：

```text
https://landminehq.github.io/duckai-cpa/
```

### 仓库设置

打开：

```text
Settings → Pages → Build and deployment
```

把 **Source** 设为 **GitHub Actions**。

工作流使用：

- `actions/configure-pages`
- `actions/upload-pages-artifact`
- `actions/deploy-pages`
- 权限：`pages: write`、`id-token: write`

### 自定义域名

如果使用自定义域名，设置：

```text
DOCS_BASE=/
```

或在 workflow 中把构建环境变量 `DOCS_BASE` 改为 `/`，并配置 Pages 自定义域名。

## 主题

`docs-site/.vitepress/theme/custom.css` 通过覆盖 VitePress CSS 变量匹配后台：

- 主色：`#f97316`（orange-500）；
- 浅色背景：奶油色 `#fffaf5`；
- 深色背景：`#14100d`；
- 卡片圆角、橙色边框、hero 渐变。

组件：

- `HomeHighlights.vue`：首页指标、能力卡、快速开始、截图；
- `VersionBadge.vue`：版本徽章。

## 内容维护

- 新增指南页：`docs-site/guide/*.md`，并在 `config.mts` 的 sidebar 注册；
- 新增 API 页：`docs-site/api/*.md`，并注册 sidebar；
- 截图放 `docs-site/public/assets/`，Markdown 用 `/assets/...` 引用；
- 图片建议压缩后提交，避免 Pages 产物体积过大。

## 验证

```bash
cd docs-site
npm run build
```

构建产物：

```text
docs-site/.vitepress/dist
```

可以用 `npm run preview` 本地检查。
