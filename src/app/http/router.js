/** Basic route helpers: /healthz, /, /favicon.ico (Phase 1 split; responses unchanged). */
import { methodNotAllowed } from '../../openai/errors.js';
import { getProxyHealthSummary } from '../../admin/proxy-routes.js';

export function requireMethod(ctx, allowed, allowHeader = null) {
  if (allowed.includes(ctx.method)) return;
  throw methodNotAllowed(ctx.method, allowHeader || allowed.join(', '));
}

export async function handleHealthz(ctx, deps) {
  requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
  const upstream = await deps.getUpstreamHealth();
  let identityPool = null;
  if (deps.identities && typeof deps.identities.getSummary === 'function') {
    try {
      const summary = deps.identities.getSummary() || {};
      let busy = 0;
      if (typeof deps.identities.queueStats === 'function') {
        const queueStats = await deps.identities.queueStats();
        busy = Number(queueStats?.totals?.inFlight) || 0;
      }
      identityPool = {
        total: summary.total ?? 0,
        enabled: summary.enabled ?? 0,
        subscribed: summary.subscribed ?? 0,
        busy
      };
    } catch {
      identityPool = null;
    }
  }
  ctx.json(200, {
    ok: true,
    service: deps.serviceName,
    version: deps.version,
    uptimeSec: Math.round((Date.now() - deps.serviceStartedAt) / 1000),
    upstream,
    proxy: await getProxyHealthSummary(ctx),
    identityPool,
    queue: deps.queue.snapshot?.() || null
  });
}

export function handleRoot(ctx, { version, config }) {
  requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
  ctx.text(200, renderIntroPage({ version, config }), 'text/html; charset=utf-8');
}

export function handleFavicon(ctx) {
  requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
  ctx.head(204);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderIntroPage({ version, config }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml('duckai-cpa')} v2</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 860px; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.65; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    pre { background: rgba(127,127,127,.12); padding: .9rem 1rem; border-radius: .5rem; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    td, th { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid rgba(127,127,127,.25); }
    .tag { font-size: .8rem; opacity: .75; }
  </style>
</head>
<body>
  <h1>${escapeHtml('duckai-cpa')} <span class="tag">v2</span></h1>
  <p class="tag">OpenAI-compatible gateway for duck.ai · version ${escapeHtml(version)}</p>
  <p>管理后台：<a href="/admin/">/admin</a> · 健康检查：<a href="/healthz">/healthz</a></p>
  <p><strong>v2 起所有 <code>/v1/*</code> 请求必须携带 API Key</strong>（<code>Authorization: Bearer sk-duck-…</code>），首次启动会自动生成 default key 并打印一次，也可在管理后台创建。</p>
  <table>
    <tr><th>方法</th><th>路径</th><th>说明</th></tr>
    <tr><td>GET</td><td><code>/v1/models</code></td><td>模型列表（含免费/付费标记）</td></tr>
    <tr><td>POST</td><td><code>/v1/chat/completions</code></td><td>对话补全（stream / web_search / image_generation / reasoning_effort）</td></tr>
    <tr><td>POST</td><td><code>/v1/responses</code></td><td>OpenAI Responses API</td></tr>
    <tr><td>POST</td><td><code>/v1/images/generations</code></td><td>图片生成</td></tr>
<tr><td>POST</td><td><code>/v1/compact</code></td><td>客户端显式上下文压缩（返回摘要 + 保留的最近消息）</td></tr>
    <tr><td>—</td><td><code>/admin/api/*</code></td><td>管理 API（adminToken）</td></tr>
  </table>
  <h2>快速开始</h2>
  <pre>curl http://127.0.0.1:${escapeHtml(config.server.port)}/v1/chat/completions \\
  -H "Authorization: Bearer $DUCKAI_CPA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-6-luna","messages":[{"role":"user","content":"Hello"}]}'</pre>
</body>
</html>`;
}

export default { requireMethod, handleHealthz, handleRoot, handleFavicon };
