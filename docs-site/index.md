---
layout: home

hero:
  name: DuckAI CPA
  text: Duck.ai 的 OpenAI 兼容网关
  tagline: 一套自托管、可审计、面向长期会话的网关：多身份池、订阅续期、图片上下文、PDF 上下文、客户端工具桥与完整管理控制台。
  image:
    src: /logo.svg
    alt: DuckAI CPA
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quickstart
    - theme: alt
      text: 浏览 API
      link: /api/overview

features:
  - icon: 🔌
    title: OpenAI 形状，直接接入
    details: Chat Completions、Responses、Images、Models、Compact 与 OpenAI SDK/客户端兼容；流式 SSE、工具调用、reasoning 与图片一应俱全。
  - icon: 🪪
    title: 多身份池与双池路由
    details: 每个身份独立 journeyId、设备指纹、队列与额度；付费模型路由到订阅身份，免费模型路由到匿名身份，绑定自动复用。
  - icon: 🔁
    title: 订阅登录与自动续期
    details: 从已登录浏览器捕获 DuckDuckGo 会话，保存 refresh token，到期前自动续期并同步绑定身份。
  - icon: 🧠
    title: Authoritative Session
    details: 网关是 canonical 会话的唯一所有者；客户端历史只用于 diff，跨轮精确复用 upstream 前缀，不重复压缩图片或改写旧消息。
  - icon: 📄
    title: PDF 上下文溢出
    details: 超过 duck.ai 文本上限时，自动把旧对话与工具协议渲染成两个 PDF；当前 user 保留文本，图片嵌入上下文 PDF。
  - icon: 🛡️
    title: 为私有部署设计
    details: API Key 与 admin token 分离、代理出口 IP 脱敏、SQLite WAL、请求日志、用量统计与可回滚的发布流程。
---

<HomeHighlights />
