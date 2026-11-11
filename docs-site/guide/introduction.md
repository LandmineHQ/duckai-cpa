# 项目介绍

**DuckAI CPA** 是一个自托管的 **duck.ai → OpenAI 兼容网关**。它把 DuckDuckGo AI Chat（`duck.ai`）的网页协议封装成标准 OpenAI API，并提供一个完整的 React 管理控制台。

> 本项目只面向**个人学习与私有部署**。请遵守 duck.ai 的服务条款，不要把它作为公共服务或用于批量抓取。

## 它解决什么问题

duck.ai 只提供网页聊天界面，没有稳定的服务端 API；普通 OpenAI SDK、客户端、Chatbox、Cherry Studio、Open WebUI 等客户端无法直接使用。

DuckAI CPA 在中间维护：

- 浏览器同形态的 **x-vqd-hash-1** 反爬挑战；
- **SSE 流式**与工具审批的 continuation；
- 多身份、订阅、额度与队列；
- 会话 canonical、图片与超长上下文的 PDF 化；
- 管理后台、日志、用量统计与私有部署所需的可观测性。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| OpenAI 兼容 API | `/v1/chat/completions`、`/v1/responses`、`/v1/images/generations`、`/v1/models`、`/v1/compact` |
| 流式 SSE | `delta.content`、`reasoning_content`、来源引用、图片与 usage |
| 多身份池 | 每个身份独立 journeyId、设备指纹、RSA 密钥、队列与额度 |
| 双池路由 | 付费模型走订阅身份，免费模型走匿名身份；会话绑定复用 |
| 订阅登录 | 浏览器捕获 token、refresh token 自动续期、身份同步 |
| 会话所有权 | authoritative session；客户端只发增量，网关保存 canonical 与精确 upstream 前缀 |
| 图片上下文 | 生成图片持久化；下一轮作为真实 image part 回放（JPEG → PNG ≤ 512px） |
| PDF 上下文 | 超 20k 字符时旧对话与工具协议分别渲染为 PDF，绕过文本上限 |
| 客户端工具桥 | OpenAI tools 自动归一化；文件工具由客户端执行，网关不接入外部工具 |
| 管理控制台 | 概览、连接测试、身份池、订阅、历史、日志、代理、模型配置、API Key |

## 架构一览

```text
OpenAI SDK / 客户端 / 桌面客户端
                │
                ▼
        ┌─────────────────┐
        │  Fastify / HTTP │  /v1/*  ·  /admin/api/*  ·  SSE
        └────────┬────────┘
                 │ 鉴权 · 路由 · 限流 · 请求日志
                 ▼
        ┌─────────────────┐
        │ 会话与身份路由层 │  canonical / session / pool / subscription
        └────────┬────────┘
                 │ 选身份 · 取队列 · 组装上下文
                 ▼
        ┌─────────────────┐
        │    Duck 协议层   │  challenge · SSE · continuation
        └────────┬────────┘
                 │
                 ▼
              duck.ai
```

更细的分层、请求流与部署形态见 [架构与请求流](/reference/architecture)。

## 适合谁

- 想用 OpenAI SDK/Agent 框架调用 duck.ai 的个人开发者；
- 需要多账号、订阅与额度管理的私有部署；
- 需要保留完整会话、图片与工具轨迹的可审计场景；
- 想研究 duck.ai 协议与反爬挑战的工程师。

## 不适合

- 对外提供多租户公共服务；
- 需要严格 SLA 或商业合规的生产系统；
- 需要模型/服务条款授权保证的场景。

## 下一步

- [快速开始](/guide/quickstart)：用 Docker Compose 或单文件二进制启动；
- [安装与部署](/guide/installation)：数据目录、环境变量、更新；
- [API 概览](/api/overview)：认证、错误格式与端点列表。
