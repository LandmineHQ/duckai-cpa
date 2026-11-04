/**
 * DuckClient 契约测试（src/duck/index.js）——mock 全局 fetch，不访问真实网络。
 *
 * 覆盖 ARCHITECTURE §4 的调用契约与 ARCHITECTURE §2.3 的会话头/请求体：
 *   - init()/health()/getModelCatalog()
 *   - chat() 文本流式聚合 + 请求头/请求体校验（含 x-vqd-hash-1 已求解、x-fe-version、journey/response id 等）
 *   - 滚动挑战：响应头下发的新挑战被下一次请求复用（不重复 GET /status）
 *   - WebSearch：tool-result.data.citations → sources/citations
 *   - GenerateImage：ui-component success → images（丢弃 partial）
 *   - 418 重试（invalidate 后重新取挑战并成功）
 *   - 429 传播 DuckError（status/type/retryAfterMs）
 *   - 400 + system 消息 → 自动降级为 prompt-prefix 模式重试
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DuckClient, DuckError, DEFAULT_USER_AGENT } from '../src/duck/index.js';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

const CHALLENGE_B64 = Buffer.from(fixture('challenge.captured.js'), 'utf8').toString('base64');
const TEXT_SSE = fixture(path.join('sse', 'text-stream.sse'));
const SEARCH_SSE = fixture(path.join('sse', 'search-stream.sse'));
const IMAGE_SSE = fixture(path.join('sse', 'image-stream.sse'));

const BASE_URL = 'https://duck.ai';
const VERSION_TAG = 'serp_20261030_223718_ET';
const VERSION_SHA = '61e4601227ece8af7a1ad4d69b79aafd35f91fae';
const PAGE_HTML = `<!doctype html><html data-version-tag="${VERSION_TAG}" data-version-sha="${VERSION_SHA}"><head></head><body></body></html>`;

function installFetchMock(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const headers = init.headers || {};
    const call = {
      url,
      pathname: url.pathname,
      method: init.method || 'GET',
      headers,
      body: init.body ? JSON.parse(init.body) : null
    };
    calls.push(call);
    return handler(call, calls);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function textResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

function sseResponse(body, { headers = {} } = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-vqd-hash-1': CHALLENGE_B64, ...headers }
  });
}

/** Standard routes with a pluggable chat responder. */
function makeRoutes(chatResponder) {
  const routes = new Map();
  routes.set('/', () => new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
  routes.set('/duckchat/v1/status', () =>
    textResponse('{"status":"0","secondaryStatus":"0","statusV2":0,"grant":null}', {
      headers: { 'x-vqd-hash-1': CHALLENGE_B64 }
    })
  );
  routes.set('/duckchat/v1/capabilities', () =>
    textResponse('{"accessLevel":"public","flags":{},"experimentEnrollments":[]}')
  );
  routes.set('/duckchat/v1/chat', chatResponder);
  return (call, calls) => {
    const responder = routes.get(call.pathname);
    if (!responder) return new Response('not found', { status: 404 });
    return responder(call, calls);
  };
}

function makeClient(overrides = {}) {
  return new DuckClient({
    baseUrl: BASE_URL,
    defaultModel: 'gpt-6-luna',
    timeoutMs: 20000,
    humanize: {
      minDelayMs: 0,
      maxDelayMs: 0,
      minIntervalMs: 0,
      concurrency: 1,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      rateLimitCooldownMs: 100,
      rateLimitWaitMs: 1000
    },
    ...overrides
  });
}

function chatCalls(calls) {
  return calls.filter((call) => call.pathname === '/duckchat/v1/chat');
}

function decodeSolvedHeader(value) {
  return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
}

const FAST_CLIENT = { challenge: { timeoutMs: 15000, solveTimeoutMs: 15000 } };

/* ------------------------------------------------------------------ */
/* init / catalog                                                      */
/* ------------------------------------------------------------------ */

test('init(): 首页版本 + /status 挑战求解 + capabilities', async () => {
  const mock = installFetchMock(makeRoutes(() => sseResponse(TEXT_SSE)));
  try {
    const client = makeClient(FAST_CLIENT);
    await client.init();
    const health = await client.health();

    assert.equal(health.ok, true);
    assert.equal(health.challengeOk, true);
    assert.equal(health.version, `${VERSION_TAG}-${VERSION_SHA}`);
    assert.equal(health.upstreamStatus, '0');

    const initPaths = mock.calls.map((call) => call.pathname);
    assert.deepEqual([...initPaths].sort(), ['/', '/duckchat/v1/capabilities', '/duckchat/v1/status'].sort());
    assert.equal(chatCalls(mock.calls).length, 0, 'init must not POST /chat');

    const catalog = client.getModelCatalog();
    assert.ok(Array.isArray(catalog));
    assert.equal(catalog.length, 10);
    assert.ok(catalog.every((model) => typeof model.model === 'string' && typeof model.id === 'string'));
  } finally {
    mock.restore();
  }
});

/* ------------------------------------------------------------------ */
/* chat: 文本流式 + 请求头/体                                          */
/* ------------------------------------------------------------------ */

test('chat(): 文本增量聚合 + 会话头/请求体符合 §2.3', async () => {
  const mock = installFetchMock(makeRoutes(() => sseResponse(TEXT_SSE)));
  try {
    const client = makeClient(FAST_CLIENT);
    await client.init();

    const deltas = [];
    const result = await client.chat(
      {
        model: 'gpt-6-luna',
        reasoningEffort: 'low',
        messages: [{ role: 'user', content: '天空为什么是蓝色的？' }]
      },
      { onTextDelta: (text) => deltas.push(text) }
    );

    assert.equal(result.content, '光被大气中的分子散射蓝光。');
    assert.equal(result.cleanContent, result.content);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.title, '天空为什么是蓝色的');
    assert.equal(deltas.join(''), result.content);
    assert.equal(result.reasoningEffort, 'low');

    const calls = chatCalls(mock.calls);
    assert.equal(calls.length, 1);
    const call = calls[0];
    const headers = call.headers;

    assert.equal(headers['user-agent'], DEFAULT_USER_AGENT);
    assert.equal(headers.accept, 'text/event-stream');
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers.origin, BASE_URL);
    assert.ok(String(headers.referer).startsWith(`${BASE_URL}/`));
    assert.equal(headers['x-fe-version'], `${VERSION_TAG}-${VERSION_SHA}`);

    // x-fe-signals: base64(JSON{start,events,end})
    const feSignals = JSON.parse(Buffer.from(headers['x-fe-signals'], 'base64').toString('utf8'));
    assert.deepEqual(Object.keys(feSignals).sort(), ['end', 'events', 'start']);

    // x-vqd-hash-1: 已求解 payload（client_hashes 已 sha256+base64，meta 已补全）
    const solved = decodeSolvedHeader(headers['x-vqd-hash-1']);
    assert.equal(solved.server_hashes.length, 3);
    assert.equal(solved.client_hashes.length, 3);
    for (const hash of solved.client_hashes) assert.match(hash, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(solved.meta.origin, BASE_URL);

    assert.match(headers['x-duckai-response-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(headers['x-ddg-journey-id'], /^[0-9a-f]{32}$/);
    assert.equal(headers['x-duckai-continuation'], 'resubmit-context');
    assert.equal(headers['x-duckai-tool-approval'], 'web-search');
    assert.match(headers['x-duckai-consent-purposes'], /web-search/);
    assert.match(headers['x-duckai-consent-purposes'], /image-generation/);
    // v2.35：浏览器在不带客户端工具时不发该 header；与抓包保持一致（缺失即正确）
    assert.equal(headers['x-duckai-client-tools'], undefined);

    assert.deepEqual(call.body, {
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: [{ type: 'text', text: '天空为什么是蓝色的？' }] }],
      canUseTools: true,
      reasoningEffort: 'low',
      // v2.35：与浏览器一致的三个能力位（缺字段会让 continuation 判 incompatible）
      canUseApproxLocation: false,
      canDelegateImageGeneration: null,
      canShowGreeting: true
    });
  } finally {
    mock.restore();
  }
});

test('滚动挑战：上一次响应头下发的新挑战被下一次请求直接使用（不重复 GET /status）', async () => {
  const mock = installFetchMock(makeRoutes(() => sseResponse(TEXT_SSE)));
  try {
    const client = makeClient(FAST_CLIENT);
    await client.init();
    const first = await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: '第一问' }] }, {});
    assert.ok(first.content.length > 0);

    const second = await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: '第二问' }] }, {});
    assert.ok(second.content.length > 0);

    assert.equal(chatCalls(mock.calls).length, 2);
    assert.equal(
      mock.calls.filter((call) => call.pathname === '/duckchat/v1/status').length,
      1,
      'rolling challenge must not trigger a second GET /status'
    );
    // 两次请求都必须带已求解挑战，且第二次是**重新求解**滚动挑战（不是复用缓存值）。
    // 注意：不能比较 header 字符串是否不同——mock 每次都下发同一份 challenge，
    // 而 v2.21 起 meta.stack 是固定的入口帧，唯一性只靠 meta.duration（毫秒），
    // 同一毫秒内求解会得到完全相同的 header（历史上因此偶发失败）。
    const [firstCall, secondCall] = chatCalls(mock.calls);
    assert.ok(firstCall.headers['x-vqd-hash-1'], '第一次请求应带 x-vqd-hash-1');
    assert.ok(secondCall.headers['x-vqd-hash-1'], '第二次请求应带 x-vqd-hash-1');
    assert.ok(
      client.challenge.stats().solves >= 2,
      `第二次请求应重新求解滚动挑战（实际 solves=${client.challenge.stats().solves}）`
    );
  } finally {
    mock.restore();
  }
});

/* ------------------------------------------------------------------ */
/* chat: 搜索 / 图片                                                   */
/* ------------------------------------------------------------------ */

test('chat({webSearch:true})：tool-result.citations → sources/citations/cleanContent', async () => {
  const mock = installFetchMock(makeRoutes(() => sseResponse(SEARCH_SSE)));
  try {
    const client = makeClient(FAST_CLIENT);
    await client.init();

    const searchResults = [];
    const result = await client.chat(
      {
        model: 'gpt-6-luna',
        webSearch: true,
        messages: [{ role: 'user', content: '纽约天气？' }]
      },
      { onSearchResults: (list) => searchResults.push(list) }
    );

    const call = chatCalls(mock.calls)[0];
    // v2.35：不再用 toolChoice 强制 WebSearch（会让天气类 continuation 判 incompatible）；
    // 浏览器默认只发 canUseTools:true，模型自行决定是否联网。
    assert.equal(call.body.metadata, undefined);

    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].url, 'https://www.accuweather.com/en/us/new-york-city/10007/weather-forecast/349727');
    assert.equal(result.sources[0].title, 'New York City, NY Weather Forecast | AccuWeather');
    assert.equal(result.sources[1].url, 'https://weather.com/weather/today/l/10001:4:US');
    assert.equal(result.citations.length, 2);
    assert.equal(result.cleanContent, '今天纽约气温约12°C，局部多云。');
    assert.ok(result.markdown.includes('https://www.accuweather.com/'));
    assert.equal(result.toolResults.length, 1);
    assert.equal(result.toolResults[0].name, 'WebSearch', 'tool-result 的 name 应从 callId 推断');
    assert.equal(searchResults.length, 1);
    assert.equal(searchResults[0].length, 2);
  } finally {
    mock.restore();
  }
});

test('chat({imageGeneration:true})：只取 generate-image success，丢弃 image-partial', async () => {
  const mock = installFetchMock(makeRoutes(() => sseResponse(IMAGE_SSE)));
  try {
    const client = makeClient(FAST_CLIENT);
    await client.init();

    const images = [];
    const result = await client.chat(
      {
        model: 'gpt-6-luna',
        imageGeneration: true,
        messages: [{ role: 'user', content: '画一只戴墨镜的鸭子' }]
      },
      { onImage: (image) => images.push(image) }
    );

    const call = chatCalls(mock.calls)[0];
    assert.deepEqual(call.body.metadata, { toolChoice: { GenerateImage: true } });
    assert.equal(call.body.canShowGreeting, true);

    assert.equal(result.images.length, 1, 'partial image must be discarded');
    const image = result.images[0];
    assert.equal(image.format, 'jpeg');
    assert.equal(image.modelDisplayName, 'GPT Image 2');
    const bytes = Buffer.from(image.b64, 'base64');
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    assert.equal(images.length, 1);
    assert.equal(images[0].b64, image.b64);
  } finally {
    mock.restore();
  }
});

/* ------------------------------------------------------------------ */
/* 错误与重试                                                          */
/* ------------------------------------------------------------------ */

test('418 ERR_CHALLENGE：自动刷新挑战并重试一次，最终成功（v2 保留 418 传输层重试）', async () => {
  let attempt = 0;
  const mock = installFetchMock(
    makeRoutes(() => {
      attempt += 1;
      if (attempt === 1) {
        return textResponse('{"action":"error","status":418,"type":"ERR_CHALLENGE"}', { status: 418 });
      }
      return sseResponse(TEXT_SSE);
    })
  );
  try {
    const client = makeClient({ ...FAST_CLIENT, humanize: { minDelayMs: 0, maxDelayMs: 0, minIntervalMs: 0, concurrency: 1, maxRetries: 1, retryBaseDelayMs: 1, rateLimitCooldownMs: 100, rateLimitWaitMs: 1000 } });
    await client.init();

    const result = await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }, {});
    assert.ok(result.content.length > 0);
    assert.equal(chatCalls(mock.calls).length, 2, '418 must trigger one retry');
    assert.equal(
      mock.calls.filter((call) => call.pathname === '/duckchat/v1/status').length,
      2,
      '418 retry must fetch a fresh challenge'
    );
    const health = await client.health();
    assert.ok(health.stats.limitHits418 >= 1);
    assert.ok(health.stats.challengeRetries >= 1);
  } finally {
    mock.restore();
  }
});

test('418 ERR_CHALLENGE 持续失败：重试耗尽后映射为 upstream_anomaly_check（403，fatal）', async () => {
  const mock = installFetchMock(
    makeRoutes(() => textResponse('{"action":"error","status":418,"type":"ERR_CHALLENGE"}', { status: 418 }))
  );
  try {
    const client = makeClient({ ...FAST_CLIENT, humanize: { minDelayMs: 0, maxDelayMs: 0, minIntervalMs: 0, concurrency: 1, maxRetries: 1, retryBaseDelayMs: 1, rateLimitCooldownMs: 100, rateLimitWaitMs: 1000 } });
    await client.init();
    await assert.rejects(
      client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }, {}),
      (error) => {
        assert.ok(error instanceof DuckError);
        assert.equal(error.code, 'upstream_anomaly_check');
        assert.equal(error.status, 403);
        assert.equal(error.transportStatus, 418);
        return true;
      }
    );
    assert.equal(chatCalls(mock.calls).length, 2, 'retries exhausted after 2 attempts');
  } finally {
    mock.restore();
  }
});

test('5xx：自动刷新挑战并重试一次，最终成功', async () => {
  let attempt = 0;
  const mock = installFetchMock(
    makeRoutes(() => {
      attempt += 1;
      if (attempt === 1) {
        return textResponse('{"action":"error","status":500,"type":"ERR_UNKNOWN"}', { status: 500 });
      }
      return sseResponse(TEXT_SSE);
    })
  );
  try {
    const client = makeClient({ ...FAST_CLIENT, humanize: { minDelayMs: 0, maxDelayMs: 0, minIntervalMs: 0, concurrency: 1, maxRetries: 1, retryBaseDelayMs: 1, rateLimitCooldownMs: 100, rateLimitWaitMs: 1000 } });
    await client.init();

    const result = await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }, {});
    assert.ok(result.content.length > 0);
    assert.equal(chatCalls(mock.calls).length, 2, '5xx must trigger one retry');
    assert.equal(
      mock.calls.filter((call) => call.pathname === '/duckchat/v1/status').length,
      2,
      '5xx retry must fetch a fresh challenge'
    );
    const health = await client.health();
    assert.ok(health.stats.challengeRetries >= 1);
  } finally {
    mock.restore();
  }
});

test('429：抛出 DuckError(status=429)，携带 retryAfterMs/retryAt', async () => {
  const mock = installFetchMock(
    makeRoutes(() =>
      textResponse('{"action":"error","status":429,"type":"ERR_RATE_LIMIT"}', {
        status: 429,
        headers: { 'retry-after': '2' }
      })
    )
  );
  try {
    const client = makeClient({ ...FAST_CLIENT, humanize: { minDelayMs: 0, maxDelayMs: 0, minIntervalMs: 0, concurrency: 1, maxRetries: 0, retryBaseDelayMs: 0, rateLimitCooldownMs: 100000, rateLimitWaitMs: 1000 } });
    await client.init();

    await assert.rejects(
      client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }, {}),
      (error) => {
        assert.ok(error instanceof DuckError);
        assert.equal(error.status, 429);
        // v2 会把上游 ERR_RATE_LIMIT 归一化为 rate_limit_exceeded（type/code 均可承载）
        assert.match(String(error.type || error.code), /rate_limit/i);
        assert.ok(Number(error.retryAfterMs) > 0, 'retryAfterMs should be set');
        assert.ok(Number(error.retryAt) > Date.now(), 'retryAt should be in the future');
        return true;
      }
    );
    assert.equal(chatCalls(mock.calls).length, 1, 'maxRetries=0 must not retry 429');
  } finally {
    mock.restore();
  }
});

test('400 + system 消息：自动降级 prompt-prefix 模式重试成功', async () => {
  let attempt = 0;
  const mock = installFetchMock(
    makeRoutes(() => {
      attempt += 1;
      if (attempt === 1) {
        return textResponse('{"action":"error","status":400,"type":"ERR_BAD_REQUEST"}', { status: 400 });
      }
      return sseResponse(TEXT_SSE);
    })
  );
  try {
    const client = makeClient({ ...FAST_CLIENT, systemPromptMode: 'system' });
    await client.init();

    const result = await client.chat(
      {
        model: 'gpt-6-luna',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' }
        ]
      },
      {}
    );
    assert.ok(result.content.length > 0);
    const calls = chatCalls(mock.calls);
    assert.equal(calls.length, 2, 'system-role rejection must be retried once in prefix mode');
    assert.equal(calls[0].body.messages[0].role, 'system');
    assert.equal(calls[1].body.messages[0].role, 'user');
    assert.match(calls[1].body.messages[0].content[0].text, /^\[系统指令\]/);
    assert.match(calls[1].body.messages[0].content[0].text, /be brief/);
  } finally {
    mock.restore();
  }
});

/* ------------------------------------------------------------------ */
/* v2.2：身份注入（durableStream + 稳定 journeyId）                     */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('v2.2 identity：chat body 含 durableStream，journeyId 来自 identity（非随机）', async () => {
  const os = await import('node:os');
  const idFs = await import('node:fs/promises');
  const dataDir = path.join(os.tmpdir(), `duckai-qa-idclient-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { createIdentityStore } = await import('../src/duck/identity.js');
  const identityStore = await createIdentityStore({ dataDir, config: {} });
  const redacted = identityStore.getRedacted();
  const mock = installFetchMock(makeRoutes(() => sseResponse(TEXT_SSE)));
  try {
    const client = makeClient({ ...FAST_CLIENT, identityStore, durableStream: { enabled: true } });
    await client.init();
    const health = await client.health();
    assert.ok(health.identity, 'health().identity missing');
    assert.equal(health.identity.stable, true);
    assert.equal(health.identity.journeyId, redacted.journeyId);
    assert.equal(health.identity.fingerprint, redacted.durableStream.fingerprint);
    // v2.2：durableStream 运行态（configured/enabled/degraded/rejectedCount）
    assert.ok(health.durableStream, 'health().durableStream missing');
    assert.equal(health.durableStream.configured, true);
    assert.equal(health.durableStream.enabled, true);
    assert.equal(health.durableStream.degraded, false);
    assert.equal(health.durableStream.rejectedCount, 0);

    await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: '第一问' }] }, {});
    await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: '第二问' }] }, {});
    const calls = chatCalls(mock.calls);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.headers['x-ddg-journey-id'], redacted.journeyId, 'journeyId must come from identity');
      const durableStream = call.body.durableStream;
      assert.ok(durableStream, 'chat body must include durableStream when identity is configured');
      assert.match(durableStream.messageId, UUID_RE);
      assert.match(durableStream.conversationId, UUID_RE);
      assert.equal(durableStream.publicKey.kty, 'RSA');
      assert.equal(durableStream.publicKey.alg, 'RSA-OAEP-256');
    }
    // conversationId 稳定；messageId 每请求随机
    assert.equal(calls[0].body.durableStream.conversationId, calls[1].body.durableStream.conversationId);
    assert.notEqual(calls[0].body.durableStream.messageId, calls[1].body.durableStream.messageId);
  } finally {
    mock.restore();
    await idFs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('v2.2 identity：未注入 identityStore 时降级（不发送 durableStream，health stable=false）', async () => {
  const mock = installFetchMock(makeRoutes(() => sseResponse(TEXT_SSE)));
  try {
    const client = makeClient(FAST_CLIENT);
    await client.init();
    const health = await client.health();
    if (health.identity) {
      assert.equal(health.identity.stable, false);
      assert.equal(health.identity.source, 'volatile');
    }
    await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }, {});
    const call = chatCalls(mock.calls)[0];
    assert.equal(call.body.durableStream, undefined, 'volatile mode must not send durableStream');
  } finally {
    mock.restore();
  }
});

/* ------------------------------------------------------------------ */
/* v2.3：代理注入（proxyManager.fetch 统一包装上游请求）                */
/* ------------------------------------------------------------------ */

test('v2.3 proxy：所有上游请求经 proxyManager.fetch；health().proxy 透出', async () => {
  const mock = installFetchMock(makeRoutes(() => sseResponse(TEXT_SSE)));
  let proxiedFetches = 0;
  const proxyManager = {
    fetch: async (url, init) => {
      proxiedFetches += 1;
      return globalThis.fetch(url, init);
    },
    getSummary: () => ({
      enabled: true,
      mode: 'http',
      active: true,
      lastTestOk: true,
      lastTestLatencyMs: 210,
      exitIp: '70.39.202.155'
    }),
    shouldBypass: () => false
  };
  try {
    const client = makeClient({ ...FAST_CLIENT, proxyManager });
    await client.init();
    await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }] }, {});

    assert.equal(chatCalls(mock.calls).length, 1);
    assert.ok(
      proxiedFetches >= 3,
      `首页/status/chat 都应经 proxyManager.fetch（实际 ${proxiedFetches} 次）`
    );

    const health = await client.health();
    assert.ok(health.proxy, 'health().proxy missing');
    assert.equal(health.proxy.enabled, true);
    assert.equal(health.proxy.mode, 'http');
    assert.equal(health.proxy.active, true);
    assert.equal(health.proxy.exitIp, '70.39.202.155');
    assert.equal(health.proxy.lastTestOk, true);
  } finally {
    mock.restore();
  }
});

test('v2.3 proxy：未注入 proxyManager 时 health().proxy 为 direct/disabled', async () => {
  const mock = installFetchMock(makeRoutes(() => sseResponse(TEXT_SSE)));
  try {
    const client = makeClient(FAST_CLIENT);
    await client.init();
    const health = await client.health();
    if (health.proxy) {
      assert.equal(health.proxy.enabled, false);
      assert.equal(health.proxy.mode, 'direct');
      assert.equal(health.proxy.active, false);
    }
  } finally {
    mock.restore();
  }
});
