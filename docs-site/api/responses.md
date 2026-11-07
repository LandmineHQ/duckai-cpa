# Responses API

```text
POST /v1/responses
```

兼容 OpenAI Responses API，支持官方事件序列、`previous_response_id` 链式会话、工具与图片。

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | 模型 ID |
| `input` | string / array | 是 | 字符串或 message/input item 数组 |
| `instructions` | string | 否 | 系统指令 |
| `stream` | boolean | 否 | `true` 时返回命名 SSE 事件 |
| `previous_response_id` | string | 否 | 链接上一轮 response |
| `store` | boolean | 否 | 是否保存 `responses` 表（默认 true） |
| `tools` | array | 否 | `web_search` / `image_generation` / 客户端 `function` |
| `reasoning.effort` | string | 否 | 推理档位 |
| `max_output_tokens` | number | 否 | 输出上限提示 |

## 非流式示例

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer sk-duck-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "input": "用一句话介绍 DuckDuckGo。"
  }'
```

响应（节选）：

```json
{
  "id": "resp_…",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        {"type": "output_text", "text": "DuckDuckGo 是…"}
      ]
    }
  ],
  "output_text": "DuckDuckGo 是…",
  "usage": {
    "input_tokens": 14,
    "output_tokens": 30,
    "total_tokens": 44
  }
}
```

## previous_response_id 链式会话

第一轮：

```json
{"model": "gpt-6-luna", "input": "记住数字 42。"}
```

保存返回的 `id`，下一轮：

```json
{
  "model": "gpt-6-luna",
  "previous_response_id": "resp_…",
  "input": "我刚才让你记住什么？"
}
```

网关会保存：

- canonical conversation；
- 精确 upstream 前缀（含工具协议/图片）；
- output items；
- toolsHash。

下一轮只发送新 `input`，可以精确复用前缀；工具/系统提示变化时会重建。

## 流式事件

```text
event: response.created
event: response.output_item.added
event: response.content_part.added
event: response.output_text.delta
event: response.output_text.done
event: response.completed
```

每个事件带递增的 `sequence_number`。错误时：

```text
event: response.failed
event: error
```

## 图片生成

```json
{
  "model": "gpt-6-luna",
  "input": "画一只橘猫",
  "tools": [{"type": "image_generation"}]
}
```

输出包含：

```json
{
  "type": "image_generation_call",
  "status": "completed",
  "result": "<base64>",
  "output_format": "png"
}
```

同时会补一条 `message` + `output_text`，避免只渲染 message 的客户端显示空消息。

下一轮 input 可以回放：

```json
{
  "type": "image_generation_call",
  "result": "…",
  "output_format": "png"
}
```

网关会把它作为真实 image part 继续发送。

## 客户端工具

```json
{
  "tools": [
    {
      "type": "function",
      "name": "read_file",
      "description": "读取本地文件",
      "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}
    }
  ]
}
```

输出 item：

```json
{
  "type": "function_call",
  "call_id": "call_…",
  "name": "read_file",
  "arguments": "{\"path\":\"README.md\"}"
}
```

下一轮回传：

```json
{"type": "function_call_output", "call_id": "call_…", "output": "…"}
```

## 与 Chat Completions 的差异

| 项 | Chat Completions | Responses |
| --- | --- | --- |
| 会话链 | 默认 stateless；可选 server 模式 | 原生 `previous_response_id` |
| 流式 | `chat.completion.chunk` + `[DONE]` | 命名事件 + `sequence_number` |
| 工具输出 | `tool_calls` | `function_call` item |
| 图片输出 | `message.images` | `image_generation_call.result` |
| 输入形状 | `messages` | `input` |

## 相关

- [Chat Completions](/api/chat-completions)
- [错误码](/api/errors)
