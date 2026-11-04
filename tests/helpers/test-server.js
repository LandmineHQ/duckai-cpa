/**
 * Test harness (v2): starts a real `src/http/server.js` instance on an ephemeral port
 * with an injected mock DuckClient and a temporary data directory.
 *
 * v2 破坏性变更：/v1/* 强制 API Key；/admin/api/* 强制 admin token。
 * 测试通过固定的 `API_KEY`（写进 config.auth.apiKeys）与 `ADMIN_TOKEN` 访问。
 *
 * Everything written by the tests lands in `duckai-cpa/data/tmp/qa-<random>/`
 * (removed on close unless `cleanup:false`), so the repository stays clean.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createServer } from '../../src/http/server.js';
import { createStore } from '../../src/store.js';
import { normalizeConfig, PROJECT_ROOT } from '../../src/config.js';
import { createNullLogger } from '../../src/logger.js';
import { createResponseStore } from '../../src/openai/responses-store.js';
import { MockDuckClient } from './mock-duck.js';
// v2.42：测试绝不发真实外网请求（duck.ai / duckduckgo.com 等统一拦截为 503）
import './no-external-network.js';

export const API_KEY = 'sk-duck-test-0123456789abcdef';
export const ADMIN_TOKEN = 'test-admin-token-0123456789';

/** 默认 v2 config：强制鉴权 + RPS 队列默认值 + 关闭 humanize 抖动（测试提速）。 */
export function makeConfig(overrides = {}) {
  const base = {
    auth: { adminToken: ADMIN_TOKEN, apiKeys: [API_KEY] },
    upstream: { rps: 1, maxConcurrent: 1, queueLimit: 50, queueTimeoutMs: 300000 },
    logging: { level: 'silent' },
    prompts: { mode: 'inline' },
    duck: {
      allowPaidModels: false,
      humanize: { minDelayMs: 0, maxDelayMs: 0, minIntervalMs: 0 }
    }
  };
  const merged = {
    ...base,
    ...overrides,
    auth: { ...base.auth, ...(overrides.auth || {}) },
    upstream: { ...base.upstream, ...(overrides.upstream || {}) },
    logging: { ...base.logging, ...(overrides.logging || {}) },
    duck: { ...base.duck, ...(overrides.duck || {}) }
  };
  return normalizeConfig(merged);
}

/** Headers for /v1/* (forced API key). */
export function apiHeaders(extra = {}) {
  return { authorization: `Bearer ${API_KEY}`, ...extra };
}

/** Headers for /admin/api/* (admin token). */
export function adminHeaders(extra = {}) {
  return { authorization: `Bearer ${ADMIN_TOKEN}`, ...extra };
}

/**
 * Start an isolated gateway instance.
 * @param {{ config?: Record<string, any>, duck?: MockDuckClient, dataDir?: string,
 *   cleanup?: boolean, webDir?: string }} [options]
 * @returns {Promise<{ baseUrl: string, server: any, store: any, config: any,
 *   duck: MockDuckClient, dataDir: string, apiKey: string, adminToken: string,
 *   close: () => Promise<void> }>}
 */
export async function startTestServer(options = {}) {
  const config = options.config || makeConfig();
  const duck = options.duck || new MockDuckClient();
  const dataDir =
    options.dataDir || path.join(PROJECT_ROOT, 'data', 'tmp', `qa-${crypto.randomBytes(6).toString('hex')}`);
  const cleanup = options.cleanup !== false;
  await fs.mkdir(dataDir, { recursive: true });

  const logger = createNullLogger();
  const store = createStore({ dataDir, config, logger });
  await store.init();

  // v2.2：身份 store（懒加载，避免未实现时影响既有测试）。api-core 约定 admin 路由从 ctx.store.identity 读取。
  let identityStore = options.identityStore || null;
  if (!identityStore && options.identity) {
    const identityModule = await import('../../src/duck/identity.js');
    identityStore = await identityModule.createIdentityStore({ dataDir, config, logger });
  }
  if (identityStore) store.identity = identityStore;

  // v2.3：代理 manager（懒加载；createServer({ proxy }) 显式注入，未就绪时相关端点应返回 proxy_unavailable）。
  let proxyManager = options.proxyManager || null;
  if (!proxyManager && options.proxy) {
    const proxyModule = await import('../../src/duck/proxy.js');
    proxyManager = await proxyModule.createProxyManager({
      config,
      logger,
      ...(options.proxyOptions || {})
    });
  }
  if (proxyManager) store.proxy = proxyManager;

  // v2.4：身份池（懒加载；createServer({ identities }) 显式注入，未就绪时 identities 端点应 503 identity_pool_unavailable）。
  let identityPool = options.identityPool || options.identities || null;
  if (!identityPool && (options.pool || options.withIdentities)) {
    const poolModule = await import('../../src/duck/identity-pool.js');
    const createRuntime =
      options.createRuntime ||
      ((record, ctx) => ({ identityId: ctx.identityId, identity: record, client: duck, queueWaitMs: 0 }));
    identityPool = await poolModule.createIdentityPool({
      dataDir,
      config,
      logger,
      createRuntime,
      ...(proxyManager ? { proxyManager } : {}),
      ...(options.poolOptions || {})
    });
    await identityPool.init?.();
    if (identityPool) store.identities = identityPool;
  }

  // v2.11：会话 compact 摘要存储（X-Session-Id / session summary；默认按 dataDir 创建）。
  let chatSummaries = options.chatSummaries || null;
  if (!chatSummaries && options.chatSummaries !== false) {
    const summaryModule = await import('../../src/admin/chat-summaries.js');
    chatSummaries = await summaryModule.createChatSummaryStore({ dataDir, logger }).init();
  }

  // v2.8：Sync 设备注册服务（工厂可拿到已创建的 identity/dataDir；也可直接传实例）。
  let syncDevices = null;
  if (typeof options.syncDevices === 'function') {
    syncDevices = await options.syncDevices({ identity: identityStore, identityPool, dataDir, config, store, logger });
  } else if (options.syncDevices) {
    syncDevices = options.syncDevices;
  }

  let responseStore = options.responsesStore || null;
  if (!responseStore && options.responses !== false) {
    try {
      responseStore = await createResponseStore({ dataDir, config, logger });
    } catch {
      responseStore = null;
    }
  }

  const server = createServer({
    config,
    store,
    duck,
    logger,
    ...(syncDevices ? { syncDevices } : {}),
    webDir: options.webDir || path.join(PROJECT_ROOT, 'web'),
    ...(identityStore ? { identity: identityStore } : {}),
    ...(proxyManager ? { proxy: proxyManager } : {}),
    ...(options.pairing ? { pairing: options.pairing } : {}),
    ...(chatSummaries ? { chatSummaries } : {}),
    ...(identityPool ? { identities: identityPool } : {}),
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.subscriptions ? { subscriptions: options.subscriptions } : {}),
    ...(options.history ? { history: options.history } : {}),
    ...(responseStore ? { responsesStore: responseStore } : {}),
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.mcp ? { mcp: options.mcp } : {})
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await server.closeGracefully({ timeoutMs: 3000 });
    } catch {
      /* ignore */
    }
    try {
      server.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    try {
      await chatSummaries?.close?.();
    } catch {
      /* ignore */
    }
    try {
      await identityStore?.flush?.();
    } catch {
      /* ignore */
    }
    try {
      await proxyManager?.close?.();
    } catch {
      /* ignore */
    }
    try {
      await identityPool?.close?.();
    } catch {
      /* ignore */
    }
    if (cleanup) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };

  const apiKey = (config.auth?.apiKeys && config.auth.apiKeys[0]) || API_KEY;
  const adminToken = config.auth?.adminToken || ADMIN_TOKEN;

  return {
    baseUrl,
    server,
    store,
    config,
    duck,
    dataDir,
    apiKey,
    adminToken,
    identityStore,
    proxyManager,
    identityPool,
    pairing: options.pairing || null,
    chatSummaries,
    syncDevices,
    close
  };
}

/**
 * Start a server, run `fn`, always close. Convenience for isolated tests.
 * @template T
 * @param {{ config?: Record<string, any>, duck?: MockDuckClient }} [options]
 * @param {(server: Awaited<ReturnType<typeof startTestServer>>) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withServer(options, fn) {
  const server = await startTestServer(options);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * One-shot JSON request.
 * @param {string} baseUrl
 * @param {string} pathName
 * @param {{ method?: string, headers?: Record<string,string>, body?: any, raw?: string,
 *   signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function request(baseUrl, pathName, options = {}) {
  const { method = 'GET', headers = {}, body, raw, signal, timeoutMs = 30000 } = options;
  const init = {
    method,
    headers: { ...headers },
    signal: signal || AbortSignal.timeout(timeoutMs)
  };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.headers['content-type'] = init.headers['content-type'] || 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${pathName}`, init);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, headers: response.headers, text, json, response };
}

/** GET/POST /v1/* with the forced API key. */
export function v1Request(baseUrl, pathName, options = {}) {
  return request(baseUrl, pathName, { ...options, headers: apiHeaders(options.headers || {}) });
}

/** GET/PUT/POST/DELETE /admin/api/* with the admin token. */
export function adminRequest(baseUrl, pathName, options = {}) {
  return request(baseUrl, pathName, { ...options, headers: adminHeaders(options.headers || {}) });
}

/**
 * Poll until `predicate()` is truthy (used by queue/log timing assertions).
 * @template T
 * @param {() => Promise<T> | T} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number, message?: string }} [options]
 */
export async function waitFor(predicate, options = {}) {
  const { timeoutMs = 5000, intervalMs = 25, message = 'condition not met before timeout' } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Minimal independent SSE reader (deliberately not reusing src/duck/sse.js so the
 * tests do not validate one implementation against itself).
 *
 * Returns `[{ event, data, json }]`; heartbeat comments are skipped.
 * @param {Response} response
 */
export async function readSSEResponse(response) {
  if (!response.body) throw new Error('response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const events = [];
  let eventName = null;
  let dataLines = [];

  const dispatch = () => {
    if (eventName === null && dataLines.length === 0) return;
    const data = dataLines.join('\n');
    let json = null;
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        json = JSON.parse(trimmed);
      } catch {
        json = null;
      }
    }
    events.push({ event: eventName, data, json });
    eventName = null;
    dataLines = [];
  };

  const consumeLine = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    if (colon === -1) return;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      consumeLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.length) consumeLine(buffer);
  dispatch();
  return events;
}

/** Read an SSE response into a normalized event list (`[DONE]` → `{done:true}`). */
export async function collectSSE(baseUrl, pathName, options = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(pathName.startsWith('/v1/') && !(options.headers || {}).authorization
      ? { authorization: `Bearer ${API_KEY}` }
      : {}),
    ...(options.headers || {})
  };
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: options.method || 'POST',
    headers,
    body: JSON.stringify(options.body ?? {}),
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 60000)
  });
  const events = await readSSEResponse(response);
  return { response, events };
}

/** Decode a base64 payload and assert it starts with known image magic bytes. */
export function decodeImageBase64(b64) {
  return Buffer.from(String(b64 || ''), 'base64');
}

export function isPNG(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
}

export function isJPEG(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

export function isImageBytes(buffer) {
  return isPNG(buffer) || isJPEG(buffer);
}
