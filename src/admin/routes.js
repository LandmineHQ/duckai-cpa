/**
 * Admin API for duckai-cpa v2 (`/admin/api/*`).
 *
 * Contract: docs/ADMIN_API_V2.md. Authentication is enforced by
 * src/http/server.js before this module runs (admin token only).
 *
 * Routes:
 *   GET    /admin/api/overview
 *   GET    /admin/api/config            PUT /admin/api/config      POST /admin/api/config/reset
 *   GET    /admin/api/logs?kind=                                 DELETE /admin/api/logs?kind=
 *   GET    /admin/api/keys              POST /admin/api/keys       DELETE /admin/api/keys/:id
 *   GET    /admin/api/models
 *   GET    /admin/api/health
 *   GET    /admin/api/test/sessions     POST /admin/api/test/sessions
 *   GET    /admin/api/test/sessions/:id PATCH ...                  DELETE ...
 *   POST   /admin/api/test/sessions/:id/messages   (SSE)
 *
 * v2 BREAKING: the old single-shot `POST /admin/api/test` route is removed (404).
 */

import { handleIdentityRoutes } from './identity-routes.js';
import { handleProxyRoutes } from './proxy-routes.js';
import { handleIdentityPoolRoutes } from './identity-pool-routes.js';
import { handleSubscriptionRoutes } from './subscriptions-routes.js';
import { friendlyErrorMessage, methodNotAllowed, requireMethod } from './routes/helpers.js';
import { handleHealth, handleOverview } from './routes/overview.js';
import { handleModels, handleModelsConfig, handleModelsConfigReset, handleModelsRefresh } from './routes/models.js';
import { handleGetConfig, handlePutConfig, handleResetConfig } from './routes/config.js';
import { handleLogs, handleLogsDownload, handleLogsRetention, handleUsage } from './routes/logs.js';
import { handleKeys } from './routes/keys.js';
import { handleHistory } from './routes/history.js';
import { handleSessions } from './routes/sessions.js';
import { notFound } from '../openai/errors.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export async function handleAdminRequest(ctx, route, method) {
  const parts = String(route || '/')
    .split('/')
    .filter(Boolean);
  const head = parts[0] || '';

  // v2.2 identity / sync & backup / subscription (docs/IDENTITY-SYNC.md §3).
  if (head === 'identity' || head === 'sync' || head === 'subscription') {
    return handleIdentityRoutes(ctx, parts, method);
  }
  // v2.3 proxy (docs/PROXY.md §3).
  if (head === 'proxy') {
    return handleProxyRoutes(ctx, parts, method);
  }
  // v2.4 identity pool (docs/IDENTITY-POOL.md §5).
  if (head === 'identities') {
    return handleIdentityPoolRoutes(ctx, parts, method);
  }
  // v2.15 first-class subscriptions (docs/ADMIN_API_V2.md §21).
  if (head === 'subscriptions') {
    return handleSubscriptionRoutes(ctx, parts, method);
  }

  switch (head) {
    case 'overview':
      if (parts.length !== 1) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleOverview(ctx);
    case 'config':
      if (parts.length === 1) {
        if (method === 'GET' || method === 'HEAD') return handleGetConfig(ctx);
        if (method === 'PUT' || method === 'POST') return handlePutConfig(ctx);
        throw methodNotAllowed(ctx, 'GET, PUT');
      }
      if (parts.length === 2 && parts[1] === 'reset') return handleResetConfig(ctx);
      throw notFound(`Unknown admin endpoint: ${method} ${route}`);
    case 'logs':
      if (parts.length === 2 && parts[1] === 'download') return handleLogsDownload(ctx);
      if (parts.length === 2 && parts[1] === 'retention') return handleLogsRetention(ctx);
      if (parts.length !== 1) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleLogs(ctx);
    case 'usage':
      if (parts.length !== 1) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleUsage(ctx);
    case 'keys':
      if (parts.length > 2) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleKeys(ctx, parts[1] || null);
    // v2.28：duck.ai 默认提示词生成器（源码逻辑）
    case 'prompts': {
      if (parts.length >= 2 && parts[1] === 'duckai') {
        if (parts.length === 2) {
          requireMethod(ctx, ['GET', 'HEAD']);
          const { promptOptionCatalog } = await import('../duck/prompt.js');
          ctx.json(200, promptOptionCatalog());
          return;
        }
        if (parts.length === 3 && parts[2] === 'preview') {
          requireMethod(ctx, ['POST']);
          const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
          const { buildDuckAiPrompt, normalizeDuckAiCustomization } = await import('../duck/prompt.js');
          const customization = normalizeDuckAiCustomization(body?.customization ?? body);
          const prompt = buildDuckAiPrompt(customization);
          ctx.json(200, { ok: true, customization, prompt, length: prompt.length });
          return;
        }
      }
      throw notFound(`Unknown admin endpoint: ${method} ${route}`);
    }
    case 'models':
      if (parts.length === 2 && parts[1] === 'config') return handleModelsConfig(ctx);
      if (parts.length === 3 && parts[1] === 'config' && parts[2] === 'reset') {
        return handleModelsConfigReset(ctx);
      }
      if (parts.length === 2 && parts[1] === 'refresh') return handleModelsRefresh(ctx);
      if (parts.length !== 1) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleModels(ctx);
    case 'history':
      return handleHistory(ctx, parts, method, route);
    case 'health':
      if (parts.length !== 1) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleHealth(ctx);
    case 'test':
      if (parts[1] === 'sessions') return handleSessions(ctx, parts.slice(2));
      // v2 BREAKING: the old POST /admin/api/test single-shot endpoint is gone.
      throw notFound(`Unknown admin endpoint: ${method} ${route}`);
    default:
      throw notFound(`Unknown admin endpoint: ${method} ${route}`);
  }
}

// Re-exported for tests / tooling.
export { friendlyErrorMessage };