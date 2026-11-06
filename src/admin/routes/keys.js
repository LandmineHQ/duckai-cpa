import { notFound } from '../../openai/errors.js';
import { methodNotAllowed, requireMethod } from './helpers.js';

async function handleKeys(ctx, keyId) {
  if (!keyId) {
    if (ctx.method === 'GET' || ctx.method === 'HEAD') {
      ctx.json(200, { items: ctx.store.listKeys() });
      return;
    }
    if (ctx.method === 'POST') {
      const label = ctx.body && typeof ctx.body === 'object' && typeof ctx.body.label === 'string' ? ctx.body.label : 'api-key';
      const created = ctx.store.createKey(label);
      if (!Array.isArray(ctx.config.auth.apiKeys)) ctx.config.auth.apiKeys = [];
      if (!ctx.config.auth.apiKeys.includes(created.key)) ctx.config.auth.apiKeys.push(created.key);
      await ctx.store.saveConfig(ctx.config);
      ctx.json(201, {
        id: created.id,
        label: created.label,
        key: created.key,
        createdAt: created.createdAt
      });
      return;
    }
    throw methodNotAllowed(ctx, 'GET, POST');
  }

  requireMethod(ctx, ['DELETE']);
  const deleted = ctx.store.deleteKey(keyId);
  if (!deleted) throw notFound(`API key "${keyId}" not found`, 'key_not_found');
  if (deleted.removedFromConfig) await ctx.store.saveConfig(ctx.config);
  ctx.json(200, { ok: true, id: keyId });
}

export { handleKeys };
export default { handleKeys };
