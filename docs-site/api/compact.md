# Compact

```text
POST /v1/compact
```

手动压缩会话：生成摘要，并把摘要 + 旧上下文写入新的 `conversation-context.pdf`。

## 适用场景

- 上下文 PDF 超过 15 页，返回 `413 context_pdf_capacity_exceeded`；
- 想主动清理旧对话、保留摘要；
- Codex 手动压缩之外的显式压缩。

## 请求

```bash
curl http://127.0.0.1:8787/v1/compact \
  -H "Authorization: Bearer sk-duck-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "messages": [
      {"role": "user", "content": "…"},
      {"role": "assistant", "content": "…"}
    ]
  }'
```

也可以带：

```http
X-Session-Id: my-session
```

## 响应

```json
{
  "ok": true,
  "summary": {
    "text": "…",
    "coveredMessageCount": 24,
    "trigger": "manual"
  },
  "contextPdf": {
    "filename": "conversation-context.pdf",
    "pages": 3,
    "bytes": 123456
  }
}
```

短会话可能返回 no-op：

```json
{
  "ok": true,
  "skipped": true,
  "reason": "nothing_to_compact"
}
```

## 与自动压缩的区别

| 项 | 自动压缩 | `/v1/compact` |
| --- | --- | --- |
| 触发 | 字符超阈值/配置 | 显式调用 |
| 上下文 PDF | 自动生成/复用 | 重新生成 |
| 适用 | 长会话 | 手动清理/修复容量 |
| 白名单 | 部分模型 | 不受自动压缩白名单限制 |

> 压缩会改变历史前缀，后续请求需要新 epoch；已有 canonical 与缓存前缀会被替换。

## 相关

- [功能说明 · PDF 上下文](/guide/features#_4-pdf-上下文溢出)
- [错误码](/api/errors)
