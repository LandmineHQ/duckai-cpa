# 快速开始

DuckAI CPA 推荐两种运行方式：

- **Docker Compose**：使用 GHCR 预构建最小镜像；
- **单文件二进制**：从 GitHub Release 下载对应平台，无需 Node.js/Bun。

> 首次启动会生成 `adminToken` 与默认 API Key，**只在启动日志打印一次**，请立即保存。

## 方式一：Docker Compose

要求：Docker + Docker Compose。

新建 `compose.yml`：

```yaml
services:
  duckai-cpa:
    image: ghcr.io/landminehq/duckai-cpa:latest
    container_name: duckai-cpa
    restart: unless-stopped
    ports:
      - "8787:8787"
    environment:
      DUCKAI_CPA_HOST: "0.0.0.0"
      DUCKAI_CPA_PORT: "8787"
      DUCKAI_CPA_DATA_DIR: "/data"
      # 强烈建议设置；不设置则由首启生成并打印
      # DUCKAI_CPA_ADMIN_TOKEN: "replace-with-a-strong-random-token"
    volumes:
      - duckai-cpa-data:/data
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8787/healthz"]
      interval: 30s
      timeout: 5s
      start_period: 60s
      retries: 3

volumes:
  duckai-cpa-data:
```

启动：

```bash
docker compose up -d
docker compose logs -f duckai-cpa
```

打开：

- 管理后台：<http://127.0.0.1:8787/admin/>
- 健康检查：<http://127.0.0.1:8787/healthz>
- API 首页：<http://127.0.0.1:8787/>

### 没有 Docker？

直接使用二进制。

## 方式二：单文件二进制

到 [最新 Release](https://github.com/LandmineHQ/duckai-cpa/releases/latest) 下载对应平台的资产：

| 平台 | 资产 |
| --- | --- |
| Windows x64 | `duckai-cpa-windows-x64.zip` |
| Linux x64 (glibc) | `duckai-cpa-linux-x64.tar.gz` |
| Linux x64 (musl/Alpine) | `duckai-cpa-linux-x64-musl.tar.gz` |
| Linux arm64 (glibc) | `duckai-cpa-linux-arm64.tar.gz` |
| Linux arm64 (musl) | `duckai-cpa-linux-arm64-musl.tar.gz` |
| macOS Intel | `duckai-cpa-darwin-x64.tar.gz` |
| macOS Apple Silicon | `duckai-cpa-darwin-arm64.tar.gz` |

Linux / macOS：

```bash
tar -xzf duckai-cpa-linux-x64.tar.gz
cd duckai-cpa-linux-x64
./duckai-cpa
```

Windows：解压后双击 `duckai-cpa.exe`，控制台窗口需要保持打开；数据默认写入二进制旁边的 `data/`。

可选环境变量：

```bash
DUCKAI_CPA_DATA_DIR=/var/lib/duckai-cpa \
DUCKAI_CPA_HOST=127.0.0.1 \
DUCKAI_CPA_PORT=8787 \
./duckai-cpa
```

> 二进制未签名：Windows SmartScreen / macOS Gatekeeper 可能提示。确认来源后选择“仍要运行”或右键打开。

## 首次配置

1. 从启动日志复制 **adminToken**；
2. 打开 `/admin/`，用 adminToken 登录；
3. 在「API Key」页创建或查看默认 API Key（完整值只展示一次）；
4. 在「设置」/「身份池」按需配置代理、身份、订阅；
5. 用任意 OpenAI SDK 指向 `http://127.0.0.1:8787/v1`。

快速验证：

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer sk-duck-xxxxxxxx"
```

## 下一步

- [安装与部署](/guide/installation)：卷、UID、端口、反向代理、更新；
- [管理控制台](/guide/admin-console)：各页面怎么用；
- [Chat Completions](/api/chat-completions)：第一段对话。
