/**
 * QA 辅助：解析 v2.4 IdentityPool 模块（src/duck/identity-pool.js）。
 *
 * 导出：PoolError（IdentityPoolError 别名）/ IdentityPool / createIdentityPool / POOL_FILE_NAME。
 */

const CANDIDATES = ['../../src/duck/identity-pool.js', '../../src/duck/identityPool.js'];

let cached = null;

export async function loadPoolModule() {
  if (cached) return cached;
  const errors = [];
  for (const candidate of CANDIDATES) {
    try {
      const mod = await import(candidate);
      const factory = mod.createIdentityPool || (typeof mod.default === 'function' ? mod.default : null);
      if (typeof factory !== 'function') {
        errors.push(`${candidate}: 未导出 createIdentityPool`);
        continue;
      }
      cached = {
        module: mod,
        createIdentityPool: factory,
        IdentityPool: mod.IdentityPool || null,
        PoolError: mod.PoolError || mod.IdentityPoolError || null,
        IdentityPoolError: mod.IdentityPoolError || mod.PoolError || null,
        POOL_FILE_NAME: mod.POOL_FILE_NAME || 'identity-pool.json',
        modulePath: candidate
      };
      return cached;
    } catch (error) {
      errors.push(`${candidate}: ${error.code || error.message}`);
    }
  }
  const error = new Error(
    `v2.4 IdentityPool 模块尚未就绪（尝试: ${CANDIDATES.join(', ')}；${errors.join(' | ')}）`
  );
  error.code = 'identity_pool_module_missing';
  throw error;
}

/** 创建 pool 并 await init()。 */
export async function createPool(overrides = {}) {
  const { createIdentityPool, modulePath } = await loadPoolModule();
  const created = createIdentityPool({
    dataDir: overrides.dataDir,
    config: overrides.config || {},
    logger: overrides.logger || null,
    ...(overrides.proxyManager ? { proxyManager: overrides.proxyManager } : {}),
    ...(overrides.createRuntime ? { createRuntime: overrides.createRuntime } : {}),
    ...(overrides.duckFactory ? { duckFactory: overrides.duckFactory } : {})
  });
  const pool = created && typeof created.then === 'function' ? await created : created;
  if (typeof pool.init === 'function') await pool.init();
  return { pool, modulePath };
}

/** 兼容不同命名的摘要读取（getSummary/getPoolSummary/getRedacted）。 */
export function poolSummary(pool) {
  if (!pool) return null;
  for (const name of ['getSummary', 'getPoolSummary', 'getRedacted']) {
    if (typeof pool[name] === 'function') return pool[name]();
  }
  return null;
}

/** 列表读取（同步 list() → identitySummary[]）。 */
export function poolItems(pool) {
  const listed = pool.list?.();
  if (Array.isArray(listed)) return listed;
  const summary = poolSummary(pool);
  if (summary && Array.isArray(summary.items)) return summary.items;
  return [];
}

/** 统一 resolve 调用：resolve / routeDetailed。 */
export async function resolveSession(pool, params) {
  if (typeof pool.resolve === 'function') return pool.resolve(params);
  if (typeof pool.routeDetailed === 'function') return pool.routeDetailed(params);
  throw new Error('IdentityPool 缺少 resolve()/routeDetailed()');
}

/** 取 hash 期望身份（盐已知时）。 */
export function expectedHashIdentity(sessionKey, salt, ids) {
  const digest = crypto.createHash('sha256').update(`${sessionKey}:${salt}`).digest('hex');
  const index = parseInt(digest.slice(0, 8), 16) % ids.length;
  return ids[index];
}

import crypto from 'node:crypto';
