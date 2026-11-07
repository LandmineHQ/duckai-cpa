# 管理 API

管理 API 位于：

```text
/admin/api/*
```

使用 **adminToken**：

```http
Authorization: Bearer <adminToken>
```

> 普通 API Key 不能访问管理 API。完整契约见仓库 [`docs/ADMIN_API_V2.md`](https://github.com/LandmineHQ/duckai-cpa/blob/main/docs/ADMIN_API_V2.md)。

## 常用端点

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/admin/api/overview` | 概览：健康、队列、统计、模型、版本 |
| `GET` | `/admin/api/health` | 上游健康 |
| `GET` | `/admin/api/models` | 模型目录（管理视图） |
| `GET/PUT` | `/admin/api/models/config` | 模型配置覆盖 |
| `GET/PUT` | `/admin/api/config` | 读取/更新运行配置 |
| `GET/POST/DELETE` | `/admin/api/keys` | API Key 管理 |
| `GET` | `/admin/api/logs` | 日志列表（支持筛选/分页） |
| `GET` | `/admin/api/logs/download` | 下载日志 |
| `PUT` | `/admin/api/logs/retention` | 日志保留策略 |
| `GET` | `/admin/api/usage` | Token 用量 |
| `GET` | `/admin/api/history` | 会话历史列表 |
| `GET` | `/admin/api/history/:id` | 会话历史详情 |
| `GET` | `/admin/api/history/:id/upstream` | 脱敏 upstream 调试视图 |
| `GET/POST` | `/admin/api/test/sessions` | 连接测试会话 |
| `POST` | `/admin/api/test/sessions/:id/messages` | 发送连接测试消息（SSE） |
| `GET/POST` | `/admin/api/identities` | 身份池 |
| `GET/POST` | `/admin/api/subscriptions` | 订阅 |
| `GET/PUT` | `/admin/api/proxy` | 代理配置 |
| `GET` | `/admin/api/sync/devices` | Sync 设备 |

## 示例

```bash
ADMIN=admin_xxxxxxxx

curl http://127.0.0.1:8787/admin/api/overview \
  -H "Authorization: Bearer $ADMIN"
```

```bash
curl http://127.0.0.1:8787/admin/api/history \
  -H "Authorization: Bearer $ADMIN"
```

## 安全

- 管理 API 只应监听内网/回环；
- 不要把 adminToken 写进前端源码或公开仓库；
- 截图前确认 token、IP、身份已脱敏；
- 管理端响应中的 IP 默认脱敏。

## 相关

- [管理控制台](/guide/admin-console)
- [配置项](/reference/configuration)
- [错误码](/api/errors)
