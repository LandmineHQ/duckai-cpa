/** /v1/images/generations route (Phase 2; thin wrapper, behavior unchanged). */
import { handleImagesGenerations } from '../../../openai/images.js';
import { requireMethod } from '../../http/router.js';

export function createImagesRoutes() {
  return [
    {
      path: '/v1/images/generations',
      handler: async (ctx) => {
        requireMethod(ctx, ['POST'], 'POST');
        ctx.log.endpoint = 'POST /v1/images/generations';
        await handleImagesGenerations(ctx.req, ctx.res, ctx);
      }
    }
  ];
}

export default { createImagesRoutes };
