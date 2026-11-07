<template>
  <div class="vp-doc docs-home-extra">
    <section class="stats-strip" aria-label="项目概览">
      <div class="stat">
        <strong>OpenAI</strong>
        <span>兼容 API</span>
      </div>
      <div class="stat">
        <strong>1</strong>
        <span>单文件 / 容器</span>
      </div>
      <div class="stat">
        <strong>多身份</strong>
        <span>池化与路由</span>
      </div>
      <div class="stat">
        <strong>SQLite</strong>
        <span>会话与历史</span>
      </div>
    </section>

    <section class="highlight-grid" aria-label="核心能力">
      <article class="highlight-card">
        <div class="icon">⌘</div>
        <h3>一套接口，接入所有客户端</h3>
        <p>
          Chat Completions、Responses、Images、Models、Compact 全兼容 OpenAI 形状；
          Codex、DSH、Chatbox、Cherry Studio、Open WebUI 直接填 Base URL 即可。
        </p>
        <a href="./guide/quickstart">开始接入 →</a>
      </article>
      <article class="highlight-card">
        <div class="icon">◈</div>
        <h3>网关是会话的唯一所有者</h3>
        <p>
          authoritative session 维护 canonical、精确 upstream 前缀与图片/PDF 上下文；
          客户端只发增量，跨轮不会重复压缩图片或改写历史。
        </p>
        <a href="./reference/architecture">了解架构 →</a>
      </article>
      <article class="highlight-card">
        <div class="icon">⚡</div>
        <h3>为长会话准备的两个 PDF</h3>
        <p>
          超过 20k 字符时，旧上下文与客户端工具协议分别渲染为
          <code>conversation-context.pdf</code> 与 <code>client-tools.pdf</code>，
          绕过 duck.ai 文本上限，同时保留工具与图片。
        </p>
        <a href="./guide/features">功能说明 →</a>
      </article>
    </section>

    <section class="quick-panel">
      <div>
        <span class="eyebrow">30 秒运行</span>
        <h2>用 Docker Compose 启动</h2>
        <p>推荐使用预构建的最小镜像；数据保存在 named volume 中。</p>
      </div>
      <pre><code>services:
  duckai-cpa:
    image: ghcr.io/landminehq/duckai-cpa:latest
    ports: ["8787:8787"]
    volumes:
      - duckai-cpa-data:/data
volumes:
  duckai-cpa-data:</code></pre>
      <a class="cta" href="./guide/installation">查看完整安装指南 →</a>
    </section>

    <section class="screenshot-panel">
      <div class="copy">
        <span class="eyebrow">控制台</span>
        <h2>不只是 API，还有完整的管理面板</h2>
        <p>
          上游健康、队列与 RPS、身份池、订阅续期、会话历史、请求日志、用量统计、
          模型配置与连接测试都在同一个后台完成。
        </p>
        <ul>
          <li>代理出口 IP 默认脱敏，点击才显示真实值</li>
          <li>会话历史支持工具调用、图片、reasoning 与来源回放</li>
          <li>连接测试覆盖流式、图片生成、压缩与会话增量</li>
        </ul>
        <a href="./guide/admin-console">浏览控制台功能 →</a>
      </div>
      <figure>
        <img src="/assets/admin-overview.jpg" alt="DuckAI CPA 管理后台概览" loading="lazy" />
        <figcaption>管理后台「概览」页：健康、队列、用量、模型与日志。</figcaption>
      </figure>
    </section>
  </div>
</template>

<style scoped>
.stats-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 24px 0 40px;
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 10px;
  border-left: 2px solid var(--vp-c-brand-1);
}

.stat strong {
  font-size: 1.1rem;
  color: var(--vp-c-text-1);
}

.stat span {
  color: var(--vp-c-text-2);
  font-size: 0.86rem;
}

.highlight-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin: 32px 0;
}

.highlight-card {
  padding: 22px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
  transition: border-color 0.2s ease, transform 0.2s ease;
}

.highlight-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.highlight-card .icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  margin-bottom: 12px;
  border-radius: 10px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-weight: 800;
}

.highlight-card h3 {
  margin: 0 0 8px;
  font-size: 1.02rem;
  border: 0;
  padding: 0;
}

.highlight-card p {
  margin: 0 0 14px;
  color: var(--vp-c-text-2);
  font-size: 0.92rem;
}

.highlight-card a,
.quick-panel a,
.screenshot-panel a {
  color: var(--vp-c-brand-1);
  font-weight: 600;
  text-decoration: none;
}

.quick-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.9fr);
  gap: 24px;
  align-items: center;
  margin: 44px 0;
  padding: 28px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 20px;
  background: linear-gradient(135deg, var(--vp-c-bg-soft), var(--vp-c-bg));
}

.quick-panel h2,
.screenshot-panel h2 {
  margin: 6px 0 8px;
  font-size: 1.5rem;
}

.quick-panel p,
.screenshot-panel p {
  color: var(--vp-c-text-2);
}

.quick-panel pre {
  margin: 0;
  padding: 16px;
  overflow: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-code-block-bg);
  color: var(--vp-code-block-color);
  font-size: 0.82rem;
}

.quick-panel .cta {
  grid-column: 1 / -1;
}

.eyebrow {
  color: var(--vp-c-brand-1);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.screenshot-panel {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: 28px;
  align-items: center;
  margin: 44px 0;
}

.screenshot-panel ul {
  padding-left: 1.1rem;
  color: var(--vp-c-text-2);
}

.screenshot-panel figure {
  margin: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
}

.screenshot-panel img {
  display: block;
  width: 100%;
}

.screenshot-panel figcaption {
  padding: 10px 12px;
  color: var(--vp-c-text-3);
  font-size: 0.78rem;
}

@media (max-width: 860px) {
  .stats-strip,
  .highlight-grid,
  .quick-panel,
  .screenshot-panel {
    grid-template-columns: 1fr;
  }

  .quick-panel .cta {
    grid-column: auto;
  }
}
</style>
