# DuckAI CPA · 对外 API 文档

> DuckAI CPA v2 把 **duck.ai** 的网页对话能力包装成 **OpenAI 兼容 API**。
> 面向调用方（Agent / SDK / 客户端）的稳定接口说明；管理后台与内部管理接口见
> [`ADMIN_API_V2.md`](./ADMIN_API_V2.md)（v2 唯一契约，v1 的 `ADMIN_API.md` 已废弃），
> 上游协议与反爬挑战细节见 [`PROTOCOL.md`](./PROTOCOL.md)。

- 默认地址：`http://127.0.0.1:8787`
- OpenAI Base URL：`http://127.0.0.1:8787/v1`
- 响应格式：JSON；流式为 `text/event-stream`
- **鉴权（v2 破坏性变更）：所有 `/v1/*` 请求必须携带 `Authorization: Bearer <apiKey>`**；
  无 Key / 错误 Key → `401 invalid_api_key`
- **上游 RPS 队列**：所有上游调用统一 FIFO 排队（默认 `rps=1`、同时 1 个执行），
  排队满/超时 → `429 queue_full` / `queue_timeout`
- **免费/付费模型**：`/v1/models` 标注 `paid` / `available`；默认 `allowPaidModels=false` 时付费模型请求返回
  `403 model_requires_subscription`

> ⚠️ 本项目仅用于**个人学习与私有部署**：它依赖 duck.ai 的匿名网页会话，请遵守 duck.ai 的服务条款，
> 不要对外提供公共服务或用于批量抓取。匿名额度受限时上游会返回 429，详见[常见问题](#常见问题-faq)。

---

## 目录

1. [认证](#1-认证)
2. [模型列表 `GET /v1/models`](#2-模型列表-get-v1models)
3. [对话补全 `POST /v1/chat/completions`](#3-对话补全-post-v1chatcompletions)
4. [Responses API `POST /v1/responses`](#4-responses-api-post-v1responses)
5. [图片生成 `POST /v1/images/generations`](#5-图片生成-post-v1imagesgenerations)
6. [健康检查 `GET /healthz`](#6-健康检查-get-healthz)
7. [`reasoning_effort` 映射](#7-reasoning_effort-映射)
8. [工具映射（联网搜索 / 图片生成）](#8-工具映射联网搜索--图片生成)
9. [错误码](#9-错误码)
10. [OpenAI SDK 接入](#10-openai-sdk-接入)
11. [管理接口](#11-管理接口)
12. [常见问题 FAQ](#常见问题-faq)

---

## 1. 认证

### 1.1 调用 `/v1/*`（强制 API Key）

v2 起没有 `auth.required` 开关：**所有 `/v1/*` 请求都必须携带 API Key**。

| 场景 | 行为 |
| --- | --- |
| 携带正确 `Authorization: Bearer sk-duck-…` | 正常处理，并计入该 Key 的使用统计 |
| 缺少 / 错误 / 已吊销的 Key | `401`，`{"error":{"message","type":"authentication_error","code":"invalid_api_key"}}` |

- 首次启动（或所有 Key 被吊销后重启）会自动创建 label 为 `default` 的 Key，
  **完整值只打印一次到启动日志**，并写入 `data/keys.json`；
- 更多 Key 在管理后台「API Key」页创建（完整值也仅展示一次），形如 `sk-duck-xxxxxxxx`；
- adminToken 与 API Key 是两套凭据：adminToken 只用于 `/admin/api/*`，普通 API Key 不能访问管理接口。

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer sk-duck-xxxxxxxx"
```

### 1.2 通用约定

- 请求体必须是 JSON 对象（`Content-Type: application/json`），最大 8 MB，超出返回 `413`。
- 所有错误均为 OpenAI 风格：

  ```json
  {
    "error": {
      "message": "Unknown model \"gpt-9\". Available models: ...",
      "type": "invalid_request_error",
      "code": "model_not_found",
      "param": "model"
    }
  }
  ```

- 响应头会带 `X-Request-Id`，便于在服务端日志中定位。
- CORS 由 `server.cors` 控制（默认 `true`，回显 `*`）；预检 `OPTIONS` 不需要鉴权。

---

## 2. 模型列表 `GET /v1/models`

返回 duck.ai 的模型目录（OpenAI `list` 格式）。v2 起每个模型都带 **免费/付费标记**：
`paid` / `tier` / `available` / `requires_subscription` / `display_name` / `supported_reasoning_efforts` / `tools`。

### 请求

> v2 强制鉴权：任何 `/v1/*` 请求都必须带 API Key。

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer sk-duck-xxxxxxxx"
```

### 响应

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-6-luna",
      "object": "model",
      "created": 1735689600,
      "owned_by": "OpenAI",
      "created_by": "OpenAI",
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
      "max_output_tokens_estimated": true,
      "compaction_supported": false,
      "compaction_trigger": null,
      "compaction_threshold_tokens": null,
      "activation_target_pair_count": 0,
      "session_limit_behavior": "new_chat",
      "default": true
    },
    {
      "id": "claude-opus-5-5",
      "object": "model",
      "created": 1735689600,
      "owned_by": "Anthropic",
      "created_by": "Anthropic",
      "display_name": "Claude Opus 5.5",
      "paid": true,
      "tier": "pro",
      "available": false,
      "requires_subscription": true,
      "reasoning": true,
      "supported_reasoning_efforts": ["none", "low", "medium"],
      "tools": ["web_search", "image_generation"]
    }
  ],
  "default_model": "gpt-6-luna"
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 对外模型 ID，可直接用于 `model` 参数 |
| `display_name` | 展示名（如 `GPT-6 Luna`） |
| `owned_by` / `created_by` | 模型提供方（OpenAI / Anthropic / Google / Mistral AI） |
| `paid` | 是否付费模型（Plus/Pro 订阅） |
| `tier` | 上游档位：`free` / `plus` / `pro` |
| `available` | 当前网关是否允许调用（付费模型在 `allowPaidModels=false` 时为 `false`） |
| `requires_subscription` | 是否需要 duck.ai 订阅 |
| `reasoning` | 是否支持 `reasoning_effort` |
| `supported_reasoning_efforts` | 该模型支持的推理档位 |
| `tools` | 支持的工具：`web_search` / `image_generation` |
| `context_window_chars` | 单次会话可用上下文（**字符**，实测约 20,000；来源见 `docs/CONTEXT-TOKENS.md`） |
| `context_window` / `max_input_tokens` | 由字符数按 3 字符/token 估算的 token 值（仅参考） |
| `max_input_chars` | 单条消息字符上限（实测 ≈19,999，超限返回 413 `context_length_exceeded`） |
| `input_char_limit` | duck.ai 前端展示的输入上限（免费模型 16,000 字符，属于 UI 软限制） |
| `max_output_tokens` | 输出 token 上限（**估算值**，见下一字段） |
| `max_output_tokens_estimated` | `true` 表示该值来自估算而非上游实测硬上限 |
| `compaction_supported` | 是否支持自动上下文压缩（duck.ai 白名单模型） |
| `compaction_trigger` | 触发方式；支持压缩时为 `tokens`（服务端 `[SUMMARY_REFRESH_HINT]`），否则 `null` |
| `compaction_threshold_tokens` | 压缩 token 阈值；服务端运行期下发，未知时为 `null` |
| `activation_target_pair_count` | 自动压缩的 pair 阈值；`0` 表示使用 fallback（≥4 pairs） |
| `session_limit_behavior` | 会话达到上限时的行为：`summarize_and_continue`（先摘要再继续）/ `new_chat`（只能新开会话，如 gpt-6-luna） |
| `default` | 是否为网关默认模型 |
| `default_model` | 顶层扩展字段，当前默认模型 |

> `data` 中可能同时返回 `duck-` 前缀形式（相同元数据，便于兼容旧客户端）。
> 配置的别名（如 `gpt-6` / `gpt6` / `duck`）不单独列出，但可直接作为 `model` 参数使用。

模型 ID 解析规则（`model` 参数同此）：

1. 精确匹配目录 id；
2. 去掉一层 `duck-` 前缀后匹配（`duck-gpt-6-luna` → `gpt-6-luna`）；
3. 匹配 `models.aliases` 配置或内置别名（`gpt-6` / `gpt6` / `duck` → `gpt-6-luna`）；
4. 仍未匹配 → `400 model_not_found`。省略 `model` 时使用 `duck.defaultModel`。

免费 / 付费模型（`config.duck.allowPaidModels` 默认 `false`）：

| 分类 | 模型 id |
| --- | --- |
| **免费**（匿名可用） | `gpt-6-luna`、`gpt-5.4-mini`、`claude-haiku-4-5`、`mistral-small-2603`、`tinfoil/gpt-oss-120b`、`tinfoil/gemma4-31b` |
| **付费**（Plus/Pro 订阅） | `gpt-5.6-terra`、`gpt-5.6-sol`、`claude-sonnet-5-5`、`claude-opus-5-5` |

- `allowPaidModels=false`（默认）：`/v1/models` 仍列出付费模型，但 `paid:true, available:false, requires_subscription:true`；
  对它们发起请求 → **`403 model_requires_subscription`**；
- `allowPaidModels=true`：放行付费模型（失败由上游错误映射，如
  `ERR_ACCOUNT_LIMIT` → `403 upstream_subscription_required`）；
- 设置入口：管理后台「设置」页的 `allowPaidModels` 开关，或 `PUT /admin/api/config`。

> 实际可用模型以 `GET /v1/models` 与 `GET /admin/api/models` 的实时返回为准。

---

## 2.1 客户端压缩 `POST /v1/compact`（v2.21）

会话达到上游上限时网关返回 **409 `conversation_limit_reached`**，不会自动压缩。调用方可显式压缩：

```bash
curl http://127.0.0.1:8787/v1/compact \
  -H "Authorization: Bearer sk-duck-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "keep_recent_messages": 6,
    "max_summary_chars": 4000,
    "messages": [
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "..." }
    ],
    "previous_summary": "（可选）上一次摘要文本"
  }'
```

响应：

```json
{
  "object": "compaction",
  "model": "gpt-6-luna",
  "summary": {
    "text": "- 用户目标…\n- 已确认事实…",
    "version": 1,
    "covered_message_count": 7,
    "covered_pair_count": 3,
    "trigger": "client",
    "saved_chars": 187,
    "model": "gpt-6-luna",
    "anchor_id": null
  },
  "kept_messages": [{ "role": "user", "content": "..." }],
  "usage": { "input_chars": 187, "summary_chars": 145 }
}
```

验证：对真实上游实测返回 200，摘要内容正确（2026-11-02）。

### 409 错误示例

```json
{
  "error": {
    "message": "The model has reached the maximum conversation length",
    "type": "invalid_request_error",
    "code": "conversation_limit_reached",
    "hint": "会话已达到 duck.ai 长度上限：请新建会话继续；或由客户端先调用 POST /v1/compact 生成摘要，再用摘要作 system prompt 重新发起请求。"
  }
}
```

```text
POST /v1/chat/completions
→ HTTP 409 conversation_limit_reached（不再自动 trim/压缩）
→ 客户端选择：新开会话（简单）/ 调 POST /v1/compact 拿摘要（继续同一逻辑会话）
```

---

## 3. 对话补全 `POST /v1/chat/completions`

### 3.1 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 否 | 模型 id / 别名；缺省用 `duck.defaultModel`；付费模型需 `duck.allowPaidModels=true`，否则 403 |
| `messages` | array | **是** | OpenAI 消息数组，至少包含一条非空 user 消息 |
| `stream` | boolean | 否 | `true` 返回 SSE 流；默认 `false` |
| `stream_options.include_usage` | boolean | 否 | 流式末尾追加一个 `choices: []` 的 usage chunk |
| `reasoning_effort` | string | 否 | `none` / `minimal` / `low` / `medium` / `high`；也可用 `reasoning.effort`；默认 `none` |
| `tools` | array | 否 | 仅支持 `{"type":"web_search"}` 与 `{"type":"image_generation"}`；**默认**不可用的 tool 会被静默丢弃（不报错），在「模型配置 → 危险 / 高级操作」关闭“静默清理”后返回 400（见 `docs/ADMIN_API_V2.md` §26） |
| `web_search` | boolean | 否 | `tools` 的快捷写法，等价于 `tools:[{"type":"web_search"}]` |
| `image_generation` | boolean | 否 | `tools` 的快捷写法，等价于 `tools:[{"type":"image_generation"}]` |

消息格式：

- `role`：`system` / `developer` / `user` / `assistant`；
- `content`：字符串，或 `[{ "type": "text", "text": "..." }]` 形式的 parts 数组；
- `system` / `developer` 消息会与网关默认提示词合并（见 [FAQ](#system-prompt-为什么默认走-inline-模式)）；
- 图片（`image_url`）、文件等非文本 part **会被忽略**（不报错）；
- 多轮对话直接把历史 `user` / `assistant` 消息按顺序传入即可。

> OpenAI 的 `temperature` / `max_tokens` / `top_p` / `stop` 等采样参数**当前不支持**（上游为网页会话协议），
> 传入会被忽略；`max_tokens` 不会截断输出，请客户端自行控制。

### 3.2 非流式示例

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-duck-REPLACE_ME" \
  -d '{
    "model": "gpt-6-luna",
    "messages": [
      {"role": "system", "content": "你是一个严谨的中文技术助手。"},
      {"role": "user", "content": "用三句话解释什么是 MCP。"}
    ],
    "reasoning_effort": "low"
  }'
```

响应：

```json
{
  "id": "chatcmpl-3f1c0d9e7a5b4c21",
  "object": "chat.completion",
  "created": 1793514000,
  "model": "gpt-6-luna",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "MCP 是……",
        "refusal": null,
        "reasoning_content": "（模型支持且返回推理时的思考摘要）"
      },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 32,
    "completion_tokens": 210,
    "total_tokens": 242,
    "estimated": true,
    "estimation": "chars/4"
  },
  "system_fingerprint": null
}
```

字段扩展说明：

- `message.reasoning_content`：模型返回的推理摘要（可能不存在）；
- `message.annotations`：联网搜索时为 `[{ "type": "url_citation", "url_citation": { "url", "title" } }]`；
- `message.sources`：来源明细 `[{ "title", "url", "snippet" }]`（OpenAI 客户端可忽略）；
- `message.images`：图片生成时为 `[{ "b64_json", "format", "width?", "height?", "model?" }]`；
- `usage` 是**估算值**：上游不提供 token 计数，网关按字符数 / 4 估算，`estimated:true` 显式标注。

### 3.3 流式示例

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-duck-REPLACE_ME" \
  -d '{
    "model": "gpt-6-luna",
    "stream": true,
    "web_search": true,
    "messages": [{"role": "user", "content": "今天有什么科技新闻？"}]
  }'
```

SSE 结构：

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1793514000,"model":"gpt-6-luna","system_fingerprint":null,"choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1793514000,"model":"gpt-6-luna","system_fingerprint":null,"choices":[{"index":0,"delta":{"content":"今天"},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1793514000,"model":"gpt-6-luna","system_fingerprint":null,"choices":[{"index":0,"delta":{"annotations":[{"type":"url_citation","url_citation":{"url":"https://example.com/a","title":"示例来源"}}],"sources":[{"title":"示例来源","url":"https://example.com/a","snippet":"..."}],"images":[{"b64_json":"...","format":"jpeg"}]},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1793514000,"model":"gpt-6-luna","system_fingerprint":null,"choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}]}

data: [DONE]
```

- 正文增量在 `choices[0].delta.content`；
- 推理增量在 `choices[0].delta.reasoning_content`；
- 搜索来源会随搜索完成以 `delta.annotations` + `delta.sources` 增量下发（可能多次）；
- 生成图片以 `delta.images` 增量下发；
- 结束标记为 `data: [DONE]`；
- 服务端每 25 秒发送注释行 `: keep-alive` 保活（SDK 会自动忽略）；
- 若开启 `stream_options.include_usage`，在 `finish_reason` 之后还有一条 `choices: []` 且带 `usage` 的 chunk。

### 3.4 响应头

| 响应头 | 说明 |
| --- | --- |
| `X-Duckai-Model` | 实际解析到的模型 id（经过别名与 `duck-` 前缀归一） |
| `X-Duckai-Reasoning-Effort` | 实际生效的推理档位 |
| `X-Duckai-Reasoning-Adjusted` | `true` 表示请求档位被就近映射 |
| `X-Duckai-Reasoning-Note` | 映射说明（URL 编码） |
| `X-Request-Id` | 请求 id |

流式响应会在写出第一行数据前设置上述头；非流式响应在所有头正常设置后再写 body。

### 3.5 队列与限流（RPS）

v2 起所有上游调用（`/v1/chat/completions`、`/v1/responses`、`/v1/images/generations` 与管理后台连接测试）
统一经过 **FIFO 队列**（`config.upstream`）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `upstream.rps` | 1 | 每秒最多开始的上游请求数 |
| `upstream.maxConcurrent` | 1 | 同时执行的上游请求上限 |
| `upstream.queueLimit` | 50 | 排队上限，超出立即返回 429 |
| `upstream.queueTimeoutMs` | 300000 | 排队等待超时（毫秒） |

- 队列满 → `429 queue_full`；排队超时 → `429 queue_timeout`；两者都可能带 `Retry-After`（秒）；
- 默认 `rps=1`：并发请求串行排队，响应耗时包含排队时间（上游日志有独立 `queueWaitMs` 字段）；
- 配置可在管理后台「设置」页或 `PUT /admin/api/config` 修改，**实时生效、无需重启**；
- 另有第三类 429：**上游匿名额度限流** → `429 rate_limit_exceeded`（冷却约 50–60 秒，透传
  `Retry-After` / `X-Duckai-Retry-At`）。

> 客户端建议：遇到任何 429 都按 `Retry-After` 指数退避，不要并发重试；需要吞吐时调大
> `rps` / `maxConcurrent` 前请先确认上游额度与风控。

---

## 4. Responses API `POST /v1/responses`

### 4.1 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 否 | 同 chat（付费模型受 `allowPaidModels` 限制） |
| `input` | string \| array | **是** | 字符串（等价于一条 user 消息）或 OpenAI input 消息数组 |
| `instructions` | string | 否 | 等价于 system 指令（与网关默认提示词合并） |
| `reasoning.effort` | string | 否 | 同 `reasoning_effort`，缺省 `none` |
| `tools` | array | 否 | 支持 `{"type":"web_search"}` / `{"type":"image_generation"}` |
| `stream` | boolean | 否 | `true` 返回 Responses 事件流 |
| `metadata` | object | 否 | 原样回显 |
| `max_output_tokens` | number | 否 | 原样回显（上游不强制截断） |
| `temperature` / `top_p` | number | 否 | 原样回显（不参与上游采样） |
| `previous_response_id` | string | 否 | 原样回显（网关不保存状态） |
| `store` | boolean | 否 | 当前始终为 `false`（无状态网关） |

### 4.2 非流式示例

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-duck-REPLACE_ME" \
  -d '{
    "model": "gpt-6-luna",
    "instructions": "你是一个严谨的中文技术助手。",
    "input": "今天有什么科技新闻？",
    "tools": [{"type": "web_search"}]
  }'
```

响应：

```json
{
  "id": "resp_9a7c...",
  "object": "response",
  "created_at": 1793514000,
  "status": "completed",
  "model": "gpt-6-luna",
  "output": [
    {
      "id": "rs_...",
      "type": "reasoning",
      "status": "completed",
      "summary": [{"type": "summary_text", "text": "…"}]
    },
    {
      "id": "msg_...",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "今天的科技新闻包括……",
          "annotations": [
            {"type": "url_citation", "url_citation": {"url": "https://example.com", "title": "示例来源"}}
          ],
          "logprobs": []
        }
      ]
    }
  ],
  "output_text": "今天的科技新闻包括……",
  "annotations": [
    {"type": "url_citation", "url_citation": {"url": "https://example.com", "title": "示例来源"}}
  ],
  "reasoning": {"effort": "none", "summary": []},
  "usage": {
    "input_tokens": 18,
    "output_tokens": 160,
    "total_tokens": 178,
    "estimated": true,
    "estimation": "chars/4"
  },
  "metadata": {},
  "store": false,
  "parallel_tool_calls": false,
  "tool_choice": "auto",
  "tools": [{"type": "web_search"}]
}
```

图片生成时 `output` 中会追加：

```json
{
  "id": "ig_...",
  "type": "image_generation_call",
  "status": "completed",
  "result": "<base64>",
  "output_format": "jpeg"
}
```

### 4.3 流式事件

`stream:true` 时响应为 `text/event-stream`，请个事件形如：

```
event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":6,"delta":"今天","response_id":"resp_...","item_id":"msg_...","output_index":1,"content_index":0,"logprobs":[]}
```

事件顺序（`sequence_number` 从 0 递增）：

| 事件 | 时机 | 关键字段 |
| --- | --- | --- |
| `response.created` | 开始 | `response`（status=`in_progress` 快照） |
| `response.in_progress` | 开始 | `response` |
| `response.output_item.added` | 新增输出项 | `output_index`、`item` |
| `response.reasoning_summary_part.added` | 有推理时 | `item_id`、`summary_index`、`part` |
| `response.reasoning_summary_text.delta` | 推理增量 | `delta` |
| `response.reasoning_summary_text.done` | 推理结束 | `text` |
| `response.reasoning_summary_part.done` | 推理结束 | `part` |
| `response.content_part.added` | 文本项开始 | `content_index`、`part` |
| `response.output_text.delta` | 正文增量 | `delta`、`content_index` |
| `response.output_text.annotation.added` | 搜索来源 | `annotation_index`、`annotation` |
| `response.output_text.done` | 正文结束 | `text` |
| `response.content_part.done` | 文本 part 结束 | `part` |
| `response.image_generation_call.in_progress` | 图片开始 | `item_id`、`output_index` |
| `response.image_generation_call.completed` | 图片完成 | `result`（base64） |
| `response.output_item.done` | 单个输出项结束 | `output_index`、`item` |
| `response.completed` | 全部完成 | `response`（status=`completed`，含 `usage`） |
| `response.failed` | 失败 | `response.error` |
| `error` | 失败 | `code`、`message`、`param` |

> 注意：`output_text.delta` 的文本在 `delta` 字段；搜索来源通过
> `response.output_text.annotation.added` 下发，最终也会聚合到 `response.completed.response.output_text`。

---

## 5. 图片生成 `POST /v1/images/generations`

上游 duck.ai 通过同一个 `/chat` 端点生成图片，网关封装为 OpenAI Images API。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | **是** | 图片描述，≤ 32000 字符 |
| `model` | string | 否 | 必须支持 `image_generation`（如 `gpt-6-luna`），缺省用默认模型；付费模型需 `allowPaidModels=true` |
| `n` | number | 否 | 1–4，默认 1（请张图会串行调用一次上游） |
| `size` | string | 否 | 仅做格式校验（`1024x1024` / `auto`），上游不保证精确尺寸 |
| `response_format` | string | 否 | `b64_json`（默认）或 `url`（返回 data URL） |

```bash
curl http://127.0.0.1:8787/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-duck-REPLACE_ME" \
  -d '{
    "model": "gpt-6-luna",
    "prompt": "一只戴墨镜的橘猫，扁平插画风，纯色背景",
    "n": 1,
    "response_format": "b64_json"
  }'
```

响应：

```json
{
  "created": 1793514000,
  "data": [{ "b64_json": "/9j/4AAQSkZJRgABAQ..." }],
  "model": "gpt-6-luna",
  "model_display_name": "GPT Image",
  "response_id": "img_4d2a..."
}
```

- `response_format:"url"` 时返回 `{ "url": "data:image/jpeg;base64,..." }`，仍是 data URL（无对象存储）。
- 模型不支持图片生成 → `400 model_not_supported`；`tools.imageGeneration=false` → `400 tool_disabled`。
- 上游未返回图片 → `400 no_image_returned`。

---

## 6. 健康检查 `GET /healthz`

```bash
curl http://127.0.0.1:8787/healthz
```

```json
{
  "ok": true,
  "service": "duckai-cpa",
  "version": "0.1.0",
  "uptimeSec": 3210,
  "upstream": {
    "ok": true,
    "version": "serp_20261030_223718_ET-61e4601",
    "challengeOk": true,
    "latencyMs": 120,
    "rateLimited": false
  }
}
```

- `upstream.challengeOk`：`x-vqd-hash-1` 挑战是否已就绪；
- `upstream.rateLimited`：上游是否处于 429 限流窗口（可能省略）；
- 服务本身可响应即 `ok:true`；上游异常时 `upstream.ok:false`，但 HTTP 仍为 200。

---

## 7. `reasoning_effort` 映射

网关接受 5 档标准值，但请个模型在上游只支持部分档位。网关策略：

1. 不在枚举内的值 → `400 invalid_reasoning_effort`；
2. 模型不支持推理 → 强制 `none`；
3. 支持但请求档位不在列表 → **就近映射**（距离相同时取更高档），并通过响应头
   `X-Duckai-Reasoning-Adjusted: true` + `X-Duckai-Reasoning-Note` 告知。

示例（`gpt-6-luna` 支持 none/low）：

| 请求 | 实际生效 |
| --- | --- |
| `none` | `none` |
| `minimal` | `low`（调整） |
| `low` | `low` |
| `medium` | `low`（调整） |
| `high` | `low`（调整） |

`gpt-5.4-mini`（none/low/medium）：`minimal→low`、`high→medium`，其余原样。

> 推理摘要只在模型/会话返回时下发（`reasoning_content` / `reasoning.summary`），匿名会话下可能为空。

---

## 8. 工具映射（联网搜索 / 图片生成）

| 能力 | `/v1/chat/completions` | `/v1/responses` | 结果位置 |
| --- | --- | --- | --- |
| 联网搜索 | `tools:[{"type":"web_search"}]` 或 `web_search:true` | `tools:[{"type":"web_search"}]` | chat：`message.annotations` + `message.sources`；responses：`output_text.annotations` |
| 图片生成 | `tools:[{"type":"image_generation"}]` 或 `image_generation:true` | `tools:[{"type":"image_generation"}]` | chat：`message.images`；responses：`image_generation_call.result` |

约束：

- 只有 `web_search` 与 `image_generation` 两种工具；其它类型（含 function calling）→ `400 unsupported_tool`；
- 模型不支持对应工具 → `400 tool_not_supported`；
- 管理后台 `tools.webSearch=false` / `tools.imageGeneration=false` 时 → `400 tool_disabled`；
- 搜索结果统一为 `url_citation` 注解（`{type, url_citation:{url,title}}`），最多保留 20 条，按 URL 去重；
- 图片以 base64 返回，`format` 通常为 `jpeg`/`png`。

---

## 9. 错误码

所有错误 body 结构：`{"error":{"message","type","code","param"}}`。

| HTTP | type | code（常见） | 含义与处理 |
| --- | --- | --- | --- |
| 400 | `invalid_request_error` | `model_not_found` | 模型不存在；先请求 `/v1/models` |
| 400 | `invalid_request_error` | `invalid_reasoning_effort` | 档位不在 5 个枚举内 |
| 400 | `invalid_request_error` | `messages_required` | `messages` 为空或缺少 user 文本 |
| 400 | `invalid_request_error` | `tool_disabled` | 配置里禁用了该工具 |
| 400 | `invalid_request_error` | `tool_not_supported` | 该模型不支持该工具 |
| 400 | `invalid_request_error` | `unsupported_tool` | 只支持 web_search / image_generation |
| 400 | `invalid_request_error` | `prompt_required` / `invalid_n` / `invalid_size` / `invalid_response_format` | 图片接口参数校验 |
| 400 | `invalid_request_error` | `invalid_json` | 请求体不是合法 JSON |
| 401 | `authentication_error` | `invalid_api_key` | **v2 强制**：缺少/错误/已吊销的 API Key |
| 403 | `model_unavailable` | `model_requires_subscription` | 付费模型（Plus/Pro）在 `allowPaidModels=false` 时被网关拦截 |
| 403 | `permission_error` | `upstream_subscription_required` | `allowPaidModels=true` 但上游账号无订阅（`ERR_ACCOUNT_LIMIT`） |
| 403 | `content_filter` | `content_filter` | 上游拒绝/审核拦截（`ERR_REFUSAL` / moderation） |
| 403 | `permission_error` | `forbidden` | 其他上游拒绝 |
| 404 | `invalid_request_error` | `not_found` | 路由或资源不存在 |
| 405 | `invalid_request_error` | `method_not_allowed` | 方法不允许（响应头含 `Allow`） |
| 413 | `invalid_request_error` | `payload_too_large` | 请求体超过 8 MB |
| 429 | `rate_limit_exceeded` | `rate_limit_exceeded` | **上游匿名额度限流**；带 `Retry-After` / `X-Duckai-Retry-At`，冷却约 50–60s |
| 429 | `rate_limit_exceeded` | `queue_full` | 网关排队已满（`upstream.queueLimit`），稍后重试或调大队列 |
| 429 | `rate_limit_exceeded` | `queue_timeout` | 网关排队等待超时（`upstream.queueTimeoutMs`） |
| 429 | `rate_limit_exceeded` | `upstream_anomaly_check` | 上游风控/异常校验（可能以 403 返回） |
| 499 | `aborted` | `client_closed_request` | 客户端提前断开（服务端日志会记录） |
| 500 | `server_error` | `internal_error` | 网关内部错误 |
| 502 | `upstream_error` | `upstream_protocol_mismatch` | 上游响应严格校验失败（非 SSE、缺挑战头、未知事件、缺 `[DONE]` 等），网关立即中断 |
| 502 | `upstream_error` | `upstream_no_image` | 图片生成结束但未拿到 `b64Image` |
| 502 | `upstream_error` | 其他上游 code（如 `ERR_CHALLENGE`） | 上游失败/挑战未通过；`X-Duckai-Retriable: true` 表示可重试 |
| 504 | `upstream_timeout` | `ERR_TIMEOUT` 等 | 上游超时（`duck.timeoutMs`，默认 120s） |

> **严格中断**：`DuckClient` 默认 `strictProtocol: true`。若上游在**首事件前**失败（429/502/403 等），
> 返回普通 JSON 错误；若**流式已开始**后失败，SSE 先发 `error` 事件（含 `message`/`code`/`status`）再结束，
> **不会伪造完成事件**。错误详情（事件片段/事件名/序号）写入上游日志 `errorDetail`（不含敏感内容）。

---

## 10. OpenAI SDK 接入

只要把 `base_url` 指向 `http://<host>:<port>/v1` 即可，其余用法与 OpenAI 一致。
**v2 强制 API Key**：`api_key` 必须填管理后台「API Key」页创建的 Key（或首次启动自动创建的 `default` key），
否则所有请求都会返回 `401 invalid_api_key`。

### 10.1 Python

```bash
pip install openai
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-duck-REPLACE_ME")

# 非流式
resp = client.chat.completions.create(
    model="gpt-6-luna",
    messages=[{"role": "user", "content": "用三句话解释什么是 MCP"}],
    extra_body={"reasoning_effort": "low"},
)
print(resp.choices[0].message.content)
print(getattr(resp.choices[0].message, "annotations", []))

# 流式 + 联网搜索
stream = client.chat.completions.create(
    model="gpt-6-luna",
    messages=[{"role": "user", "content": "今天有什么科技新闻？"}],
    stream=True,
    extra_body={"web_search": True},
)
for chunk in stream:
    delta = chunk.choices[0].delta.content if chunk.choices else None
    if delta:
        print(delta, end="", flush=True)

# 图片生成
image = client.images.generate(
    model="gpt-6-luna",
    prompt="一只戴墨镜的橘猫，扁平插画风",
    response_format="b64_json",
)
print(image.data[0].b64_json[:40], "...")
```

### 10.2 Node.js

```bash
npm i openai
```

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "sk-duck-REPLACE_ME"
});

const completion = await client.chat.completions.create({
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "用三句话解释什么是 MCP" }],
  reasoning_effort: "low"
});
console.log(completion.choices[0].message.content);

const stream = await client.chat.completions.create({
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "今天有什么科技新闻？" }],
  stream: true,
  web_search: true
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

### 10.3 Responses API

```python
resp = client.responses.create(
    model="gpt-6-luna",
    instructions="你是一个严谨的中文技术助手。",
    input="今天有什么科技新闻？",
    tools=[{"type": "web_search"}],
)
print(resp.output_text)
```

> OpenAI SDK 的 `responses.stream()` 可直接消费本网关的事件流；如自行解析，
> 请按 `event:` 行区分事件类型，并忽略 `: keep-alive` 注释行。

---

## 11. 管理接口

v2 管理后台是 **React + shadcn 控制台**（源码 `webapp/`，`npm run build:web` 构建到 `web/`），
页面地址：`http://127.0.0.1:8787/admin`（首次启动的 adminToken 见启动日志、`data/config.json` 与
`/admin?token=<adminToken>` 快捷登录）。

管理 API（`/admin/api/*`）需要 **admin token**，与 `/v1/*` 的 API Key 是两套凭据：

- `Authorization: Bearer <adminToken>`，或 GET 时 `?token=<adminToken>`；
- 普通 API Key 不能访问管理接口（401）；
- 完整契约见 [`ADMIN_API_V2.md`](./ADMIN_API_V2.md)，要点：
  - `GET /admin/api/overview`：`stats.upstream` / `stats.admin` 拆分、`recentUpstream` / `recentAdmin`、
    `upstream.queue`（inFlight/waiting/rps/avgWaitMs 等）、模型免费/付费元数据；
  - `GET/PUT /admin/api/config`：`upstream`（RPS 队列）、`duck.allowPaidModels`、`prompts.mode`、工具、日志级别；
  - `GET/DELETE /admin/api/logs?kind=upstream|admin`：上游与后台日志分开分页/清空；
  - **会话式连接测试**（替代 v1 单次 `POST /admin/api/test`）：
    `GET/POST /admin/api/test/sessions`、`GET/PATCH/DELETE /admin/api/test/sessions/:id`、
    `POST /admin/api/test/sessions/:id/messages`（SSE：`session` / `delta` / `reasoning` / `search` /
    `image` / `done` / `error`，服务端按历史拼接多轮上下文并持久化）；
  - **重新生成 / 重试**：`POST /admin/api/test/sessions/:id/messages/:messageId/retry`（SSE 与 messages 相同，
    `session` 事件带 `retryOf`、`done.message` 带 `retriedFrom`；服务端截断该轮 user 提示之后的消息并原地重新生成，
    error 消息（如 429）同样可重试；错误码：`session_not_found` / `message_not_found` / `message_not_assistant` /
    `invalid_history` / `session_busy`）；
  - assistant 消息可能带 `reasoningEncrypted: true`（匿名档只有加密推理摘要，`reasoning` 为空，前端显示「推理已加密」提示）；
  - **身份 / Sync / 订阅（v2.2）**：
    `GET /admin/api/identity`（journeyId/deviceId/durable-stream 指纹/stable）、
    `POST /admin/api/identity/rotate`、`GET /admin/api/identity/export`（下载完整备份）、
    `POST /admin/api/identity/import`、`POST /admin/api/identity/reveal`
    （需 `{field:"token"|"mainKey", confirm:true}`，返回该字段明文一次；缺 confirm → 400 `confirmation_required`，
    field 非法 → 400 `invalid_field`）；
    `GET /admin/api/sync`、`POST /admin/api/sync/enable|disable|pairing-code|pair`、
    `GET/POST /admin/api/sync/recovery-code`（`transport:"blocked"` 时跨设备传输返回
    `503 sync_transport_unavailable`，本地密钥/配对码/恢复码能力仍可用）；
    `GET /admin/api/subscription`、`POST /admin/api/subscription/activate|verify`、`DELETE /admin/api/subscription`
    （token 只写 `data/identity.json`，接口不返回明文；付费模型仍受 `duck.allowPaidModels` 控制；
    `verified` 语义为 `verifyScope:"reachability"`：仅表示 token 本地解析通过 + 上游可达，
    不代表 Duck.ai 确认订阅有效，真实档位以实际请求上游为准）；
  - **出站代理（v2.3）**：`GET /admin/api/proxy`（配置 + status，不返回密码，`hasAuth` 表示已保存）、
    `PUT /admin/api/proxy`（部分配置，深合并，`password` 省略=不修改/空串=清除，非法字段 `400 invalid_proxy`）、
    `POST /admin/api/proxy/test`（临时 dispatcher 测试，200 返回 `{ok,mode,status,latencyMs,exitIp,error,code}`，
    失败也用 200 便于前端展示）、`GET /healthz` 增加 `proxy` 摘要；代理仅作用于服务端出站请求；
  - **身份池 / 会话绑定（v2.4）**：`GET /admin/api/identities`（`pool` 概览 + 脱敏身份列表，含每身份
    `queue:{waiting,inFlight,rps}`）、`POST /admin/api/identities`（新建 / `{import}` 导入）、
    `POST /admin/api/identities/generate`（批量 1–20）、`GET|PATCH|DELETE /admin/api/identities/:id`
    （删除被默认身份/会话绑定时 409 `identity_in_use`，`?force=true` 强制并清理绑定）、
    `POST /admin/api/identities/:id/activate|rotate`、`GET .../export`（含私钥/token 的完整文件）、
    `POST|DELETE .../:id/subscription`（订阅绑定/解除）；
    `GET/POST /admin/api/identities/bindings`、`DELETE /admin/api/identities/bindings/:sessionKey`
    （sessionKey → identity 持久化映射，手工覆盖自动路由）；
    `GET /admin/api/identities/routing`、`PATCH /admin/api/identities/router`（`hash` / `least-loaded`，
    salt 轮换只影响新绑定）。测试会话的列表/详情新增 `identityId` / `identityLabel`。
  - **会话 → 身份路由（v2.4，`/v1/*`）**：调用方传 `X-Session-Id: <稳定会话标识>`（或 body
    `session_id` / `conversation_id`，含 `metadata.*` 嵌套）即可把同一会话固定到身份池中的同一匿名身份；
    不传则单轮 least-loaded 路由且不写绑定。命中时响应头返回 `X-Duckai-Identity-Id` /
    `X-Duckai-Identity-Label`，有排队等待时附 `X-Duckai-Queue-Wait: <ms>`；`/v1/*` 本身仍无状态、
    不保存对话历史（多轮请回传完整 `messages` / `input`）。
  - **会话级并发（v2.5）**：同一会话流式中再次发送消息/重试返回
    `409 session_busy`（`error.code:"session_busy"`，响应头 `Retry-After: 1`、
    `X-Duckai-Retriable: true`）；不同会话可并行，前端按会话独立维护流式状态与 AbortController。
    命中身份时响应头 `X-Duckai-Identity-Id` / `X-Duckai-Identity-Label`，排队等待时
    `X-Duckai-Queue-Wait`（JSON 与 SSE 均有）；SSE `done` 事件顶层带 `identityId/identityLabel/queueWaitMs`；
  - **扫码配对（v2.5，PairingHost 真实频道）**：先 `POST /admin/api/sync/pairing` 向
    `sync.duckduckgo.com` 注册真实 Sync 频道，**成功返回 `url` 后**再由前端本地渲染二维码
    （旧版本地生成 code2 的二维码无法完成握手）。成功返回
    `{ok, channelId, pairingCode, url, qrUrl, expiresAt, state:"waiting", accountAvailable, pairing:{...}}`；
    错误：409 `pairing_in_progress`、400 `sync_not_enabled`、503 `sync_transport_unavailable`、
    502 `pairing_start_failed`。`GET /admin/api/sync/pairing` → `{pairing: status|null}`，
    状态 `waiting|hello|exchange|completed|failed|timeout`，另有
    `endReason/peerChannelId/peerName/peerKind/expiresInMs/messages[]`（message 仅 `dir/type/at/seq?/httpStatus?`，已脱敏）；
    `completedAs` 为 `joiner` 时表示手机下发了官方恢复码、由网关自动落盘（`GET official-recovery-code`
    随即返回 `configured:true` 与 preview），`host` 表示网关向手机提供了恢复码；
    `DELETE /admin/api/sync/pairing`（关闭弹窗/切换页面必须调用）。官方恢复码（可选）：
    `GET/PUT/DELETE /admin/api/sync/official-recovery-code`（GET 仅返回
    `configured/hasCode/updatedAt/preview/length`，不回显明文；PUT body `{code}`，DELETE 清除）。
    扫码后会自动接收手机的官方恢复码；仅在手机端失败时再手动粘贴重试（UI 已按此文案与状态展示）；
  - **身份设备与轮换（v2.8）**：`GET /admin/api/sync` 新增
    `server:{registered,deviceName,userId}`；`GET /admin/api/sync/server-devices` →
    `{devices:[{id,name,type,credential_id,jwt_iat,thisDevice}],total,server}`；
    `POST /admin/api/sync/register-device` 注册本机（未配置官方恢复码 → 400 `recovery_code_required`，
    代理不可用 → 503 `sync_transport_unavailable`）；`DELETE /admin/api/sync/server-devices/:id`
    （当前设备 → 409 `cannot_remove_current_device`）；`PUT /admin/api/config` 支持
    `identity.deviceName`（默认 `DuckCPA@<4hex>`，传 `null` 恢复默认，用于手机 My Devices 识别）；
    `POST /admin/api/identity/rotate`（及身份池 `.../:id/rotate`）返回
    `{identityLost:true, note}`，前端为两步确认（第二步「确认轮换（不可恢复）」危险按钮）并展示丢失提示。
    设备注册/设备列表遇 DuckDuckGo Sync 登录限流时返回 **429 `sync_rate_limited`**（`retryAfterMs` / `hint`），
    前端显示「DuckDuckGo Sync 限流中，请 X 秒后重试」并保持按钮可重试；400/401/503 保持各自提示；
  - **身份设备名 / 设备槽（v2.9）**：身份池 `items[]` 新增 **`deviceName`**（默认身份 `DuckAI@main`，
    其它 `DuckCPA@<4hex>`；身份表格以设备名为主标识，label 仅作副标题）；默认身份删除返回
    **409 `default_identity_protected`**；`GET /admin/api/sync/device-slots` →
    `{identityIds:[...], slots:[{identityId}], saved, savedAt}`；`PUT /admin/api/sync/device-slots`
    body `{identityIds:[string]}` 保存后生效（前端两栏拖拽：左身份池设备 / 右 DuckDuckGo 设备槽，
    默认身份初始在右侧、可拖出且账号保留；保存后重新拉取 device-slots + `/sync` + server-devices；
    429 同上显示限流秒数）；
  - **设备列表独立卡片 / 设备槽删除保护（v2.10）**：`GET /admin/api/sync/device-slots` 增加
    `orphans`（身份已删除/禁用的设备槽，数组）与 `orphansCount`；`PUT /admin/api/sync/device-slots?reconcile=true`
    清理失效设备（同样受 429 限流）；删除身份时若仍在设备槽返回 **409 `identity_in_device_slots`**
    （前端弹窗提供「先去设备列表移除」/「移除设备并删除（force）」），`DELETE /identities/:id?force=true`
    会同时移除设备槽并删除身份（可能注销设备）；默认身份仍只返回 409 `default_identity_protected` 且无 force。
    身份页设备槽 UI 已从 Sync & Backup 卡拆为独立「DuckDuckGo 设备列表」卡片（`#ddg-device-list-card`）；
  - **模型上下文 / 会话压缩 / 官方恢复码明文（v2.11）**：
    `GET /v1/models`（及 `overview.models`）新增 `contextWindowChars` / `maxInputChars` / `maxOutputTokens` /
    `capabilities[]`（前端显示「上下文约 N 字符（估算 tokens）」+ 联网/图片/推理/免费|付费标签）；
    会话列表/详情新增 `summary:{text, coveredPairCount, coveredMessageCount, updatedAt}`；
    `POST /admin/api/test/sessions/:id/compact` → `{ok, session, summary, compacted, coveredMessageCount}`；
    流式 `done` 事件可带 `compacted:true` + `summary` + `coveredMessageCount`（自动压缩提示条）；
    429/413 保留可重试提示。`GET /admin/api/sync/official-recovery-code` 现返回完整 `code`（等同账号密钥），
    新增 `GET /admin/api/sync/official-recovery-code/download`（txt 附件）；前端在配置后直接展示完整 code，
    并提供复制/下载/「查看恢复码二维码」Modal（本地 qrcode，内容为完整 code）；
  - **摘要折叠块 / 编辑清除 / 模型压缩支持（v2.12）**：模型新增
    `compactionSupported`（`gpt-6-luna` 等为 false）、`activationTargetPairCount`（约 N 轮后自动压缩）、
    `inputCharLimit`；前端显示「支持自动压缩 · 约 N 轮后」/「不支持自动压缩」，不再用固定「16k 就压缩」文案。
    `summary` 增加 `savedChars`（节省字符）；
    `PATCH /admin/api/test/sessions/:id/summary` body `{text}`（或 `{summary}`）更新摘要 → `{ok, session, summary}`；
    `DELETE /admin/api/test/sessions/:id/summary` 清除压缩恢复完整消息 → `{ok, session, summary:null}`。
    会话页在消息流顶部渲染可折叠卡片「上下文摘要 · 覆盖 N 条消息 / 节省 X 字符」（默认折叠，展开可复制/编辑/清除压缩），
    头部徽章点击联动展开并滚动高亮。

---

## 常见问题 FAQ

### 429 / 限流与排队

v2 有三类 429，处理方式不同：

1. **上游匿名额度限流** `rate_limit_exceeded`：duck.ai 匿名会话连续请求触发（实测冷却约 **50–60 秒**），
   响应带 `Retry-After` / `X-Duckai-Retry-At`；管理后台连接测试会中文提示「匿名额度受限，请稍后重试」；
2. **网关排队已满** `queue_full`：并发请求超过 `upstream.queueLimit`（默认 50），稍后重试或调大队列；
3. **网关排队超时** `queue_timeout`：等待超过 `upstream.queueTimeoutMs`（默认 300000ms）。

默认 `upstream.rps=1`、`maxConcurrent=1`，所有上游调用串行排队；客户端建议：

- 遇 429 按 `Retry-After` 指数退避（上游限流至少等 60 秒），**不要并发重试**；
- 需要吞吐时在「设置」页调大 `rps` / `maxConcurrent` / `queueLimit` 并观察是否触发上游风控；
- 服务端另有拟人化限流（随机延迟、指数退避），不要绕过。

### system-prompt 为什么默认走 inline 模式？

实测匿名 duck.ai 会话**不接受 `system` 角色**（直接前置 system 消息会被上游以 400 拒绝），
因此网关默认 `prompts.mode="inline"`，把系统提示词合并进用户消息：

- `inline`（默认，推荐）：以 `[系统指令] …\n\n[用户] …` 前缀合并进**首条 user 消息**；
- `system`：作为独立 `system` 消息前置，仅在确认上游行为变化时使用（当前不推荐）。

系统提示词来源（按顺序拼接）：`prompts.defaultSystemPrompt` → `prompts.defaults[<model>]` →
请求里的 `system` / `developer` / `instructions`。管理后台「配置」页可改。

### 为什么 usage 是估算的？

上游网页协议不返回 token 计数。网关按 **字符数 / 4** 估算，并在 `usage` 中标注
`estimated: true`、`estimation: "chars/4"`。不要把该值用于精确计费。

### 流式输出里没有推理内容？

匿名会话下多数模型不返回推理摘要；`reasoning_effort` 只影响上游请求参数，
不保证一定返回 `reasoning_content`。若为 `none` 则一定没有推理内容。

### 图片返回的是 base64，不是 URL

`/v1/images/generations` 默认返回 `b64_json`；`response_format:"url"` 返回的是 `data:` URL。
需要持久化请客户端自行解码保存（注意 `jpeg` 格式需补 `.jpg` 后缀）。

### 支持 function calling / 自定义工具吗？

不支持（v2.39 曾实验性支持，v2.42 已移除）。仅支持 `web_search` 与 `image_generation` 两种**内置工具**；
OpenAI `tools[].function` 默认会被静默丢弃（`models.tools.dropUnsupported=false` 时返回 `400 unsupported_tool`）。
需要函数调用请在客户端自行实现「把工具结果拼回 prompt」。

### 模型别名与 `duck-` 前缀

`gpt-6-luna`、`duck-gpt-6-luna`、`gpt-6`、`gpt6`、`duck` 都指向同一模型；
自定义别名在配置 `models.aliases` 中维护，管理后台保存后即时生效。

### 免费 / 付费模型怎么用？

- `/v1/models` 中 `paid:false` 为免费模型（匿名可用）；`paid:true` 为 Plus/Pro 付费模型；
- 默认 `duck.allowPaidModels=false`：付费模型 `available:false`，请求返回 `403 model_requires_subscription`；
- 在管理后台「设置」页开启 `allowPaidModels` 后网关放行，但仍要求 duck.ai 账号本身有对应订阅
  （否则上游返回 `ERR_ACCOUNT_LIMIT`，映射为 `403 upstream_subscription_required`）；
- 管理后台的模型选择器会把付费模型置灰并显示「付费 · 需订阅」。

### 队列满了 / 并发被串行怎么办？

按设计，所有上游请求共用 FIFO 队列（默认 `rps=1`、`maxConcurrent=1`）。并发请求会排队，
响应里耗时包含排队时间，服务端上游日志有独立 `queueWaitMs`。可在「设置」页调整
`rps` / `maxConcurrent` / `queueLimit` / `queueTimeoutMs`，保存后实时生效。

### 上游挑战失败 / 502 `ERR_CHALLENGE`

网关会自动重新获取 `x-vqd-hash-1` 挑战并退避重试 2–3 次；仍失败时返回 502。
排查顺序：`GET /healthz` 看 `upstream.challengeOk` → 检查网络是否只能访问 `https://duck.ai` →
查看服务端日志（挑战求解超时、版本号变化等）→ 必要时重启服务重新预热挑战。

### 反向代理 / Nginx 下流式被缓冲

网关已设置 `X-Accel-Buffering: no` 且每 25 秒发送 `: keep-alive`。若仍被缓冲，
在 Nginx 对应 location 加：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
chunked_transfer_encoding on;
```

### 多轮对话怎么传？

把历史消息按 `user` / `assistant` 顺序原样传入 `messages`（或 Responses 的 `input` 数组）即可，
网关每次都会把完整历史转发给上游。`/v1/*` 当前**无状态**，不保存 `conversation_id` / `previous_response_id`；
需要服务端保存多轮历史的场景请使用管理后台「连接测试」的会话式测试（`/admin/api/test/sessions`）。

### 请求被取消会怎样？

客户端断开后网关会中止上游请求，日志中记录 `499 client_closed_request`；
流式请求不会继续消耗上游额度。

### 管理后台打不开 / 一直要求登录

- 页面地址：`http://127.0.0.1:8787/admin`（React 控制台，源码 `webapp/`）；
- 若仓库内 `web/` 为空，先构建前端：`npm run build:web`（Vite 输出到 `web/`，资源路径 `/admin/assets/*`）；
- adminToken 在首次启动日志里打印一次，也写入 `data/config.json` 的 `auth.adminToken`；
- 可用环境变量 `DUCKAI_CPA_ADMIN_TOKEN` 覆盖（容器部署推荐）；
- 401 会清除本地 token 并回到登录门；也可用 `/admin?token=<adminToken>` 直接进入；
- 首次启动还会自动创建 `default` API Key（完整值打印一次），`/v1/*` 调用必须使用它。

---

## 版本与兼容性

- 当前版本：`0.1.0`（Node.js ≥ 20，推荐 24）；
- **v2 是破坏性版本**：`/v1/*` 强制 API Key、删除 `auth.required`、删除旧单次 `POST /admin/api/test`、
  日志/统计拆分（`stats.upstream` / `stats.admin`、`recentUpstream` / `recentAdmin`）、新增 RPS 队列与
  免费/付费模型。旧 v1 前端（手写 `web/index.html`）已被 React 控制台替换；旧 data 文件会自动迁移或丢弃；
- 兼容 OpenAI Chat Completions / Responses / Images 的**常用子集**，扩展字段（`sources`、`images`、
  `reasoning_content`、`estimated`、`queueWaitMs`）在标准客户端中可安全忽略；
- 上游 duck.ai 协议可能变化：若出现 418/429/字段变更，请先查看 `docs/PROTOCOL.md`、
  `docs/PROTOCOL-ERRORS.md` 与 `GET /healthz`，再调整 `config/config.example.json` 或等待网关适配更新。

---

## 22. v2.15 订阅池（前端）

- 左侧新增「订阅」标签页（`#/subscriptions`）：新增订阅（粘贴 token）、改名、校验、删除、绑定身份数；
- 「身份池」页新增「订阅」列（显示订阅名称 + tier 徽章，未绑定显示「未绑定」）；
- 绑定改为**选择器**：选项来自 `GET /admin/api/subscriptions`，确认后 `POST /admin/api/identities/:id/subscription {subscriptionId}`；
- 「身份」页保留 Sync/官方恢复码；订阅入口改为提示前往「订阅」页。

## v2.35：图片响应格式（OpenAI 兼容）

### `POST /v1/images/generations`

```json
{
  "created": 1793779201,
  "data": [{
    "b64_json": "/9j/4AAQSkZJRg...",
    "revised_prompt": "一只戴帽子的橘猫",
    "format": "jpeg",
    "mime_type": "image/jpeg"
  }],
  "model": "gpt-6-luna",
  "response_id": "img_..."
}
```

- `response_format:"url"` 时 `data[0]` 是 `{ "url": "data:image/jpeg;base64,..." }`；
- duck.ai 实际返回 **JPEG**，网关按 base64 魔数探测真实格式，`format`/`mime_type`/data URI 的 MIME 一致；
- `revised_prompt` 回显请求的 prompt（OpenAI 兼容字段）。

### `POST /v1/chat/completions`（`tools:[{type:"image_generation"}]`）

Chat Completions 没有官方的 assistant 图片字段，采用主流 OpenAI 兼容网关（OpenRouter/LobeChat/OpenWebUI）
约定：`message.images` 数组，每项同时给出 data URI 与 base64：

```json
"images": [{
  "type": "image_url",
  "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQ..." },
  "b64_json": "/9j/4AAQ...",
  "format": "jpeg",
  "mime_type": "image/jpeg",
  "model": "GPT Image 2"
}]
```

流式响应中同样通过 `choices[0].delta.images` 下发该结构。

### `POST /v1/responses`

图片以 OpenAI Responses 官方格式返回：`output` 中的 `image_generation_call` 项，
`result` 为 base64，`output_format` 为真实格式（`jpeg`/`png`/`webp`）。
## v2.42：自定义 tools 已移除

v2.39 的网关级 function calling（`tools.functionCalling.*`）与 MCP 工具（`tools.mcp.*`）已全部删除。
现在只保留 duck.ai 原生内置工具：`web_search`、`image_generation`、`location`（设置 → 工具）。
OpenAI `tools[].function` 视为不支持的 tool：默认静默丢弃；`models.tools.dropUnsupported=false` 时返回 `400 unsupported_tool`。