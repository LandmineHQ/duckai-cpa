# 安装与部署

## 运行形态

| 形态 | 适用 | 需要 |
| --- | --- | --- |
| GHCR 镜像 + Compose | 绝大多数私有部署 | Docker / Docker Compose |
| 单文件二进制 | 无 Docker 的机器、便携运行 | 无（无需 Node.js/Bun） |
| 源码开发 | 改代码、跑测试 | Node.js 24+、Bun（构建二进制时） |

镜像与二进制使用同一套运行时代码，数据格式一致。

## Docker

镜像：

```text
ghcr.io/landminehq/duckai-cpa:latest
```

- 基础镜像：Alpine 3.20 + musl 单文件二进制；
- 默认平台：`linux/amd64`；
- 容器用户：**UID/GID 10001:10001**；
- 默认数据目录：`/data`；
- 推荐使用 **named volume**（`duckai-cpa-data:/data`），不要用 root 拥有的 bind mount。

### 端口与反向代理

容器监听 `0.0.0.0:8787`。如果放在 Nginx/Caddy/Traefik 后：

- 保留 `Authorization` 与 `Content-Type` 头；
- SSE 关闭代理缓冲（Nginx `proxy_buffering off;`）；
- 为长请求设置足够的 `proxy_read_timeout`；
- 不要把 `/admin` 暴露到公网而不加额外访问控制。

### 卷与权限

```yaml
volumes:
  - duckai-cpa-data:/data
```

如果必须使用 host bind mount，在 Linux 上先准备权限：

```bash
mkdir -p data
sudo chown -R 10001:10001 data
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DUCKAI_CPA_HOST` | `127.0.0.1` | 监听地址；容器内必须是 `0.0.0.0` |
| `DUCKAI_CPA_PORT` | `8787` | 监听端口 |
| `DUCKAI_CPA_DATA_DIR` | `data` | 数据目录 |
| `DUCKAI_CPA_CONFIG_PATH` | `<data>/config.json` | 运行配置路径 |
| `DUCKAI_CPA_ADMIN_TOKEN` | 首启生成 | 管理后台 token；建议显式设置 |
| `DUCKAI_CPA_VERSION` | package/镜像版本 | 覆盖展示版本 |

### 中文 PDF

上下文 PDF 默认不包含 CJK 字体。需要中文 PDF 时，从源码构建镜像：

```bash
INSTALL_CJK_FONTS=true docker compose build
```

会增加约 16 MB。详见仓库 `docs/BINARY-BUILDS.md`。

## 单文件二进制

- 数据默认在二进制同目录 `data/`；可用 `DUCKAI_CPA_DATA_DIR` 改。
- 资产未签名，Windows/macOS 可能触发安全提示。
- Linux musl 版本用于 Alpine，glibc 版本用于 Debian/Ubuntu。
- 二进制内置 `web/`、`config/` 与 `package.json`，不需要外部 node_modules。

### 作为系统服务（Linux）

```ini
# /etc/systemd/system/duckai-cpa.service
[Unit]
Description=DuckAI CPA
After=network-online.target

[Service]
ExecStart=/opt/duckai-cpa/duckai-cpa
WorkingDirectory=/opt/duckai-cpa
Environment=DUCKAI_CPA_DATA_DIR=/var/lib/duckai-cpa
Environment=DUCKAI_CPA_HOST=127.0.0.1
Environment=DUCKAI_CPA_PORT=8787
Restart=on-failure
User=duckai

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now duckai-cpa
```

## 源码开发

```bash
git clone https://github.com/LandmineHQ/duckai-cpa.git
cd duckai-cpa
npm install
npm run build:web
npm start
```

二进制构建需要 Bun：

```bash
npm run build:exe
node scripts/verify-exe.mjs --exe dist/<target>/duckai-cpa
```

## 更新

- Docker：拉取新标签并重建容器；数据在卷中保留。
- 二进制：停止旧进程，替换可执行文件，保留 `data/`。
- 升级前建议备份 `data/`（包含身份、订阅与密钥）。

## 发布

镜像与二进制都通过 GitHub Actions **手动发布**，不会在 push 时自动推送：

- `publish-docker-image`：构建并推送 GHCR；
- `publish-binaries`：构建多平台二进制并发布 GitHub Release。

具体版本/标签规则见仓库 README 的 Publishing 章节。
