# 数据与安全

## 敏感数据

| 数据 | 位置 | 保护 |
| --- | --- | --- |
| adminToken / API Key | `data/config.json`、SQLite | 文件 0600；接口只返回脱敏 |
| 身份密钥 / journeyId | `data/identity.json`、SQLite | 不轮换；不打印私钥 |
| 订阅 access/refresh token | SQLite | 0600；响应脱敏；不写日志 |
| 配对恢复码 | `data/pairing.json` | 最高敏感；只增改不打印 |
| 请求历史 | SQLite | 30 天保留可配；含图片/工具轨迹 |
| 代理出口 IP | 管理 API | 默认 `MaskedIp` 脱敏 |

## 凭据分离

- `/v1/*`：API Key，可创建多个、可吊销；
- `/admin/api/*`：adminToken，仅管理；
- 两者不通用。

## 部署建议

- 默认只监听 `127.0.0.1`；
- 对外时放在 HTTPS 反向代理后，并增加认证；
- 不要公开 `/admin`；
- 容器使用 named volume；
- 不要把 `data/` 提交到 Git；
- 定期备份，但备份文件同样敏感。

## 代理

- 支持 HTTP/HTTPS/SOCKS；
- 代理配置与测试在管理台「代理」页；
- 出口 IP 展示默认脱敏，点击才显示；
- 代理失败会影响所有上游请求，先在页面测试。

## 日志

- upstream/admin 分开；
- 日志不记录完整 token/API Key；
- 错误详情可带 upstream 片段，但不含私钥；
- 支持保留条数/天数与下载。

## 图片与 PDF

- 图片 base64 可能很大；历史/上下文只保留必要数量；
- 上游调试视图会把 `b64`/data URL 替换为 `[image data …]`；
- PDF 仅用于绕过文本字符限制，不改变模型 token 窗口。

## 威胁模型（简要）

| 风险 | 缓解 |
| --- | --- |
| API Key 泄露 | 可吊销、按 Key 统计、最小权限 |
| adminToken 泄露 | 仅内网、反向代理认证 |
| 恶意请求体 | 4MB 限制、JSON 校验、路径穿越防护 |
| 上游身份漂移 | 持久身份、不随意轮换 |
| 订阅 token 泄露 | 加密/脱敏、不写日志 |
| 截图泄露 IP | MaskedIp 默认脱敏 |

## 相关

- [配置项](/reference/configuration)
- [常见问题](/guide/faq)
