/** Public health/root/favicon routes (Phase 2; handlers still live in http/router). */
import { handleFavicon, handleHealthz, handleRoot } from '../http/router.js';

export function createHealthRoutes() {
  return [
    { path: '/healthz', handler: (ctx, deps) => handleHealthz(ctx, deps) },
    { path: '/health', handler: (ctx, deps) => handleHealthz(ctx, deps) },
    { path: '/', handler: (ctx, deps) => handleRoot(ctx, { version: deps.version, config: deps.config }) },
    { path: '/favicon.ico', handler: (ctx) => handleFavicon(ctx) }
  ];
}

export default { createHealthRoutes };
