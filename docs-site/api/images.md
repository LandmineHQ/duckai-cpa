# Images

```text
POST /v1/images/generations
```

独立图片生成端点，返回 OpenAI Images 兼容结构。

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 否 | 支持图片生成的模型；缺省用默认模型 |
| `prompt` | string | 是 | 图片描述 |
| `n` | number | 否 | 生成数量（通常为 1） |
| `size` | string | 否 | 尺寸提示 |
| `response_format` | string | 否 | `b64_json`（默认） |

## 请求

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H "Authorization: Bearer sk-duck-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "prompt": "一只在阳光下打盹的橘猫，水彩插画",
    "n": 1,
    "response_format": "b64_json"
  }'
```

## 响应

```json
{
  "created": 1735689600,
  "data": [
    {
      "b64_json": "…",
      "revised_prompt": "…",
      "format": "jpeg",
      "mime_type": "image/jpeg"
    }
  ]
}
```

> duck.ai 实际返回 JPEG 的情况较多；`format`/`mime_type` 会按图片魔数修正，而不是盲信上游声明。

## 错误

| 状态 | code | 说明 |
| --- | --- | --- |
| 400 | `model_not_supported` | 模型不支持图片生成 |
| 400 | `tool_disabled` | 管理台关闭了图片生成 |
| 429 | `image_generation_limit_exceeded` | 图片额度耗尽 |
| 502 | `upstream_no_image` | 上游没有返回图片 |

## 在 Chat / Responses 中生图

如果使用对话接口：

```json
{
  "tools": [{"type": "image_generation"}],
  "messages": [{"role": "user", "content": "画一只橘猫"}]
}
```

Chat 返回 `message.images`；Responses 返回 `image_generation_call`。

## 图片上下文

下一轮回放 `image_url` 或 `image_generation_call` 时，网关会把图片作为真实 image part 发送，并自动：

- JPEG → PNG；
- 缩放到 ≤ 512px；
- 持久化到会话，避免跨轮丢失。

## 相关

- [Chat Completions](/api/chat-completions)
- [功能说明 · 图片上下文](/guide/features#_3-图片上下文)
