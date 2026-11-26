/** /v1/responses routes (POST create + GET/DELETE /:id + GET /:id/input_items). */
import {
  handleResponses,
  handleGetResponse,
  handleDeleteResponse,
  handleListResponseInputItems
} from '../../../openai/responses.js';
import { methodNotAllowed, notFound } from '../../../openai/errors.js';

export function createResponsesRoutes() {
  return [
    {
      path: '/v1/responses',
      prefix: true,
      handler: async (ctx) => {
        const rest = ctx.pathname.slice('/v1/responses'.length);
        const parts = rest.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
        if (parts.length === 0) {
          if (ctx.method !== 'POST') throw methodNotAllowed(ctx.method, 'POST');
          ctx.log.endpoint = 'POST /v1/responses';
          await handleResponses(ctx.req, ctx.res, ctx);
          return;
        }
        if (parts.length === 1) {
          const id = parts[0];
          if (ctx.method === 'GET' || ctx.method === 'HEAD') {
            await handleGetResponse(ctx, id);
            return;
          }
          if (ctx.method === 'DELETE') {
            await handleDeleteResponse(ctx, id);
            return;
          }
          throw methodNotAllowed(ctx.method, 'GET, HEAD, DELETE');
        }
        if (parts.length === 2 && parts[1] === 'input_items') {
          if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
            throw methodNotAllowed(ctx.method, 'GET, HEAD');
          }
          await handleListResponseInputItems(ctx, parts[0]);
          return;
        }
        throw notFound(`Unknown endpoint: ${ctx.method} ${ctx.pathname}`);
      }
    }
  ];
}

export default { createResponsesRoutes };
