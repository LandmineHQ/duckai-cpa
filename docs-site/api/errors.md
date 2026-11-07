# 错误码

所有 HTTP 错误都使用 OpenAI 风格：

```json
{
  "error": {
    "message": "…",
    "type": "invalid_request_error",
    "code": "model_not_found",
    "param": "model"
  }
}
```

流式请求在**首事件前**失败时返回普通 JSON；已经下发 SSE 后失败时：

```text
event: error / data: {"error": {...}}
```

不会伪造完成事件。

## 常见错误

| HTTP | type | code | 处理 |
| --- | --- | --- | --- |
| 400 | `invalid_request_error` | `invalid_json` | 请求体不是合法 JSON |
| 400 | `invalid_request_error` | `messages_required` | messages 为空/缺少 user |
| 400 | `invalid_request_error` | `invalid_reasoning_effort` | 推理档位不在枚举内 |
| 400 | `invalid_request_error` | `model_not_found` | 未知模型 |
| 400 | `invalid_request_error` | `tool_disabled` | 管理台关闭了该工具 |
| 400 | `invalid_request_error` | `tool_not_supported` | 模型不支持该工具 |
| 400 | `invalid_request_error` | `unsupported_tool` | 只支持 web_search / image_generation |
| 401 | `authentication_error` | `invalid_api_key` | 缺少/错误/吊销的 API Key |
| 403 | `model_unavailable` | `model_requires_subscription` | 付费模型但无订阅身份 |
| 403 | `permission_error` | `upstream_subscription_required` | 上游账号无订阅 |
| 403 | `content_filter` | `content_filter` | 上游审核拒绝 |
| 404 | `invalid_request_error` | `not_found` | 路由/资源不存在 |
| 405 | `invalid_request_error` | `method_not_allowed` | 方法不允许；响应含 `Allow` |
| 409 | `invalid_request_error` | `session_history_mismatch` | 客户端历史与 canonical 冲突 |
| 413 | `invalid_request_error` | `payload_too_large` | 请求体超过 4 MB |
| 413 | `invalid_request_error` | `context_length_exceeded` | 上游判定输入超长 |
| 413 | `invalid_request_error` | `context_pdf_capacity_exceeded` | 上下文 PDF 超过 15 页 |
| 429 | `rate_limit_exceeded` | `rate_limit_exceeded` | 上游匿名额度限流 |
| 429 | `rate_limit_exceeded` | `queue_full` | 网关队列已满 |
| 429 | `rate_limit_exceeded` | `queue_timeout` | 网关排队超时 |
| 429 | `rate_limit_exceeded` | `all_identities_cooling` | 所有身份额度冷却中 |
| 499 | `aborted` | `client_closed_request` | 客户端提前断开 |
| 500 | `server_error` | `internal_error` | 网关内部错误 |
| 502 | `upstream_error` | `upstream_protocol_mismatch` | 上游响应不符合协议 |
| 502 | `upstream_error` | `upstream_no_image` | 图片生成结束但没有图片 |
| 502 | `upstream_error` | `challenge_fetch_failed` / `ERR_CHALLENGE` | 反爬挑战失败 |
| 504 | `upstream_timeout` | `upstream_timeout` | 上游超时 |

## 重试建议

| 情况 | 是否重试 |
| --- | --- |
| 429 `queue_full` / `queue_timeout` | 是，按 `Retry-After` 退避 |
| 429 上游限流 | 是，但不要高频重试 |
| 5xx 上游/网络 | 是，有限次 |
| 400 参数错误 | 否，修正参数 |
| 401/403 | 否，检查 Key/订阅/模型 |
| 409 `session_history_mismatch` | 先修正历史或 fork/epoch |
| 413 PDF 容量 | 调用 `/v1/compact` 或减少历史 |

## 排查入口

- 管理台「日志」：`requestId`、`sessionKey`、`identity`、`errorDetail`；
- `GET /admin/api/history/:id/upstream`：脱敏的真实 upstream messages；
- `/healthz`：上游状态、挑战、队列；
- 管理台「连接测试」：可复现流式/图片/工具/压缩问题。

## 相关

- [认证](/api/authentication)
- [Chat Completions](/api/chat-completions)
- [常见问题](/guide/faq)
