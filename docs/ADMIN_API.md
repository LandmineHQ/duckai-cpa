# v1（已被 v2 取代）

> ⚠️ 本文件为 v1 契约，**已被 `docs/ADMIN_API_V2.md` 取代（BREAKING）**：v2 强制 API Key、RPS 队列、日志拆分、付费模型、会话式测试、严格中断。本文件仅作历史参考。

# Admin API 契约（`/admin/api/*`）

> 管理后台（web-dashboard）与网关（api-core）之间的稳定契约。
> 所有响应 JSON；错误 `{"error":{"message","type"}}`。
> 鉴权：`Authorization: Bearer <adminToken>`，或 `?token=<adminToken>`（仅 GET 允许 query token）。
> 默认 `adminToken` 在首次启动时生成并写入 `data/config.json` + 启动日志；`config/config.example.json` 默认值仅作示例。
> 本地开发可通过环境变量 `DUCKAI_CPA_ADMIN_TOKEN` 覆盖。

## 1. 概览

`GET /admin/api/overview`

```json
{
  "service": { "name": "duckai-cpa", "version": "0.1.0", "uptimeSec": 123 },
  "upstream": { "ok": true, "version": "serp_20261030_223718_ET-61e4601...", "challengeOk": true, "latencyMs": 120 },
  "stats": { "requests": 42, "errors": 1, "avgLatencyMs": 1830, "totalPromptChars": 12000, "byModel": { "gpt-6-luna": 40 }, "byEndpoint": { "/v1/chat/completions": 40 }, "lastErrorAt": null },
  "models": [ { "id": "gpt-6-luna", "name": "GPT-6 Luna", "reasoning": true, "tools": ["web_search", "image_generation"] } ],
  "recent": [ { "ts": 1793514000000, "endpoint": "/v1/chat/completions", "model": "gpt-6-luna", "status": 200, "latencyMs": 2100, "stream": true } ]
}
```

## 2. 配置

- `GET /admin/api/config` → `{ "config": { ...脱敏配置 } }`（`auth.apiKeys` 用 `keyPreview` 形式返回，不返回明文）。
- `PUT /admin/api/config` → body 为部分配置（深合并），返回 `{ "ok": true, "config": {...}, "restartRequired"?: true, "ignored"?: [...] }`。
  - 允许修改：`server.cors`、`auth.required`、`auth.apiKeys`、`duck.defaultModel`、`duck.timeoutMs`、`duck.humanize.*`、`prompts.*`、`models.aliases`、`tools.*`、`logging.level`。
  - `server.port` 等需要重启的字段：返回 `restartRequired:true`。
- `POST /admin/api/config/reset` → `{ "ok": true, "config": {...}, "restartRequired": true }`（恢复 `config/config.example.json` 默认值）。

## 3. 连接测试

`POST /admin/api/test`（stream 可选）

```json
{ "prompt": "你好", "model": "gpt-6-luna", "reasoningEffort": "none", "webSearch": false, "imageGeneration": false, "stream": true }
```

- `stream:false` → `{ "ok": true, "model": "gpt-6-luna", "content": "...", "reasoning": "", "sources": [], "images": [], "latencyMs": 1200 }`
- `stream:true` → `text/event-stream`，事件行：
  - `data: {"type":"delta","text":"..."}`
  - `data: {"type":"search","results":[{"title","url","snippet"}]}`
  - `data: {"type":"image","b64":"...","format":"png"}`
  - `data: {"type":"done","content":"...","latencyMs":...}`
  - `data: {"type":"error","message":"..."}`

## 4. 日志

- `GET /admin/api/logs?limit=50&offset=0` → `{ "total": 123, "items": [ { "id","ts","endpoint","model","status","latencyMs","stream","error" } ] }`
- `DELETE /admin/api/logs` → `{ "ok": true }`

## 5. API Key 管理

- `GET /admin/api/keys` → `{ "items": [ { "id","label","keyPreview","createdAt","lastUsedAt","requestCount" } ] }`
- `POST /admin/api/keys` `{ "label": "my-agent" }` → `{ "id", "label", "key": "sk-duck-...", "createdAt" }`（key 只显示一次）
- `DELETE /admin/api/keys/:id` → `{ "ok": true }`

## 6. 模型与健康

- `GET /admin/api/models` → `{ "items": [ { "id","name","createdBy","modelType","reasoningEfforts","tools","tiers","default" } ] }`
- `GET /admin/api/health` → `{ "ok": true, "upstream": { "ok": true, "challengeOk": true }, "version": "0.1.0" }`

## 7. 前端约定

- 页面：`/admin` 返回 `web/index.html`；静态资源 `/admin/assets/*`。
- Token 获取顺序：URL `?token=` → localStorage `duckai_cpa_admin_token` → 弹窗输入。
- 401 时清 token 并提示。
- 所有写操作成功后给出 toast 反馈；概览页每 5s 轮询 `/admin/api/overview`。
