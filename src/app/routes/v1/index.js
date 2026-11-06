/** /v1 route group: auth/log setup (unchanged) + nested thin routes (Phase 2). */
import { notFound } from '../../../openai/errors.js';
import { authorizeV1 } from '../../http/auth.js';
import { createRouter } from '../../http/router.js';
import { createChatRoutes } from './chat.js';
import { createCompactRoutes } from './compact.js';
import { createImagesRoutes } from './images.js';
import { createModelsRoutes } from './models.js';
import { createResponsesRoutes } from './responses.js';

export function createV1Route({ config }) {
  const router = createRouter([
    ...createModelsRoutes({ config }),
    ...createChatRoutes(),
    ...createCompactRoutes(),
    ...createResponsesRoutes(),
    ...createImagesRoutes()
  ]);

  return {
    path: '/v1/',
    prefix: true,
    handler: async (ctx) => {
      ctx.log.record = true;
      ctx.log.kind = 'upstream';
      ctx.log.source = 'v1';
      ctx.log.endpoint = `${ctx.method} ${ctx.pathname}`;
      authorizeV1(ctx);
      const matched = await router.dispatch(ctx);
      if (!matched) throw notFound(`Unknown request URL: ${ctx.method} ${ctx.pathname}`);
    }
  };
}

export default { createV1Route };
