/** /v1/chat/completions route (Phase 2; thin wrapper, behavior unchanged). */
import { handleChatCompletions } from '../../../openai/chat.js';
import { requireMethod } from '../../http/router.js';

export function createChatRoutes() {
  return [
    {
      path: '/v1/chat/completions',
      handler: async (ctx) => {
        requireMethod(ctx, ['POST'], 'POST');
        ctx.log.endpoint = 'POST /v1/chat/completions';
        await handleChatCompletions(ctx.req, ctx.res, ctx);
      }
    }
  ];
}

export default { createChatRoutes };
