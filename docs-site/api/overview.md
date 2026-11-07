# API 概览

DuckAI CPA 对外提供一套 **OpenAI 兼容 API**，默认监听：

```text
http://127.0.0.1:8787
```

OpenAI Base URL：

```text
http://127.0.0.1:8787/v1
```

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/models` | 模型目录、上下文与工具能力 |
| `POST` | `/v1/chat/completions` | 对话补全（流式/非流式） |
| `POST` | `/v1/responses` | Responses API（支持 `previous_response_id`） |
| `POST` | `/v1/images/generations` | 独立图片生成 |
| `POST` | `/v1/compact` | 手动压缩会话并生成新的上下文 PDF |
| `GET` | `/healthz` | 健康检查（无需鉴权） |
| `*` | `/admin/api/*` | 管理 API（adminToken） |

## 认证

所有 `/v1/*` 请求必须带：

```http
Authorization: Bearer sk-duck-xxxxxxxx
```

也支持：

```http
x-api-key: sk-duck-xxxxxxxx
```

没有 Key / Key 错误 → `401 invalid_api_key`。

adminToken 只用于 `/admin/api/*`，不能替代 API Key。

## 通用约定

- 请求体：JSON 对象，`Content-Type: application/json`；
- 请求体上限：**4 MB**，超出返回 `413 payload_too_large`；
- 响应：JSON 或 `text/event-stream`；
- 错误：OpenAI 风格 envelope：

```json
{
  "error": {
    "message": "Unknown model \"gpt-9\".",
    "type": "invalid_request_error",
    "code": "model_not_found",
    "param": "model"
  }
}
```

- 响应头会带 `X-Request-Id`；部分请求还会带 `X-Duckai-Model`、`X-Duckai-Reasoning-*`、`X-Session-Id`、`X-Session-Epoch`。
- CORS 由 `server.cors` 控制，默认开启；`OPTIONS` 预检不需要鉴权。

## 会话相关请求头

| 请求头 | 作用 |
| --- | --- |
| `X-Session-Id` | 稳定会话标识；用于身份路由、历史与 authoritative session |
| `X-Session-Epoch` | 显式指定 epoch；与已保存 epoch 不同视为 fork |
| `X-Session-Fork` | 强制新 epoch |
| `X-Conversation-Mode: server` | Chat Completions 启用服务端会话 |
| `X-Conversation-Delta: true` | 只发送新增 user/tool 输入 |

Responses API 使用官方 `previous_response_id` 链式会话，不需要这些头。

## 流式

- Chat Completions：标准 `chat.completion.chunk`，最后 `data: [DONE]`；
- Responses：命名事件 + `sequence_number`，最后 `response.completed`；
- 客户端断开时网关会 abort 上游请求；
- 反向代理需要关闭缓冲，否则流会被攒到最后才返回。

## 队列与限流

所有上游调用统一走 FIFO 队列，默认：

```text
rps = 1
maxConcurrent = 1
queueLimit = 50
queueTimeoutMs = 300000
```

排队满/超时返回：

```text
429 queue_full
429 queue_timeout
```

带 `Retry-After`。

## 下一步

- [认证与请求约定](/api/authentication)
- [Chat Completions](/api/chat-completions)
- [Responses](/api/responses)
- [错误码](/api/errors)
