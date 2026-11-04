/**
 * v2.42：离线测试护栏 + 上游 mock 工作方式验证。
 *
 * 目的：证明测试套件不会访问真实 duck.ai / duckduckgo.com；需要上游成功/失败路径时，
 * 通过 `fetchImpl` 注入 mock（而不是真实网络）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { verifySubscriptionOnline } from '../src/duck/auth.js';
import { detectSyncTransport } from '../src/duck/sync.js';
import {
  installNoExternalNetworkGuard,
  getBlockedExternalRequests
} from './helpers/no-external-network.js';

const HTML = '<html data-version-tag="serp_test_20260101" data-version-sha="abc123"></html>';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('测试网络护栏：外网 fetch 被拦截（不发出真实请求），localhost 放行', async () => {
  const guard = installNoExternalNetworkGuard();
  const before = guard.blocked.length;
  await assert.rejects(
    () => fetch('https://duck.ai/duckchat/v1/status'),
    (error) => error.code === 'ERR_TEST_EXTERNAL_NETWORK_BLOCKED'
  );
  assert.ok(guard.blocked.length > before, '应记录被拦截的外网请求');
  assert.ok(guard.blocked.at(-1).startsWith('https://duck.ai/'));
});

test('verifySubscriptionOnline：mock 上游 200 → verified:true（不发真实请求）', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/')) return new Response(HTML, { status: 200 });
    if (String(url).endsWith('/duckchat/v1/status')) return jsonResponse({ status: 'ok' });
    if (String(url).endsWith('/duckchat/v1/capabilities')) return jsonResponse({ flags: {} });
    throw new Error(`unexpected url: ${url}`);
  };
  const result = await verifySubscriptionOnline({ token: 'fake-token', baseUrl: 'https://duck.ai', fetchImpl });
  assert.equal(result.verified, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.error, null);
  assert.deepEqual(calls, [
    'https://duck.ai/',
    'https://duck.ai/duckchat/v1/status',
    'https://duck.ai/duckchat/v1/capabilities'
  ]);
});

test('verifySubscriptionOnline：mock 上游不可达 → verify_unavailable（不是真实网络错误）', async () => {
  const fetchImpl = async () => {
    throw new TypeError('mock network down');
  };
  const result = await verifySubscriptionOnline({ token: 'fake-token', baseUrl: 'https://duck.ai', fetchImpl });
  assert.equal(result.verified, false);
  assert.equal(result.error.code, 'verify_unavailable');
});

test('detectSyncTransport：mock 200 → available；mock 网络错误 → blocked', async () => {
  const available = await detectSyncTransport({
    baseUrl: 'https://duckduckgo.com/sync/pairing/',
    fetchImpl: async () => new Response('', { status: 200 })
  });
  assert.equal(available.status, 'available');
  assert.equal(available.reason, 'http:200');

  const blocked = await detectSyncTransport({
    baseUrl: 'https://duckduckgo.com/sync/pairing/',
    fetchImpl: async () => {
      throw new TypeError('mock network down');
    }
  });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /^network:/);
});

test('测试网络护栏：被拦截的请求列表可用于排障', () => {
  const blocked = getBlockedExternalRequests();
  assert.ok(Array.isArray(blocked));
  assert.ok(blocked.every((url) => /^https?:\/\//.test(url)));
});
