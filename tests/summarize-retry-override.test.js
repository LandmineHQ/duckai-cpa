/**
 * v2.62 残余 418 修复回归（src/duck/index.js）。
 *
 * 覆盖：
 *  - summarizeNative 对 418/429 的重试（每次重新 acquire 已解挑战），并记录 overrideCode；
 *  - chat 418 的 overrideCode 归因（stats.lastOverrideCode / stats.overrideCodes / error.overrideCode）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DuckClient } from '../src/duck/index.js';

function makeClient(fetchImpl, overrides = {}) {
  const client = new DuckClient({
    baseUrl: 'https://sync.example.test',
    defaultModel: 'gpt-6-luna',
    fetchImpl,
    humanize: { minDelayMs: 0, maxDelayMs: 0, minIntervalMs: 0, maxRetries: 2, retryBaseDelayMs: 0, rateLimitCooldownMs: 100, rateLimitWaitMs: 1000 },
    ...overrides
  });
  const invalidations = [];
  let acquisitions = 0;
  client.challenge = {
    version: '1.2.3',
    async acquire() {
      acquisitions += 1;
      return { header: 'solved-vqd', source: 'stub', commit() {}, release() {} };
    },
    async ensureVersion() {
      return '1.2.3';
    },
    stats() {
      return { lastSolveSource: 'stub', solves: acquisitions };
    },
    async invalidate(reason) {
      invalidations.push(reason);
    }
  };
  client._respectRateLimit = async () => {};
  client._fetch = fetchImpl;
  return { client, invalidations, acquisitions: () => acquisitions };
}

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('summarizeNative：418 自动重试一次并记录 overrideCode', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    if (calls.length === 1) {
      return jsonResponse({ action: 'error', status: 418, type: 'ERR_CHALLENGE', overrideCode: 'f741' }, 418);
    }
    return jsonResponse({ summary: { text: '阶段摘要', version: 2 }, coveredPairCount: 4 });
  };
  const { client, invalidations } = makeClient(fetchImpl);

  const result = await client.summarizeNative({
    model: 'gpt-6-luna',
    messages: [
      { role: 'user', text: 'Q1' },
      { role: 'assistant', text: 'A1' }
    ]
  });

  assert.equal(result.text, '阶段摘要');
  assert.equal(calls.length, 2, '418 后应重试一次');
  assert.equal(invalidations.length, 1, '418 应触发 invalidate');
  for (const call of calls) assert.equal(call.headers['x-vqd-hash-1'], 'solved-vqd', '每次尝试都使用已解挑战');
  assert.equal(client._stats.summaryRetries, 1);
  assert.equal(client._stats.lastOverrideCode, 'f741');
  assert.equal(client._stats.challengeRetries, 1);
});

test('chat：持续 418 时记录 overrideCode 归因（error/stats/overrideCodes）', async () => {
  const fetchImpl = async () =>
    jsonResponse({ action: 'error', status: 418, type: 'ERR_CHALLENGE', overrideCode: 'd78d' }, 418);
  const { client } = makeClient(fetchImpl);

  await assert.rejects(
    () => client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.equal(error.overrideCode, 'd78d', 'DuckError 应携带 overrideCode');
      assert.equal(error.transportStatus, 418);
      return true;
    }
  );

  const stats = client.health ? await client.health() : null;
  assert.equal(client._stats.lastOverrideCode, 'd78d');
  assert.equal(client._stats.overrideCodes['d78d:ERR_CHALLENGE'], 3, '3 次尝试（maxRetries=2）均归因');
  assert.equal(client._stats.limitHits418, 3);
  if (stats) assert.equal(stats.stats.lastOverrideCode, 'd78d', 'health().stats 暴露 overrideCode');
});
