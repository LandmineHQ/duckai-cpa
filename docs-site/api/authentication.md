# 认证与请求约定

## API Key

每个 `/v1/*` 请求都必须带 API Key：

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer sk-duck-xxxxxxxx"
```

或：

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "x-api-key: sk-duck-xxxxxxxx"
```

API Key 在启动日志或管理台「API Key」页创建；完整值只展示一次。

### 常见认证错误

| 场景 | 状态 | code |
| --- | --- | --- |
| 缺少 Key | 401 | `invalid_api_key` |
| Key 错误/已吊销 | 401 | `invalid_api_key` |
| 用 adminToken 调 `/v1` | 401 | `invalid_api_key` |

## 管理 API

`/admin/api/*` 使用：

```http
Authorization: Bearer <adminToken>
```

adminToken 在首启生成，或用 `DUCKAI_CPA_ADMIN_TOKEN` 显式设置。

## 请求体

- 必须是 JSON 对象；
- 最大 **4 MB**；
- 无效 JSON → `400 invalid_json`；
- 超过大小 → `413 payload_too_large`。

## 响应头

| 头 | 说明 |
| --- | --- |
| `X-Request-Id` | 请求 ID，可在日志中定位 |
| `X-Duckai-Model` | 实际解析后的模型 ID |
| `X-Duckai-Reasoning-Effort` | 实际使用的推理档位 |
| `X-Duckai-Reasoning-Adjusted` | 是否因模型能力被调整 |
| `X-Session-Id` | 会话 ID（如适用） |
| `X-Session-Epoch` | 会话 epoch（如适用） |

## 错误格式

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

部分错误还会带：

- `retriable`；
- `retry_after` / `Retry-After`；
- `hint`；
- `errorDetail`（管理日志）。

## 幂等与重试

- Chat Completions 默认 stateless：重试时应回放完整历史；
- 服务端会话模式请重试相同 session 请求；
- 429/5xx 可以根据 `Retry-After` 退避；
- 409 `session_history_mismatch` 不要盲目重试，先修正历史或显式 fork/epoch。

## 请求取消

客户端关闭连接后：

- SSE 写入停止；
- 上游请求 abort；
- 不写入半截会话状态（以实际响应完成情况为准）。
