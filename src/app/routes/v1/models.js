/** /v1/models routes (Phase 2; thin wrappers, behavior unchanged). */
import { notFound } from '../../../openai/errors.js';
import { handleListModels, listModelsPayload } from '../../../openai/models.js';
import { requireMethod } from '../../http/router.js';

export function createModelsRoutes({ config }) {
  return [
    {
      path: '/v1/models',
      handler: async (ctx) => {
        requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
        ctx.log.endpoint = 'GET /v1/models';
        await handleListModels(ctx.req, ctx.res, ctx);
      }
    },
    {
      path: '/v1/models',
      prefix: true,
      handler: async (ctx) => {
        requireMethod(ctx, ['GET', 'HEAD'], 'GET, HEAD');
        const modelId = decodeURIComponent(ctx.pathname.slice('/v1/models/'.length));
        const found = listModelsPayload(config).data.find((model) => model.id === modelId);
        if (!found) throw notFound(`Model "${modelId}" not found`, 'model_not_found');
        ctx.log.endpoint = 'GET /v1/models/:id';
        ctx.json(200, found);
      }
    }
  ];
}

export default { createModelsRoutes };
