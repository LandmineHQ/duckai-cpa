/**
 * v2.62 挑战生命周期修复回归（src/duck/challenge.js）。
 *
 * 覆盖：
 *  - /capabilities 等旁路响应头挑战只在 idle 时采纳，不再覆盖进行中的滚动链；
 *  - 未求解滚动挑战超过 pendingTtlMs 后丢弃并重新 /status；
 *  - 版本 tag/sha 缓存过期后，求解前自动刷新首页（meta.stack / __DDG_* 新鲜度）；
 *  - 诊断字段：lastChallengeSuite（challenge_id 后缀）/ lastClientHashes（明文指纹）；
 *  - buildFeSignals 的 `end` 语义（距离 start 的毫秒差，而非 epoch）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ChallengeManager, DEFAULT_USER_AGENT, buildFeSignals } from '../src/duck/challenge.js';

const CHALLENGE_B64 = Buffer.from(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'challenge.captured.js'), 'utf8'),
  'utf8'
).toString('base64');
const BASE_URL = 'https://duck.ai';
const VERSION_TAG = 'serp_20261030_223718_ET';
const VERSION_SHA = '61e4601227ece8af7a1ad4d69b79aafd35f91fae';
const PAGE_HTML = `<!doctype html><html data-version-tag="${VERSION_TAG}" data-version-sha="${VERSION_SHA}"><head></head><body></body></html>`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function installFetchMock() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push({ pathname: url.pathname });
    if (url.pathname === '/') return new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/duckchat/v1/status') {
      return new Response('{"status":"0"}', { status: 200, headers: { 'content-type': 'application/json', 'x-vqd-hash-1': CHALLENGE_B64 } });
    }
    return new Response('not found', { status: 404 });
  };
  return {
    calls,
    count: (pathname) => calls.filter((call) => call.pathname === pathname).length,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function makeManager(overrides = {}) {
  return new ChallengeManager({
    baseUrl: BASE_URL,
    userAgent: DEFAULT_USER_AGENT,
    timeoutMs: 5000,
    solveTimeoutMs: 20000,
    logger: null,
    ...overrides
  });
}

test('旁路挑战头只在 idle 时采纳（不覆盖进行中的滚动链）', async () => {
  const mock = installFetchMock();
  try {
    const manager = makeManager();
    assert.equal(await manager.noteChallengeFromHeader(CHALLENGE_B64), true, 'idle 时应采纳');
    assert.equal(await manager.noteChallengeFromHeader(CHALLENGE_B64), false, '已有 pending 时不应覆盖');
    assert.equal(manager.stats().externalChallengeSkips, 1);
    assert.equal(manager.stats().externalChallenges, 1);

    const lease = await manager.acquire({ reason: 'test' });
    lease.release();
    // acquire 消费掉 pending/solved 后重新 idle，可再次采纳。
    assert.equal(await manager.noteChallengeFromHeader(CHALLENGE_B64), true);
  } finally {
    mock.restore();
  }
});

test('未求解滚动挑战超过 pendingTtlMs → 丢弃并重新 GET /status', async () => {
  const mock = installFetchMock();
  try {
    const manager = makeManager({ pendingTtlMs: 20 });
    await manager.init();
    const first = await manager.acquire();
    assert.equal(first.source, 'cache', 'init() 已预热一个已解值');
    first.commit(new Headers({ 'x-vqd-hash-1': CHALLENGE_B64 }));
    first.release();
    assert.equal(manager.stats().statusFetches, 1);

    await sleep(60);
    const second = await manager.acquire({ reason: 'stale-pending' });
    try {
      assert.equal(second.source, 'status', '陈旧 pending 应被丢弃后走 /status');
      assert.equal(manager.stats().stalePendingDropped, 1);
      assert.equal(mock.count('/duckchat/v1/status'), 2);
    } finally {
      second.release();
    }
  } finally {
    mock.restore();
  }
});

test('版本缓存过期后求解前自动刷新首页（versionRefreshes）', async () => {
  const mock = installFetchMock();
  try {
    const manager = makeManager({ versionTtlMs: 5 });
    await manager.init();
    const first = await manager.acquire();
    first.commit(new Headers({ 'x-vqd-hash-1': CHALLENGE_B64 }));
    first.release();
    assert.equal(mock.count('/'), 1);

    await sleep(30);
    const second = await manager.acquire({ reason: 'version-refresh' });
    try {
      assert.equal(manager.stats().versionRefreshes, 1, '求解前应刷新过期版本');
      assert.equal(mock.count('/'), 2, '应重新抓取首页');
      assert.equal(manager.stats().statusFetches, 1, '滚动挑战链不应因此重新 /status');
    } finally {
      second.release();
    }
  } finally {
    mock.restore();
  }
});

test('诊断字段：lastChallengeSuite / lastClientHashes 记录明文环境指纹', async () => {
  const mock = installFetchMock();
  try {
    const manager = makeManager();
    await manager.init();
    const stats = manager.stats();
    assert.equal(stats.environment, 'page');
    assert.equal(stats.lastChallengeSuite, 'q7klm', 'fixture challenge_id 后缀即 suite tag');
    assert.equal(Array.isArray(stats.lastClientHashes), true);
    assert.equal(stats.lastClientHashes.length, 3);
    assert.match(stats.lastClientHashes[0], /Mozilla\/5\.0/);
    assert.equal(stats.pendingTtlMs, 120000);
    assert.equal(stats.versionTtlMs, 300000);
  } finally {
    mock.restore();
  }
});

test('buildFeSignals：end 是相对 start 的毫秒差（浏览器语义）', () => {
  const parsed = JSON.parse(Buffer.from(buildFeSignals(), 'base64').toString('utf8'));
  assert.equal(typeof parsed.start, 'number');
  assert.equal(typeof parsed.end, 'number');
  assert.ok(parsed.end >= 0 && parsed.end < 1000, `end 应为毫秒差，实际 ${parsed.end}`);
});
