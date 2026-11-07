# 架构与请求流

## 分层

```text
src/
  app/
    http/          传输层：Fastify/native adapter、auth、body、CORS、SSE、static
    routes/        路由层：/healthz、/v1/*、/admin/api/*
    session/       会话领域：context assembly、manual compaction、authoritative state、save
  openai/          OpenAI 协议映射：chat/responses/images/models/compact/errors
  admin/           管理 API 与连接测试
  duck/            duck.ai 协议层：challenge、SSE、continuation、identity、proxy
  http/server.js   组合根 + request handler
  index.js         启动装配
```

依赖方向：

```text
routes -> domain/session -> openai/duck ports
app/http -> routes + ports
infra/duck -> external duck.ai
```

## 请求生命周期

以 `/v1/chat/completions` 为例：

```text
1. Fastify onRequest / native adapter
2. 鉴权：Bearer API Key
3. 解析请求体（4MB 上限）
4. 解析模型、工具、reasoning
5. 解析 session / canonical / epoch
6. 选择身份（pool / subscription / cooldown）
7. 组装上下文（图片 / PDF / 工具协议）
8. 上游串行队列
9. DuckClient：挑战 → SSE → continuation
10. 映射为 OpenAI SSE / JSON
11. 保存 canonical / upstream 快照 / history
12. 请求日志 / 用量
```

## 会话流水线

```text
客户端历史
  → normalize
  → diff canonical
  → 检查 epoch/fork/冲突
  → 图片回放
  → PDF/工具上下文装配
  → 上游请求
  → assistant 输出
  → canonical/upstream/history 保存
```

关键不变量：

- canonical 只追加，不重写旧消息；
- upstream 前缀逐字节稳定；
- 图片/PDF/工具变化显式新 epoch；
- 冲突返回 409，不静默猜测。

## 传输层

- 默认 Fastify，`HTTP_ADAPTER=native` 可回滚；
- 两种 adapter 共享同一个 Node request handler；
- Fastify 只做传输壳，body/SSE/静态/错误仍由共享逻辑处理。

## 身份与订阅

```text
request sessionKey
  → 绑定的 identity
  → 付费池 / 免费池
  → 每身份 RPS=1 队列
  → duck.ai
```

- 绑定有 TTL；
- 额度冷却身份不参与路由；
- 订阅身份只在付费池；
- 删除绑定订阅的身份需要先解绑。

## 数据

- SQLite WAL：`data/duckai.db`；
- 运行配置：`data/config.json`；
- 身份密钥：`data/identity.json`；
- 恢复码：`data/pairing.json`。

## 相关

- [功能说明](/guide/features)
- [数据与安全](/reference/security)
