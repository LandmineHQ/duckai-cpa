# Chat Completions

```text
POST /v1/chat/completions
```

兼容 OpenAI Chat Completions 的请求/响应形状，支持流式、工具、图片与 reasoning。

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 模型 ID 或别名 |
| `messages` | array | 是 | 标准 OpenAI 消息数组 |
| `stream` | boolean | 否 | `true` 时返回 SSE |
| `stream_options.include_usage` | boolean | 否 | 流式末尾追加 usage 帧 |
| `reasoning_effort` | string | 否 | `none` / `minimal` / `low` / `medium` / `high` |
| `reasoning.effort` | string | 否 | 与 `reasoning_effort` 等价 |
| `tools` | array | 否 | `web_search` / `image_generation` / 客户端 `function` |
| `web_search` | boolean | 否 | `tools:[{"type":"web_search"}]` 的快捷写法 |
| `image_generation` | boolean | 否 | `tools:[{"type":"image_generation"}]` 的快捷写法 |
| `temperature` / `top_p` | number | 否 | 透传/映射到上游可用参数 |

## 非流式示例

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-duck-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "messages": [
      {"role": "user", "content": "用三句话解释 SSE。"}
    ],
    "reasoning_effort": "low"
  }'
```

响应（节选）：

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "model": "gpt-6-luna",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "SSE 是一种…"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 48,
    "total_tokens": 60
  }
}
```

## 流式示例

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-duck-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "messages": [{"role":"user","content":"写一个短故事"}],
    "stream": true
  }'
```

事件顺序：

```text
data: {"choices":[{"delta":{"role":"assistant"}}]}
data: {"choices":[{"delta":{"content":"从前"}}]}
data: {"choices":[{"delta":{"content":"…"}}]}
data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

`include_usage=true` 时，`[DONE]` 前会有一个 `choices:[]` 的 usage 帧。

## 工具

### 服务端工具

```json
{
  "model": "gpt-6-luna",
  "messages": [{"role": "user", "content": "搜索今天的新闻并总结"}],
  "tools": [{"type": "web_search"}]
}
```

联网搜索会在响应中返回：

- `message.annotations`（`url_citation`）；
- `message.sources`；
- 正文中清理掉引用标记。

图片生成：

```json
{
  "tools": [{"type": "image_generation"}],
  "messages": [{"role": "user", "content": "画一只橘猫"}]
}
```

响应额外带：

```json
{
  "message": {
    "role": "assistant",
    "content": "",
    "images": [
      {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,…"},
        "b64_json": "…",
        "format": "png",
        "mime_type": "image/png"
      }
    ]
  }
}
```

### 客户端 function 工具

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取本地文件",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}
      }
    }
  ]
}
```

返回：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_…",
            "type": "function",
            "function": {"name": "read_file", "arguments": "{\"path\":\"README.md\"}"}
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

下一轮把 `assistant.tool_calls` 和 `role:"tool"` 结果回放即可。网关不执行工具。

## 图片输入

`content` 支持多模态数组：

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "这张图是什么颜色？"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,…"}}
  ]
}
```

仅支持 `data:` URL；远程 URL 不会由网关下载。

## 会话

默认 stateless：客户端每次回放完整历史。

需要服务端会话时：

```http
X-Session-Id: my-session
X-Conversation-Mode: server
```

第二轮回放完整历史，或只发增量：

```http
X-Conversation-Delta: true
```

历史前缀不匹配会返回：

```text
409 conversation_session_conflict
```

authoritative session 冲突会返回：

```text
409 session_history_mismatch
```

## 响应头

```http
X-Request-Id: …
X-Duckai-Model: gpt-6-luna
X-Duckai-Reasoning-Effort: low
X-Session-Id: …
X-Session-Epoch: 0
```

## 相关

- [Responses](/api/responses)
- [错误码](/api/errors)
- [图片上下文](/guide/features#_3-图片上下文)
