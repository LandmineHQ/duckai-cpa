/** Admin routes: capture (public), /admin/api thin wrapper, /admin static UI (Phase 2, behavior unchanged). */
import path from 'node:path';
import { handleAdminRequest } from '../../admin/routes.js';
import { authorizeAdmin } from '../http/auth.js';
import { applyCaptureCors } from '../http/cors.js';
import { requireMethod } from '../http/router.js';
import { resolveStaticPath, serveAdminIndex, serveStaticFile } from '../http/static.js';

export function createAdminRoutes({ config, webDir, serviceName }) {
  return [
    {
      path: '/admin/api/subscriptions/capture',
      handler: async (ctx) => {
        requireMethod(ctx, ['POST'], 'POST, OPTIONS');
        applyCaptureCors(ctx.res, ctx.req);
        ctx.log.record = false;
        const { handleSubscriptionCapture } = await import('../../admin/subscriptions-routes.js');
        await handleSubscriptionCapture(ctx);
      }
    },
    {
      path: '/admin/api',
      prefix: true,
      handler: async (ctx) => {
        ctx.log.record = true;
        ctx.log.kind = 'admin';
        const adminRoute = ctx.pathname.slice('/admin/api'.length) || '/';
        ctx.log.endpoint = `${ctx.method} /admin/api${adminRoute}`;
        authorizeAdmin(ctx, config);
        await handleAdminRequest(ctx, adminRoute, ctx.method);
      }
    },
    {
      path: '/admin',
      prefix: true,
      handler: async (ctx) => {
        requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
        const relative =
          ctx.pathname === '/admin' || ctx.pathname === '/admin/' ? '' : ctx.pathname.slice('/admin/'.length);
        if (!relative) {
          await serveAdminIndex(ctx, { webDir, serviceName });
          return;
        }
        const filePath = resolveStaticPath(webDir, relative);
        if (filePath && (await serveStaticFile(ctx, filePath, { cacheControl: 'public, max-age=3600' }))) return;
        // SPA fallback for client-side routes (no file extension → index.html).
        if (!path.extname(relative) && !relative.startsWith('assets/')) {
          await serveAdminIndex(ctx, { webDir, serviceName });
          return;
        }
        ctx.text(404, 'Not found', 'text/plain; charset=utf-8');
      }
    }
  ];
}

export default { createAdminRoutes };
