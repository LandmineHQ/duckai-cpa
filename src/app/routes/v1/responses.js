/** /v1/responses route (Phase 2; thin wrapper, behavior unchanged). */
import { handleResponses } from '../../../openai/responses.js';
import { requireMethod } from '../../http/router.js';

export function createResponsesRoutes() {
  return [
    {
      path: '/v1/responses',
      handler: async (ctx) => {
        requireMethod(ctx, ['POST'], 'POST');
        ctx.log.endpoint = 'POST /v1/responses';
        await handleResponses(ctx.req, ctx.res, ctx);
      }
    }
  ];
}

export default { createResponsesRoutes };
