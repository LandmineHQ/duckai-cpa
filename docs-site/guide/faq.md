# 常见问题

## 启动 / 部署

### Docker 启动报 `EACCES: permission denied, open '/data/...'`

容器以 UID **10001:10001** 运行。使用 named volume 时通常不会出现；如果改成 host bind mount：

```bash
docker compose down
mkdir -p data
sudo chown -R 10001:10001 data
docker compose up -d
```

### 容器里连不上 duck.ai

检查：

- 代理是否配置且可用；
- 出口 IP 是否被 duck.ai 限制（免费池常见 429/403/418）；
- DNS / 出网是否正常。

### 二进制被 Windows SmartScreen / macOS Gatekeeper 拦截

二进制未签名。Windows 选择“更多信息 → 仍要运行”；macOS 右键打开，或：

```bash
xattr -d com.apple.quarantine ./duckai-cpa
```

### 管理台打不开

- 确认端口映射正确；
- 确认 `DUCKAI_CPA_HOST=0.0.0.0`（容器内）；
- 如果放在反向代理后，确认路径 `/admin/` 没有被错误重写。

## API

### 401 `invalid_api_key`

- 没带 `Authorization: Bearer sk-duck-...`；
- Key 已吊销或复制不完整；
- 把 adminToken 当成 API Key 使用（两者不通用）。

### 403 `model_requires_subscription`

请求的是付费模型，但当前没有可用的订阅身份。先绑定订阅，或改用免费模型。

### 429 `queue_full` / `queue_timeout`

上游是串行队列（默认 RPS=1、并发=1）。降低并发，或等待队列释放；响应带 `Retry-After`。

### 429/418 上游限流

免费匿名池共享出口 IP，容易触发。可以：

- 等待额度窗口恢复；
- 配置代理/更换出口；
- 降低请求频率；
- 在管理台查看日志与身份冷却状态。

### 409 `session_history_mismatch`

authoritative session 检测到客户端回放的历史与网关 canonical 不一致：

- 发送完整 canonical 历史；
- 只发送最新 user/tool 输入（delta）；
- 或显式 fork/新 epoch。

DSH 标题生成等辅助请求会被识别为 ephemeral，不写入 canonical；若旧会话曾被污染，重试一次通常会自动修复。

### 图片生成了但下一轮上下文没有图

确认：

- 客户端是否回放了 `image_generation_call` / `image_url`；
- 是否使用同一 session；
- 升级到包含图片上下文修复的版本（v2.64+）。

### 长上下文返回 413 `context_pdf_capacity_exceeded`

旧历史超过 15 页 PDF 容量。调用：

```bash
POST /v1/compact
```

先手动压缩，或减少历史。

## 会话 / 历史

### 连接测试页面正常，但「会话历史」显示了旧内容

v2.64 起历史详情/列表对 `sess_*` 会话优先读取 `test_sessions`，因此旧记录会按真实会话显示；升级后刷新即可。新写入的记录也会保留图片-only assistant。

### 历史图片/工具信息不显示

- 确认升级到支持 `images`/`toolCalls` 的版本；
- 旧记录可能需要重新产生一轮消息才会覆盖；
- 不要直接修改数据库，先备份。

## 发布 / 文档

### GitHub Pages 部署失败

- 仓库 Settings → Pages → Source 选择 **GitHub Actions**；
- 确认 workflow 有 `pages: write` 与 `id-token: write`；
- 项目站点 base 默认为 `/duckai-cpa/`，自定义域名时设置 `DOCS_BASE=/`。

### `npm test` 访问外网失败

测试必须离线；真实上游验证用 `scripts/live-check.mjs`，并先确认额度。
