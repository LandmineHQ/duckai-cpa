# 功能说明

本页按使用场景说明 DuckAI CPA 的核心机制。只想快速接入可以看 [快速开始](/guide/quickstart)；需要字段细节看 [API 文档](/api/overview)。

## 1. OpenAI 兼容层

### 端点

| 端点 | 用途 |
| --- | --- |
| `POST /v1/chat/completions` | Chat Completions，支持流式/非流式、tools、图片 |
| `POST /v1/responses` | Responses API，支持 `previous_response_id` 链式会话 |
| `POST /v1/images/generations` | 独立图片生成 |
| `GET /v1/models` | 模型目录与上下文/工具能力 |
| `POST /v1/compact` | 手动压缩并生成新的上下文 PDF |
| `GET /healthz` | 健康检查（不需要鉴权） |

### 流式

- Chat：标准 `chat.completion.chunk` + 最后一帧 `[DONE]`；
- Responses：命名事件（`response.created`、`response.output_text.delta`、`response.completed` 等），带递增 `sequence_number`；
- reasoning 通过 `reasoning_content` / reasoning item 回放；
- 图片通过 chat `message.images` / responses `image_generation_call` 返回；
- 客户端断开时会 abort 上游请求。

## 2. 会话所有权（Authoritative Session）

网关是**唯一会话所有者**：

- 稳定 session（`X-Session-Id`、`conversation_id`、`prompt_cache_key`、`previous_response_id` 链）下，客户端历史只用于 diff；
- canonical 由网关保存，`conversation_state.client_json` 保存上次客户端视图；
- 第二轮回放只 append suffix；只发新 user/tool 输入视为 delta；
- 无前缀的短历史/冲突返回 **409 `session_history_mismatch`**；
- 需要编辑历史/分支时显式带 `X-Session-Fork: true` 或 `session_epoch`；
- 普通轮次复用持久化 `upstream_json` 精确前缀，不每轮 rebuild。

这保证：

- 旧消息逐字节稳定；
- 图片压缩只发生一次；
- PDF/工具协议变化通过新 epoch 处理；
- 历史来自 canonical，不会被客户端下一轮错误回放覆盖。

### 什么时候会新 epoch

- 客户端明确 fork / 指定新 epoch；
- 工具集合变化（toolsHash 变化）；
- 系统提示词变化；
- 手动压缩/上下文 PDF 变化。

## 3. 图片上下文

生成图片不会只返回一次：

- `/v1/chat/completions` 的 `message.images` 使用 data URI + `b64_json`（OpenRouter/LobeChat 约定）；
- `/v1/responses` 使用官方 `image_generation_call.result`；
- 下一轮客户端回放 `image_generation_call` / `image_url` 时，网关会把它作为真实 image part 继续发送；
- 上游只稳定接受 PNG/WebP，JPEG 会自动转 PNG 并缩到 512px；
- 图片还会保存到会话状态与历史，避免 assistant 空消息导致“图片被丢弃”。

## 4. PDF 上下文溢出

duck.ai 的文本输入有字符上限（约 20k）。超过阈值时：

1. 除当前 user 外的历史渲染成 `conversation-context.pdf`（≤15 页，250 行/页，图片嵌入）；
2. 客户端工具协议渲染成 `client-tools.pdf`（1 页）；
3. 当前 user 保留文本，同时附带两个 PDF file part；
4. 同一会话的 context PDF 持久化复用，只有再次触发溢出或 `/v1/compact` 才更新。

超过 15 页会返回 `413 context_pdf_capacity_exceeded`，不会静默丢内容。

## 5. 客户端工具桥

- OpenAI `tools[].function` 在 Chat/Responses 两端都会自动归一化；
- 网关只负责把工具调用返回给客户端，**不执行文件工具，不接入外部工具**；
- 下一轮接受 `role:"tool"` / `function_call_output`；
- 工具协议固定在第一条 user，保证历史前缀稳定；
- 工具调用的 JSON 即使被上游截断少量括号，也会修复后再解析，避免把原始 JSON 当正文发给客户端。

## 6. 多身份与路由

- 付费模型 → 订阅身份池；免费模型 → 匿名身份池；
- 每个会话首次路由后绑定身份，只有跨池才改绑；
- 每个身份独立队列，RPS=1；
- 额度冷却：上游返回每日/实体额度时写入 `cooldownUntil`，到期自动恢复；
- 全冷却时返回 `429 all_identities_cooling`；
- 绑定缓存有 TTL，过期后自动清理。

## 7. 订阅与续期

- 登录 token 从已登录浏览器捕获，不要求网关能访问 DuckDuckGo 登录页；
- refresh token 加密保存，每 5 分钟巡检，到期前自动续期；
- 续期后同步到绑定该订阅的身份；
- 删除已绑定订阅的身份会被拒绝（`409 identity_has_subscription`）。

## 8. 可观测性

- upstream/admin 日志分离；
- 每条请求带 requestId、sessionKey、identity；
- 历史记录保存工具调用、图片、reasoning、来源与注入元数据；
- `/admin/api/history/:id/upstream` 可查看脱敏后的真实 upstream messages；
- 用量统计按模型与“身份 × 模型”聚合；
- 代理出口 IP 默认脱敏展示。

## 9. 安全与私有部署

- `/v1/*` 强制 API Key；
- `/admin/api/*` 强制 admin token；
- 请求体大小限制、CORS、静态路径穿越防护；
- 敏感文件 0600；
- 建议放在内网或认证反向代理后；
- 不要提交 `data/`、`recon/`、抓包或密钥。
