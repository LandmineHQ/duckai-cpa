import {
  adminCatalogItems,
  getModelToolPolicy,
  modelConfigPayload,
  validateModelOverrides,
  validateModelToolPolicy
} from '../../openai/models.js';
import { badRequest } from '../../openai/errors.js';
import { methodNotAllowed, requireMethod } from './helpers.js';

async function handleModels(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  ctx.json(200, { items: adminCatalogItems(ctx.config) });
}

async function handleModelsConfigReset(ctx) {
  requireMethod(ctx, ['POST'], 'POST');
  if (!ctx.config.models || typeof ctx.config.models !== 'object') ctx.config.models = {};
  ctx.config.models.overrides = {};
  ctx.config.models.tools = { dropUnsupported: true, perModel: {} };
  await ctx.store.saveConfig(ctx.config);
  ctx.logger?.warn?.('model config reset to defaults');
  ctx.json(200, { ok: true, ...modelConfigPayload(ctx.config) });
}

async function handleModelsRefresh(ctx) {
  requireMethod(ctx, ['POST'], 'POST');
  const before = ctx.duck?.health ? await ctx.duck.health() : null;
  const startedAt = Date.now();
  let probe = null;
  let probeError = null;
  try {
    probe = ctx.duck?.health ? await ctx.duck.health({ probe: true }) : null;
  } catch (error) {
    probeError = error.message;
  }
  const catalog = adminCatalogItems(ctx.config);
  ctx.json(200, {
    ok: !probeError,
    catalogSource: 'static',
    catalogNote:
      '模型元数据为内置静态目录（src/duck/models.js），随网关版本更新；duck.ai 没有 /models 端点，/capabilities 只含 flags/实验。',
    modelCount: catalog.length,
    modelsVersion: catalog.map((item) => item.id).join(','),
    capabilities: probe?.capabilities ?? before?.capabilities ?? null,
    upstreamVersion: probe?.version ?? before?.version ?? null,
    challengeOk: probe?.challengeOk ?? before?.challengeOk ?? null,
    latencyMs: Date.now() - startedAt,
    probedAt: Date.now(),
    error: probeError
  });
}

async function handleModelsConfig(ctx) {
  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    ctx.json(200, modelConfigPayload(ctx.config));
    return;
  }
  if (ctx.method !== 'PUT' && ctx.method !== 'POST') {
    throw methodNotAllowed(ctx, 'GET, PUT');
  }
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : null;
  if (!body) throw badRequest('请求体必须是 JSON 对象');
  const { overrides, errors } = validateModelOverrides(body.overrides);
  if (errors.length) {
    throw badRequest(errors.join('；'), 'overrides', 'invalid_model_override');
  }
  if (!ctx.config.models || typeof ctx.config.models !== 'object') ctx.config.models = {};
  ctx.config.models.overrides = overrides;

  // v2.22：每模型工具开关 + 不支持工具的处理策略
  if (body.tools !== undefined) {
    const current = getModelToolPolicy(ctx.config);
    const { policy, errors } = validateModelToolPolicy(body.tools, adminCatalogItems(ctx.config));
    if (errors.length) {
      throw badRequest(errors.join('；'), 'tools', 'invalid_model_override');
    }
    ctx.config.models.tools = {
      dropUnsupported:
        policy.dropUnsupported === null ? current.dropUnsupported : policy.dropUnsupported !== false,
      perModel: body.tools.perModel === undefined ? current.perModel : policy.perModel
    };
  }

  await ctx.store.saveConfig(ctx.config);
  ctx.json(200, modelConfigPayload(ctx.config));
}

export { handleModels, handleModelsConfigReset, handleModelsRefresh, handleModelsConfig };
export default { handleModels, handleModelsConfigReset, handleModelsRefresh, handleModelsConfig };
