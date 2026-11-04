/**
 * 挑战求解器单测（src/duck/challenge.js）。
 *
 * 用真实抓包得到的挑战 JS（tests/fixtures/challenge.captured.js，来自 recon-tmp/challenge.js，
 * 2026-11-01 抓取）验证完整流程：
 *   解码 base64 → jsdom 执行 → client_hashes SHA-256+base64 → meta 合并 → btoa payload
 * 并覆盖失败分支：无挑战头、上游 5xx/429、版本号缺失、执行超时、执行抛错、结果缺字段，
 * 以及滚动挑战（响应头下发的新挑战优先于 GET /status）与 invalidate 回退。
 *
 * 全部通过 mock 全局 fetch 完成，不访问真实网络。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  ChallengeManager,
  ChallengeError,
  sha256Base64,
  buildFeSignals,
  stackText
} from '../src/duck/challenge.js';

const FIXTURE_CHALLENGE_JS = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'challenge.captured.js'), 'utf8');
const CHALLENGE_B64 = Buffer.from(FIXTURE_CHALLENGE_JS, 'utf8').toString('base64');

const BASE_URL = 'https://duck.ai';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const VERSION_TAG = 'serp_20261030_223718_ET';
const VERSION_SHA = '61e4601227ece8af7a1ad4d69b79aafd35f91fae';

/** 捕获的挑战在 JS 里写死的 server_hashes（见 recon-tmp/challenge.js）。 */
const EXPECTED_SERVER_HASHES = [
  '4KI7/C9MlcE60w0m6WOqb4ok2jXh/15IxvSZV0R5l1c=',
  'RVB5DySrSmr0VgRmvjUWRSV/EY9gaTbUToG8nIUE/j4=',
  'iDHI/hNmtCES2jpCFlTXfg6rjgCxGhZEnaKLMMtVjIw='
];
const EXPECTED_CHALLENGE_ID =
  'b5dcc05392fc1e00d997c0846849915b9f200f5c250ca93bc8d294dd7e4bbc66q7klm';

const PAGE_HTML = `<!doctype html><html data-version-tag="${VERSION_TAG}" data-version-sha="${VERSION_SHA}"><head></head><body></body></html>`;

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

/**
 * Install a fetch mock; returns call log + restore().
 * @param {(url: URL, init: any) => Response | Promise<Response>} handler
 */
function installFetchMock(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push({ pathname: url.pathname, url: url.href, headers: init.headers || {} });
    return handler(url, init);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

/** Standard routes: homepage + /status (challenge) + /capabilities. */
function makeRoutes(overrides = {}) {
  const {
    homepage = () => new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
    status = () =>
      new Response('{"status":"0","secondaryStatus":"0","statusV2":0,"grant":null}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-vqd-hash-1': CHALLENGE_B64 }
      }),
    capabilities = () =>
      new Response('{"accessLevel":"public","flags":[],"experimentEnrollments":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  } = overrides;
  return (url) => {
    if (url.pathname === '/') return homepage(url);
    if (url.pathname === '/duckchat/v1/status') return status(url);
    if (url.pathname === '/duckchat/v1/capabilities') return capabilities(url);
    return new Response('not found', { status: 404 });
  };
}

function makeManager(overrides = {}) {
  return new ChallengeManager({
    baseUrl: BASE_URL,
    userAgent: USER_AGENT,
    timeoutMs: 5000,
    solveTimeoutMs: 20000,
    logger: null,
    ...overrides
  });
}

function decodeHeader(header) {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

/* ------------------------------------------------------------------ */
/* 辅助函数                                                            */
/* ------------------------------------------------------------------ */

test('sha256Base64: SHA-256(UTF-8) → 标准 base64', () => {
  // 公开测试向量：sha256("abc")
  assert.equal(sha256Base64('abc'), 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  assert.equal(sha256Base64(''), '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  assert.equal(sha256Base64('光'), sha256Base64('光'), 'UTF-8 编码稳定');
});

test('buildFeSignals: base64(JSON{start,events,end}) 结构', () => {
  const value = buildFeSignals([{ type: 'pointer' }]);
  const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), ['end', 'events', 'start']);
  assert.equal(typeof parsed.start, 'number');
  assert.equal(typeof parsed.end, 'number');
  assert.deepEqual(parsed.events, [{ type: 'pointer' }]);
});

test('stackText: 取前 N 帧并输出省略提示', () => {
  const value = stackText(5);
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0);
  // 帧数不超过 5 帧（加上可能的 "more frames omitted" 行）
  assert.ok(value.split('\n').length <= 6);
});

/* ------------------------------------------------------------------ */
/* 完整求解流程                                                        */
/* ------------------------------------------------------------------ */

test('完整流程：解码→jsdom 执行→sha256→payload，结构与真实 solved-payload 一致', async () => {
  const mock = installFetchMock(makeRoutes());
  try {
    const manager = makeManager();
    const initResult = await manager.init();
    assert.equal(initResult.version, `${VERSION_TAG}-${VERSION_SHA}`);
    assert.equal(initResult.challengeReady, true);

    const stats = manager.stats();
    assert.equal(stats.statusFetches, 1);
    assert.equal(stats.solves, 1);
    assert.equal(stats.solveErrors, 0);
    assert.equal(stats.upstreamStatus, '0');
    assert.equal(stats.lastChallengeId, EXPECTED_CHALLENGE_ID);

    // 请求 /status 时必须携带 initial 挑战语义的头部
    const statusCall = mock.calls.find((call) => call.pathname === '/duckchat/v1/status');
    assert.ok(statusCall, 'must call GET /duckchat/v1/status');
    assert.equal(statusCall.headers['x-vqd-accept'], '1');
    assert.equal(statusCall.headers['x-vqd-hash-1'], 'initial');
    assert.match(String(statusCall.headers['x-fe-version']), /\w+-\w+/);
    assert.ok(statusCall.headers['x-fe-signals']);

    // acquire() 拿到的一次性 header
    const lease = await manager.acquire({ reason: 'test' });
    try {
      assert.equal(typeof lease.header, 'string');
      assert.ok(lease.header.length > 200);
      const payload = decodeHeader(lease.header);

      // 1) server_hashes 原样来自挑战 JS
      assert.deepEqual(payload.server_hashes, EXPECTED_SERVER_HASHES);
      // 2) client_hashes 已替换为 SHA-256+base64
      assert.equal(payload.client_hashes.length, 3);
      for (const hash of payload.client_hashes) {
        assert.match(hash, /^[A-Za-z0-9+/]{43}=$/, `invalid sha256-base64: ${hash}`);
      }
      // 3) 首项是 navigator.userAgent 的哈希：验证“执行环境 UA == 请求头 UA”
      assert.equal(
        payload.client_hashes[0],
        sha256Base64(USER_AGENT),
        'jsdom navigator.userAgent must match the request header UA'
      );
      // 4) meta 合并
      assert.equal(payload.meta.v, '4');
      assert.equal(payload.meta.challenge_id, EXPECTED_CHALLENGE_ID);
      assert.equal(payload.meta.timestamp, '1793516115704');
      assert.equal(payload.meta.origin, BASE_URL);
      assert.equal(typeof payload.meta.stack, 'string');
      assert.match(payload.meta.stack, /at\s/);
      assert.match(payload.meta.duration, /^\d+$/);
      // 5) signals 透传
      assert.equal(typeof payload.signals, 'object');
    } finally {
      lease.release();
    }
  } finally {
    mock.restore();
  }
});

test('滚动挑战：commit(响应头) 后优先使用新挑战，不重新 GET /status', async () => {
  const mock = installFetchMock(makeRoutes());
  try {
    const manager = makeManager();
    await manager.init();

    const first = await manager.acquire();
    const firstPayload = decodeHeader(first.header);
    // 模拟 /chat 响应头下发的新挑战（内容可不同：这里复用同一份 JS）
    const nextChallenge = b64(FIXTURE_CHALLENGE_JS);
    first.commit(new Headers({ 'x-vqd-hash-1': nextChallenge }));
    first.release();
    assert.equal(manager.stats().rollingChallenges, 1);

    const second = await manager.acquire();
    try {
      const secondPayload = decodeHeader(second.header);
      assert.equal(secondPayload.meta.challenge_id, EXPECTED_CHALLENGE_ID);
      assert.equal(secondPayload.meta.origin, BASE_URL);
      // 第二次应从 commit 的滚动挑战解出，不再访问 /status
      assert.equal(mock.calls.filter((call) => call.pathname === '/duckchat/v1/status').length, 1);
      assert.equal(manager.stats().solves, 2);
    } finally {
      second.release();
    }
  } finally {
    mock.restore();
  }
});

test('invalidate 后重新 GET /status 取新挑战（418 重试路径）', async () => {
  const mock = installFetchMock(makeRoutes());
  try {
    const manager = makeManager();
    await manager.init();
    const first = await manager.acquire();
    first.release();
    await manager.invalidate('simulated-418');

    const second = await manager.acquire();
    try {
      assert.equal(typeof second.header, 'string');
      assert.equal(mock.calls.filter((call) => call.pathname === '/duckchat/v1/status').length, 2);
      assert.equal(manager.stats().solves, 2);
    } finally {
      second.release();
    }
  } finally {
    mock.restore();
  }
});

test('refresh(): 强制刷新并返回 header 长度', async () => {
  const mock = installFetchMock(makeRoutes());
  try {
    const manager = makeManager();
    const result = await manager.refresh();
    assert.equal(result.solved, true);
    assert.ok(result.headerLen > 200);
  } finally {
    mock.restore();
  }
});

/* ------------------------------------------------------------------ */
/* 失败分支                                                            */
/* ------------------------------------------------------------------ */

test('无挑战头：ChallengeError(challenge_fetch_failed, 不可重试)', async () => {
  const mock = installFetchMock(
    makeRoutes({
      status: () => new Response('{"status":"0"}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
  );
  try {
    const manager = makeManager();
    await assert.rejects(manager.init(), (error) => {
      assert.ok(error instanceof ChallengeError);
      assert.equal(error.type, 'challenge_fetch_failed');
      assert.equal(error.retriable, false);
      return true;
    });
    // 失败后 single-flight 标记要复位，下次可以重试
    assert.equal(manager.ready, false);
  } finally {
    mock.restore();
  }
});

test('上游 429/5xx：ChallengeError 可重试', async () => {
  for (const status of [429, 500, 503]) {
    const mock = installFetchMock(
      makeRoutes({ status: () => new Response('rate limited', { status, headers: { 'content-type': 'text/plain' } }) })
    );
    try {
      const manager = makeManager();
      await assert.rejects(manager.init(), (error) => {
        assert.ok(error instanceof ChallengeError, `status ${status} should raise ChallengeError`);
        if (status === 429) {
          // 429 可能被区分为限流错误，但必须可重试
          assert.ok(
            ['rate_limit_exceeded', 'challenge_fetch_failed'].includes(error.type),
            `unexpected 429 error type: ${error.type}`
          );
        } else {
          assert.equal(error.type, 'challenge_fetch_failed');
        }
        assert.equal(error.retriable, true, `status ${status} must be retriable`);
        return true;
      });
    } finally {
      mock.restore();
    }
  }
});

test('首页缺少 data-version 属性：ChallengeError(version_parse_failed)', async () => {
  const mock = installFetchMock(
    makeRoutes({ homepage: () => new Response('<html><head></head><body></body></html>', { status: 200 }) })
  );
  try {
    const manager = makeManager();
    await assert.rejects(manager.init(), (error) => {
      assert.ok(error instanceof ChallengeError);
      assert.equal(error.type, 'version_parse_failed');
      return true;
    });
  } finally {
    mock.restore();
  }
});

test('挑战执行超时：ChallengeError(type="timeout")', async () => {
  const hanging = b64('(async function(){ await new Promise(function(){ }); })()');
  const mock = installFetchMock(
    makeRoutes({
      status: () =>
        new Response('{"status":"0"}', { status: 200, headers: { 'x-vqd-hash-1': hanging } })
    })
  );
  try {
    const manager = makeManager({ solveTimeoutMs: 150 });
    await assert.rejects(manager.init(), (error) => {
      assert.ok(error instanceof ChallengeError);
      assert.equal(error.type, 'timeout');
      return true;
    });
    assert.equal(manager.stats().solveErrors, 1);
  } finally {
    mock.restore();
  }
});

test('挑战执行抛错：ChallengeError(challenge_solve_failed)', async () => {
  const throwing = b64('throw new Error("boom at eval");');
  const mock = installFetchMock(
    makeRoutes({
      status: () =>
        new Response('{"status":"0"}', { status: 200, headers: { 'x-vqd-hash-1': throwing } })
    })
  );
  try {
    const manager = makeManager();
    await assert.rejects(manager.init(), (error) => {
      assert.ok(error instanceof ChallengeError);
      assert.match(error.type, /challenge_solve_failed|challenge_result_invalid|network_error/);
      return true;
    });
  } finally {
    mock.restore();
  }
});

test('挑战结果缺 client_hashes：ChallengeError(challenge_result_invalid)', async () => {
  const invalid = b64('(async function(){ return { server_hashes: [] }; })()');
  const mock = installFetchMock(
    makeRoutes({
      status: () =>
        new Response('{"status":"0"}', { status: 200, headers: { 'x-vqd-hash-1': invalid } })
    })
  );
  try {
    const manager = makeManager();
    await assert.rejects(manager.init(), (error) => {
      assert.ok(error instanceof ChallengeError);
      assert.equal(error.type, 'challenge_result_invalid');
      return true;
    });
  } finally {
    mock.restore();
  }
});

test('fetchCapabilities 失败时安全降级为 null（不抛错）', async () => {
  const mock = installFetchMock(
    makeRoutes({ capabilities: () => new Response('boom', { status: 500 }) })
  );
  try {
    const manager = makeManager();
    await manager.init();
    const capabilities = await manager.fetchCapabilities();
    assert.equal(capabilities, null);
  } finally {
    mock.restore();
  }
});
