/**
 * Outbound proxy manager for the duck.ai upstream (v2.3).
 *
 * Contract: docs/PROXY.md. Default is a direct connection (`enabled:false`); when enabled, **every**
 * outbound request of the duck layer goes through the configured proxy:
 *   - HTTP / HTTPS proxy : undici `ProxyAgent` (CONNECT tunnelling for https targets)
 *   - SOCKS4 / SOCKS5    : undici `Agent` with a custom connector built on the `socks` package
 *
 * The duck.ai sandbox originally could only reach duck.ai; the local proxy at 127.0.0.1:10808 also
 * unlocks duckduckgo.com (Sync transport) and arbitrary external hosts, so the same manager is used
 * for the sync transport probe / subscription verification as well.
 *
 * Notes learned while implementing (see docs/PROXY-IMPL.md):
 *  - undici calls the custom connector with `opts.port === ''` for default ports → fall back to
 *    443/80 based on `opts.protocol`.
 *  - for https targets the SOCKS connector must perform TLS itself and call back only after
 *    `secureConnect`.
 */
import net from 'node:net';
import tls from 'node:tls';
import { fetch as undiciFetch, ProxyAgent, Agent } from 'undici';
import socksPackage from 'socks';

const { SocksClient } = socksPackage;

/**
 * Bun 运行时检测（含 `bun build --compile` 生成的单文件 exe）。
 *
 * Bun 的原生 `fetch` 支持 per-request `proxy` 选项，但 undici 的 `ProxyAgent`
 * 在 Bun 下不可用（CONNECT/TLS 行为不一致：表现为 ECONNRESET / timeout，
 * 见 windows 分支 docs/ACCEPTANCE.md §2.56.7）。因此 HTTP/HTTPS 代理在 Bun 下
 * 改用原生 fetch；Node 运行时仍使用 undici（既有行为与测试不变）。
 */
const BUN_RUNTIME = (() => {
  try {
    return typeof globalThis.Bun !== 'undefined' && typeof globalThis.Bun.version === 'string';
  } catch {
    return false;
  }
})();

/**
 * 把 http(s) 代理配置拼成 `scheme://[user:pass@]host:port`。
 * @param {{ type?: string, host: string, port: number, username?: string, password?: string }} config
 * @returns {string}
 */
export function buildHttpProxyUri(config) {
  const scheme = config.type === 'https' ? 'https' : 'http';
  const auth =
    config.username || config.password
      ? `${encodeURIComponent(config.username || '')}:${encodeURIComponent(config.password || '')}@`
      : '';
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  return `${scheme}://${auth}${host}:${config.port}`;
}

export const PROXY_TYPES = Object.freeze(['http', 'https', 'socks4', 'socks5']);
export const DEFAULT_PROXY_CONFIG = Object.freeze({
  enabled: false,
  type: 'http',
  // Contract default (docs/PROXY.md §1 example). The local test proxy 127.0.0.1:10808 is passed
  // explicitly via config.proxy / the admin "填入本机代理" shortcut, not baked in here.
  host: '127.0.0.1',
  port: 8080,
  username: '',
  password: '',
  noProxy: ['127.0.0.1', 'localhost'],
  testUrl: 'https://duck.ai/duckchat/v1/status',
  ipCheckUrl: 'https://api.ipify.org?format=json',
  timeoutMs: 15000
});

/** Error type for proxy configuration problems. */
export class ProxyError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, field?: string, hint?: string, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ProxyError';
    this.status = meta.status ?? 400;
    this.code = meta.code ?? 'invalid_proxy';
    if (meta.field !== undefined) this.field = meta.field;
    if (meta.hint !== undefined) this.hint = meta.hint;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a SOCKS connector compatible with undici's `Agent({ connect })`.
 * @param {ReturnType<typeof normalizeProxyConfig>} config
 * @param {{ logger?: any }} [options]
 */
function createSocksConnector(config, options = {}) {
  const isSocks4 = config.type === 'socks4';
  return function connect(opts, callback) {
    const hostname = String(opts.hostname || opts.host || '').replace(/^\[|\]$/g, '');
    const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
    if (!hostname) {
      callback(new Error('socks connector: destination host is empty'), null);
      return;
    }
    const proxy = {
      host: config.host,
      port: config.port,
      type: isSocks4 ? 4 : 5,
      ...(config.username ? { userId: config.username } : {}),
      ...(config.password ? { password: config.password } : {})
    };
    SocksClient.createConnection({
      proxy,
      command: 'connect',
      destination: { host: hostname, port },
      timeout: config.timeoutMs || DEFAULT_PROXY_CONFIG.timeoutMs
    })
      .then(({ socket }) => {
        if (opts.protocol !== 'https:') {
          callback(null, socket);
          return;
        }
        const servername = opts.servername || hostname;
        const tlsSocket = tls.connect({
          socket,
          servername: net.isIP(servername) ? undefined : servername,
          ALPNProtocols: ['http/1.1'],
          rejectUnauthorized: opts.rejectUnauthorized !== false
        });
        let settled = false;
        const done = (error) => {
          if (settled) return;
          settled = true;
          if (error) {
            try {
              tlsSocket.destroy();
            } catch {
              /* ignore */
            }
            callback(error, null);
          } else {
            callback(null, tlsSocket);
          }
        };
        tlsSocket.once('secureConnect', () => done(null));
        tlsSocket.once('error', (error) => done(error));
        tlsSocket.setTimeout(config.timeoutMs || DEFAULT_PROXY_CONFIG.timeoutMs, () => {
          done(new Error('socks connector: TLS handshake timed out'));
        });
      })
      .catch((error) => {
        options.logger?.warn?.('[duck:proxy] socks connection failed', { host: hostname, port, error: String(error && error.message) });
        callback(error, null);
      });
  };
}

/** @param {any} raw */
function normalizeProxyConfig(raw = {}) {  return {
    enabled: raw.enabled === true,
    type: PROXY_TYPES.includes(raw.type) ? raw.type : 'http',
    host: typeof raw.host === 'string' ? raw.host.trim() : '',
    port: Number(raw.port),
    username: typeof raw.username === 'string' ? raw.username : '',
    password: typeof raw.password === 'string' ? raw.password : '',
    noProxy: Array.isArray(raw.noProxy)
      ? [...new Set(raw.noProxy.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()))]
      : [...DEFAULT_PROXY_CONFIG.noProxy],
    testUrl: typeof raw.testUrl === 'string' && raw.testUrl ? raw.testUrl : DEFAULT_PROXY_CONFIG.testUrl,
    ipCheckUrl: typeof raw.ipCheckUrl === 'string' && raw.ipCheckUrl ? raw.ipCheckUrl : DEFAULT_PROXY_CONFIG.ipCheckUrl,
    timeoutMs: Number.isFinite(Number(raw.timeoutMs)) && Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : DEFAULT_PROXY_CONFIG.timeoutMs
  };
}

/**
 * Validate a normalized proxy config; throws `ProxyError(400 invalid_proxy)` with `field`.
 * @param {ReturnType<typeof normalizeProxyConfig>} config
 * @param {{ requireHostPort?: boolean }} [options]
 */
function validateProxyConfig(config, options = {}) {
  if (!PROXY_TYPES.includes(config.type)) {
    throw new ProxyError(`invalid proxy type "${config.type}" (expected ${PROXY_TYPES.join('|')})`, { field: 'type' });
  }
  const requireHostPort = options.requireHostPort !== false;
  if (requireHostPort) {
    if (typeof config.host !== 'string' || !config.host.trim()) throw new ProxyError('proxy host is required', { field: 'host' });
    if (!isValidProxyHost(config.host)) throw new ProxyError(`proxy host "${config.host}" is not a valid hostname/IP`, { field: 'host' });
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new ProxyError(`invalid proxy port "${config.port}" (expected 1-65535)`, { field: 'port' });
    }
  }
  if (!Array.isArray(config.noProxy) || config.noProxy.length > 50) {
    throw new ProxyError('noProxy must be an array of at most 50 strings', { field: 'noProxy' });
  }
  for (const [field, value] of [['testUrl', config.testUrl], ['ipCheckUrl', config.ipCheckUrl]]) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) {
      throw new ProxyError(`${field} must be an http(s) URL`, { field });
    }
  }
  return config;
}

/** Normalize user input for `update()`; password semantics handled by the caller. */
function mergeProxyConfig(current, patch) {
  const next = { ...current };
  if (!isPlainObject(patch)) return next;
  for (const key of ['enabled', 'type', 'host', 'port', 'username', 'noProxy', 'testUrl', 'ipCheckUrl', 'timeoutMs']) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  // Password: omitted -> unchanged; '' -> cleared; non-empty -> replaced.
  if (patch.password !== undefined) next.password = patch.password;
  return normalizeProxyConfig(next);
}

/**
 * Hostname / IP validation for proxy hosts (contract §3.2: "host 非空字符串（允许域名/IP）").
 * Accepts: DNS names, IPv4, bracketed or bare IPv6. Rejects spaces, paths, credentials, schemes.
 * @param {string} host
 * @returns {boolean}
 */
export function isValidProxyHost(host) {
  if (typeof host !== 'string') return false;
  const value = host.trim();
  if (!value || value.length > 253) return false;
  if (/[\s/\\@?#]/.test(value)) return false;
  if (value.includes('://')) return false;
  const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  // IPv6 literal (optionally with brackets)
  if (net.isIP(bare) === 6) return true;
  // IPv4
  if (net.isIP(bare) === 4) return true;
  // DNS name: labels of [a-z0-9-], no leading/trailing hyphen, optional trailing dot.
  const name = value.endsWith('.') ? value.slice(0, -1) : value;
  if (!name || name.length > 253) return false;
  return name.split('.').every((label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

/**
 * Validate **raw** patch fields before normalization (contract §3.2: invalid values must surface as
 * `ProxyError{status:400, code:"invalid_proxy", field}` instead of being silently normalized).
 * @param {Record<string, any>} patch
 * @param {{ allowEmptyHost?: boolean }} [options] `allowEmptyHost` is used by `init()` so a disabled
 *   config may keep `host:""` (the field is cleared in the UI) without blocking start-up.
 */
function validateProxyPatch(patch, options = {}) {
  if (!isPlainObject(patch)) {
    throw new ProxyError('proxy patch must be an object', { field: 'body' });
  }
  if (patch.type !== undefined && !PROXY_TYPES.includes(patch.type)) {
    throw new ProxyError(`invalid proxy type "${patch.type}" (expected ${PROXY_TYPES.join('|')})`, { field: 'type' });
  }
  if (patch.port !== undefined) {
    const port = Number(patch.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ProxyError(`invalid proxy port "${patch.port}" (expected an integer 1-65535)`, { field: 'port' });
    }
  }
  if (patch.host !== undefined) {
    if (typeof patch.host !== 'string') {
      throw new ProxyError('proxy host must be a string', { field: 'host' });
    }
    if (!patch.host.trim()) {
      // Only tolerated for a disabled saved config (init path); explicit updates must supply a host.
      if (options.allowEmptyHost !== true) {
        throw new ProxyError('proxy host must be a non-empty string', { field: 'host' });
      }
    } else if (!isValidProxyHost(patch.host)) {
      throw new ProxyError(`proxy host "${patch.host}" is not a valid hostname/IP`, { field: 'host' });
    }
  }
  if (patch.noProxy !== undefined) {
    if (!Array.isArray(patch.noProxy) || patch.noProxy.length > 50 || patch.noProxy.some((entry) => typeof entry !== 'string')) {
      throw new ProxyError('noProxy must be an array of at most 50 strings', { field: 'noProxy' });
    }
  }
  for (const field of ['testUrl', 'ipCheckUrl']) {
    if (patch[field] !== undefined && (typeof patch[field] !== 'string' || !/^https?:\/\//i.test(patch[field]))) {
      throw new ProxyError(`${field} must be an http(s) URL`, { field });
    }
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
    throw new ProxyError('enabled must be a boolean', { field: 'enabled' });
  }
  for (const field of ['username', 'password']) {
    if (patch[field] !== undefined && typeof patch[field] !== 'string') {
      throw new ProxyError(`${field} must be a string`, { field });
    }
  }
  if (patch.timeoutMs !== undefined && (!Number.isFinite(Number(patch.timeoutMs)) || Number(patch.timeoutMs) <= 0)) {
    throw new ProxyError('timeoutMs must be a positive number', { field: 'timeoutMs' });
  }
}

/**
 * Proxy manager.
 */
export class ProxyManager {
  /**
   * @param {{
   *   config?: Record<string, any>,
   *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function } | null,
   *   fetchImpl?: typeof fetch
   * }} [options]
   */
  constructor(options = {}) {
    const rawConfig = options.config || {};
    const proxySource = isPlainObject(rawConfig.proxy) ? rawConfig.proxy : rawConfig;
    this._rawConfig = isPlainObject(proxySource) ? { ...proxySource } : {};
    this.logger = options.logger || null;
    this._directFetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : undiciFetch;
    // Bun 运行时（尤其是编译 exe）：http(s) 代理改用原生 fetch 的 `proxy` 选项。
    // 测试可显式注入 bunRuntime/nativeFetch 来模拟，不依赖真实 Bun 进程。
    this._bunRuntime = options.bunRuntime === undefined ? BUN_RUNTIME : options.bunRuntime === true;
    this._nativeFetch =
      typeof options.nativeFetch === 'function'
        ? options.nativeFetch
        : typeof globalThis.fetch === 'function'
          ? globalThis.fetch.bind(globalThis)
          : null;
    this._config = normalizeProxyConfig({ ...DEFAULT_PROXY_CONFIG, ...proxySource });
    /** @type {import('undici').Dispatcher | null} */
    this._dispatcher = null;
    this._closed = false;
    /** @type {Array<import('undici').Dispatcher>} */
    this._retired = [];
    this._status = {
      active: false,
      mode: 'direct',
      lastTestAt: null,
      lastTestOk: null,
      lastTestLatencyMs: null,
      lastTestStatus: null,
      exitIp: null,
      lastError: null,
      updatedAt: Date.now()
    };
  }

  /** Build the dispatcher for the current config. */
  async init() {
    // Validate the raw config first so a bad config file surfaces as `invalid_proxy` rather than
    // being silently normalized into something the operator did not ask for.
    // An empty host is tolerated while the proxy is disabled (UI clears the field), but a proxy that
    // is actually enabled must have a usable host/port.
    validateProxyPatch(this._rawConfig, { allowEmptyHost: this._config.enabled !== true });
    validateProxyConfig(this._config, { requireHostPort: this._config.enabled === true });
    this._rebuild();
    return this;
  }

  /** Current config without the password. */
  getRedacted() {
    const { password, ...rest } = this._config;
    return {
      ...clone(rest),
      hasAuth: Boolean(this._config.username || this._config.password),
      // `username` is safe to expose, `password` never is
      username: this._config.username,
      status: this.getStatus()
    };
  }

  /** Current config including the password (internal use only, e.g. persistence). */
  getRaw() {
    return clone(this._config);
  }

  /** Last test / activity status. */
  getStatus() {
    return clone(this._status);
  }

  /** Compact summary for `/healthz` and DuckClient.health(). */
  getSummary() {
    return {
      enabled: this._config.enabled,
      mode: this._config.enabled ? this._config.type : 'direct',
      active: Boolean(this._config.enabled && (this._dispatcher || this._getBunProxyUri(this._config))),
      lastTestOk: this._status.lastTestOk,
      lastTestLatencyMs: this._status.lastTestLatencyMs,
      exitIp: this._status.exitIp
    };
  }

  get config() {
    return this.getRedacted();
  }

  /** @param {Record<string, any>} patch */
  async update(patch) {
    // Validate raw values first: silent normalization would hide invalid input (QA v2.3 bug #1).
    validateProxyPatch(patch);
    const next = mergeProxyConfig(this._config, patch);
    validateProxyConfig(next);
    const previous = this._config;
    this._config = next;
    this._rebuild();
    this._status.updatedAt = Date.now();
    this.logger?.info?.('[duck:proxy] configuration updated', {
      enabled: next.enabled,
      type: next.type,
      host: next.host,
      port: next.port,
      changed: previous.type !== next.type || previous.host !== next.host || previous.port !== next.port || previous.enabled !== next.enabled
    });
    return this.getRedacted();
  }

  /** Alias used by the admin layer. */
  async apply(patch) {
    return this.update(patch);
  }

  /**
   * Should a request to `url` bypass the proxy (direct connection)?
   * @param {string | URL} url
   * @returns {boolean}
   */
  shouldBypass(url) {
    if (!this._config.enabled) return true;
    return this._shouldBypassForConfig(url, this._config.noProxy);
  }

  /** noProxy matcher for an arbitrary config (used by `test()` with overrides). */
  _shouldBypassForConfig(url, noProxy) {
    let hostname;
    try {
      hostname = new URL(String(url)).hostname.toLowerCase();
    } catch {
      hostname = String(url).toLowerCase();
    }
    hostname = hostname.replace(/^\[|\]$/g, '');
    for (const ruleRaw of Array.isArray(noProxy) ? noProxy : []) {
      const rule = String(ruleRaw).toLowerCase().replace(/^\[|\]$/g, '');
      if (!rule) continue;
      if (rule === '*') return true;
      if (rule === hostname) return true;
      if (rule.startsWith('*.')) {
        if (hostname.endsWith(rule.slice(1))) return true;
      } else if (hostname.endsWith(`.${rule}`)) {
        return true;
      }
    }
    return false;
  }

  /** @returns {import('undici').Dispatcher | undefined} */
  getDispatcher() {
    if (!this._config.enabled || !this._dispatcher) return undefined;
    return this._dispatcher;
  }

  /**
   * Bun 运行时下 HTTP/HTTPS 代理使用原生 fetch 的 `proxy` 选项。
   * @param {Record<string, any>} [config]
   * @returns {string|null} 代理 URI；不需要/不支持时返回 null（走 undici 或直连）。
   */
  _getBunProxyUri(config = this._config) {
    if (!this._bunRuntime || !this._nativeFetch) return null;
    if (!config || config.enabled !== true) return null;
    if (config.type !== 'http' && config.type !== 'https') return null;
    return buildHttpProxyUri(config);
  }

  /** Bound fetch that automatically uses the proxy dispatcher (except for noProxy hosts). */
  getFetch() {
    return (url, init = {}) => this.fetch(url, init);
  }

  /**
   * Proxy-aware fetch.
   * @param {string | URL} url
   * @param {RequestInit & { dispatcher?: any }} [init]
   * @returns {Promise<Response>}
   */
  async fetch(url, init = {}) {
    if (this.shouldBypass(url)) {
      return this._directFetch(url, init);
    }
    const { dispatcher: _ignoredDispatcher, ...rest } = init || {};
    const bunProxyUri = this._getBunProxyUri();
    if (bunProxyUri) {
      return this._nativeFetch(url, { ...rest, proxy: bunProxyUri });
    }
    const dispatcher = this.getDispatcher();
    return undiciFetch(url, { ...rest, dispatcher });
  }

  /**
   * Test connectivity using a **temporary** dispatcher built from `overrides` (saved config untouched).
   *
   * @param {Record<string, any>} [overrides]
   * @returns {Promise<{
   *   ok: boolean, mode: string, target: string, status: number|null, latencyMs: number,
   *   exitIp: string|null, ipError: string|null, testedAt: number, error: string|null, code: string|null
   * }>}
   */
  async test(overrides = {}) {
    const testedAt = Date.now();
    const patch = isPlainObject(overrides) ? overrides : {};
    // Surface invalid overrides as a structured failure (never throw, contract §3.3).
    try {
      validateProxyPatch(patch);
    } catch (error) {
      const message = String((error && error.message) || error);
      const result = {
        ok: false,
        mode: this._config.enabled ? this._config.type : 'direct',
        target: this._config.testUrl,
        status: null,
        latencyMs: 0,
        exitIp: null,
        ipError: null,
        testedAt,
        error: message,
        code: 'invalid_proxy',
        invalidField: error && error.field ? error.field : null
      };
      this._status = {
        ...this._status,
        lastTestAt: testedAt,
        lastTestOk: false,
        lastTestLatencyMs: 0,
        lastTestStatus: null,
        exitIp: null,
        lastError: message,
        updatedAt: Date.now()
      };
      return result;
    }

    const explicitTarget = patch.host !== undefined || patch.port !== undefined;
    const merged = mergeProxyConfig(this._config, { ...patch, ...(explicitTarget ? { enabled: true } : {}) });
    const requestedProxy = explicitTarget ? true : Boolean(this._config.enabled);
    const target = merged.testUrl;
    // `test()` honours noProxy for both the probe and the exit-IP check: a bypassed target is
    // tested over a direct connection (mode "direct"), matching `fetch()` behaviour.
    const bypassTestUrl = this._shouldBypassForConfig(target, merged.noProxy);
    const useProxy = requestedProxy && !bypassTestUrl;
    const mode = useProxy ? merged.type : 'direct';
    const result = {
      ok: false,
      mode,
      target,
      status: null,
      latencyMs: 0,
      exitIp: null,
      ipError: null,
      testedAt,
      error: null,
      code: null,
      bypassNoProxy: Boolean(requestedProxy && bypassTestUrl)
    };
    let temporary = null;
    // Bun 运行时 http(s) 代理：用原生 fetch 的 proxy 选项，不建 undici dispatcher。
    const nativeProxyUri = useProxy ? this._getBunProxyUri(merged) : null;
    const startedAt = Date.now();
    try {
      validateProxyConfig(merged, { requireHostPort: requestedProxy });
      temporary = useProxy && !nativeProxyUri ? this._buildDispatcher(merged) : null;
      const fetchWithProxy = (input, init = {}) => {
        const { dispatcher: _ignoredDispatcher, ...rest } = init || {};
        if (nativeProxyUri) return this._nativeFetch(input, { ...rest, proxy: nativeProxyUri });
        if (temporary) return undiciFetch(input, { ...rest, dispatcher: temporary });
        return this._directFetch(input, rest);
      };
      const response = await fetchWithProxy(target, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(merged.timeoutMs),
        headers: { 'user-agent': 'duckai-cpa/proxy-test', accept: '*/*' }
      });
      result.status = response.status;
      result.ok = response.status > 0 && response.status < 500;
      // Consume the body so the connection can be reused/closed.
      await response.text().catch(() => '');

      // Exit IP check must run **before** the temporary dispatcher is closed (v2.3 QA bug #2).
      if (result.ok) {
        const bypassIp = this._shouldBypassForConfig(merged.ipCheckUrl, merged.noProxy);
        const ipFetch = (input, init = {}) => {
          const { dispatcher: _ignoredDispatcher, ...rest } = init || {};
          if (nativeProxyUri && !bypassIp) return this._nativeFetch(input, { ...rest, proxy: nativeProxyUri });
          if (temporary && !bypassIp) return undiciFetch(input, { ...rest, dispatcher: temporary });
          return this._directFetch(input, rest);
        };
        try {
          const ipResponse = await ipFetch(merged.ipCheckUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(Math.min(merged.timeoutMs, 8000)),
            headers: { accept: 'application/json, text/plain' }
          });
          const text = await ipResponse.text().catch(() => '');
          try {
            const json = JSON.parse(text);
            result.exitIp = typeof json.ip === 'string' ? json.ip : null;
          } catch {
            result.exitIp = text.trim().slice(0, 64) || null;
          }
          if (!ipResponse.ok && !result.exitIp) result.ipError = `ip check HTTP ${ipResponse.status}`;
        } catch (error) {
          result.ipError = String((error && error.message) || error);
        }
      }
    } catch (error) {
      Object.assign(result, this._classifyTestError(error));
    } finally {
      result.latencyMs = Date.now() - startedAt;
      if (temporary) {
        try {
          await temporary.close();
        } catch {
          /* ignore */
        }
      }
    }

    // Persist test result in the manager status (docs/PROXY.md §3.3).
    this._status = {
      ...this._status,
      active: Boolean(this._config.enabled && (this._dispatcher || this._getBunProxyUri(this._config))),
      mode: this._config.enabled ? this._config.type : 'direct',
      lastTestAt: testedAt,
      lastTestOk: result.ok,
      lastTestLatencyMs: result.latencyMs,
      lastTestStatus: result.status,
      exitIp: result.exitIp,
      lastError: result.error,
      updatedAt: Date.now()
    };
    this.logger?.info?.('[duck:proxy] test finished', {
      ok: result.ok,
      mode: result.mode,
      status: result.status,
      latencyMs: result.latencyMs,
      exitIp: result.exitIp,
      code: result.code
    });
    return result;
  }

  /** @param {any} error */
  _classifyTestError(error) {
    const message = String((error && error.message) || error);
    const name = error && error.name;
    if (name === 'AbortError' || name === 'TimeoutError' || /timeout|timed out/i.test(message)) {
      return { ok: false, status: null, error: message, code: 'proxy_timeout' };
    }
    if (/certificate|tls|ssl|self.signed|unable to verify|handshake/i.test(message)) {
      return { ok: false, status: null, error: message, code: 'proxy_tls_failed' };
    }
    if (/UnsupportedProxyProtocol/i.test(message)) {
      return { ok: false, status: null, error: message, code: 'proxy_unsupported' };
    }
    if (error instanceof ProxyError) {
      return { ok: false, status: null, error: message, code: 'invalid_proxy' };
    }
    return { ok: false, status: null, error: message, code: 'proxy_connect_failed' };
  }

  /** Build a dispatcher for `config` (does not mutate manager state). */
  _buildDispatcher(config) {
    if (config.type === 'http' || config.type === 'https') {
      return new ProxyAgent({
        uri: buildHttpProxyUri(config),
        ...(config.timeoutMs ? { timeout: config.timeoutMs } : {})
      });
    }
    if (config.type === 'socks4' || config.type === 'socks5') {
      return new Agent({ connect: createSocksConnector(config, { logger: this.logger }), ...(config.timeoutMs ? { timeout: config.timeoutMs } : {}) });
    }
    throw new ProxyError(`unsupported proxy type "${config.type}"`, { field: 'type' });
  }

  /** Rebuild the live dispatcher after a config change (old one is retired after a grace period). */
  _rebuild() {
    const previous = this._dispatcher;
    this._dispatcher = null;
    this._status = {
      ...this._status,
      active: false,
      mode: this._config.enabled ? this._config.type : 'direct',
      updatedAt: Date.now()
    };
    if (!this._config.enabled) {
      if (previous) this._retire(previous);
      return;
    }
    const bunProxyUri = this._getBunProxyUri(this._config);
    if (bunProxyUri) {
      // Bun 运行时 http(s) 代理走原生 fetch，不需要（也不应使用）undici dispatcher。
      this._status.active = true;
    } else {
      this._dispatcher = this._buildDispatcher(this._config);
      this._status.active = true;
      if (this._bunRuntime && (this._config.type === 'socks4' || this._config.type === 'socks5')) {
        this.logger?.warn?.(
          '[duck:proxy] SOCKS 代理在 Bun/单文件 exe 下依赖 undici + node:net/tls，可靠性未验证；' +
            '如遇连接异常请改用 HTTP/HTTPS 代理'
        );
      }
    }
    if (previous) this._retire(previous);
  }

  /** Close retired dispatchers after in-flight requests have had time to finish. */
  _retire(dispatcher) {
    this._retired.push(dispatcher);
    const timer = setTimeout(() => {
      try {
        // `dispatcher.close()` returns a Promise: swallow async rejections too (undici throws
        // ClientDestroyedError when the client was already destroyed), otherwise the rejection
        // escapes as an unhandledRejection (QA v2.3: npm test exit 1).
        Promise.resolve(dispatcher.close()).catch(() => {});
      } catch {
        /* ignore */
      }
      this._retired = this._retired.filter((entry) => entry !== dispatcher);
    }, 30000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async close() {
    this._closed = true;
    for (const dispatcher of [this._dispatcher, ...this._retired]) {
      if (!dispatcher) continue;
      try {
        await dispatcher.close();
      } catch {
        /* ignore */
      }
    }
    this._dispatcher = null;
    this._retired = [];
  }
}

/**
 * Create + initialize a proxy manager.
 * @param {{ config?: Record<string, any>, logger?: any, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<ProxyManager>}
 */
export async function createProxyManager(options = {}) {
  const manager = new ProxyManager(options);
  await manager.init();
  return manager;
}

export default { ProxyManager, ProxyError, createProxyManager, PROXY_TYPES, DEFAULT_PROXY_CONFIG };
