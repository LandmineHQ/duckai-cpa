/**
 * v2.42：测试网络护栏。
 *
 * 所有单测必须离线：除 127.0.0.1 / localhost 外，任何 `fetch` 出站请求都会被拦截并抛出
 * 网络错误（模拟上游不可达），同时记录到 `blocked` 列表供断言/排障。
 * 这样 upstream 验证（duck.ai / duckduckgo.com）在测试中不会真实发出请求。
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const STATE_KEY = '__duckaiTestNetworkGuard';

export function installNoExternalNetworkGuard() {
  if (globalThis[STATE_KEY]) return globalThis[STATE_KEY];
  const original = globalThis.fetch;
  const blocked = [];
  const guard = {
    blocked,
    restore() {
      globalThis.fetch = original;
      delete globalThis[STATE_KEY];
    }
  };
  if (typeof original !== 'function') {
    globalThis[STATE_KEY] = guard;
    return guard;
  }
  globalThis.fetch = async function guardedFetch(input, init) {
    const raw = typeof input === 'string' ? input : input && input.url;
    let url = null;
    try {
      url = raw ? new URL(String(raw)) : null;
    } catch {
      url = null;
    }
    if (url && !LOCAL_HOSTS.has(url.hostname)) {
      guard.blocked.push(url.href);
      const error = new TypeError(`fetch failed: blocked external request in tests (${url.href})`);
      error.code = 'ERR_TEST_EXTERNAL_NETWORK_BLOCKED';
      throw error;
    }
    return original.call(this, input, init);
  };
  globalThis[STATE_KEY] = guard;
  return guard;
}

export function getBlockedExternalRequests() {
  return globalThis[STATE_KEY] ? [...globalThis[STATE_KEY].blocked] : [];
}

// 导入即安装：测试文件通过 test-server helper 共享同一个护栏。
installNoExternalNetworkGuard();

export default { installNoExternalNetworkGuard, getBlockedExternalRequests };
