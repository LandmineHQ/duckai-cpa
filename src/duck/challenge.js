/**
 * Duck.ai upstream challenge manager — `x-vqd-hash-1` (JSA) solving.
 *
 * Flow (verified against the live upstream, 2026-11-01; environment-probe semantics re-verified 2026-11-06):
 *   1. `GET /`                                   → `<html data-version-tag data-version-sha>` → `x-fe-version`.
 *   2. `GET /duckchat/v1/status`                 → response header `x-vqd-hash-1` = base64(obfuscated async IIFE).
 *      Request headers must carry `x-vqd-accept: 1`, `x-vqd-hash-1: initial`, `x-fe-version`, `x-fe-signals`.
 *   3. Execute the decoded JS in a browser-like realm (jsdom). The payload must run inside duck.ai's hidden
 *      `<iframe id="jsa">` because some challenge suites probe the page it lives in:
 *        - `window.top.document.querySelector('#jsa')` with sandbox="allow-scripts allow-same-origin";
 *        - its srcdoc `<meta http-equiv="Content-Security-Policy">`;
 *        - `window.top.__DDG_BE_VERSION__` / `window.top.__DDG_FE_CHAT_HASH__`;
 *        - layout metrics (`offsetWidth` / `getBoundingClientRect` / `scrollHeight` > 0).
 *      It resolves to `{ server_hashes, client_hashes: [string...], signals, meta:{v,challenge_id,timestamp,debug} }`.
 *   4. Browser post-processing: SHA-256(UTF-8) → base64 for every client_hash; append
 *      `meta.origin` (page origin), `meta.stack` (first 5 Error frames) and `meta.duration` (ms string);
 *      `btoa(JSON.stringify(payload))` becomes the next request's `x-vqd-hash-1` header.
 *   5. Rolling: every `/duckchat/*` response carries a *new* challenge in its `x-vqd-hash-1` response header.
 *      The browser solves it before the next request. Re-fetching `/status` for every request instead of
 *      consuming the rolling challenge makes the upstream fail every other request with 418 ERR_CHALLENGE.
 *
 * Upstream validates the solved `client_hashes` (exact environment-fingerprint values, not just their shape).
 * Challenges rotate between several probe suites; the page-state and layout suites above fail in a flat
 * empty jsdom window → 418. That is why the solver now emulates the real page realm.
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
 * Real duck.ai page facts required by the JSA environment-probe suites (captured in Chrome, 2026-11-06):
 * the app renders a hidden `<iframe id="jsa">` whose srcdoc carries a CSP meta tag, and exposes the deployed
 * FE version/hash on the top window. Some challenge variants hash these values into `client_hashes`, and the
 * upstream compares them; solving in a flat empty jsdom window makes them wrong → 418 ERR_CHALLENGE.
 */
const JSA_IFRAME_ID = 'jsa';
const JSA_IFRAME_SANDBOX = 'allow-scripts allow-same-origin';
const JSA_IFRAME_SRCDOC =
  '<!DOCTYPE html>\n<html>\n<head>\n<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\';">\n</head>\n<body></body>\n</html>';
const JSA_CSP_META_HTML =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\';">';

function escapeHtmlAttribute(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** jsdom page document that mirrors duck.ai's shell: a hidden #jsa iframe inside a same-origin page. */
const JSA_PAGE_HTML = `<!doctype html><html><head></head><body><iframe id="${JSA_IFRAME_ID}" sandbox="${JSA_IFRAME_SANDBOX}" style="position: absolute; left: -9999px; top: -9999px;" srcdoc="${escapeHtmlAttribute(JSA_IFRAME_SRCDOC)}"></iframe></body></html>`;

/**
 * jsdom has no layout engine: `offsetWidth`/`offsetHeight`/`getBoundingClientRect()`/`scrollHeight` are all 0.
 * Some challenge suites render a padded inline-block div and hash `metric > 0` results; a real browser always
 * passes those. Give the eval realm deterministic positive metrics so the fingerprint matches the browser.
 * @param {Window} win
 */
function installLayoutShims(win) {
  if (!win) return;
  // duck.ai's layout suite measures a connected, visible (visibility:hidden still lays out) element.
  // Emulate "has a box" semantics: detached or display:none → 0, everything else → positive.
  const positive = (el) => {
    try {
      if (!el || !el.isConnected) return 0;
      const computed = win.getComputedStyle(el);
      return computed && computed.display === 'none' ? 0 : 1;
    } catch {
      return 0;
    }
  };
  const rect = (el) => {
    const size = positive(el);
    return {
      x: 0,
      y: 0,
      width: size,
      height: size,
      top: 0,
      left: 0,
      right: size,
      bottom: size,
      toJSON() {
        return { x: 0, y: 0, width: size, height: size, top: 0, left: 0, right: size, bottom: size };
      }
    };
  };
  const elementProto = win.Element && win.Element.prototype;
  if (elementProto) {
    try {
      Object.defineProperty(elementProto, 'getBoundingClientRect', { configurable: true, writable: true, value: function () { return rect(this); } });
      Object.defineProperty(elementProto, 'getClientRects', { configurable: true, writable: true, value: function () { return [rect(this)]; } });
    } catch {
      /* ignore */
    }
  }
  const htmlElementProto = win.HTMLElement && win.HTMLElement.prototype;
  if (htmlElementProto) {
    for (const name of ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight']) {
      try {
        Object.defineProperty(htmlElementProto, name, { configurable: true, get: function () { return positive(this); } });
      } catch {
        /* ignore */
      }
    }
    for (const name of ['offsetTop', 'offsetLeft', 'clientTop', 'clientLeft']) {
      try {
        Object.defineProperty(htmlElementProto, name, { configurable: true, get: () => 0 });
      } catch {
        /* ignore */
      }
    }
  }
  if (win.document && win.document.documentElement) {
    for (const [name, value] of Object.entries({ clientWidth: 1280, clientHeight: 720, scrollWidth: 1280, scrollHeight: 720 })) {
      try {
        Object.defineProperty(win.document.documentElement, name, { configurable: true, get: () => value });
      } catch {
        /* ignore */
      }
    }
  }
  for (const [name, value] of Object.entries({ outerWidth: 1280, outerHeight: 720, devicePixelRatio: 1 })) {
    try {
      Object.defineProperty(win, name, { configurable: true, get: () => value });
    } catch {
      /* ignore */
    }
  }
}


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
  // Browser ground truth: `start` is epoch ms, `end` is the elapsed ms since start (e.g. 71740), not an epoch.
  return base64Utf8(JSON.stringify({ start, events, end: Date.now() - start }));
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
   *   pendingTtlMs?: number,
   *   statusTimeoutMs?: number,
   *   solveTimeoutMs?: number,
   *   fetchImpl?: typeof fetch,
   *   legacyChallengeEnv?: boolean,
   *   logger?: { debug?: Function, warn?: Function, info?: Function, error?: Function } | null
   * }} [config]
   */
  constructor(config = {}) {
    this.baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.userAgent = config.userAgent || DEFAULT_USER_AGENT;
    this.timeoutMs = config.timeoutMs ?? 20000;
    this.statusTimeoutMs = config.statusTimeoutMs ?? this.timeoutMs;
    this.solveTimeoutMs = config.solveTimeoutMs ?? 20000;
    this.versionTtlMs = config.versionTtlMs ?? 5 * 60 * 1000;
    this.challengeTtlMs = config.challengeTtlMs ?? 90 * 1000;
    // v2.62: an unsolved rolling challenge that sat around for too long is stale; refetching /status is
    // safer than sending a challenge the upstream may already consider superseded (observed validity >72s).
    this.pendingTtlMs = config.pendingTtlMs ?? 120 * 1000;
    this.logger = config.logger || null;
    // v2.3: every outbound request must go through the proxy-aware fetch when configured.
    this.fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : globalThis.fetch;
    this.proxyMode = null;

    // v2.62: emulate duck.ai's real page realm (#jsa iframe + page globals + layout metrics) while solving.
    // Environment-probe challenge suites hash these values and the upstream compares them; the legacy flat
    // window yields a wrong fingerprint → 418 ERR_CHALLENGE. `legacyChallengeEnv` is a diagnostics escape hatch.
    this.legacyChallengeEnv =
      config.legacyChallengeEnv === true || process.env.DUCKAI_LEGACY_JSA_ENV === '1';

    /** @type {{ value: string | null, at: number, tag: string | null, sha: string | null }} */
    this._version = { value: null, at: 0, tag: null, sha: null };
    /** @type {string | null} */
    this._pending = null;
    /** Timestamp of when `_pending` was received (0 when none). */
    this._pendingAt = 0;
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
      externalChallengeSkips: 0,
      stalePendingDropped: 0,
      versionRefreshes: 0,
      solves: 0,
      solveErrors: 0,
      versionFetches: 0,
      versionErrors: 0,
      lastSolvedAt: 0,
      lastSolveDurationMs: 0,
      lastSolveSource: null,
      lastChallengeId: null,
      lastChallengeSuite: null,
      lastClientHashes: null,
      lastError: null,
      envFallbacks: 0
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
      environment: this.legacyChallengeEnv ? 'legacy' : 'page',
      version: this._version.value,
      versionAgeMs: this._version.at ? Date.now() - this._version.at : null,
      versionTtlMs: this.versionTtlMs,
      upstreamStatus: this._lastUpstreamStatus,
      pendingChallenge: Boolean(this._pending),
      pendingAgeMs: this._pendingAt ? Date.now() - this._pendingAt : null,
      pendingTtlMs: this.pendingTtlMs,
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
            this._pendingAt = 0;
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
      this._pendingAt = 0;
      this._stats.lastError = reason;
    });
  }

  /** Force a fresh `/status` challenge and solve it (used by health probes / self-tests). */
  async refresh() {
    return this._mutex.run(async () => {
      await this._fetchStatusChallengeLocked();
      this._solved = { value: await this._solveLocked(this._pending), at: Date.now() };
      this._pending = null;
      this._pendingAt = 0;
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
   *
   * v2.62: browser ground truth shows duck.ai **never consumes** the `/capabilities` challenge header;
   * adopting it unconditionally used to clobber a healthy rolling chain (chat stream in flight). Only
   * adopt when the manager is idle (no pending/solved value), otherwise count the skip for diagnostics.
   * @param {string | null | undefined} challengeB64
   */
  async noteChallengeFromHeader(challengeB64) {
    if (!challengeB64 || challengeB64 === 'initial') return false;
    return this._mutex.run(() => {
      if (this._pending || this._solved) {
        this._stats.externalChallengeSkips = (this._stats.externalChallengeSkips || 0) + 1;
        this.logger?.debug?.('[duck:challenge] ignoring external challenge header (rolling chain active)');
        return false;
      }
      this._pending = challengeB64;
      this._pendingAt = Date.now();
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
        this._version = { value: version, at: Date.now(), tag: tag[1], sha: sha[1] };
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
    this._pendingAt = Date.now();
    return challenge;
  }

  /**
   * v2.62: `meta.stack` / `__DDG_*` inputs come from the homepage version cache. Refreshing it lazily before
   * solving keeps the entrypoint/version from going stale during a long rolling-challenge conversation.
   * Failures are non-fatal: the previous version is better than failing the solve.
   * @returns {Promise<void>}
   */
  async _refreshVersionIfStaleLocked() {
    if (!this._version.value) return;
    if (Date.now() - this._version.at < this.versionTtlMs) return;
    this._stats.versionRefreshes = (this._stats.versionRefreshes || 0) + 1;
    try {
      await this._ensureVersionLocked();
    } catch (error) {
      this.logger?.warn?.('[duck:challenge] version refresh failed; keeping cached version', {
        ageMs: Date.now() - this._version.at,
        error: String(error && error.message)
      });
    }
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
    await this._refreshVersionIfStaleLocked();
    const started = Date.now();
    let raw;
    const virtualConsole = new VirtualConsole();
    const jsdomErrors = [];
    virtualConsole.on('jsdomError', (error) => jsdomErrors.push(String(error && error.message)));
    let dom;
    try {
      dom = this._createChallengeRealm(virtualConsole);
      raw = await withTimeout(this._evaluateChallenge(dom, code), this.solveTimeoutMs, 'challenge solve');
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
    // Observability for the randomized probe suites: suite tag is the challenge_id suffix; the raw
    // (pre-SHA256) environment fingerprints help identify a new/unknown suite without extra requests.
    this._stats.lastChallengeSuite = this._stats.lastChallengeId ? String(this._stats.lastChallengeId).slice(-5) : null;
    this._stats.lastClientHashes = raw.client_hashes.map((value) => String(value).slice(0, 300));
    this.logger?.debug?.('[duck:challenge] solved', {
      durationMs: this._stats.lastSolveDurationMs,
      clientHashes: clientHashes.length,
      challengeId: this._stats.lastChallengeId
    });
    return header;
  }

  /**
   * Build the jsdom realm used to execute the challenge JS.
   *
   * The default realm mirrors duck.ai's page: a same-origin document with the hidden `#jsa` iframe.
   * `legacyChallengeEnv` keeps the old flat empty window for diagnostics.
   * `runScripts: 'outside-only'` gives us a browser-shaped realm plus `window.eval` without executing
   * page scripts.
   * @param {VirtualConsole} virtualConsole
   */
  _createChallengeRealm(virtualConsole) {
    return new JSDOM(this.legacyChallengeEnv ? '<!doctype html><html><head></head><body></body></html>' : JSA_PAGE_HTML, {
      url: `${this.baseUrl}/`,
      resources: { userAgent: this.userAgent },
      pretendToBeVisual: true,
      runScripts: 'outside-only',
      virtualConsole
    });
  }

  /**
   * Execute the decoded async-IIFE challenge expression and return its result.
   *
   * The real app injects the expression into the hidden `#jsa` iframe's document, so the challenge
   * observes the iframe realm while `window.top` is the duck.ai page. Some probe suites hash:
   *   - `window.top.document.querySelector('#jsa')` → sandbox attr + srcdoc CSP meta content;
   *   - `window.top.__DDG_BE_VERSION__` / `window.top.__DDG_FE_CHAT_HASH__` presence;
   *   - element layout metrics (jsdom always reports 0 → shimmed).
   * Solving in a flat window makes those hashes differ from a real browser and the upstream answers
   * 418 ERR_CHALLENGE, so the expression must run inside the emulated iframe.
   * @param {JSDOM} dom
   * @param {string} code decoded challenge expression
   * @returns {Promise<unknown>}
   */
  _evaluateChallenge(dom, code) {
    const win = dom.window;
    if (this.legacyChallengeEnv) return win.eval(code);
    const iframe = win.document.getElementById(JSA_IFRAME_ID);
    if (!iframe || !iframe.contentWindow) {
      // Never silently degrade: a flat window makes page-state/layout suites hash wrong values → 418.
      this._stats.envFallbacks = (this._stats.envFallbacks || 0) + 1;
      this.logger?.warn?.('[duck:challenge] #jsa iframe unavailable; falling back to flat window (page-state suites will mismatch)');
      return win.eval(code);
    }
    // Values the real page exposes on `window` (challenge only checks ownership, but keep them faithful).
    win.__DDG_BE_VERSION__ = this._version.tag || '';
    win.__DDG_FE_CHAT_HASH__ = this._version.sha || '';
    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    if (iframeDoc && iframeDoc.documentElement) {
      if (!iframeDoc.head) {
        iframeDoc.documentElement.insertBefore(iframeDoc.createElement('head'), iframeDoc.documentElement.firstChild);
      }
      if (iframeDoc.head) iframeDoc.head.innerHTML = JSA_CSP_META_HTML;
      if (!iframeDoc.body) iframeDoc.documentElement.appendChild(iframeDoc.createElement('body'));
      installLayoutShims(iframe.contentWindow);
    }
    return iframe.contentWindow.eval(code);
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
    if (challenge === this._pending) {
      // Same link handed back twice (retry/summary of the same response) — keep the original timestamp.
      this._stats.rollingChallenges += 1;
      return;
    }
    this._pending = challenge;
    this._pendingAt = Date.now();
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
    if (this._pending && this._pendingAt && Date.now() - this._pendingAt > this.pendingTtlMs) {
      // The rolling challenge sat unsolved for too long; a fresh /status challenge is safer than a 418.
      this._pending = null;
      this._pendingAt = 0;
      this._stats.stalePendingDropped = (this._stats.stalePendingDropped || 0) + 1;
      this.logger?.debug?.('[duck:challenge] dropped stale pending challenge', { reason });
    }
    let source = 'rolling';
    if (!this._pending) {
      this.logger?.debug?.('[duck:challenge] fetching fresh challenge from /status', { reason });
      await this._fetchStatusChallengeLocked();
      source = 'status';
    }
    const pending = this._pending;
    this._pending = null;
    this._pendingAt = 0;
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
