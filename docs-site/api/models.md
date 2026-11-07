# Models

```text
GET /v1/models
```

返回 duck.ai 模型目录（OpenAI list 形状），并附带免费/付费、上下文、工具与推理能力字段。

## 请求

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer sk-duck-xxxxxxxx"
```

## 响应

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-6-luna",
      "object": "model",
      "owned_by": "OpenAI",
      "display_name": "GPT-6 Luna",
      "paid": false,
      "tier": "free",
      "available": true,
      "requires_subscription": false,
      "reasoning": true,
      "supported_reasoning_efforts": ["none", "low"],
      "tools": ["web_search", "image_generation"],
      "context_window_chars": 20000,
      "context_window": 6667,
      "max_input_chars": 20000,
      "max_input_tokens": 6667,
      "input_char_limit": 16000,
      "max_output_tokens": 4096,
      "compaction_supported": false,
      "session_limit_behavior": "new_session"
    }
  ]
}
```

## 字段说明

| 字段 | 说明 |
| --- | --- |
| `paid` | 是否付费模型 |
| `tier` | `free` / `paid` |
| `available` | 当前是否可用（身份/订阅） |
| `requires_subscription` | 是否需要订阅身份 |
| `reasoning` | 是否支持 `reasoning_effort` |
| `supported_reasoning_efforts` | 支持档位 |
| `tools` | 支持的服务端工具 |
| `context_window_chars` | 上下文字符窗口 |
| `context_window` | 估算 token 窗口 |
| `max_input_chars` | 单条输入字符上限 |
| `max_input_tokens` | 估算 token 上限 |
| `input_char_limit` | PDF 溢出阈值 |
| `max_output_tokens` | 输出 token 估算 |
| `compaction_supported` | 是否支持自动压缩 |
| `activation_target_pair_count` | 压缩触发 pair 数 |
| `session_limit_behavior` | 会话到上限时的行为 |

## 模型别名

常见别名：

```text
gpt-6 / luna / default  → gpt-6-luna
claude                  → claude-haiku-4-5
duck                    → 默认模型
```

未知模型返回：

```json
{
  "error": {
    "code": "model_not_found",
    "type": "invalid_request_error",
    "message": "Unknown model \"…\"."
  }
}
```

## 免费与付费

- 默认 `allowPaidModels=false`；
- 付费模型在未配置订阅时返回 `403 model_requires_subscription`；
- 有订阅身份时，付费模型会路由到付费池。

## 模型配置覆盖

管理台「模型配置」页可以按模型覆盖：

- 上下文/输入限制；
- 输出 token；
- 推理等级。

覆盖会立即影响 `/v1/models` 的返回。

## 相关

- [Chat Completions](/api/chat-completions)
- [配置项](/reference/configuration)
