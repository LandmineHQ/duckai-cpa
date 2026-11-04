/**
 * Duck.ai upstream challenge manager — `x-vqd-hash-1` (JSA) solving.
 *
 * Flow (verified against the live upstream, 2026-11-01):
 *   1. `GET /`                                   → `<html data-version-tag data-version-sha>` → `x-fe-version`.
 *   2. `GET /duckchat/v1/status`                 → response header `x-vqd-hash-1` = base64(obfuscated async IIFE).
 *      Request headers must carry `x-vqd-accept: 1`, `x-vqd-hash-1: initial`, `x-fe-version`, `x-fe-signals`.
 *   3. Execute the decoded JS in a browser-like realm (jsdom). It resolves to
 *      `{ server_hashes, client_hashes: [string...], signals, meta:{v,challenge_id,timestamp,debug} }`.
 *   4. Browser post-processing: SHA-256(UTF-8) → base64 for every client_hash; append
 *      `meta.origin` (page origin), `meta.stack` (first 5 Error frames) and `meta.duration` (ms string);
 *      `btoa(JSON.stringify(payload))` becomes the next request's `x-vqd-hash-1` header.
 *   5. Rolling: every `/duckchat/*` response carries a *new* challenge in its `x-vqd-hash-1` response header.
 *      The browser solves it before the next request. Re-fetching `/status` for every request instead of
 *      consuming the rolling challenge makes the upstream fail every other request with 418 ERR_CHALLENGE.
 *
 * This module owns: version discovery, challenge fetching, jsdom solving, the rolling state machine and
 * the mutex that makes exactly one in-flight request the consumer/updater of the challenge at a time.
 */
import crypto from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';

/** Default desktop Chrome UA — must stay identical between the solver realm and request headers. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

export const DEFAULT_BASE_URL = 'https://duck.ai';

/**
 * Error raised by the challenge subsystem. `DuckClient` converts it into `DuckError`
 * so the public API only ever sees one error type.
 */
export class ChallengeError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, type?: string, retriable?: boolean, cause?: unknown, body?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ChallengeError';
    this.status = meta.status ?? 502;
    this.type = meta.type ?? 'challenge_error';
    this.retriable = meta.retriable ?? true;
    if (meta.body !== undefined) this.body = meta.body;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

/** @param {string} text */
function base64Utf8(text) {
  return Buffer.from(String(text), 'utf8').toString('base64');
}

/** @param {string} text */
export function sha256Base64(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('base64');
}

/**
 * `x-fe-signals` value the browser sends: base64(JSON{start,events,end}).
 * @param {Array<unknown>} [events]
 * @returns {string}
 */
export function buildFeSignals(events = []) {
  const start = Date.now();
  return base64Utf8(JSON.stringify({ start, events, end: start + 37 }));
}

/**
 * Browser-equivalent `Error().stack` extraction: first `frames` stack frames, trimmed,
 * plus an omitted-frames suffix (matches the site solver's helper `u(e, t = 5)`).
 * @param {number} [frames]
 * @returns {string}
 */
export function stackText(frames = 5) {
  const err = new Error();
  const lines = String(err.stack || '').split('\n');
  const message = err.message || 'Unknown';
  const first = lines[0] && lines[0].includes(message) ? 1 : 0;
  const picked = lines.slice(first, first + frames).map((line) => line.trim());
  const omitted = lines.length - first - frames;
  return picked.join('\n') + (omitted > 0 ? `\n... (${omitted} more frames omitted)` : '');
}

/** @template T @param {Promise<T>} promise @param {number} ms @param {string} label @returns {Promise<T>} */
function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ChallengeError(`${label} timed out after ${ms}ms`, { type: 'timeout', retriable: true })), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Minimal async mutex. `acquire()` resolves to a release function; the lock is FIFO.
 */
class Mutex {
  constructor() {
    /** @type {Promise<void>} */
    this._tail = Promise.resolve();
  }

  /** @returns {Promise<() => void>} */
  acquire() {
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const previous = this._tail;
    this._tail = gate;
    return previous.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    });
  }

  /** Run `fn` while holding the lock. */
  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Core challenge state machine.
 *
 * State:
 *  - `_pending` : raw base64 challenge JS received from the upstream, not solved yet (rolling).
 *  - `_solved`  : `{ value, at }` solved header value, not consumed yet.
 *  - lease      : acquired by the HTTP layer per outbound request. Consumes `_solved` and, on commit,
 *                 stores the challenge handed back by that response.
 */
export class ChallengeManager {
  /**
   * @param {{
   *   baseUrl?: string,
   *   userAgent?: string,
   *   timeoutMs?: number,
   *   versionTtlMs?: number,
   *   challengeTtlMs?: number,
   *   statusTimeoutMs?: number,
   *   solveTimeoutMs?: number,
   *   fetchImpl?: typeof fetch,
   *   logger?: { debug?: Function, warn?: Function, info?: Function, error?: Function } | null
   * }} [config]
   */
  constructor(config = {}) {
    this.baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.userAgent = config.userAgent || DEFAULT_USER_AGENT;
    this.timeoutMs = config.timeoutMs ?? 20000;
    this.statusTimeoutMs = config.statusTimeoutMs ?? this.timeoutMs;
    this.solveTimeoutMs = config.solveTimeoutMs ?? 20000;
    this.versionTtlMs = config.versionTtlMs ?? 30 * 60 * 1000;
    this.challengeTtlMs = config.challengeTtlMs ?? 90 * 1000;
    this.logger = config.logger || null;
    // v2.3: every outbound request must go through the proxy-aware fetch when configured.
    this.fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : globalThis.fetch;
    this.proxyMode = null;

    /** @type {{ value: string | null, at: number }} */
    this._version = { value: null, at: 0 };
    /** @type {string | null} */
    this._pending = null;
    /** @type {{ value: string, at: number } | null} */
    this._solved = null;
    /** @type {Promise<unknown> | null} */
    this._initPromise = null;
    this._mutex = new Mutex();
    this._lastUpstreamStatus = 'unknown';
    this._lastUpstreamBody = '';
    /** Where the most recently solved challenge came from: 'status' | 'rolling' | 'cache'. */
    this._lastSolveSource = null;
    this._stats = {
      statusFetches: 0,
      rollingChallenges: 0,
      externalChallenges: 0,
      solves: 0,
      solveErrors: 0,
      versionFetches: 0,
      versionErrors: 0,
      lastSolvedAt: 0,
      lastSolveDurationMs: 0,
      lastSolveSource: null,
      lastChallengeId: null,
      lastError: null
    };
  }

  /** Last known `x-fe-version` (may be null before `init()`). */
  get version() {
    return this._version.value;
  }

  /** Last `/duckchat/v1/status` payload (JSON stringified) or `unknown`. */
  get upstreamStatus() {
    return this._lastUpstreamStatus;
  }

  /** Challenge is warm when a solved value or an unsolved rolling challenge is buffered. */
  get ready() {
    return Boolean(this._solved || this._pending);
  }

  /** Diagnostics for `DuckClient.health()`. */
  stats() {
    return {
      ...this._stats,
      version: this._version.value,
      upstreamStatus: this._lastUpstreamStatus,
      pendingChallenge: Boolean(this._pending),
      solvedChallenge: Boolean(this._solved),
      solvedAgeMs: this._solved ? Date.now() - this._solved.at : null
    };
  }

  /**
   * Fetch homepage version + warm one challenge. Safe to call multiple times (single-flight).
   * @returns {Promise<{ version: string | null, challengeReady: boolean }>}
   */
  async init() {
    if (!this._initPromise) {
      this._initPromise = this._mutex
        .run(async () => {
          const version = await this._ensureVersionLocked();
          if (!this._pending && !this._solved) {
            await this._fetchStatusChallengeLocked();
          }
          if (this._pending && !this._solved) {
            this._solved = { value: await this._solveLocked(this._pending), at: Date.now() };
            this._pending = null;
          }
          return { version, challengeReady: this.ready };
        })
        .catch((error) => {
          // Warmup failures must not poison later calls: reset the single-flight marker.
          this._initPromise = null;
          throw error;
        });
    }
    return this._initPromise;
  }

  /**
   * Acquire a lease for exactly one outbound request.
   *
   * Resolves to `{ header, commit(headers), release() }`. The caller MUST call `release()`
   * (typically in a `finally` block) and SHOULD call `commit(response.headers)` as soon as the
   * response headers are available so the rolling challenge is captured.
   *
   * @param {{ reason?: string }} [options]
   */
  async acquire(options = {}) {
    const release = await this._mutex.acquire();
    try {
      const header = await this._ensureSolvedLocked(options.reason);
      const source = this._lastSolveSource;
      this._solved = null; // consumed by this request
      let released = false;
      return {
        header,
        source,
        /** @param {Headers} responseHeaders */
        commit: (responseHeaders) => this._commitLocked(responseHeaders),
        release: () => {
          if (released) return;
          released = true;
          release();
        }
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * Drop every buffered challenge (used after 418/429) so the next request re-fetches `/status`.
   * @param {string} [reason]
   */
  async invalidate(reason = 'invalidated') {
    await this._mutex.run(() => {
      this._solved = null;
      this._pending = null;
      this._stats.lastError = reason;
    });
  }

  /** Force a fresh `/status` challenge and solve it (used by health probes / self-tests). */
  async refresh() {
    return this._mutex.run(async () => {
      await this._fetchStatusChallengeLocked();
      this._solved = { value: await this._solveLocked(this._pending), at: Date.now() };
      this._pending = null;
      return { solved: true, headerLen: this._solved.value.length };
    });
  }

  /**
   * Ensure `x-fe-version` is known (cached for `versionTtlMs`).
   * @returns {Promise<string>}
   */
  async ensureVersion() {
    return this._mutex.run(() => this._ensureVersionLocked());
  }

  /** Best-effort `/duckchat/v1/capabilities` read; never throws. */
  async fetchCapabilities() {
    const result = await this.fetchCapabilitiesWithHeaders();
    return result ? result.capabilities : null;
  }

  /**
   * Like `fetchCapabilities()` but also reports the rolling challenge header the response may carry.
   * Any `/duckchat/*` response can rotate the challenge; ignoring it desynchronises the chain.
   * @returns {Promise<{ capabilities: any, challengeHeader: string | null } | null>}
   */
  async fetchCapabilitiesWithHeaders() {
    try {
      const version = await this._ensureVersionLocked();
      const res = await this._fetchWithTimeout(
        `${this.baseUrl}/duckchat/v1/capabilities`,
        {
          headers: {
            'user-agent': this.userAgent,
            accept: 'application/json',
            'accept-language': 'en-US,en;q=0.9',
            origin: this.baseUrl,
            referer: `${this.baseUrl}/`,
            'x-fe-version': version,
            'x-fe-signals': buildFeSignals()
          }
        },
        this.statusTimeoutMs
      );
      const body = await res.text();
      const challengeHeader = res.headers.get('x-vqd-hash-1');
      if (!res.ok) return { capabilities: null, challengeHeader };
      let capabilities = null;
      try {
        capabilities = JSON.parse(body);
      } catch {
        capabilities = null;
      }
      return { capabilities, challengeHeader };
    } catch {
      return null;
    }
  }

  /**
   * Adopt a challenge handed back by a non-chat response (e.g. `/capabilities`).
   * Buffers it as pending and drops any older solved value.
   * @param {string | null | undefined} challengeB64
   */
  async noteChallengeFromHeader(challengeB64) {
    if (!challengeB64 || challengeB64 === 'initial') return false;
    return this._mutex.run(() => {
      this._pending = challengeB64;
      this._solved = null;
      this._stats.externalChallenges = (this._stats.externalChallenges || 0) + 1;
      return true;
    });
  }

  // ---------------------------------------------------------------- internals

  /** @returns {Promise<string>} */
  async _ensureVersionLocked() {
    const { value, at } = this._version;
    if (value && Date.now() - at < this.versionTtlMs) return value;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this._stats.versionFetches += 1;
        const res = await this._fetchWithTimeout(
          `${this.baseUrl}/`,
          {
            headers: {
              'user-agent': this.userAgent,
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'en-US,en;q=0.9'
            }
          },
          this.statusTimeoutMs
        );
        const html = await res.text();
        if (!res.ok) throw new ChallengeError(`homepage fetch failed with HTTP ${res.status}`, { status: res.status, type: 'version_fetch_failed' });
        const entryMatch = html.match(/\/dist\/duckai-dist\/entry\.duckai\.[a-f0-9]+\.js/);
        if (entryMatch) this._entryBundlePath = entryMatch[0];
        const tag = html.match(/data-version-tag=["']([^"']+)["']/);
        const sha = html.match(/data-version-sha=["']([^"']+)["']/);
        if (!tag || !sha) throw new ChallengeError('homepage is missing data-version-tag / data-version-sha', { type: 'version_parse_failed' });
        const version = `${tag[1]}-${sha[1]}`;
        this._version = { value: version, at: Date.now() };
        return version;
      } catch (error) {
        lastError = error;
        this._stats.versionErrors += 1;
        if (error && error.retriable === false) break;
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    throw lastError instanceof ChallengeError
      ? lastError
      : new ChallengeError(`failed to fetch x-fe-version: ${String(lastError && lastError.message)}`, { type: 'version_fetch_failed', cause: lastError });
  }

  /** GET /duckchat/v1/status with `x-vqd-hash-1: initial` and buffer the returned challenge. */
  async _fetchStatusChallengeLocked() {
    const version = await this._ensureVersionLocked();
    this._stats.statusFetches += 1;
    const res = await this._fetchWithTimeout(
      `${this.baseUrl}/duckchat/v1/status`,
      {
        headers: {
          'user-agent': this.userAgent,
          accept: 'application/json',
          'accept-language': 'en-US,en;q=0.9',
          origin: this.baseUrl,
          referer: `${this.baseUrl}/`,
          'x-vqd-accept': '1',
          'x-vqd-hash-1': 'initial',
          'x-fe-version': version,
          'x-fe-signals': buildFeSignals()
        }
      },
      this.statusTimeoutMs
    );
    const body = await res.text().catch(() => '');
    this._lastUpstreamBody = body.slice(0, 500);
    try {
      const parsed = JSON.parse(body);
      this._lastUpstreamStatus = parsed && parsed.status !== undefined ? String(parsed.status) : String(res.status);
    } catch {
      this._lastUpstreamStatus = String(res.status);
    }
    const challenge = res.headers.get('x-vqd-hash-1');
    if (!res.ok || !challenge || challenge === 'initial') {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* not JSON */
      }
      const error = new ChallengeError(`no challenge from GET /duckchat/v1/status (HTTP ${res.status})`, {
        status: res.status || 502,
        type: res.status === 429 ? 'rate_limit_exceeded' : 'challenge_fetch_failed',
        body: body.slice(0, 300),
        retriable: res.status === 429 || res.status >= 500
      });
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter && /^\d+$/.test(retryAfter.trim())) error.retryAfterMs = Number(retryAfter.trim()) * 1000;
      if (parsed && parsed.r) error.requestId = String(parsed.r);
      throw error;
    }
    this._pending = challenge;
    return challenge;
  }

  /** Solve a base64 challenge JS and return the base64 header value. */
  async _solveLocked(challengeB64) {
    let code;
    try {
      code = Buffer.from(challengeB64, 'base64').toString('utf8');
    } catch (error) {
      this._stats.solveErrors += 1;
      throw new ChallengeError('challenge is not valid base64', { type: 'challenge_decode_failed', cause: error });
    }
    const started = Date.now();
    let raw;
    const virtualConsole = new VirtualConsole();
    const jsdomErrors = [];
    virtualConsole.on('jsdomError', (error) => jsdomErrors.push(String(error && error.message)));
    let dom;
    try {
      // `runScripts: 'outside-only'` gives us a browser-shaped realm plus `window.eval`, without
      // executing page scripts. The challenge only needs document/navigator/window/location.
      dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: `${this.baseUrl}/`,
        resources: { userAgent: this.userAgent },
        pretendToBeVisual: true,
        runScripts: 'outside-only',
        virtualConsole
      });
      // The decoded payload is an async IIFE expression, exactly what the site injects into a
      // same-origin iframe's <script> tag: `parent.__jsaCallbacks[n](null, <payload>)`.
      raw = await withTimeout(dom.window.eval(code), this.solveTimeoutMs, 'challenge solve');
    } catch (error) {
      this._stats.solveErrors += 1;
      this._stats.lastError = String(error && error.message);
      throw error instanceof ChallengeError
        ? error
        : new ChallengeError(`challenge execution failed: ${String(error && error.message)}`, {
            type: 'challenge_solve_failed',
            cause: error
          });
    } finally {
      try {
        dom && dom.window.close();
      } catch {
        /* ignore */
      }
    }

    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.client_hashes)) {
      this._stats.solveErrors += 1;
      throw new ChallengeError('challenge result is missing client_hashes', { type: 'challenge_result_invalid', body: JSON.stringify(raw).slice(0, 300) });
    }

    const clientHashes = raw.client_hashes.map((value) => sha256Base64(value));
    const payload = {
      ...raw,
      client_hashes: clientHashes,
      meta: {
        ...(raw.meta || {}),
        origin: this.baseUrl,
        // v2.21: 上游用 meta.stack 判断请求是否来自 duck.ai 的入口 bundle
        // （否则 429 ERR_BN_LIMIT "unsupported entrypoint"）。浏览器 stack 形如：
        //   Error\nat l (https://duck.ai/dist/duckai-dist/entry.duckai.<hash>.js:2:2151366)\n...
        // Node 侧原生 stack 指向本地文件，会被判定为非法入口，因此这里伪装成当前部署的 entry 文件。
        stack: this._entrypointStack(),
        duration: String(Date.now() - started)
      }
    };
    let header;
    try {
      header = base64Utf8(JSON.stringify(payload));
    } catch (error) {
      throw new ChallengeError('failed to encode solved challenge', { type: 'challenge_encode_failed', cause: error });
    }
    this._stats.solves += 1;
    this._stats.lastSolvedAt = Date.now();
    this._stats.lastSolveDurationMs = Date.now() - started;
    this._stats.lastChallengeId = (raw.meta && raw.meta.challenge_id) || null;
    this.logger?.debug?.('[duck:challenge] solved', {
      durationMs: this._stats.lastSolveDurationMs,
      clientHashes: clientHashes.length,
      challengeId: this._stats.lastChallengeId
    });
    return header;
  }

  /**
   * v2.21：生成与真实浏览器一致的 Error stack 文本。
   * 上游 challenge 结果里的 meta.stack 会带上入口脚本（当前部署的 entry.duckai.<hash>.js），
   * Node 原生 stack 的本地路径会被判定为 "unsupported entrypoint"。
   */
  _entrypointStack() {
    if (process.env.DUCKAI_NATIVE_STACK === '1') return stackText(5);
    const entryPath = this._entryBundlePath || '/dist/duckai-dist/entry.duckai.965285ea097e2b920cc8.js';
    const url = `${this.baseUrl}${entryPath}`;
    // 与浏览器抓包一致的 frame 形态（函数名 l / async 顶层、固定行列仅用于形态匹配）。
    return `Error\nat l (${url}:2:2151366)\nat async ${url}:2:1869472`;
  }

  /** Capture the rolling challenge handed back by a response. */
  _commitLocked(headers) {
    if (!headers || typeof headers.get !== 'function') return;
    const challenge = headers.get('x-vqd-hash-1');
    if (!challenge || challenge === 'initial') return;
    this._pending = challenge;
    this._stats.rollingChallenges += 1;
  }

  /** @returns {Promise<string>} */
  async _ensureSolvedLocked(reason) {
    if (this._solved && Date.now() - this._solved.at > this.challengeTtlMs) {
      this._solved = null; // stale: upstream challenge windows are short
    }
    if (this._solved) {
      this._lastSolveSource = 'cache';
      this._stats.lastSolveSource = 'cache';
      return this._solved.value;
    }
    let source = 'rolling';
    if (!this._pending) {
      this.logger?.debug?.('[duck:challenge] fetching fresh challenge from /status', { reason });
      await this._fetchStatusChallengeLocked();
      source = 'status';
    }
    const pending = this._pending;
    this._pending = null;
    const value = await this._solveLocked(pending);
    this._solved = { value, at: Date.now() };
    this._lastSolveSource = source;
    this._stats.lastSolveSource = source;
    return value;
  }

  /**
   * `fetch` with timeout. Node's fetch has no default timeout for the response body;
   * the caller streams the body separately, so this only bounds the header wait.
   * @param {string} url
   * @param {RequestInit} init
   * @param {number} timeoutMs
   * @returns {Promise<Response>}
   */
  async _fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1000, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      const message = String((error && error.message) || error);
      throw new ChallengeError(`request to ${url} failed: ${message}`, {
        type: 'network_error',
        retriable: true,
        cause: error
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export default ChallengeManager;
