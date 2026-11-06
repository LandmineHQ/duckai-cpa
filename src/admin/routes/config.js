import {
  applyConfigPatch,
  deepApply,
  deepClone,
  redactConfig,
  resetConfig,
  RESTART_REQUIRED_PATHS
} from '../../config.js';
import { getByDottedPath, methodNotAllowed, requireMethod } from './helpers.js';

async function handleGetConfig(ctx) {
  requireMethod(ctx, ['GET', 'HEAD']);
  ctx.json(200, { config: redactConfig(ctx.config) });
}

async function handlePutConfig(ctx) {
  requireMethod(ctx, ['PUT', 'POST']);
  let patch = ctx.body;
  if (patch && typeof patch === 'object' && !Array.isArray(patch) && patch.config && typeof patch.config === 'object') {
    patch = patch.config;
  }
  const result = applyConfigPatch(ctx.config, patch);
  await ctx.store.saveConfig(ctx.config);
  // v2.30：pool 配置（如 bindingTtlDays）实时生效（池对象读取的是同一个 config 引用）
  try {
    if (result.changes.includes('pool.bindingTtlDays')) ctx.identities?.pruneBindings?.();
  } catch (error) {
    ctx.logger?.warn?.('failed to apply pool settings', { error: error.message });
  }
  // v2.8: keep the persisted identity deviceName in sync with config.identity.deviceName.
  try {
    await ctx.syncDevices?.ensureDeviceName?.();
  } catch (error) {
    ctx.logger?.warn?.('failed to apply identity.deviceName', { error: error.message });
  }
  try {
    ctx.logger?.setLevel?.(ctx.config.logging.level);
  } catch {
    // ignore logger update failures
  }
  ctx.json(200, {
    ok: true,
    config: redactConfig(ctx.config),
    restartRequired: result.restartRequired,
    ...(result.ignored.length ? { ignored: result.ignored } : {}),
    // upstream / allowPaidModels / auth changes apply live; queue reads config live
    applied: result.changes
  });
}

async function handleResetConfig(ctx) {
  requireMethod(ctx, ['POST']);
  const before = deepClone({
    server: { host: ctx.config.server.host, port: ctx.config.server.port },
    duck: {
      baseUrl: ctx.config.duck.baseUrl,
      userAgent: ctx.config.duck.userAgent,
      challenge: ctx.config.duck.challenge,
      humanize: ctx.config.duck.humanize
    }
  });
  const reset = await resetConfig({
    currentConfig: ctx.config,
    apiKeys: ctx.store.getManagedKeyStrings?.() || []
  });
  deepApply(ctx.config, reset.config);
  await ctx.store.saveConfig(ctx.config);
  try {
    ctx.logger?.setLevel?.(ctx.config.logging.level);
  } catch {
    // ignore
  }
  const restartRequired =
    RESTART_REQUIRED_PATHS.some(
      (dotted) => JSON.stringify(getByDottedPath(before, dotted)) !== JSON.stringify(getByDottedPath(ctx.config, dotted))
    ) || JSON.stringify(before.duck?.humanize) !== JSON.stringify(ctx.config.duck?.humanize);
  ctx.json(200, {
    ok: true,
    config: redactConfig(ctx.config),
    restartRequired
  });
}

export { handleGetConfig, handlePutConfig, handleResetConfig };
export default { handleGetConfig, handlePutConfig, handleResetConfig };
