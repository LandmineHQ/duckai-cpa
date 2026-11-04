/**
 * v2.3 代理（docs/PROXY.md）— ProxyManager 模块级单测。
 *
 * 覆盖：
 *   - 默认禁用 → direct；getSummary/getRedacted 字段；不含 password
 *   - update 校验（type/port/host/noProxy/testUrl/ipCheckUrl 非法 → ProxyError 400 invalid_proxy）
 *   - 密码语义：省略=不变、''=清除、非空=设置，且 getRedacted 只给 hasAuth、绝不含明文
 *   - noProxy：精确 / 后缀 / 通配 `.internal` 规则
 *   - dispatcher：http(s) → ProxyAgent；socks4/socks5 → undici Agent（自定义 connector）
 *   - 端到端（进程内 mock 代理，不访问外网）：
 *       http 代理 → getFetch() 抓本地源站成功
 *       socks5 代理 → getFetch() 抓本地源站成功
 *       代理不可达 → test() ok:false + code
 *       noProxy 命中 → 直连（代理不可达也 ok）
 *       test() 成功路径：ok/status/latencyMs/mode，且写回 status.lastTestOk/exitIp
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startHttpProxy, startSocks5Proxy, startHttpOrigin, getClosedPort } from './helpers/mock-proxy.js';
import { createManager, managerState, managerMode, loadProxyModule } from './helpers/proxy-module.js';

function baseProxy(overrides = {}) {
  return {
    enabled: false,
    type: 'http',
    host: '127.0.0.1',
    port: 1080,
    noProxy: ['127.0.0.1', 'localhost'],
    testUrl: 'https://duck.ai/duckchat/v1/status',
    ipCheckUrl: 'https://api.ipify.org?format=json',
    ...overrides
  };
}

async function managerWith(proxy) {
  return createManager({ config: { proxy }, logger: null });
}

test('默认禁用 → direct；getRedacted 不含 password', async () => {
  const { manager } = await managerWith(baseProxy());
  try {
    const state = managerState(manager);
    assert.ok(state, 'getRedacted() 返回空');
    assert.equal(state.enabled, false);
    assert.equal(managerMode(manager, state), 'direct');
    assert.ok(Array.isArray(state.noProxy));
    assert.equal(state.hasAuth, false);
    const text = JSON.stringify(state);
    assert.ok(!text.includes('"password"'), 'getRedacted 不得含 password 字段');
    const summary = typeof manager.getSummary === 'function' ? manager.getSummary() : null;
    if (summary) {
      assert.equal(summary.enabled, false);
      assert.equal(summary.mode, 'direct');
      assert.equal(typeof summary.active, 'boolean');
    }
  } finally {
    await manager.close();
  }
});

test('update 校验：type/port/host/noProxy/testUrl 非法 → 400 invalid_proxy（含 field）', async () => {
  const { manager } = await managerWith(baseProxy());
  const { ProxyError } = await loadProxyModule();
  const cases = [
    { patch: { type: 'ftp' }, field: 'type' },
    { patch: { port: 0 }, field: 'port' },
    { patch: { port: 70000 }, field: 'port' },
    { patch: { port: 'abc' }, field: 'port' },
    { patch: { host: '' }, field: 'host' },
    { patch: { noProxy: 'not-an-array' }, field: 'noProxy' },
    { patch: { noProxy: Array.from({ length: 51 }, (_, i) => `h${i}.local`) }, field: 'noProxy' },
    { patch: { testUrl: 'ftp://example.com' }, field: 'testUrl' },
    { patch: { ipCheckUrl: 'not-a-url' }, field: 'ipCheckUrl' }
  ];
  try {
    for (const { patch, field } of cases) {
      let error = null;
      try {
        await manager.update(patch);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error, `expected update to reject: ${JSON.stringify(patch)}`);
      assert.ok(
        (ProxyError && error instanceof ProxyError) || error.name === 'ProxyError' || error.code === 'invalid_proxy',
        `unexpected error type: ${error.name}/${error.code}`
      );
      assert.equal(error.status, 400, `status for ${JSON.stringify(patch)}`);
      assert.equal(error.code, 'invalid_proxy');
      assert.equal(error.field, field, `field for ${JSON.stringify(patch)}`);
    }
    // 校验失败不应改变配置
    const state = managerState(manager);
    assert.equal(state.type, 'http');
    assert.equal(state.host, '127.0.0.1');
  } finally {
    await manager.close();
  }
});

test('密码语义：省略=不变、空串=清除、非空=设置；getRedacted 仅 hasAuth', async () => {
  const { manager } = await managerWith(baseProxy());
  try {
    await manager.update({ username: 'user1', password: 'secret-pass' });
    let state = managerState(manager);
    assert.equal(state.hasAuth, true);
    assert.equal(state.username, 'user1');
    assert.ok(!JSON.stringify(state).includes('secret-pass'), '明文密码泄漏');

    // 省略 password：保持不变
    await manager.update({ port: 3128 });
    state = managerState(manager);
    assert.equal(state.hasAuth, true);
    assert.equal(state.port, 3128);

    // 空字符串：清除密码（username 仍在 → hasAuth 仍为 true，表示仍会发 Basic 认证）
    await manager.update({ password: '' });
    state = managerState(manager);
    assert.equal(state.hasAuth, true, 'username 仍存在时 hasAuth 仍为 true');
    assert.ok(!JSON.stringify(state).includes('secret-pass'));

    // 再清除 username：无凭据
    await manager.update({ username: '' });
    state = managerState(manager);
    assert.equal(state.hasAuth, false);

    // 非空：重新设置
    await manager.update({ username: 'user2', password: 'another-secret' });
    state = managerState(manager);
    assert.equal(state.hasAuth, true);
    assert.equal(state.username, 'user2');
    assert.ok(!JSON.stringify(state).includes('another-secret'));
  } finally {
    await manager.close();
  }
});

test('noProxy：精确 / 后缀 / 通配匹配', async () => {
  const { manager } = await managerWith(
    baseProxy({
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: 1080,
      noProxy: ['localhost', '127.0.0.1', '*.internal', 'example.org']
    })
  );
  try {
    assert.equal(manager.shouldBypass('http://localhost:8787/x'), true);
    assert.equal(manager.shouldBypass('http://127.0.0.1:1080/'), true);
    assert.equal(manager.shouldBypass('https://api.internal/x'), true);
    assert.equal(manager.shouldBypass('https://deep.api.internal/x'), true);
    assert.equal(manager.shouldBypass('https://example.org/path'), true);
    assert.equal(manager.shouldBypass('https://duck.ai/duckchat/v1/status'), false);
    assert.equal(manager.shouldBypass('https://notexample.org/'), false);
    assert.equal(manager.shouldBypass('https://internal.evil.com/'), false);
  } finally {
    await manager.close();
  }
});

test('dispatcher：http(s) 启用 → ProxyAgent；socks4/socks5 → undici Agent；direct → undefined', async () => {
  const { manager } = await managerWith(baseProxy());
  try {
    assert.equal(manager.getDispatcher(), undefined, 'disabled 应为 direct（无 dispatcher）');

    await manager.update({ enabled: true, type: 'http', port: 3128 });
    const httpDispatcher = manager.getDispatcher();
    assert.ok(httpDispatcher, 'http 模式应有 dispatcher');
    assert.match(String(httpDispatcher.constructor?.name || ''), /ProxyAgent/i);
    assert.equal(managerMode(manager), 'http');
    assert.equal(typeof manager.getFetch(), 'function');

    await manager.update({ type: 'https', port: 3129 });
    assert.match(String(manager.getDispatcher()?.constructor?.name || ''), /ProxyAgent/i);
    assert.equal(managerMode(manager), 'https');

    for (const type of ['socks4', 'socks5']) {
      await manager.update({ type, port: 1080 });
      const dispatcher = manager.getDispatcher();
      assert.ok(dispatcher, `${type} 模式应有 dispatcher`);
      assert.match(String(dispatcher.constructor?.name || ''), /^Agent$/);
      assert.equal(managerMode(manager), type);
    }

    await manager.update({ enabled: false });
    assert.equal(manager.getDispatcher(), undefined);
    assert.equal(managerMode(manager), 'direct');
  } finally {
    await manager.close();
  }
});

test('http 代理：getFetch() 经代理访问本地源站成功；test() ok + exitIp', async () => {
  const origin = await startHttpOrigin({ ip: '198.51.100.9' });
  const proxy = await startHttpProxy();
  const { manager } = await managerWith(
    baseProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: proxy.port, noProxy: [] })
  );
  try {
    const response = await manager.getFetch()(`${origin.url}/via-http`, { method: 'GET' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.path, '/via-http');
    assert.ok(proxy.requests.length >= 1, 'proxy should see the request');

    const result = await manager.test({
      testUrl: `${origin.url}/probe`,
      ipCheckUrl: `${origin.url}/ip`,
      noProxy: []
    });
    assert.equal(result.ok, true, `test failed: ${JSON.stringify(result)}`);
    assert.equal(result.status, 200);
    assert.equal(result.mode, 'http');
    assert.ok(result.latencyMs >= 0);
    assert.equal(result.exitIp, '198.51.100.9');
    assert.equal(result.error, null);

    const state = managerState(manager);
    assert.equal(state.status.lastTestOk, true);
    assert.equal(state.status.exitIp, '198.51.100.9');
  } finally {
    await manager.close();
    await proxy.close();
    await origin.close();
  }
});

test('socks5 代理：getFetch() 经 SOCKS5 访问本地源站成功', async () => {
  const origin = await startHttpOrigin({ ip: '203.0.113.7' });
  const socks = await startSocks5Proxy();
  const { manager } = await managerWith(
    baseProxy({ enabled: true, type: 'socks5', host: '127.0.0.1', port: socks.port, noProxy: [] })
  );
  try {
    const response = await manager.getFetch()(`${origin.url}/via-socks`, { method: 'GET' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.path, '/via-socks');
    assert.ok(socks.connections.length >= 1, 'socks server should see a CONNECT');

    const result = await manager.test({ testUrl: `${origin.url}/socks-probe`, ipCheckUrl: `${origin.url}/ip`, noProxy: [] });
    assert.equal(result.ok, true, `test failed: ${JSON.stringify(result)}`);
    assert.equal(result.mode, 'socks5');
  } finally {
    await manager.close();
    await socks.close();
    await origin.close();
  }
});

test('代理不可达 → test() ok:false + code；status.lastError 记录', async () => {
  const closedPort = await getClosedPort();
  const origin = await startHttpOrigin();
  const { manager } = await managerWith(
    baseProxy({
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: closedPort,
      testUrl: `${origin.url}/probe`,
      ipCheckUrl: `${origin.url}/ip`,
      noProxy: []
    })
  );
  try {
    const result = await manager.test();
    assert.equal(result.ok, false);
    assert.ok(
      ['proxy_connect_failed', 'proxy_timeout', 'proxy_tls_failed', 'invalid_proxy'].includes(result.code),
      `unexpected code: ${result.code}`
    );
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    const state = managerState(manager);
    assert.equal(state.status.lastTestOk, false);
    assert.equal(typeof state.status.lastError, 'string');
  } finally {
    await manager.close();
    await origin.close();
  }
});

test('noProxy 命中 127.0.0.1 → fetch 与 test() 均绕过不可达代理（直连）', async () => {
  const closedPort = await getClosedPort();
  const origin = await startHttpOrigin({ ip: '192.0.2.5' });
  const { manager } = await managerWith(
    baseProxy({
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: closedPort,
      testUrl: `${origin.url}/direct`,
      ipCheckUrl: `${origin.url}/ip`,
      noProxy: ['127.0.0.1', 'localhost']
    })
  );
  try {
    assert.equal(manager.shouldBypass(`${origin.url}/direct`), true);
    // fetch 路径：命中 noProxy → 直连成功（代理端口不可达也不受影响）
    const response = await manager.getFetch()(`${origin.url}/bypass`, { method: 'GET' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).path, '/bypass');
    // test() 同样应用 noProxy：命中时走直连并 ok:true
    const result = await manager.test();
    assert.equal(result.ok, true, `noProxy should bypass unreachable proxy: ${JSON.stringify(result)}`);
    assert.equal(result.mode, 'direct');
    assert.equal(result.bypassNoProxy, true, 'test() 命中 noProxy 时应标记 bypassNoProxy:true');
  } finally {
    await manager.close();
    await origin.close();
  }
});

test('test() 非法 overrides 不抛：ok:false + code invalid_proxy + invalidField', async () => {
  const { manager } = await managerWith(baseProxy());
  try {
    for (const [patch, field] of [
      [{ type: 'ftp' }, 'type'],
      [{ port: 0 }, 'port'],
      [{ host: 'bad host' }, 'host'],
      [{ testUrl: 'ftp://x' }, 'testUrl']
    ]) {
      const result = await manager.test(patch);
      assert.equal(result.ok, false, `expected ok:false for ${JSON.stringify(patch)}`);
      assert.equal(result.code, 'invalid_proxy', `code for ${JSON.stringify(patch)}`);
      assert.equal(result.invalidField, field, `invalidField for ${JSON.stringify(patch)}`);
      assert.equal(typeof result.error, 'string');
    }
  } finally {
    await manager.close();
  }
});

test('update 立即生效：切换代理端口后新请求走新代理', async () => {
  const origin = await startHttpOrigin();
  const proxyA = await startHttpProxy();
  const proxyB = await startHttpProxy();
  const { manager } = await managerWith(
    baseProxy({ enabled: true, type: 'http', host: '127.0.0.1', port: proxyA.port, noProxy: [] })
  );
  try {
    await manager.getFetch()(`${origin.url}/a`, { method: 'GET' });
    assert.equal(proxyA.requests.length >= 1, true);
    assert.equal(proxyB.requests.length, 0);

    await manager.update({ port: proxyB.port });
    await manager.getFetch()(`${origin.url}/b`, { method: 'GET' });
    assert.ok(proxyB.requests.length >= 1, 'new request should use proxy B');
  } finally {
    await manager.close();
    await proxyA.close();
    await proxyB.close();
    await origin.close();
  }
});
