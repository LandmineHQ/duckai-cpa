/**
 * windows 平台分支：Bun 运行时（含编译 exe）的 HTTP 代理改用原生 fetch `proxy` 选项。
 *
 * 背景：Bun 下 undici `ProxyAgent` 连接行为异常（ECONNRESET/timeout，编译 exe 内代理
 * 实际不可用）；Bun 原生 `fetch(url, { proxy })` 实测正常。这里用注入的
 * `bunRuntime` / `nativeFetch` 在 Node 测试进程里模拟 Bun，锁定以下契约：
 *   - 启用 http(s) 代理且 Bun 模式下，fetch/test 都带 `proxy`、且不向 fetch 传 `dispatcher`；
 *   - noProxy 命中的目标仍然直连；
 *   - 禁用代理时走直连；
 *   - 代理 URI 构造（scheme / auth / IPv6 host）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ProxyManager, buildHttpProxyUri } from '../src/duck/proxy.js';

function baseProxy(overrides = {}) {
  return {
    enabled: true,
    type: 'http',
    host: '127.0.0.1',
    port: 10808,
    username: '',
    password: '',
    noProxy: ['127.0.0.1', 'localhost'],
    testUrl: 'https://duck.ai/duckchat/v1/status',
    ipCheckUrl: 'https://api.ipify.org?format=json',
    ...overrides
  };
}

/** Records every fetch call; returns canned responses by URL substring. */
function createFetchRecorder() {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('ipify')) {
      return new Response(JSON.stringify({ ip: '70.39.202.155' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ status: '0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return { calls, fetchImpl };
}

async function bunManager(proxyConfig, fetchRecorder) {
  const manager = new ProxyManager({
    config: { proxy: proxyConfig },
    logger: null,
    bunRuntime: true,
    nativeFetch: fetchRecorder.fetchImpl,
    fetchImpl: fetchRecorder.fetchImpl
  });
  await manager.init();
  return manager;
}

test('buildHttpProxyUri：scheme / auth / IPv6 host', () => {
  assert.equal(buildHttpProxyUri({ type: 'http', host: '127.0.0.1', port: 10808 }), 'http://127.0.0.1:10808');
  assert.equal(buildHttpProxyUri({ type: 'https', host: 'proxy.local', port: 8443 }), 'https://proxy.local:8443');
  assert.equal(
    buildHttpProxyUri({ type: 'http', host: '127.0.0.1', port: 8080, username: 'u@x', password: 'p:w' }),
    'http://u%40x:p%3Aw@127.0.0.1:8080'
  );
  assert.equal(buildHttpProxyUri({ type: 'http', host: '::1', port: 1080 }), 'http://[::1]:1080');
});

test('Bun 模式：fetch 使用原生 proxy 选项且不带 dispatcher', async () => {
  const recorder = createFetchRecorder();
  const manager = await bunManager(baseProxy(), recorder);
  try {
    // Bun 模式下不再需要 undici dispatcher（状态 active 由原生 proxy 路径维持）。
    assert.equal(manager.getDispatcher(), undefined);
    assert.equal(manager.getSummary().active, true);

    const response = await manager.getFetch()('https://duck.ai/duckchat/v1/status', {
      headers: { accept: '*/*' },
      dispatcher: { shouldBeDropped: true }
    });
    assert.equal(response.status, 200);
    assert.equal(recorder.calls.length, 1);
    const [{ url, init }] = recorder.calls;
    assert.equal(url, 'https://duck.ai/duckchat/v1/status');
    assert.equal(init.proxy, 'http://127.0.0.1:10808');
    assert.equal('dispatcher' in init, false, '原生 fetch 不应收到 undici dispatcher');
    assert.deepEqual(init.headers, { accept: '*/*' }, '其余 init 字段应保留');
  } finally {
    await manager.close();
  }
});

test('Bun 模式：noProxy 命中时直连；禁用代理时也直连', async () => {
  const recorder = createFetchRecorder();
  const manager = await bunManager(baseProxy(), recorder);
  try {
    await manager.getFetch()('http://127.0.0.1:8787/healthz');
    assert.equal(recorder.calls[0].init.proxy, undefined, 'noProxy 目标不应设置 proxy');

    const disabled = await bunManager(baseProxy({ enabled: false }), recorder);
    try {
      await disabled.getFetch()('https://duck.ai/duckchat/v1/status');
      assert.equal(recorder.calls[1].init.proxy, undefined, '禁用代理时应直连');
      assert.equal(disabled.getSummary().active, false);
    } finally {
      await disabled.close();
    }
  } finally {
    await manager.close();
  }
});

test('Bun 模式：test() 通过原生 proxy 探测 target 与 exit IP', async () => {
  const recorder = createFetchRecorder();
  const manager = await bunManager(baseProxy(), recorder);
  try {
    const result = await manager.test({});
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'http');
    assert.equal(result.status, 200);
    assert.equal(result.exitIp, '70.39.202.155');
    assert.equal(recorder.calls.length, 2, '应分别请求 testUrl 与 ipCheckUrl');
    for (const call of recorder.calls) {
      assert.equal(call.init.proxy, 'http://127.0.0.1:10808');
      assert.equal('dispatcher' in call.init, false);
    }
    assert.equal(manager.getStatus().lastTestOk, true);
    assert.equal(manager.getStatus().active, true);
  } finally {
    await manager.close();
  }
});

test('Bun 模式：test() 的显式 host/port 覆盖也走原生 proxy', async () => {
  const recorder = createFetchRecorder();
  const manager = await bunManager(baseProxy({ enabled: false }), recorder);
  try {
    const result = await manager.test({ host: '127.0.0.1', port: 10809 });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'http');
    assert.equal(recorder.calls[0].init.proxy, 'http://127.0.0.1:10809');
  } finally {
    await manager.close();
  }
});
