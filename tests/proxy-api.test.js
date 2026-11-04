/**
 * v2.3 代理 — Admin API 契约（docs/PROXY.md §3）。
 *
 * 覆盖：
 *   - GET /admin/api/proxy：字段完整、脱敏（无 password）、status 形状、默认 direct
 *   - PUT /admin/api/proxy：深合并；非法值 → 400 invalid_proxy；密码语义（省略=不变、''=清除、非空=设置）；
 *     保存后 GET 不回显密码；enabled 切换影响 healthz.proxy.mode
 *   - POST /admin/api/proxy/test：成功（经进程内 mock HTTP 代理 → 本地源站）与失败（不可达端口）均 200；
 *     test 使用临时 dispatcher，不改变已保存配置
 *   - GET /healthz：proxy {enabled,mode,active,...}，不泄漏密码
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { withServer, adminRequest } from './helpers/test-server.js';
import { startHttpProxy, startHttpOrigin, getClosedPort } from './helpers/mock-proxy.js';

async function getProxy(baseUrl) {
  const res = await adminRequest(baseUrl, '/admin/api/proxy');
  assert.equal(res.status, 200, `GET proxy HTTP ${res.status}: ${res.text}`);
  return res.json.proxy;
}

async function putProxy(baseUrl, patch) {
  return adminRequest(baseUrl, '/admin/api/proxy', { method: 'PUT', body: patch });
}

async function postProxyTest(baseUrl, body = {}) {
  return adminRequest(baseUrl, '/admin/api/proxy/test', { method: 'POST', body });
}

test('GET /admin/api/proxy：默认 direct、字段完整、不含 password', async () => {
  await withServer({ proxy: true }, async ({ baseUrl }) => {
    const proxy = await getProxy(baseUrl);
    assert.equal(proxy.enabled, false);
    assert.equal(typeof proxy.type, 'string');
    assert.equal(typeof proxy.host, 'string');
    assert.equal(typeof proxy.port, 'number');
    assert.equal(typeof proxy.hasAuth, 'boolean');
    assert.ok(Array.isArray(proxy.noProxy));
    assert.equal(typeof proxy.testUrl, 'string');
    assert.equal(typeof proxy.ipCheckUrl, 'string');
    assert.ok(proxy.status && typeof proxy.status === 'object');
    assert.equal(proxy.status.active, false);
    assert.equal(proxy.status.mode, 'direct');
    assert.ok(!('password' in proxy), 'GET proxy 不得返回 password 字段');

    const health = await adminRequest(baseUrl, '/healthz');
    assert.equal(health.status, 200);
    assert.ok(health.json.proxy, 'healthz.proxy missing');
    assert.equal(typeof health.json.proxy.enabled, 'boolean');
    assert.equal(health.json.proxy.mode, 'direct');
    assert.equal(typeof health.json.proxy.active, 'boolean');
    assert.ok(!JSON.stringify(health.json.proxy).includes('password'));
  });
});

test('PUT /admin/api/proxy：深合并 + 校验 400 invalid_proxy + 非法值不改变已保存配置', async () => {
  await withServer({ proxy: true }, async ({ baseUrl }) => {
    const updated = await putProxy(baseUrl, {
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: 10808,
      noProxy: ['localhost']
    });
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.json.ok, true);
    assert.equal(updated.json.proxy.enabled, true);
    assert.equal(updated.json.proxy.type, 'http');
    assert.equal(updated.json.proxy.port, 10808);
    assert.ok(!('password' in updated.json.proxy));

    const before = await getProxy(baseUrl);

    const invalidCases = [
      { type: 'ftp' },
      { port: 0 },
      { port: 99999 },
      { host: '' },
      { host: 'bad host with spaces' },
      { noProxy: 'localhost' },
      { noProxy: ['ok', 123] },
      { testUrl: 'ftp://example.com' },
      { ipCheckUrl: 'nope' }
    ];
    for (const patch of invalidCases) {
      const res = await putProxy(baseUrl, patch);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(patch)}: ${res.text}`);
      assert.equal(res.json.error.code, 'invalid_proxy', `code for ${JSON.stringify(patch)}`);
      assert.equal(res.json.error.type, 'invalid_request_error');
    }

    const after = await getProxy(baseUrl);
    assert.deepEqual(
      { enabled: after.enabled, type: after.type, host: after.host, port: after.port, noProxy: after.noProxy },
      { enabled: before.enabled, type: before.type, host: before.host, port: before.port, noProxy: before.noProxy },
      'invalid PUT must not mutate saved config'
    );

    // 关闭后 healthz.proxy.mode 回到 direct
    const disabled = await putProxy(baseUrl, { enabled: false });
    assert.equal(disabled.status, 200);
    const health = await adminRequest(baseUrl, '/healthz');
    assert.equal(health.json.proxy.mode, 'direct');
  });
});

test('PUT /admin/api/proxy：密码语义（省略不变 / 空串清除 / 非空设置）且永不回显', async () => {
  await withServer({ proxy: true }, async ({ baseUrl }) => {
    const set = await putProxy(baseUrl, {
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: 10808,
      username: 'user1',
      password: 'top-secret-password'
    });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.proxy.hasAuth, true);
    assert.equal(set.json.proxy.username, 'user1');
    assert.ok(!set.text.includes('top-secret-password'), 'PUT 响应不得回显密码');

    // 省略 password：保持
    const kept = await putProxy(baseUrl, { port: 10809 });
    assert.equal(kept.status, 200);
    assert.equal(kept.json.proxy.hasAuth, true);
    assert.equal(kept.json.proxy.port, 10809);
    assert.ok(!kept.text.includes('top-secret-password'));

    // 空串：清除 password（username 仍在 → hasAuth 仍 true，表示仍会发 Basic 认证）
    const cleared = await putProxy(baseUrl, { password: '' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.proxy.hasAuth, true, 'username 仍在时 hasAuth 仍为 true');
    assert.ok(!cleared.text.includes('top-secret-password'));

    // 再清除 username：无凭据
    const clearedUser = await putProxy(baseUrl, { username: '' });
    assert.equal(clearedUser.status, 200);
    assert.equal(clearedUser.json.proxy.hasAuth, false);

    // 再次设置
    const reset = await putProxy(baseUrl, { username: 'user2', password: 'another-secret' });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.proxy.hasAuth, true);
    assert.ok(!reset.text.includes('another-secret'));

    const finalGet = await getProxy(baseUrl);
    assert.equal(finalGet.hasAuth, true);
    assert.ok(!JSON.stringify(finalGet).includes('another-secret'));
  });
});

test('POST /admin/api/proxy/test：经 mock http 代理成功（ok/status/latency/exitIp）；不改保存配置', async () => {
  const origin = await startHttpOrigin({ ip: '198.51.100.9' });
  const proxy = await startHttpProxy();
  await withServer({ proxy: true }, async ({ baseUrl }) => {
    try {
      const before = await getProxy(baseUrl);
      const res = await postProxyTest(baseUrl, {
        type: 'http',
        host: '127.0.0.1',
        port: proxy.port,
        testUrl: `${origin.url}/probe`,
        ipCheckUrl: `${origin.url}/ip`,
        noProxy: []
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.ok, true, `test failed: ${res.text}`);
      assert.equal(res.json.status, 200);
      assert.ok(res.json.latencyMs >= 0);
      assert.equal(res.json.exitIp, '198.51.100.9');
      assert.equal(res.json.code, null);
      assert.equal(typeof res.json.testedAt, 'number');
      assert.equal(typeof res.json.mode, 'string');

      const after = await getProxy(baseUrl);
      assert.equal(after.enabled, before.enabled, 'test 不应改变保存的 enabled');
      assert.equal(after.host, before.host);
      assert.equal(after.port, before.port);
      // 但 status 会记录最近一次测试结果
      assert.equal(after.status.lastTestOk, true);
      assert.equal(after.status.exitIp, '198.51.100.9');
      assert.equal(typeof after.status.lastTestAt, 'number');
    } finally {
      await origin.close();
      await proxy.close();
    }
  });
});

test('POST /admin/api/proxy/test：代理不可达 → 200 + ok:false + code + lastError', async () => {
  const closedPort = await getClosedPort();
  const origin = await startHttpOrigin();
  await withServer({ proxy: true }, async ({ baseUrl }) => {
    try {
      const res = await postProxyTest(baseUrl, {
        type: 'http',
        host: '127.0.0.1',
        port: closedPort,
        testUrl: `${origin.url}/probe`,
        ipCheckUrl: `${origin.url}/ip`,
        noProxy: []
      });
      assert.equal(res.status, 200, 'proxy/test 失败也返回 200');
      assert.equal(res.json.ok, false);
      assert.ok(
        ['proxy_connect_failed', 'proxy_timeout', 'proxy_tls_failed', 'invalid_proxy'].includes(res.json.code),
        `unexpected code: ${res.json.code}`
      );
      assert.equal(typeof res.json.error, 'string');
      assert.ok(res.json.error.length > 0);

      const after = await getProxy(baseUrl);
      assert.equal(after.status.lastTestOk, false);
      assert.equal(typeof after.status.lastError, 'string');
    } finally {
      await origin.close();
    }
  });
});

test('POST /admin/api/proxy/test：非法 overrides 统一 200 + ok:false + code invalid_proxy + invalidField（契约 §3.3）', async () => {
  await withServer({ proxy: true }, async ({ baseUrl }) => {
    const cases = [
      [{ type: 'ftp' }, 'type'],
      [{ port: 0 }, 'port'],
      [{ port: 99999 }, 'port'],
      [{ host: 'bad host with spaces' }, 'host'],
      [{ noProxy: 'localhost' }, 'noProxy'],
      [{ testUrl: 'ftp://example.com' }, 'testUrl'],
      [{ ipCheckUrl: 'nope' }, 'ipCheckUrl'],
      [{ enabled: 'yes' }, 'enabled']
    ];
    for (const [body, field] of cases) {
      const res = await postProxyTest(baseUrl, body);
      assert.equal(res.status, 200, `非法 overrides 应 200（契约 §3.3），实际 ${res.status}: ${res.text}`);
      assert.equal(res.json.ok, false, `ok 应为 false: ${JSON.stringify(body)}`);
      assert.equal(res.json.code, 'invalid_proxy', `code for ${JSON.stringify(body)}`);
      assert.equal(res.json.invalidField, field, `invalidField for ${JSON.stringify(body)}`);
      assert.equal(typeof res.json.error, 'string');
      assert.equal(res.json.status, null);
      assert.equal(res.json.exitIp, null);
      assert.equal(typeof res.json.testedAt, 'number');
    }
    // PUT 仍为 400 invalid_proxy（契约 §3.2，不被统一语义影响）
    const put = await putProxy(baseUrl, { type: 'ftp' });
    assert.equal(put.status, 400);
    assert.equal(put.json.error.code, 'invalid_proxy');
  });
});

test('POST /admin/api/proxy/test：直连测试（禁用代理时）仍返回结构完整结果', async () => {
  const origin = await startHttpOrigin({ ip: '192.0.2.20' });
  await withServer({ proxy: true }, async ({ baseUrl }) => {
    try {
      const res = await postProxyTest(baseUrl, {
        testUrl: `${origin.url}/direct-test`,
        ipCheckUrl: `${origin.url}/ip`
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(typeof res.json.ok, 'boolean');
      assert.equal(res.json.mode, 'direct');
      if (res.json.ok) {
        assert.equal(res.json.exitIp, '192.0.2.20');
      }
    } finally {
      await origin.close();
    }
  });
});

test('PUT 非法值不改变 healthz.proxy 状态', async () => {
  await withServer({ proxy: true }, async ({ baseUrl }) => {
    await putProxy(baseUrl, { enabled: true, type: 'http', host: '127.0.0.1', port: 10808 });
    const before = await adminRequest(baseUrl, '/healthz');
    const invalid = await putProxy(baseUrl, { port: 0 });
    assert.equal(invalid.status, 400);
    const after = await adminRequest(baseUrl, '/healthz');
    assert.deepEqual(after.json.proxy, before.json.proxy);
  });
});

test('未注入 proxy 时端点返回明确不可用错误（不 500、不泄漏）', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const res = await adminRequest(baseUrl, '/admin/api/proxy');
    assert.ok([502, 503].includes(res.status), `expected 502/503 without proxy injection: ${res.status} ${res.text}`);
    assert.equal(res.json.error.code, 'proxy_unavailable');
  });
});
