/** /v1/compact route (Phase 2; thin wrapper, behavior unchanged). */
import { handleCompact } from '../../../openai/compact.js';
import { requireMethod } from '../../http/router.js';

export function createCompactRoutes() {
  return [
    {
      path: '/v1/compact',
      handler: async (ctx) => {
        requireMethod(ctx, ['POST'], 'POST');
        ctx.log.endpoint = 'POST /v1/compact';
        await handleCompact(ctx.req, ctx.res, ctx);
      }
    }
  ];
}

export default { createCompactRoutes };
