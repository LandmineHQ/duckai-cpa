/**
 * QA 辅助：解析 v2.3 ProxyManager 模块（实现方可能放在 src/proxy/ 或 src/duck/）。
 *
 * 返回 { createProxyManager, ProxyError?, modulePath }；模块缺失时抛出带提示的错误，
 * 便于实现未就绪时测试明确失败原因。
 */

const CANDIDATES = ['../../src/proxy/index.js', '../../src/proxy.js', '../../src/duck/proxy.js'];

let cached = null;

export async function loadProxyModule() {
  if (cached) return cached;
  const errors = [];
  for (const candidate of CANDIDATES) {
    try {
      const mod = await import(candidate);
      const factory =
        mod.createProxyManager ||
        mod.createProxyManagerForConfig ||
        (typeof mod.default === 'function' ? mod.default : null);
      if (typeof factory !== 'function') {
        errors.push(`${candidate}: 未导出 createProxyManager`);
        continue;
      }
      cached = {
        module: mod,
        createProxyManager: factory,
        ProxyError: mod.ProxyError || null,
        modulePath: candidate
      };
      return cached;
    } catch (error) {
      errors.push(`${candidate}: ${error.code || error.message}`);
    }
  }
  const error = new Error(
    `v2.3 ProxyManager 模块尚未就绪（尝试: ${CANDIDATES.join(', ')}；${errors.join(' | ')}）`
  );
  error.code = 'proxy_module_missing';
  throw error;
}

/** 创建 manager 并等待初始化（若实现返回 Promise / 有 init）。 */
export async function createManager(overrides = {}) {
  const { createProxyManager, modulePath } = await loadProxyModule();
  const config = { proxy: { enabled: false, type: 'http', host: '', port: 0, noProxy: ['127.0.0.1', 'localhost'], ...overrides.config?.proxy } , ...overrides.config };
  const created = createProxyManager({ config, logger: overrides.logger || null, ...overrides.options });
  const manager = created && typeof created.then === 'function' ? await created : created;
  if (typeof manager.init === 'function') await manager.init();
  return { manager, modulePath };
}

/** 归一化读取 manager 的脱敏状态（兼容不同方法命名）。 */
export function managerState(manager) {
  if (!manager) return null;
  if (typeof manager.getRedacted === 'function') return manager.getRedacted();
  if (typeof manager.snapshot === 'function') return manager.snapshot();
  if (typeof manager.status === 'function') return manager.status();
  if (typeof manager.getStatus === 'function') return manager.getStatus();
  return manager.state || null;
}

/** 读取 manager 当前 mode（direct/http/https/socks4/socks5）。 */
export function managerMode(manager, state = managerState(manager)) {
  if (typeof manager?.mode === 'string') return manager.mode;
  if (state && typeof state.status === 'object' && state.status) {
    return state.status.mode || (state.status.active ? state.type : 'direct') || 'direct';
  }
  if (state) return state.active === false ? 'direct' : state.mode || state.type || 'direct';
  return null;
}

/** 取 manager 的 fetch 实现（用于断言 DuckClient 走代理包装）。 */
export function managerFetch(manager) {
  return typeof manager?.fetch === 'function' ? manager.fetch.bind(manager) : null;
}
