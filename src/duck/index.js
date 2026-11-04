/**
 * Duck.ai upstream client — public boundary of the `duck` layer.
 *
 * Contract: ARCHITECTURE.md §4. Exports `DuckClient` + `DuckError` (names are stable; the OpenAI
 * compatible layer imports them). This layer knows nothing about OpenAI semantics: it speaks the
 * duck.ai protocol, normalizes SSE events and raises `DuckError` for every failure.
 *
 * Protocol facts are documented in `docs/PROTOCOL.md`; the challenge machinery lives in
 * `./challenge.js`, SSE parsing/normalization in `./sse.js`, model data in `./models.js`.
 */
import crypto from 'node:crypto';

import { ChallengeManager, ChallengeError, DEFAULT_BASE_URL, DEFAULT_USER_AGENT, buildFeSignals } from './challenge.js';
import {
  consumeSSE,
  extractCitations,
  normalizeSources,
  stripCitationMarkers,
  citationsToMarkdown,
  collectCitationIds,
  redactSnippet,
  SSEProtocolError
} from './sse.js';
import { DUCK_MODELS, DEFAULT_MODEL, MODEL_ALIASES, findModel, getApiModelCatalog, getModelCapabilities } from './models.js';
import { IdentityStore, IdentityError, MemoryIdentityStore, createIdentityStore } from './identity.js';
import { ProxyManager, ProxyError, createProxyManager } from './proxy.js';
import { detectImageFormat, normalizeFormat } from './image-format.js';
import { toUpstreamPngDataUrl } from './image-convert.js';

/** Reasoning effort ordering used for clamping unsupported tiers. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'];

/** `x-duckai-client-tools` header value the current web bundle sends. Required by the upstream. */
export const CLIENT_TOOLS_HEADER = JSON.stringify({ version: 1, capabilities: [] });

/** Headers sent with every chat call (mirrors the browser bundle). */
const CONSENT_PURPOSES = 'user-location,image-generation,web-search';

/**
 * Error codes that are terminal: the upstream answered, but the protocol/semantics forbid a retry.
 * Used by the retry loop so strict-protocol failures are surfaced immediately (v2 requirement).
 */
export const NON_RETRIABLE_CODES = new Set([
  'upstream_protocol_mismatch',
  'upstream_no_image',
  'upstream_anomaly_check',
  'content_filter',
  'bad_request',
  'model_unavailable',
  'model_requires_subscription',
  'context_length_exceeded',
  'upstream_continuation_restart_required'
]);

/**
 * Map duck.ai `ERR_*` codes (from error frames / HTTP bodies) to gateway-facing error metadata.
 *
 * Sources: docs/PROTOCOL-ERRORS.md (duck.ai web bundle error dictionary, 2026-11-01).
 * `httpStatus`/`code` are what the OpenAI compatibility layer should expose; `retriable` drives
 * whether `DuckClient` may retry (transport level 418/429 retries are handled separately).
 *
 * @param {string | null | undefined} type  upstream ERR_* code (or a DuckClient code)
 * @param {number | null | undefined} [upstreamStatus]
 * @returns {{ httpStatus: number, code: string, openaiType: string, retriable: boolean, finishReason?: string, anomaly?: boolean }}
 */
export function mapUpstreamError(type, upstreamStatus) {
  const code = String(type || '');
  switch (code) {
    case 'ERR_CHALLENGE':
      // The browser solves this via the /anomaly.js tile challenge; a gateway cannot, so it is a
      // hard block for us. Code aligns with the gateway's `upstream_anomaly_check` mapping
      // (docs/ADMIN_API_V2.md §6) and api-core's DUCK_CODE_MAP.
      return { httpStatus: 403, code: 'upstream_anomaly_check', openaiType: 'permission_error', retriable: false, anomaly: true };
    case 'ERR_BN_LIMIT':
      return { httpStatus: 429, code: 'upstream_rate_limited', openaiType: 'rate_limit_exceeded', retriable: true };
    case 'ERR_RATE_LIMIT':
      return { httpStatus: 429, code: 'rate_limit_exceeded', openaiType: 'rate_limit_exceeded', retriable: true };
    case 'ERR_USER_LIMIT':
      return { httpStatus: 429, code: 'user_limit_exceeded', openaiType: 'rate_limit_exceeded', retriable: true };
    case 'ERR_ACCOUNT_LIMIT':
      return { httpStatus: 403, code: 'upstream_subscription_required', openaiType: 'model_unavailable', retriable: false };
    case 'ERR_CONVERSATION_LIMIT':
      // v2.4: conversation is too long → context problem (not a rate limit). The gateway may trim
      // and retry once (docs/IDENTITY-POOL.md §7); otherwise surface 409.
      return { httpStatus: 409, code: 'conversation_limit_reached', openaiType: 'invalid_request_error', retriable: false };
    case 'ERR_IMAGE_GENERATION_LIMIT':
      return { httpStatus: 429, code: 'image_generation_limit_exceeded', openaiType: 'rate_limit_exceeded', retriable: true };
    case 'ERR_SERVICE_LIMIT':
      return { httpStatus: 429, code: 'service_limit_exceeded', openaiType: 'rate_limit_exceeded', retriable: true };
    case 'ERR_INPUT_LIMIT':
    case 'ERR_SELECTION_INPUT_LIMIT':
      return { httpStatus: 413, code: 'context_length_exceeded', openaiType: 'invalid_request_error', retriable: false };
    case 'ERR_OUTPUT_LIMIT':
    case 'ERR_MAX_TOKENS':
      return { httpStatus: 200, code: 'max_tokens', openaiType: 'upstream_error', retriable: false, finishReason: 'length' };
    case 'ERR_REFUSAL':
    case 'ERR_MODERATION_FLAG':
      return { httpStatus: 403, code: 'content_filter', openaiType: 'content_filter', retriable: false };
    case 'ERR_MODERATION_UNAVAILABLE':
      return { httpStatus: 503, code: 'moderation_unavailable', openaiType: 'upstream_unavailable', retriable: true };
    case 'ERR_MODEL_RESTRICTED':
      return { httpStatus: 403, code: 'model_requires_subscription', openaiType: 'model_unavailable', retriable: false };
    case 'ERR_MODEL_UNAVAILABLE':
      return { httpStatus: 404, code: 'model_not_found', openaiType: 'model_unavailable', retriable: false };
    case 'ERR_MODEL_DEPRECATED':
      return { httpStatus: 410, code: 'model_deprecated', openaiType: 'model_unavailable', retriable: false };
    case 'ERR_MODEL_REMOVED':
      return { httpStatus: 410, code: 'model_removed', openaiType: 'model_unavailable', retriable: false };
    case 'ERR_SERVICE_UNAVAILABLE':
      return { httpStatus: 503, code: 'upstream_unavailable', openaiType: 'upstream_unavailable', retriable: true };
    case 'ERR_SERVICE_OFFLINE':
      return { httpStatus: 503, code: 'upstream_offline', openaiType: 'upstream_unavailable', retriable: true };
    case 'ERR_NETWORK':
    case 'ERR_STREAM_NETWORK':
      return { httpStatus: 503, code: 'upstream_network_error', openaiType: 'upstream_unavailable', retriable: true };
    case 'ERR_STREAM_EXPIRED':
      return { httpStatus: 410, code: 'upstream_stream_expired', openaiType: 'model_unavailable', retriable: false };
    case 'ERR_STREAM_NOT_SAVED':
      return { httpStatus: 502, code: 'upstream_stream_not_saved', openaiType: 'upstream_error', retriable: true };
    case 'ERR_BAD_REQUEST':
      return { httpStatus: 400, code: 'bad_request', openaiType: 'invalid_request_error', retriable: false };
    case 'ERR_EMPTY_RESPONSE':
      return { httpStatus: 502, code: 'upstream_empty_response', openaiType: 'upstream_error', retriable: true };
    case 'ERR_INVALID_ACTION':
      return { httpStatus: 502, code: 'upstream_invalid_action', openaiType: 'upstream_error', retriable: false };
    case 'ERR_RESPONSE_PARSING':
      return { httpStatus: 502, code: 'upstream_response_parsing', openaiType: 'upstream_error', retriable: false };
    case 'ERR_IMAGE_PROCESSING':
      return { httpStatus: 502, code: 'upstream_image_processing', openaiType: 'upstream_error', retriable: true };
    case 'ERR_UPSTREAM':
    case 'ERR_UNKNOWN':
      return { httpStatus: 502, code: 'upstream_error', openaiType: 'upstream_error', retriable: true };
    case 'upstream_protocol_mismatch':
      return { httpStatus: 502, code: 'upstream_protocol_mismatch', openaiType: 'upstream_error', retriable: false };
    case 'upstream_no_image':
      return { httpStatus: 502, code: 'upstream_no_image', openaiType: 'upstream_error', retriable: false };
    case 'upstream_continuation_restart_required':
      return { httpStatus: 409, code: 'upstream_continuation_restart_required', openaiType: 'invalid_request_error', retriable: false };
    default: {
      const status = typeof upstreamStatus === 'number' ? upstreamStatus : 502;
      if (status === 429) return { httpStatus: 429, code: 'rate_limit_exceeded', openaiType: 'rate_limit_exceeded', retriable: true };
      if (status === 403) return { httpStatus: 403, code: 'upstream_forbidden', openaiType: 'upstream_error', retriable: false };
      if (status === 400) return { httpStatus: 400, code: 'bad_request', openaiType: 'invalid_request_error', retriable: false };
      return { httpStatus: status >= 500 ? status : 502, code: 'upstream_error', openaiType: 'upstream_error', retriable: status >= 500 };
    }
  }
}

/**
 * Normalized upstream error. The OpenAI layer maps `status`/`type`/`retriable` onto its own errors.
 */
export class DuckError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   status?: number,
   *   type?: string,
   *   retriable?: boolean,
   *   cause?: unknown,
   *   body?: string,
   *   code?: string,
   *   eventIndex?: number | null,
   *   detail?: unknown,
   *   partial?: Record<string, any> | null,
   *   requestId?: string | null,
   *   retryAfterMs?: number | null,
   *   retryAt?: number | null,
   *   upstreamType?: string | null
   * }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'DuckError';
    this.status = meta.status ?? 502;
    this.type = meta.type ?? 'upstream_error';
    this.retriable = meta.retriable ?? false;
    this.code = meta.code ?? meta.type ?? 'upstream_error';
    if (meta.cause !== undefined) this.cause = meta.cause;
    if (meta.body !== undefined) this.body = meta.body;
    if (meta.eventIndex !== undefined) this.eventIndex = meta.eventIndex;
    if (meta.detail !== undefined) {
      this.detail = meta.detail;
      // api-core reads `errorDetail` when writing the upstream log (ADMIN_API_V2 §6).
      this.errorDetail = meta.detail;
    }
    if (meta.partial !== undefined) {
      this.partial = meta.partial;
      this.partialResult = meta.partial;
    }
    if (meta.requestId !== undefined) this.requestId = meta.requestId;
    if (meta.retryAfterMs !== undefined) this.retryAfterMs = meta.retryAfterMs;
    if (meta.retryAt !== undefined) this.retryAt = meta.retryAt;
    if (meta.upstreamType !== undefined) this.upstreamType = meta.upstreamType;
  }
}

/**
 * Convert any internal error into `DuckError` (single error type at the public boundary).
 * @param {unknown} error
 * @param {string} [fallbackType]
 * @returns {DuckError}
 */
export function toDuckError(error, fallbackType = 'upstream_error') {
  if (error instanceof DuckError) return error;
  if (error instanceof SSEProtocolError) {
    const mapped = mapUpstreamError(error.code, error.status);
    return new DuckError(error.message, {
      status: error.status ?? mapped.httpStatus,
      type: mapped.code,
      code: error.code || mapped.code,
      retriable: error.retriable === undefined ? mapped.retriable : Boolean(error.retriable),
      eventIndex: error.eventIndex ?? null,
      detail: error.snippet ? redactSnippet(error.snippet) : null,
      cause: error
    });
  }
  if (error instanceof ChallengeError) {
    const duckError = new DuckError(error.message, {
      status: error.status,
      type: error.type,
      retriable: error.retriable,
      cause: error,
      body: error.body
    });
    if (error.retryAfterMs !== undefined) duckError.retryAfterMs = error.retryAfterMs;
    if (error.requestId !== undefined) duckError.requestId = error.requestId;
    return duckError;
  }
  if (error && error.name === 'AbortError') {
    return new DuckError('request aborted', { status: 499, type: 'aborted', code: 'aborted', retriable: false, cause: error });
  }
  const message = String((error && error.message) || error || 'unknown upstream error');
  if (error && typeof error === 'object' && typeof error.status === 'number') {
    // Errors coming from injected/alternative transports (tests, mocks, alternate fetch) may already
    // carry HTTP metadata; preserve it instead of flattening to a generic 502.
    const mapped = new DuckError(message, {
      status: error.status,
      type: typeof error.type === 'string' ? error.type : fallbackType,
      code: typeof error.code === 'string' ? error.code : undefined,
      retriable:
        typeof error.retriable === 'boolean'
          ? error.retriable
          : error.status === 418 || error.status === 429 || error.status >= 500,
      cause: error
    });
    if (error.retryAfterMs !== undefined) mapped.retryAfterMs = error.retryAfterMs;
    if (error.requestId !== undefined) mapped.requestId = error.requestId;
    if (error.body !== undefined) mapped.body = error.body;
    if (error.eventIndex !== undefined) mapped.eventIndex = error.eventIndex;
    if (error.partial !== undefined) mapped.partial = error.partial;
    if (error.detail !== undefined) mapped.detail = error.detail;
    return mapped;
  }
  const duckError = new DuckError(message, { status: 502, type: fallbackType, retriable: true, cause: error });
  if (error && error.retryAfterMs !== undefined) duckError.retryAfterMs = error.retryAfterMs;
  if (error && error.requestId !== undefined) duckError.requestId = error.requestId;
  return duckError;
}

/** Simple FIFO counting semaphore used to cap global upstream concurrency. */
class Semaphore {
  /** @param {number} limit */
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    /** @type {Array<() => void>} */
    this.queue = [];
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  async run(fn) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/** @param {number} min @param {number} max */
function randomBetween(min, max) {
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || lo);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Build the upstream `messages` array from OpenAI-normalized messages.
 * @param {Array<{ role: string, content: string }>} messages
 * @param {{ systemMode?: 'system' | 'developer' | 'prefix', systemPrompt?: string }} [options]
 */
export function buildUpstreamMessages(messages, options = {}) {
  const systemMode = options.systemMode || 'system';
  /** @type {Array<Record<string, any>>} */
  const out = [];
  const systemTexts = [];
  /** @type {Array<{ role: 'system'|'user'|'assistant', text: string, images: Array<Record<string, any>> }>} */
  const normalized = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    const role = message.role === 'developer' ? 'developer' : message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user';
    const messageText = extractMessageText(message.content);
    const images = extractMessageImages(message);
    if (role === 'system' || role === 'developer') {
      if (messageText) systemTexts.push(messageText);
      continue;
    }
    normalized.push({ role, text: messageText, images });
  }

  const injectedSystem = options.systemPrompt ? String(options.systemPrompt).trim() : '';
  if (injectedSystem) systemTexts.unshift(injectedSystem);

  if (systemTexts.length && systemMode !== 'prefix') {
    out.push({ role: systemMode, content: [{ type: 'text', text: systemTexts.join('\n\n') }] });
  }

  // v2.44：assistant 历史里的图片（上一轮生成图）挂到紧随其后的 user 消息，
  // 这样模型在“继续修改这张图”时能真正看到图片而不是文本占位。
  let pendingImages = [];
  for (const item of normalized) {
    if (item.role === 'assistant') {
      out.push({ role: 'assistant', content: '', parts: [{ type: 'text', text: item.text }] });
      if (item.images.length) pendingImages.push(...item.images);
    } else {
      const content = [{ type: 'text', text: item.text }];
      if (item.images.length || pendingImages.length) {
        content.push(...pendingImages, ...item.images);
        pendingImages = [];
      }
      out.push({ role: 'user', content });
    }
  }
  if (pendingImages.length) {
    out.push({ role: 'user', content: [{ type: 'text', text: '（上一轮生成的图片）' }, ...pendingImages] });
  }

  if (systemTexts.length && systemMode === 'prefix') {
    const prefix = systemTexts.join('\n\n');
    const firstUser = out.find((message) => message.role === 'user');
    if (firstUser) {
      const existing = firstUser.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      const imageParts = firstUser.content.filter((part) => part.type !== 'text');
      firstUser.content = [{ type: 'text', text: `[系统指令]\n${prefix}\n\n[用户]\n${existing}` }, ...imageParts];
    } else {
      out.unshift({ role: 'user', content: [{ type: 'text', text: `[系统指令]\n${prefix}` }] });
    }
  }

  return out;
}

/**
 * Normalize a message content field (`string` or `[{type:'text',text}]`) to plain text.
 * @param {unknown} content
 * @returns {string}
 */
/**
 * v2.44：把网关内部图片（{mimeType,dataUrl} / {b64,format}）转换为上游 image part。
 * 上游 user content 支持：{ type:"image", mimeType, image:"data:<mime>;base64,..." }
 */
function toUpstreamImagePart(image) {
  if (!image || typeof image !== 'object') return null;
  // v2.44：上游图像输入只接受 PNG/WebP（JPEG 实测返回 400 ERR_BAD_REQUEST sc22），
  // 统一转 PNG 并缩到 512（所有模型的保守上限）。
  const converted = toUpstreamPngDataUrl(image, { maxDimension: 512 });
  if (converted) {
    return { type: 'image', mimeType: converted.mimeType, image: converted.dataUrl };
  }
  let dataUrl = typeof image.dataUrl === 'string' ? image.dataUrl.trim() : '';
  if (!dataUrl && typeof image.b64 === 'string' && image.b64) {
    const format = typeof image.format === 'string' && image.format ? image.format.toLowerCase().replace(/^image\//, '') : 'png';
    const mime = format === 'jpg' ? 'image/jpeg' : `image/${format}`;
    dataUrl = `data:${mime};base64,${image.b64}`;
  }
  if (!dataUrl.startsWith('data:image/')) return null;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
  const mimeType = match ? match[1] : 'image/png';
  return { type: 'image', mimeType, image: dataUrl };
}

/** 读取 conversation message 上携带的图片（OpenAI 层已归一化为 {mimeType,dataUrl}）。 */
function extractMessageImages(message) {
  const images = Array.isArray(message?.images) ? message.images : [];
  return images.map(toUpstreamImagePart).filter(Boolean);
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * Clamp a requested reasoning effort to what the upstream model supports.
 * Unsupported tiers are downgraded to the highest supported tier below the request.
 * @param {string | null | undefined} model
 * @param {string | null | undefined} effort
 * @returns {string}
 */
export function normalizeReasoningEffort(model, effort) {
  const requested = typeof effort === 'string' && effort ? effort : 'none';
  const requestedIndex = REASONING_EFFORTS.indexOf(requested);
  if (requestedIndex === -1) return 'none';
  const entry = findModel(model || '');
  const supported = entry && Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts.filter((value) => REASONING_EFFORTS.includes(value)) : [];
  if (!supported.length) return requested;
  if (supported.includes(requested)) return requested;
  let best = null;
  for (const tier of supported) {
    const index = REASONING_EFFORTS.indexOf(tier);
    if (index <= requestedIndex && (best === null || index > REASONING_EFFORTS.indexOf(best))) best = tier;
  }
  return best ?? supported[0];
}

/**
 * Duck.ai upstream client.
 *
 * @example
 * const client = new DuckClient();
 * await client.init();
 * const res = await client.chat({ model: 'gpt-6-luna', messages: [{ role: 'user', content: '你好' }] }, {
 *   onTextDelta: (text) => process.stdout.write(text)
 * });
 */
export class DuckClient {
  /**
   * @param {{
   *   baseUrl?: string,
   *   userAgent?: string,
   *   defaultModel?: string,
   *   timeoutMs?: number,
   *   warmup?: boolean,
   *   strictInit?: boolean,
   *   strictProtocol?: boolean,
   *   systemPromptMode?: 'auto' | 'system' | 'developer' | 'prefix',
   *   humanize?: { minDelayMs?: number, maxDelayMs?: number, concurrency?: number, retries?: number, retryBaseDelayMs?: number },
   *   challenge?: Record<string, any>,
   *   identityStore?: IdentityStore,
   *   identityRecord?: Record<string, any>,
   *   identityDir?: string,
   *   dataDir?: string,
   *   durableStream?: { enabled?: boolean },
   *   proxyManager?: ProxyManager,
   *   proxy?: Record<string, any>,
   *   logger?: { debug?: Function, info?: Function, warn?: Function, error?: Function } | null
   * }} [config]
   * @param {{ identityStore?: IdentityStore, proxyManager?: ProxyManager }} [options] alternative injection points
   */
  constructor(config = {}, options = {}) {
    this.config = config;
    this.baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.userAgent = config.userAgent || DEFAULT_USER_AGENT;
    this.defaultModel = config.defaultModel || DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs ?? 120000;
    this.warmup = config.warmup !== false;
    this.strictInit = config.strictInit === true;
    // v2: any deviation from the expected upstream contract aborts the request immediately instead of
    // silently degrading (docs/ADMIN_API_V2.md §6). Disable only for protocol debugging.
    this.strictProtocol = config.strictProtocol !== false;
    // v2.19: how many times a continuation frame (tool approval / resumable stream) may be
    // resubmitted before giving up (weather/web-search style prompts need one extra round).
    this.maxContinuations = Number.isFinite(config.maxContinuations)
      ? Math.max(0, Math.trunc(config.maxContinuations))
      : 2;
    // duck.ai rejects `role:"system"` with 400 ERR_BAD_REQUEST (verified 2026-11-01), so the
    // default is inline mode: system/developer text is folded into the first user message.
    this.systemPromptMode = config.systemPromptMode || 'prefix';
    this.logger = config.logger || null;

    const humanize = config.humanize || {};
    const humanizeEnabled = humanize.enabled !== false;
    this.humanize = {
      enabled: humanizeEnabled,
      minDelayMs: humanizeEnabled ? humanize.minDelayMs ?? 400 : 0,
      maxDelayMs: humanizeEnabled ? humanize.maxDelayMs ?? 1500 : 0,
      minIntervalMs: humanizeEnabled ? humanize.minIntervalMs ?? 1000 : 0,
      concurrency: Math.max(1, humanize.concurrency ?? 1),
      // `maxRetries` is the ARCHITECTURE §6 spelling; `retries` is accepted as an alias.
      retries: Math.max(0, humanize.maxRetries ?? humanize.retries ?? 3),
      retryBaseDelayMs: humanize.retryBaseDelayMs ?? 1000,
      rateLimitCooldownMs: humanize.rateLimitCooldownMs ?? 60000,
      // How long a chat() call is allowed to block waiting for a 429 cooldown to expire.
      rateLimitWaitMs: humanize.rateLimitWaitMs ?? 5000
    };

    /**
     * v2.3 outbound proxy. Accepts an injected manager (api-core) or builds one from `config.proxy`.
     * Every upstream fetch (challenge/version/status/chat/capabilities/auth verify) goes through
     * `this._fetch`, which is `proxyManager.fetch` when a manager exists.
     * @type {ProxyManager | null}
     */
    this.proxyManager =
      config.proxyManager ||
      options.proxyManager ||
      (config.proxy && typeof config.proxy === 'object' && typeof config.proxy.fetch !== 'function'
        ? new ProxyManager({ config: { proxy: config.proxy }, logger: this.logger })
        : null);
    this._fetch = this.proxyManager
      ? (url, init) => this.proxyManager.fetch(url, init)
      : (url, init) => fetch(url, init);

    this.challenge = new ChallengeManager({
      baseUrl: this.baseUrl,
      userAgent: this.userAgent,
      timeoutMs: Math.min(this.timeoutMs, 30000),
      fetchImpl: this._fetch,
      logger: this.logger,
      ...(config.challenge || {})
    });

    /**
     * Stable anonymous identity (v2.2). When injected, `x-ddg-journey-id`, `durableStream` and
     * `Authorization` all come from the persisted identity file instead of being regenerated.
     * Accepted shapes: `config.identityStore`, second-arg `{ identityStore }`, `config.identity`
     * when it is already an IdentityStore instance (api-core passes both config sections), or
     * `config.identityRecord` (v2.4 identity pool: an in-memory identity record).
     * @type {IdentityStore | MemoryIdentityStore | null}
     */
    this.identityStore =
      config.identityStore ||
      options.identityStore ||
      (config.identity && typeof config.identity.getJourneyId === 'function' ? config.identity : null) ||
      (config.identityRecord ? new MemoryIdentityStore(config.identityRecord, { source: 'pool' }) : null) ||
      null;
    const identityDir = config.identityDir || config.dataDir || config.identity?.dataDir || null;
    this._identityDir = identityDir;
    // Volatile fallback (legacy behaviour): random journey id per process; no durableStream / auth.
    this.journeyId = this.identityStore ? this.identityStore.getJourneyId() || crypto.randomBytes(16).toString('hex') : crypto.randomBytes(16).toString('hex');
    /** durableStream is opt-in and auto-degrades when the upstream rejects it (anonymous public tier rejects it). */
    this.durableStreamConfig = {
      enabled: (config.durableStream && config.durableStream.enabled === true) || (config.identity && config.identity.durableStream && config.identity.durableStream.enabled === true)
    };
    this._durableStreamDegraded = false;
    this._authExpired = false;
    this.capabilities = null;
    this._semaphore = new Semaphore(this.humanize.concurrency);
    /** @type {'system' | 'developer' | 'prefix' | null} */
    this._systemModeResolved = this.systemPromptMode === 'auto' ? null : this.systemPromptMode;
    this._initDone = false;
    /** @type {Promise<any> | null} */
    this._initPromise = null;
    /** Last request start time (used to enforce humanize.minIntervalMs). */
    this._lastRequestAt = 0;
    /** Last upstream rate-limit observation: { at, retryAt, count, status }. */
    this._rateLimit = null;
    this._stats = {
      requests: 0,
      success: 0,
      failures: 0,
      retries: 0,
      challengeRetries: 0,
      limitHits418: 0,
      limitHits429: 0,
      durableStreamRequests: 0,
      durableStreamRejected: 0,
      authRequests: 0,
      authExpired: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorAt: null,
      lastStatus: null,
      lastModel: null,
      lastRequestAt: null,
      firstRequestAt: null,
      recentErrors: []
    };
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Ensure the stable identity store is loaded (v2.2). Creates one lazily when `identityDir`/`dataDir`
   * is configured but no store was injected. Never throws: identity problems must not block serving.
   * @returns {Promise<IdentityStore | null>}
   */
  async _ensureIdentity() {
    try {
      if (!this.identityStore && this._identityDir) {
        this.identityStore = await createIdentityStore({
          dataDir: this._identityDir,
          config: { baseUrl: this.baseUrl, userAgent: this.userAgent, timeoutMs: this.timeoutMs },
          logger: this.logger
        });
      }
      if (this.identityStore && typeof this.identityStore.init === 'function') {
        await this.identityStore.init();
      }
      if (this.identityStore) {
        this.journeyId = this.identityStore.getJourneyId() || this.journeyId;
      } else {
        this.logger?.warn?.(
          '[duck:identity] no identity store configured — using a volatile random journeyId (upstream identity will drift across restarts)'
        );
      }
    } catch (error) {
      this.logger?.error?.('[duck:identity] identity initialization failed; falling back to volatile identity', error);
      this.identityStore = null;
      this._noteError(error, { phase: 'identity_init' });
    }
    return this.identityStore;
  }

  /** Current upstream-visible journey id (persisted identity when available). */
  _currentJourneyId() {
    return (this.identityStore && this.identityStore.getJourneyId && this.identityStore.getJourneyId()) || this.journeyId;
  }

  /** Compact identity summary for `health()`; also used by api-core/admin. */
  identitySummary() {
    if (this.identityStore && typeof this.identityStore.getSummary === 'function') {
      const summary = this.identityStore.getSummary();
      this.journeyId = summary.journeyId || this.journeyId;
      return {
        ...summary,
        durableStreamEnabled: this._durableStreamEnabled(),
        durableStreamDegraded: this._durableStreamDegraded,
        volatile: false
      };
    }
    return {
      journeyId: this.journeyId,
      fingerprint: null,
      conversationId: null,
      deviceId: null,
      stable: false,
      source: 'volatile',
      authTier: 'free',
      authenticated: false,
      authExpired: false,
      syncEnabled: false,
      durableStreamEnabled: false,
      durableStreamDegraded: false,
      volatile: true
    };
  }

  /** Re-read the journey id after `identityStore.rotate()` (also called automatically per request). */
  refreshIdentity() {
    if (this.identityStore) this.journeyId = this.identityStore.getJourneyId() || this.journeyId;
    return this.identitySummary();
  }

  /** durableStream is never sent in volatile/legacy mode, nor after the upstream rejected it. */
  _durableStreamEnabled() {
    return Boolean(this.identityStore && this.durableStreamConfig.enabled && !this._durableStreamDegraded);
  }

  /**
   * Build the `durableStream` body field.
   * Upstream shape (bundle): `{ messageId, conversationId, publicKey }` where `publicKey` is the
   * RSA-OAEP-256 JWK and `conversationId` is the stable per-identity conversation id.
   * @returns {{ messageId: string, conversationId: string, publicKey: Record<string, any> } | null}
   */
  _buildDurableStream() {
    if (!this._durableStreamEnabled()) return null;
    const store = this.identityStore;
    const publicKey = store.getDurableStreamPublicKey && store.getDurableStreamPublicKey();
    const conversationId = store.getConversationId && store.getConversationId();
    if (!publicKey || !conversationId) return null;
    return {
      messageId: crypto.randomUUID(),
      conversationId,
      publicKey
    };
  }

  /**
   * Discover the page version, warm the challenge and read capabilities.
   * Non-fatal by default (config.strictInit = true to throw), so the gateway can boot and retry.
   */
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      // v2.3: proxy dispatcher must exist before any upstream request.
      if (this.proxyManager && typeof this.proxyManager.init === 'function') {
        try {
          await this.proxyManager.init();
        } catch (error) {
          this.logger?.error?.('[duck:proxy] proxy initialization failed; continuing with direct connections', error);
          this._noteError(error, { phase: 'proxy_init' });
        }
      }
      await this._ensureIdentity();
      // Wire the proxy into identity/sync/subscription verification.
      if (this.identityStore) {
        try {
          this.identityStore.setProxyManager?.(this.proxyManager);
          this.identityStore.setFetchImpl?.(this._fetch);
        } catch (error) {
          this.logger?.warn?.('[duck:proxy] could not inject proxy into identity store', error);
        }
      }
      let error = null;
      try {
        await this._semaphore.run(async () => {
          await this.challenge.ensureVersion();
        });
      } catch (caught) {
        error = caught;
        this._noteError(caught);
      }
      if (!error || this.strictInit) {
        // `/capabilities` can rotate the challenge; read it *before* warming so the prewarmed
        // challenge stays the last one issued by the upstream.
        const capabilitiesResult = await this._semaphore.run(() => this.challenge.fetchCapabilitiesWithHeaders());
        if (capabilitiesResult) {
          this.capabilities = capabilitiesResult.capabilities;
          await this.challenge.noteChallengeFromHeader(capabilitiesResult.challengeHeader).catch(() => {});
        }
      }
      if (this.warmup && (!error || this.strictInit)) {
        try {
          await this._semaphore.run(async () => {
            await this.challenge.init();
          });
        } catch (caught) {
          error = error || caught;
          this._noteError(caught);
        }
      }
      this._initDone = true;
      if (error && this.strictInit) throw toDuckError(error);
      return this.health();
    })().catch((caught) => {
      this._initPromise = null;
      throw caught;
    });
    return this._initPromise;
  }

  /**
   * Static model catalog in v2 shape (`ADMIN_API_V2.md` §4): free/paid flags, tier, availability,
   * supported reasoning efforts and API-level tool names. A defensive copy is returned.
   * @returns {Array<Record<string, any>>}
   */
  getModelCatalog() {
    return getApiModelCatalog();
  }

  /**
   * Health snapshot. Uses cached upstream state only (no extra upstream request),
   * so polling `/healthz` never disturbs the rolling challenge chain.
   * @param {{ probe?: boolean }} [options] `probe:true` re-reads /capabilities (best effort).
   */
  async health(options = {}) {
    if (options.probe) {
      const probe = await this.challenge.fetchCapabilitiesWithHeaders();
      if (probe) {
        if (probe.capabilities) this.capabilities = probe.capabilities;
        await this.challenge.noteChallengeFromHeader(probe.challengeHeader).catch(() => {});
      }
    }
    const challenge = this.challenge.stats();
    const { recentErrors, ...stats } = this._stats;
    const now = Date.now();
    const rateLimited = Boolean(this._rateLimit && this._rateLimit.retryAt > now);
    const identity = this.identitySummary();
    return {
      ok: this._stats.consecutiveFailures === 0 && challenge.solveErrors === 0 && !rateLimited,
      upstreamStatus: this.challenge.upstreamStatus,
      challengeOk: this.challenge.ready || challenge.solves > 0,
      version: this.challenge.version,
      initDone: this._initDone,
      capabilities: this.capabilities,
      strictProtocol: this.strictProtocol,
      identity,
      durableStream: {
        configured: Boolean(this.durableStreamConfig.enabled),
        enabled: this._durableStreamEnabled(),
        degraded: this._durableStreamDegraded,
        rejectedCount: this._stats.durableStreamRejected
      },
      auth: {
        tier: identity.authTier,
        authenticated: identity.authenticated,
        expired: identity.authExpired || this._authExpired
      },
      proxy: this.proxyManager && typeof this.proxyManager.getSummary === 'function'
        ? this.proxyManager.getSummary()
        : { enabled: false, mode: 'direct', active: false, lastTestOk: null, lastTestLatencyMs: null, exitIp: null },
      rateLimited,
      retryAt: rateLimited ? this._rateLimit.retryAt : null,
      rateLimit: this._rateLimit,
      challenge,
      stats,
      recentErrors: recentErrors.map((entry) => ({ ...entry })),
      humanize: { ...this.humanize },
      journeyId: identity.journeyId || this.journeyId
    };
  }

  // ---------------------------------------------------------------------- chat

  /**
   * Send a chat turn upstream and stream normalized events back.
   *
   * @param {import('./index.js').DuckChatParams & {
   *   systemPrompt?: string,
   *   systemPromptMode?: 'auto' | 'system' | 'developer' | 'prefix'
   * }} params
   * @param {import('./index.js').DuckChatHandlers} [handlers]
   * @returns {Promise<{
   *   content: string,
   *   cleanContent: string,
   *   markdown: string,
   *   reasoning: string,
   *   sources: Array<Record<string, any>>,
   *   citations: Array<Record<string, any>>,
   *   images: Array<{ b64: string, format: string, modelDisplayName?: string, width?: number, height?: number }>,
   *   toolCalls: Array<Record<string, any>>,
   *   toolResults: Array<Record<string, any>>,
   *   finishReason: string,
   *   rawEvents: Array<Record<string, any>>,
   *   model: string,
   *   reasoningEffort: string,
   *   reasoningEffortRequested: string,
   *   conversationId?: string | null,
   *   title?: string | null
   * }>}
   */
  async chat(params = {}, handlers = {}) {
    const requestedModel = params.model || this.defaultModel;
    const model = this._resolveModel(requestedModel);
    const requestedEffort = params.reasoningEffort || 'none';
    const reasoningEffort = normalizeReasoningEffort(model, requestedEffort);
    const messages = Array.isArray(params.messages) ? params.messages : [];
    if (!messages.length) {
      throw new DuckError('messages is required and must be a non-empty array', { status: 400, type: 'invalid_request', retriable: false });
    }
    const systemPromptMode = params.systemPromptMode || this.systemPromptMode;

    const toolChoice = {};
    // 2026-11-04：显式 toolChoice.WebSearch 会让上游把该流标记为不可续传（天气的 LocationPrompt
    // 审批会 409 continuation-restart-required: incompatible）。浏览器默认只发 canUseTools:true，
    // 模型会自行决定是否联网搜索（实测无 toolChoice 仍会返回 sources / url_citation）。
    // 图片生成仍保留 GenerateImage（这是图片接口的显式意图）。
    if (params.imageGeneration) toolChoice.GenerateImage = true;

    const buildBody = (systemMode) => {
      const body = {
        model,
        messages: buildUpstreamMessages(messages, { systemMode, systemPrompt: params.systemPrompt }),
        canUseTools: true,
        reasoningEffort,
        // 浏览器始终发送这三个能力位（未授权时为 null），缺字段会被后续 continuation 判为 incompatible。
        // v2.36/v2.38：定位设置关闭时，浏览器抓包发送的是 **false**（不是 null，null 会触发定位询问）；
        // 开启时先发 null（允许上游询问），审批通过后再发 true。
        canUseApproxLocation: params.approxLocation === true ? null : false,
        canDelegateImageGeneration: null,
        canShowGreeting: true
      };
      if (Object.keys(toolChoice).length) body.metadata = { toolChoice };
      const durableStream = this._buildDurableStream();
      if (durableStream) body.durableStream = durableStream;
      return body;
    };

    const hasSystemContent =
      Boolean(params.systemPrompt) || messages.some((message) => message && (message.role === 'system' || message.role === 'developer'));

    await this._respectRateLimit(params.signal);

    let mode = this._resolveSystemMode(systemPromptMode);
    let body = buildBody(mode);
    const chatContext = () => ({
      handlers,
      model,
      reasoningEffort,
      requestedEffort,
      approxLocation: params.approxLocation === true,
      signal: params.signal,
      extraHeaders: params.extraHeaders,
      conversationId: params.conversationId,
      expectImage: params.imageGeneration === true
    });
    let result = await this._executeChat(body, chatContext());

    // v2.2: the anonymous/public upstream tier rejects `durableStream` with 400 ERR_BAD_REQUEST.
    // Remember that once, disable durableStream for this process, and retry exactly once without it.
    if (result.error && body.durableStream && this._isDurableStreamRejection(result.error)) {
      this._durableStreamDegraded = true;
      this._stats.durableStreamRejected += 1;
      this.logger?.warn?.('[duck] upstream rejected durableStream (anonymous tier?); disabling durableStream for this process and retrying once', {
        status: result.error.status,
        code: result.error.code,
        upstreamType: result.error.upstreamType || null
      });
      body = buildBody(mode);
      result = await this._executeChat(body, chatContext());
    }

    // Native `system` role can be rejected by the upstream; fall back to prompt prefix once and remember it.
    if (result.error400 && hasSystemContent && mode !== 'prefix' && (systemPromptMode === 'auto' || systemPromptMode === 'system' || systemPromptMode === 'developer')) {
      this.logger?.warn?.('[duck] system role rejected upstream; falling back to prompt-prefix mode');
      this._systemModeResolved = 'prefix';
      mode = 'prefix';
      result = await this._executeChat(buildBody(mode), {
        handlers,
        model,
        reasoningEffort,
        requestedEffort,
        signal: params.signal,
        extraHeaders: params.extraHeaders,
        conversationId: params.conversationId,
        expectImage: params.imageGeneration === true
      });
    }

    if (result.error) {
      const duckError = toDuckError(result.error);
      if (duckError.status === 429) {
        const retryAt = (this._rateLimit && this._rateLimit.retryAt) || Date.now() + this.humanize.retryBaseDelayMs;
        // Preserve an upstream Retry-After hint when present; otherwise derive from the cooldown.
        if (!Number.isFinite(duckError.retryAfterMs)) duckError.retryAfterMs = Math.max(0, retryAt - Date.now());
        duckError.retryAt = retryAt;
        duckError.type = duckError.type === 'upstream_error' ? 'rate_limit_exceeded' : duckError.type;
      }
      throw duckError;
    }
    if (!result.value) {
      throw new DuckError('upstream chat produced no result', { status: 502, type: 'empty_result', retriable: true });
    }
    return result.value;
  }

  /**
   * Summarize a conversation for context compaction (v2.11). Thin wrapper around
   * `src/duck/compact.js` (loaded dynamically to avoid a static import cycle).
   * @param {{ messages: Array<Record<string, any>>, model?: string, maxSummaryChars?: number, previousSummary?: string, systemPrompt?: string, signal?: AbortSignal, inputCharsLimit?: number }} [params]
   */
  async summarizeMessages(params = {}) {
    const { summarizeMessages } = await import('./compact.js');
    if (!Array.isArray(params.messages)) {
      throw new DuckError('summarizeMessages requires params.messages', { status: 400, type: 'invalid_request', retriable: false });
    }
    return summarizeMessages(this, params.messages, params);
  }

  /**
   * Native Duck.ai summarizer (`POST /duckchat/v1/summarize`, v2.11).
   *
   * Body: `{ model, previousSummary: {text,version}|null, targetPairCount, newMessages }`.
   * Response: `{ summary: {text,version}, coveredPairCount?, fixedCostWindowUsage? }`.
   * The rolling challenge header is committed from the response so the next chat request can reuse it.
   *
   * This is a single attempt (no retry loop); `compact.summarizeMessages` falls back to a normal
   * chat summary when this fails. Errors are `DuckError` (with `retriable`/`fixedCostWindowUsage`).
   *
   * @param {{
   *   model?: string,
   *   messages?: Array<Record<string, any>>,
   *   newMessages?: Array<Record<string, any>>,
   *   previousSummary?: { text: string, version?: number } | null,
   *   targetPairCount?: number,
   *   coveredPairCount?: number,
   *   systemPromptMode?: 'auto'|'prefix'|'system',
   *   systemPrompt?: string,
   *   extraHeaders?: Record<string, string>,
   *   signal?: AbortSignal
   * }} [params]
   * @returns {Promise<{ ok: true, text: string, version: number|null, coveredPairCount: number|null, fixedCostWindowUsage: any, raw: any }>}
   */
  async summarizeNative(params = {}) {
    const model = this._resolveModel(params.model || this.defaultModel);
    const allMessages = Array.isArray(params.messages) ? params.messages : [];
    const coveredPairCount = Number.isFinite(Number(params.coveredPairCount)) ? Math.max(0, Math.floor(Number(params.coveredPairCount))) : 0;
    // The summarize endpoint expects `newMessages` as `{role,text}` entries (not chat `content`),
    // one entry per user/assistant message (pairs ×2), like duck.ai bundle module 89099 (`e4`).
    const toSummarizeEntries = (source) => {
      const entries = [];
      for (const message of Array.isArray(source) ? source : []) {
        if (!message || typeof message !== 'object') continue;
        const role = typeof message.role === 'string' ? message.role : '';
        if (role !== 'user' && role !== 'assistant') continue;
        let text = '';
        if (typeof message.text === 'string') {
          text = message.text;
        } else if (typeof message.content === 'string') {
          text = message.content;
        } else if (Array.isArray(message.content)) {
          text = message.content
            .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
            .filter(Boolean)
            .join('\n');
        }
        text = text.trim();
        if (!text) continue;
        entries.push({ role, text });
      }
      return entries;
    };
    const normalized = toSummarizeEntries(params.newMessages || allMessages);
    if (!normalized.length) {
      throw new DuckError('summarizeNative requires messages/newMessages', { status: 400, type: 'invalid_request', retriable: false });
    }
    const targetPairCount = Number.isFinite(Number(params.targetPairCount))
      ? Math.max(1, Math.floor(Number(params.targetPairCount)))
      : Math.max(1, Math.floor(normalized.length / 2));
    const newMessages = normalized.slice(0, targetPairCount * 2).slice(coveredPairCount * 2);
    if (!newMessages.length) {
      throw new DuckError('summarizeNative has no new message pairs to summarize', { status: 400, type: 'invalid_request', retriable: false });
    }
    const body = {
      model,
      previousSummary: params.previousSummary && typeof params.previousSummary.text === 'string'
        ? { ...params.previousSummary, text: params.previousSummary.text, version: Number(params.previousSummary.version) || 0 }
        : null,
      targetPairCount,
      newMessages
    };

    await this._respectRateLimit(params.signal);
    const lease = await this.challenge.acquire({ reason: `summarize:${model}` });
    const controller = new AbortController();
    const signal = this._composeSignal(params.signal, controller.signal);
    const version = this.challenge.version || (await this.challenge.ensureVersion());
    const identityJourneyId = this._currentJourneyId();
    const authToken = this.identityStore && typeof this.identityStore.getAuthToken === 'function' ? this.identityStore.getAuthToken() : null;
    if (authToken && authToken.expired) this._authExpired = true;
    const headers = {
      'user-agent': this.userAgent,
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json',
      origin: this.baseUrl,
      referer: `${this.baseUrl}/`,
      'x-fe-version': version,
      'x-fe-signals': buildFeSignals(this._feSignalsEvents()),
      'x-vqd-hash-1': lease.header,
      'x-duckai-response-id': crypto.randomUUID(),
      'x-ddg-journey-id': identityJourneyId,
      ...(authToken && authToken.token ? { authorization: `Bearer ${authToken.token}` } : {}),
      ...(params.extraHeaders || {})
    };
    this._stats.requests += 1;
    this._stats.lastRequestAt = Date.now();
    this._stats.lastModel = model;
    let response;
    try {
      response = await this._fetch(`${this.baseUrl}/duckchat/v1/summarize`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      lease.release?.();
      throw this._mapFetchError(error, { model, signal });
    }
    lease.commit(response.headers);
    // The challenge mutex is held by the lease until released; release before any invalidate()/retry
    // path so a fallback chat request can acquire a fresh challenge instead of deadlocking.
    lease.release?.();
    this._stats.lastStatus = response.status;
    const rawText = await response.text().catch(() => '');
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      // 418 (challenge/soft limit) consumes the rolling challenge; drop it so the next request gets
      // a fresh one (same behaviour as `_executeChat`).
      // Any failed summarize response consumes/rolls the challenge; reset it so a fallback chat
      // request (or the next attempt) can acquire a fresh challenge instead of hanging.
      if (typeof this.challenge.invalidate === 'function') {
        await this.challenge.invalidate(`summarize-${response.status}`).catch(() => {});
      }
      const errorType = String((parsed && (parsed.type || parsed.errorType)) || 'ERR_SUMMARIZE_FAILED');
      const mapped = mapUpstreamError(errorType);
      const duckError = new DuckError(parsed && parsed.message ? String(parsed.message) : `summarize failed with HTTP ${response.status}`, {
        status: response.status || mapped.httpStatus,
        type: mapped.code,
        retriable: typeof (parsed && parsed.retriable) === 'boolean' ? parsed.retriable : mapped.retriable,
        code: errorType,
        detail: parsed || rawText.slice(0, 300)
      });
      duckError.transportStatus = response.status;
      duckError.httpStatus = response.status;
      if (parsed && parsed.fixedCostWindowUsage !== undefined) duckError.fixedCostWindowUsage = parsed.fixedCostWindowUsage;
      throw duckError;
    }
    const summary = parsed && parsed.summary;
    if (!summary || typeof summary.text !== 'string' || !summary.text.trim()) {
      throw new DuckError('summarize response has no summary text', { status: 502, type: 'empty_summary', retriable: true, detail: parsed });
    }
    return {
      ok: true,
      text: summary.text,
      version: Number.isFinite(Number(summary.version)) ? Number(summary.version) : null,
      coveredPairCount: parsed && Number.isFinite(Number(parsed.coveredPairCount)) ? Number(parsed.coveredPairCount) : null,
      fixedCostWindowUsage: (parsed && parsed.fixedCostWindowUsage) ?? null,
      raw: parsed
    };
  }

  /**
   * Generate an image through the same `/duckchat/v1/chat` endpoint using the `GenerateImage` tool.
   * @param {{ prompt: string, model?: string, signal?: AbortSignal, extraHeaders?: Record<string, string> }} params
   * @returns {Promise<{ images: Array<{ b64: string, format: string }>, modelDisplayName?: string }>}
   */
  async imageGeneration(params = {}) {
    const prompt = String(params.prompt || '').trim();
    if (!prompt) throw new DuckError('prompt is required for imageGeneration', { status: 400, type: 'invalid_request', retriable: false });
    const result = await this.chat(
      {
        model: params.model || this.defaultModel,
        messages: [{ role: 'user', content: prompt }],
        imageGeneration: true,
        reasoningEffort: 'none',
        canShowGreeting: true,
        signal: params.signal,
        extraHeaders: params.extraHeaders
      },
      {}
    );
    if (!result.images.length) {
      throw new DuckError('upstream finished without returning an image', {
        status: 502,
        code: 'upstream_no_image',
        type: 'upstream_no_image',
        retriable: false
      });
    }
    return {
      images: result.images.map((image) => ({
        b64: image.b64,
        format: detectImageFormat(image.b64, normalizeFormat(image.format) || 'png')
      })),
      modelDisplayName: result.images[0]?.modelDisplayName,
      rawEvents: result.rawEvents
    };
  }

  // ------------------------------------------------------------------ internals

  /**
   * If the upstream recently rate limited us, either wait out a short cooldown or fail fast with
   * a 429 carrying `retryAfterMs`/`retryAt` so the gateway can answer with `Retry-After`.
   * @param {AbortSignal} [signal]
   */
  async _respectRateLimit(signal) {
    if (!this._rateLimit) return;
    const remaining = this._rateLimit.retryAt - Date.now();
    if (remaining <= 0) {
      this._rateLimit = null;
      return;
    }
    if (remaining > this.humanize.rateLimitWaitMs) {
      this._stats.limitHits429 += 1;
      const error = new DuckError('upstream rate limit cooldown is active', {
        status: 429,
        type: 'rate_limit_exceeded',
        retriable: true
      });
      error.retryAfterMs = remaining;
      error.retryAt = this._rateLimit.retryAt;
      error.requestId = this._rateLimit.requestId;
      throw error;
    }
    if (signal?.aborted) throw new DuckError('request aborted', { status: 499, type: 'aborted', retriable: false });
    this.logger?.warn?.('[duck] waiting out upstream rate limit cooldown', { waitMs: remaining });
    await sleep(remaining);
    this._rateLimit = null;
  }

  /**
   * Execute one chat request with humanize delay, concurrency cap, challenge lease and retries.
   * Never throws; returns `{ value }` or `{ error }`.
   */
  async _executeChat(body, context) {
    const maxAttempts = this.humanize.retries + 1;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const value = await this._semaphore.run(async () => {
          // humanize: honour the minimum gap between upstream requests, then add random jitter.
          const gap = this.humanize.minIntervalMs - (Date.now() - this._lastRequestAt);
          const delay = Math.max(0, gap) + randomBetween(this.humanize.minDelayMs, this.humanize.maxDelayMs);
          if (delay > 0) await sleep(delay);
          this._lastRequestAt = Date.now();
          return this._attemptChat(body, context);
        });
        // A successful request clears the rate-limit cooldown marker.
        this._rateLimit = null;
        return { value };
      } catch (error) {
        lastError = error;
        const duckError = toDuckError(error);
        // Strict protocol / semantic failures are terminal: the upstream answered, retrying would
        // only repeat the same deviation (v2 requirement: abort immediately).
        // Exception: transport-level 418 (challenge/soft limit) is retried with a *fresh* challenge —
        // observed to self-heal, and the anomaly mapping is only for the gateway-facing error.
        const transportStatus = duckError.transportStatus ?? duckError.status;
        const fatal = NON_RETRIABLE_CODES.has(duckError.code) && transportStatus !== 418;
        const retriable =
          !fatal &&
          (duckError.retriable ||
            transportStatus === 418 ||
            transportStatus === 429 ||
            transportStatus >= 500 ||
            duckError.type === 'challenge_fetch_failed' ||
            duckError.type === 'network_error');
        this._noteError(duckError, { attempt, model: body.model, fatal });
        if (transportStatus === 418) this._stats.limitHits418 += 1;
        if (transportStatus === 429) {
          this._noteRateLimit(duckError);
          // Quota windows are long (tens of seconds): do not burn retries hammering the upstream.
          const remainingCooldown = (this._rateLimit && this._rateLimit.retryAt ? this._rateLimit.retryAt : 0) - Date.now();
          if (remainingCooldown > this.humanize.rateLimitWaitMs) break;
        }
        // 400 means the request body/schema is wrong: never retry (system-role fallback lives in chat()).
        if (!retriable || attempt >= maxAttempts) break;
        this._stats.retries += 1;
        this._stats.challengeRetries += 1;
        // The challenge we consumed is gone: drop any buffered state and fetch a fresh one next attempt.
        await this.challenge.invalidate(`retry-after-${duckError.status}`).catch(() => {});
        const backoff =
          this.humanize.retryBaseDelayMs * 2 ** (attempt - 1) +
          randomBetween(0, 250) +
          (duckError.retryAfterMs ? Math.min(duckError.retryAfterMs, 15000) : 0);
        this.logger?.warn?.('[duck] retrying chat after upstream error', {
          attempt,
          status: duckError.status,
          type: duckError.type,
          backoffMs: backoff
        });
        await sleep(backoff);
      }
    }
    // 400 with a system message is handled by chat() (system-role fallback), so surface the flag.
    const error400 = lastError && (lastError.status === 400 || (lastError.cause && lastError.cause.status === 400));
    return { error: lastError, error400 };
  }

  /** Record a 429 observation, including the upstream `retry-after` hint when present. */
  /**
   * v2.21：x-fe-signals 里的交互事件。浏览器会带 {name,delta,trusted} 事件；
   * 空 events 是自动化客户端的明显特征，这里按“新建/发送/操作”三种常见事件补齐。
   */
  _feSignalsEvents() {
    if (process.env.DUCKAI_EMPTY_SIGNALS === '1') return [];
    const now = Date.now();
    const startedAt = this._feSignalsStartedAt || (this._feSignalsStartedAt = now);
    const delta = Math.max(1, now - startedAt);
    const events = [];
    if (!this._feSignalsFirstSent) {
      this._feSignalsFirstSent = true;
      events.push({ name: 'startNewChat_free', delta: Math.min(delta, 5000) });
      events.push({ name: 'action', delta, trusted: true });
    } else {
      events.push({ name: 'action', delta, trusted: true });
    }
    return events;
  }

  _noteRateLimit(duckError) {
    const now = Date.now();
    const cooldown = duckError.retryAfterMs || this.humanize.rateLimitCooldownMs;
    const previousCount = this._rateLimit ? this._rateLimit.count : 0;
    this._rateLimit = {
      at: now,
      retryAt: now + cooldown,
      count: previousCount + 1,
      status: 429,
      type: duckError.type || 'ERR_RATE_LIMIT',
      requestId: duckError.requestId || null
    };
    this.logger?.warn?.('[duck] upstream rate limited', this._rateLimit);
  }

  /** One HTTP attempt: challenge lease + POST + SSE consumption. Throws `DuckError` on failure. */
  async _attemptChat(body, context) {
    const lease = await this.challenge.acquire({ reason: context.model });
    const controller = new AbortController();
    const attemptContext = { ...context, controller, body, lease };
    let response;
    try {
      // `acquire()` guarantees the /status round trip, which also populates the page version.
      const version = this.challenge.version || (await this.challenge.ensureVersion());
      // v2.2: stable anonymous identity (persisted journey id) + subscription token.
      const identityJourneyId = this._currentJourneyId();
      const authToken = this.identityStore && typeof this.identityStore.getAuthToken === 'function' ? this.identityStore.getAuthToken() : null;
      if (authToken && authToken.expired) this._authExpired = true;
      // Reuse the response id when resubmitting a continuation (the browser keeps it stable).
      const responseId = context.responseId || crypto.randomUUID();
      context.responseId = responseId;
      attemptContext.responseId = responseId;
      const headers = {
        'user-agent': this.userAgent,
        accept: 'text/event-stream',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        origin: this.baseUrl,
        referer: `${this.baseUrl}/`,
        'x-fe-version': version,
        'x-fe-signals': buildFeSignals(this._feSignalsEvents()),
        'x-vqd-hash-1': lease.header,
        'x-duckai-response-id': responseId,
        'x-ddg-journey-id': identityJourneyId,
        'x-duckai-continuation': 'resubmit-context',
        'x-duckai-tool-approval': 'web-search',
        'x-duckai-consent-purposes': CONSENT_PURPOSES,
        ...(authToken && authToken.token ? { authorization: `Bearer ${authToken.token}` } : {}),
        ...(context.extraHeaders || {})
      };
      this._stats.requests += 1;
      this._stats.lastRequestAt = Date.now();
      this._stats.lastModel = body.model;
      if (body.durableStream) this._stats.durableStreamRequests += 1;
      if (authToken && authToken.token) this._stats.authRequests += 1;

      if (process.env.DUCKAI_DEBUG_INITIAL === '1') {
        this.logger?.warn?.('[duck] initial request body', { body: JSON.stringify(body).slice(0, 1200), durableStream: Boolean(body.durableStream), model: body.model, reasoningEffort: body.reasoningEffort });
      }
      const signal = this._composeSignal(context.signal, controller.signal);
      attemptContext.signal = signal;
      try {
        response = await this._fetch(`${this.baseUrl}/duckchat/v1/chat`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal
        });
      } catch (error) {
        // Abort/timeout while waiting for headers.
        throw this._mapFetchError(error, attemptContext);
      }
      lease.commit(response.headers);
      this._stats.lastStatus = response.status;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        // v2: a continuation resubmit may be rejected with 409 continuation-restart-required.
        if (response.status === 409 && parsed && parsed.action === 'continuation-restart-required') {
          const reason = String(parsed.reason || 'unknown');
          const error = new DuckError(`continuation restart required (${reason})`, {
            status: 409,
            code: 'upstream_continuation_restart_required',
            type: 'upstream_continuation_restart_required',
            retriable: false,
            body: redactSnippet(text)
          });
          error.reason = reason;
          throw error;
        }
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim()) ? Number(retryAfterHeader.trim()) * 1000 : null;
        const upstreamType = (parsed && (parsed.type || parsed.overrideCode)) || `http_${response.status}`;
        const mapped = mapUpstreamError(upstreamType, response.status);
        const message = (parsed && parsed.message) || `upstream returned HTTP ${response.status}`;
        const error = new DuckError(message, {
          status: mapped.httpStatus,
          type: mapped.code,
          code: mapped.code,
          retriable: mapped.retriable || response.status === 418,
          body: redactSnippet(text),
          upstreamType
        });
        // Keep the real HTTP status separately: 418 is a *transport-level* retriable signal
        // (challenge/soft-limit) even though the gateway-facing mapping is 403/429.
        error.transportStatus = response.status;
        error.requestId = parsed && parsed.r ? String(parsed.r) : null;
        error.challengeData = (parsed && parsed.cd) || null;
        error.fixedCostWindowUsage = (parsed && parsed.fixedCostWindowUsage) || null;
        if (retryAfterMs) error.retryAfterMs = retryAfterMs;
        throw error;
      }

      if (this.strictProtocol) {
        this._assertStrictChatResponse(response, attemptContext);
      }

      return await this._consumeChatResponse(response, attemptContext);
    } finally {
      lease.release();
    }
  }

  /**
   * v2 strict check on a successful chat response, before consuming any frame:
   * content type must be `text/event-stream` and the rolling challenge header must be present.
   * Failure aborts the upstream request immediately (no further frames are read).
   * @param {Response} response
   * @param {Record<string, any>} context
   */
  _assertStrictChatResponse(response, context) {
    const headers = response.headers || new Headers();
    const contentType = String(headers.get('content-type') || '').toLowerCase();
    const challengeHeader = headers.get('x-vqd-hash-1');
    const problems = [];
    if (!contentType.includes('text/event-stream')) problems.push(`content-type=${contentType || '(missing)'}`);
    if (!challengeHeader) problems.push('x-vqd-hash-1=(missing)');
    if (!problems.length) return;

    this._abortUpstream(context, response, 'upstream_protocol_mismatch');
    throw new DuckError(`upstream chat response violates the protocol contract (${problems.join(', ')})`, {
      status: 502,
      code: 'upstream_protocol_mismatch',
      type: 'upstream_protocol_mismatch',
      retriable: false,
      detail: { reason: 'invalid_response_headers', problems }
    });
  }

  /** Abort the in-flight upstream request (and cancel the unread body) after a protocol violation. */
  _abortUpstream(context, response, reason) {
    try {
      context?.controller?.abort(new Error(String(reason || 'aborted')));
    } catch {
      /* ignore */
    }
    try {
      if (response && response.body && typeof response.body.cancel === 'function') {
        response.body.cancel(new Error(String(reason || 'aborted'))).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Read the SSE body, dispatch handlers and aggregate a normalized result.
   *
   * v2 strict behaviour (`strictProtocol: true`, default):
   *  - invalid JSON frame / unknown role / `action:"error"` frame / missing `[DONE]` /
   *    malformed tool frames / `generate-image` success without `b64Image`
   *    → abort the upstream request, throw `DuckError` with `code`, `eventIndex`, `detail`
   *    and `partial` (everything received so far) so the API layer can emit an `error` event.
   * @param {Response} response
   * @param {Record<string, any>} context
   */
  /**
   * v2.19: resubmit a chat request when the upstream ends the stream with a `continuation` frame.
   *
   * Payload (bundle research): `{role:"continuation", action:"success", token, pendingActions:[...]}`
   * where pendingActions can be:
   *   - `{kind:"approval", approvalId, purpose, toolName}` → resubmit with
   *     `{continuation:{token,responseId,responses:[{kind:"approval",approvalId,approved:true}]}}`
   *   - `{kind:"client-output", ...}` → requires a client-side tool; the gateway cannot satisfy it.
   *
   * @returns {Promise<Record<string, any> | null>} merged final result, or null when unresumable.
   */
  /**
   * 把「暂停时已流出的 assistant 内容」还原为浏览器 currentAssistant.parts 形状。
   * 浏览器会把 reasoning part（含 encryptedText / sourceUpstreamId）原样带回，缺了上游会 400。
   * @param {Record<string, any>} collected
   */
  _buildContinuationAssistant(collected) {
    const parts = [];
    const seenReasoning = new Set();
    for (const event of Array.isArray(collected.rawEvents) ? collected.rawEvents : []) {
      if (!event || event.type !== 'reasoning') continue;
      const raw = event.raw && typeof event.raw === 'object' ? event.raw : null;
      if (!raw) continue;
      const isDone = event.state === 'done' || typeof raw.encryptedText === 'string';
      if (!isDone) continue;
      const id = String(raw.id || raw.reasoningId || '');
      if (id && seenReasoning.has(id)) continue;
      if (id) seenReasoning.add(id);
      const part = {
        type: 'reasoning',
        state: 'done',
        // 浏览器抓包：done 的 reasoning part summaryText 为空数组（正文在 encryptedText 里）
        summaryText: []
      };
      if (id) part.id = id;
      if (typeof raw.encryptedText === 'string' && raw.encryptedText) part.encryptedText = raw.encryptedText;
      if (raw.sourceUpstreamId) part.sourceUpstreamId = raw.sourceUpstreamId;
      if (raw.sourceModelId) part.sourceModelId = raw.sourceModelId;
      parts.push(part);
    }
    const content = typeof collected.content === 'string' ? collected.content : '';
    if (content) parts.push({ type: 'text', text: content });
    return { role: 'assistant', content: '', parts };
  }

  async _resumeContinuation(collected, context, eventIndex, response) {
    const continuations = Array.isArray(collected.continuations) ? collected.continuations : [];
    const latest = [...continuations].reverse().find((item) => item && typeof item.token === 'string' && item.token);
    if (!latest) return null;
    const depth = Number.isFinite(context.continuationDepth) ? context.continuationDepth : 0;
    if (depth >= this.maxContinuations) {
      this.logger?.warn?.('[duck] continuation depth limit reached', { depth, eventIndex });
      return null;
    }
    const pendingActions = Array.isArray(latest.pendingActions) ? latest.pendingActions : [];
    const clientOutputs = pendingActions.filter((action) => action && action.kind === 'client-output');
    if (clientOutputs.length) {
      const tools = [...new Set(clientOutputs.map((action) => String(action.toolName || 'unknown')))];
      throw new DuckError('upstream requires a client-side tool output the gateway cannot provide', {
        status: 502,
        code: 'upstream_client_tool_unsupported',
        type: 'upstream_client_tool_unsupported',
        retriable: false,
        eventIndex,
        detail: { reason: 'client_tool_required', tools }
      });
    }
    const approvals = pendingActions.filter((action) => action && action.kind === 'approval' && action.approvalId);
    // v2.36：工具开关决定审批结果。user-location 未开启时显式拒绝（approved:false），
    // 与浏览器「请勿使用」一致；模型会改用不含定位的回答。
    const approxLocationAllowed = context.approxLocation === true;
    // The gateway always advertises consent for web-search / image-generation / user-location
    // (same as the duck.ai browser headers), so approvals are auto-granted.
    //
    // 2026-11-04：duck.ai 的 continuation 校验要求 approval 条目带上 toolCallId / toolName
    // （bundle：claimNext → consent 校验 → {kind:'approval',toolCallId,toolName,approvalId,purpose?,imageModelDisplayName?}），
    // 只发 {kind:'approval',approvalId,approved:true} 会被上游 400 ERR_BAD_REQUEST。
    // 浏览器真实提交格式（2026-11-04 抓包）：{kind:"approval", approvalId, approved:true}
    const responses = approvals.map((action) => {
      const isLocation = action.purpose === 'user-location' || action.toolName === 'LocationPrompt';
      const approved = isLocation ? approxLocationAllowed : true;
      return {
        kind: 'approval',
        approvalId: String(action.approvalId),
        approved
      };
    });
    // v2.36：把「工具审批」决策暴露给上层（会话历史展示 位置调用/图片生成 是否批准）
    const approvalRecords = approvals.map((action, index) => ({
      toolName: action.toolName ? String(action.toolName) : null,
      purpose: action.purpose ? String(action.purpose) : null,
      approved: responses[index].approved === true
    }));
    const continuation = {
      token: latest.token,
      // the browser reuses the response id of the suspended stream here
      responseId: context.responseId || crypto.randomUUID(),
      responses
    };
    const baseBody = context.body && typeof context.body === 'object' ? context.body : null;
    if (!baseBody) return null;
    // 2026-11-04：以下字段与浏览器抓包的 continuation 请求保持一致
    // （多余/缺失字段会被上游判为 continuation-restart-required: incompatible）。
    const purposes = new Set(approvals.map((action) => String(action.purpose || '')));
    const approvedLocation = purposes.has('user-location') && approxLocationAllowed;
    const nextBody = {
      ...baseBody,
      continuation,
      currentAssistant: this._buildContinuationAssistant(collected),
      // 拒绝定位时显式发 false（上游允许「不使用定位」，null 会被判 400）
      canUseApproxLocation: approvedLocation ? true : purposes.has('user-location') ? false : baseBody.canUseApproxLocation ?? null,
      canDelegateImageGeneration: purposes.has('image-generation')
        ? true
        : baseBody.canDelegateImageGeneration ?? null
    };
    // The browser disables durable streams while continuing；metadata 不带（浏览器抓包为无）。
    delete nextBody.durableStream;
    delete nextBody.metadata;
    this.logger?.info?.('[duck] resubmitting chat with continuation', {
      depth: depth + 1,
      approvals: responses.length,
      pendingActions: pendingActions.length,
      hasToken: Boolean(latest.token)
    });
    if (process.env.DUCKAI_DEBUG_CONTINUATION === '1') {
      const debugBody = { ...nextBody, continuation: { ...nextBody.continuation, token: '<token>' } };
      this.logger?.warn?.('[duck] continuation request body', { body: JSON.stringify(debugBody).slice(0, 4000) });
    }
    if (response && response.body && typeof response.body.cancel === 'function') {
      try {
        response.body.cancel().catch(() => {});
      } catch {
        /* ignore */
      }
    }
    this._stats.continuations = (this._stats.continuations || 0) + 1;
    // The outer attempt still holds the challenge mutex; release it or the resubmit deadlocks.
    try {
      context.lease?.release?.();
    } catch {
      /* ignore */
    }
    // 2026-11-04：continuation 必须复用「挂起流响应头里的滚动挑战」，否则上游判 incompatible。
    const rollingChallenge = (() => {
      try {
        return response && response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('x-vqd-hash-1')
          : null;
      } catch {
        return null;
      }
    })();
    const continuationHeaders = rollingChallenge ? { 'x-vqd-hash-1': rollingChallenge } : {};
    let resumed;
    try {
      resumed = await this._attemptChat(nextBody, {
        ...context,
        continuationDepth: depth + 1,
        body: undefined,
        lease: null,
        extraHeaders: { ...(context.extraHeaders || {}), ...continuationHeaders }
      });
    } catch (error) {
      // v2.19: some continuations (notably user-location approval) are rejected as
      // ERR_BAD_REQUEST even with the browser-shaped payload. Fall back to an explicit Web Search
      // tool choice — the verified path for "weather"-style questions.
      const looksRetriable =
        Boolean(error) &&
        (error.status === 400 ||
          error.transportStatus === 400 ||
          error.code === 'bad_request' ||
          error.code === 'upstream_continuation_restart_required' ||
          /ERR_BAD_REQUEST/i.test(String(error.upstreamType || '')));
      if (!looksRetriable) throw error;
      this.logger?.warn?.('[duck] continuation rejected; restarting the stream once', {
        code: error.code,
        status: error.status,
        upstreamType: error.upstreamType || null,
        reason: error.reason || null,
        body: error.body || null
      });
      // 重启语义（对应浏览器 onRestartRequired）：去掉 continuation/currentAssistant/metadata，
      // 但保留已批准的能力位，避免模型再次弹出同一个审批。
      const fallbackBody = {
        ...baseBody,
        canUseTools: true,
        canUseApproxLocation: purposes.has('user-location') && approxLocationAllowed ? true : baseBody.canUseApproxLocation ?? null,
        canDelegateImageGeneration: purposes.has('image-generation')
          ? true
          : baseBody.canDelegateImageGeneration ?? null
      };
      delete fallbackBody.continuation;
      delete fallbackBody.currentAssistant;
      delete fallbackBody.durableStream;
      delete fallbackBody.metadata;
      this._stats.continuations = (this._stats.continuations || 0) + 1;
      resumed = await this._attemptChat(fallbackBody, {
        ...context,
        continuationDepth: depth + 1,
        body: undefined,
        lease: null,
        responseId: undefined
      });
    }
    // Merge what was streamed before the continuation with the resumed result.
    const merged = { ...resumed };
    merged.content = (collected.content || '') + (resumed.content || '');
    merged.cleanContent = (collected.content ? merged.content : resumed.cleanContent || '').trim();
    merged.reasoning = (collected.reasoning || '') + (resumed.reasoning || '');
    merged.sources = [...(collected.sources || []), ...(resumed.sources || [])].filter(
      (source, index, list) => list.findIndex((item) => item && source && item.url === source.url) === index
    );
    merged.toolCalls = [...(collected.toolCalls || []), ...(resumed.toolCalls || [])];
    merged.toolResults = [...(collected.toolResults || []), ...(resumed.toolResults || [])];
    merged.images = [...(collected.images || []), ...(resumed.images || [])];
    merged.rawEvents = [...(collected.rawEvents || []), ...(resumed.rawEvents || [])];
    merged.continuations = [...(collected.continuations || []), ...(resumed.continuations || [])];
    merged.title = resumed.title || collected.title || null;
    merged.finishReason = resumed.finishReason || 'stop';
    merged.approvals = [
      ...(collected.approvals || []).filter((item) => item.approved !== null),
      ...approvalRecords,
      ...((resumed && resumed.approvals) || []).filter((item) => item.approved !== null)
    ];
    return merged;
  }

  async _consumeChatResponse(response, context) {
    const handlers = context.handlers || {};
    /** @type {Map<string, Record<string, any>>} */
    const sourceMap = new Map();
    const collected = {
      content: '',
      reasoning: '',
      reasoningEncrypted: false,
      images: [],
      toolCalls: [],
      toolResults: [],
      rawEvents: [],
      title: null,
      usage: null,
      errorEvent: null,
      refusal: false,
      refusalDetectedBy: null,
      limit: null,
      stopReason: null,
      quotaWindows: null,
      summaryRefreshHint: null,
      summaryInvalid: false,
      adWindow: null,
      conversationLimitPercent: null,
      continuations: [],
      approvals: [],
      skillReferences: [],
      imageValidatedTokens: [],
      imageTitle: null,
      imageError: null
    };
    let eventIndex = -1;

    const addSources = (list) => {
      // `list` is expected to be already normalized (see extractCitations / normalizeSources).
      for (const source of Array.isArray(list) ? list : []) {
        if (!source || !source.url) continue;
        const key = source.url;
        if (!sourceMap.has(key)) sourceMap.set(key, { ...source });
      }
    };

    const dispatch = (event, index) => {
      handlers.onEvent?.(event);
      switch (event.type) {
        case 'text':
          collected.content += event.text;
          handlers.onTextDelta?.(event.text);
          break;
        case 'reasoning':
          if (event.encrypted) collected.reasoningEncrypted = true;
          if (event.state === 'done') {
            // Never append the done-frame summaryText on top of streamed deltas; use it only as a
            // fallback when the upstream did not stream any plaintext reasoning at all.
            if (!collected.reasoning && typeof event.finalText === 'string' && event.finalText) {
              collected.reasoning = event.finalText;
              handlers.onReasoningDelta?.(event.finalText, 'done');
            } else {
              handlers.onReasoningDelta?.('', 'done');
            }
          } else if (event.text) {
            collected.reasoning += event.text;
            handlers.onReasoningDelta?.(event.text, event.state || null);
          } else {
            handlers.onReasoningDelta?.('', event.state || null);
          }
          break;
        case 'tool-call':
          if (this.strictProtocol && !event.callId) {
            throw new SSEProtocolError('tool-invocation call frame is missing toolCallId', {
              code: 'upstream_protocol_mismatch',
              eventIndex: index,
              snippet: redactSnippet(event.raw)
            });
          }
          collected.toolCalls.push({ name: event.name, callId: event.callId, args: event.args });
          handlers.onToolCall?.({ name: event.name, args: event.args, callId: event.callId });
          break;
        case 'tool-result': {
          if (this.strictProtocol && (!event.callId || (event.result === undefined && event.data === undefined))) {
            throw new SSEProtocolError('tool-invocation result frame is missing toolCallId/result', {
              code: 'upstream_protocol_mismatch',
              eventIndex: index,
              snippet: redactSnippet(event.raw)
            });
          }
          const name = event.name || this._findToolName(collected.toolCalls, event.callId);
          collected.toolResults.push({ name, callId: event.callId, result: event.result, data: event.data });
          const citations = extractCitations(event.data);
          if (citations.length) addSources(citations);
          handlers.onToolResult?.({ name, result: event.result, data: event.data, callId: event.callId });
          break;
        }
        case 'source':
          if (event.source && event.source.url) addSources(normalizeSources([event.source]));
          break;
        case 'ui-component':
          this._handleUiComponent(event, collected, handlers, index);
          break;
        case 'image':
          this._addImage(collected, handlers, {
            b64: event.b64,
            format: event.format,
            width: event.width,
            height: event.height,
            id: event.id,
            moderationToken: event.moderationToken
          });
          break;
        case 'image-partial':
          // Low quality preview frame: keep the last one for diagnostics only, never as output.
          collected.lastPartialImage = { b64Length: event.b64 ? event.b64.length : 0, format: event.format, id: event.id };
          handlers.onEvent?.({ ...event, type: 'image-partial' });
          break;
        case 'refusal':
          collected.refusal = true;
          collected.refusalDetectedBy = event.detectedBy || null;
          handlers.onRefusal?.({ detectedBy: event.detectedBy || null });
          break;
        case 'limit':
          collected.limit = event;
          handlers.onLimit?.({ code: event.code, scope: event.scope });
          break;
        case 'stop-reason':
          collected.stopReason = event.reason;
          handlers.onStopReason?.(event.reason);
          break;
        case 'quota':
          collected.quotaWindows = event.windows;
          handlers.onQuota?.(event.windows);
          break;
        case 'summary-refresh-hint':
          collected.summaryRefreshHint = event.hint;
          break;
        case 'summary-invalid':
          collected.summaryInvalid = true;
          break;
        case 'ad-window':
          collected.adWindow = event.payload;
          break;
        case 'conversation-limit-warning':
          collected.conversationLimitPercent = event.percent;
          handlers.onConversationLimitWarning?.(event.percent);
          break;
        case 'continuation':
          collected.approvals = collected.approvals || [];
          for (const action of Array.isArray(event.pendingActions) ? event.pendingActions : []) {
            if (action && action.kind === 'approval') {
              collected.approvals.push({
                toolName: action.toolName ? String(action.toolName) : null,
                purpose: action.purpose ? String(action.purpose) : null,
                approved: null
              });
            }
          }
          collected.continuations.push({
            action: event.action,
            token: event.token,
            pendingActions: event.pendingActions,
            replayPolicy: event.replayPolicy,
            consentDecisions: event.consentDecisions
          });
          handlers.onContinuation?.(event);
          break;
        case 'skill-references':
          collected.skillReferences.push(...event.skills);
          break;
        case 'image-validated':
          collected.imageValidatedTokens.push(...event.tokens);
          break;
        case 'title':
          collected.title = event.title;
          handlers.onTitle?.(event.title);
          break;
        case 'error':
          // Strict mode throws inside consumeSSE; non-strict only records it.
          collected.errorEvent = event;
          handlers.onError?.(
            new DuckError(event.message || 'upstream stream error', {
              status: mapUpstreamError(event.code, event.status).httpStatus,
              code: mapUpstreamError(event.code, event.status).code,
              type: event.code || 'upstream_error',
              retriable: mapUpstreamError(event.code, event.status).retriable
            })
          );
          break;
        default:
          break;
      }
      if (event.raw && event.raw.usage && typeof event.raw.usage === 'object' && !collected.usage) {
        collected.usage = event.raw.usage;
        handlers.onUsage?.(event.raw.usage);
      }
    };

    let sawDone = false;
    try {
      const consumed = await consumeSSE(response.body, {
        strict: this.strictProtocol,
        signal: context.signal,
        onEvent: (event, index) => {
          eventIndex = index;
          collected.rawEvents.push(event);
          if (event.type === 'done') sawDone = true;
          dispatch(event, index);
        }
      });
      sawDone = sawDone || consumed.sawDone;
      if (this.strictProtocol && !sawDone) {
        // v2.19: duck.ai may end the POST with a "continuation" frame (tool approval: web-search /
        // image-generation / user-location, or a resumable stream). The browser resubmits the chat
        // with the continuation token; without that we wrongly reported
        // "SSE stream ended without a [DONE] terminator" (502) — e.g. asking for the weather.
        const resumed = await this._resumeContinuation(collected, context, eventIndex, response);
        if (resumed) return resumed;
        throw new SSEProtocolError('SSE stream ended without a [DONE] terminator', {
          code: 'upstream_protocol_mismatch',
          eventIndex,
          snippet: 'missing [DONE]'
        });
      }
    } catch (error) {
      if (error instanceof SSEProtocolError) {
        this._abortUpstream(context, response, error.code);
        throw this._toProtocolDuckError(error, collected, context, eventIndex, sourceMap);
      }
      const mapped = this._mapFetchError(error, context);
      // Mid-stream network/abort errors keep whatever content was already produced.
      if (collected.content || collected.reasoning || collected.images.length) {
        mapped.partial = this._buildPartial(collected, context, { eventIndex, sourceMap });
      }
      throw mapped;
    }

    // Non-strict mode can surface error frames as events; treat them as failures too.
    if (collected.errorEvent) {
      throw this._toEventDuckError(collected.errorEvent, collected, context, eventIndex, sourceMap);
    }

    // `[LIMIT_*]` markers arrive on the `[DONE]` frame with HTTP 200: they are terminal quota errors.
    if (collected.limit) {
      const mapped = mapUpstreamError(collected.limit.code, 200);
      const error = new DuckError(`upstream quota marker: ${collected.limit.code}`, {
        status: mapped.httpStatus,
        code: mapped.code,
        type: mapped.code,
        retriable: mapped.retriable,
        eventIndex,
        upstreamType: collected.limit.code,
        detail: {
          reason: 'stream_limit_marker',
          scope: collected.limit.scope,
          // v2.32：limit 帧常带 [FIXED_COST_WINDOW_USAGE]，其中 resetAt 决定额度何时恢复
          windows: collected.quotaWindows || null
        }
      });
      // 保留顶层字段，供网关标记身份冷却
      error.fixedCostWindowUsage = collected.quotaWindows || null;
      error.limitScope = collected.limit.scope;
      error.partial = this._buildPartial(collected, context, { eventIndex, sourceMap });
      this._abortUpstream(context, response, collected.limit.code);
      throw error;
    }

    // `role:"refusal"` is how the model declines; browser raises ERR_REFUSAL at stream end.
    if (collected.refusal) {
      const mapped = mapUpstreamError('ERR_REFUSAL', 200);
      const error = new DuckError('the model declined to answer this request (refusal)', {
        status: mapped.httpStatus,
        code: mapped.code,
        type: 'content_filter',
        retriable: false,
        eventIndex,
        upstreamType: 'ERR_REFUSAL',
        detail: { reason: 'stream_refusal', detectedBy: collected.refusalDetectedBy }
      });
      error.partial = this._buildPartial(collected, context, { eventIndex, sourceMap });
      throw error;
    }

    // Image generation must end with at least one successful image.
    if (context.expectImage && !collected.images.length) {
      const error = new DuckError('image generation finished without a successful image', {
        status: 502,
        code: 'upstream_no_image',
        type: 'upstream_no_image',
        retriable: false,
        eventIndex,
        upstreamType: 'ERR_EMPTY_RESPONSE',
        detail: {
          reason: 'image_generation_no_success_image',
          imageTitle: collected.imageTitle,
          imageError: collected.imageError,
          eventCount: collected.rawEvents.length
        }
      });
      error.partial = this._buildPartial(collected, context, { eventIndex, sourceMap });
      throw error;
    }

    const sources = [...sourceMap.values()];
    if (sources.length) handlers.onSearchResults?.(sources);

    const citationIds = collectCitationIds(collected.content);
    const citations = citationIds
      .map((id) => sources.find((source) => String(source.id) === String(id)))
      .filter(Boolean);

    this._stats.success += 1;
    this._stats.consecutiveFailures = 0;

    const finishReason = collected.stopReason === 'max_tokens' ? 'length' : sawDone ? 'stop' : 'incomplete';

    return {
      content: collected.content,
      cleanContent: stripCitationMarkers(collected.content).trim(),
      markdown: citationsToMarkdown(collected.content, sources).trim(),
      reasoning: collected.reasoning,
      // Free/anonymous sessions may only deliver an encrypted reasoning blob (no plaintext).
      reasoningEncrypted: Boolean(collected.reasoningEncrypted),
      sources,
      citations,
      images: collected.images,
      toolCalls: collected.toolCalls,
      toolResults: collected.toolResults,
      finishReason,
      refusal: collected.refusal,
      stopReason: collected.stopReason,
      quotaWindows: collected.quotaWindows,
      summaryRefreshHint: collected.summaryRefreshHint,
      summaryInvalid: collected.summaryInvalid,
      adWindow: collected.adWindow,
      conversationLimitPercent: collected.conversationLimitPercent,
      continuations: collected.continuations,
      skillReferences: collected.skillReferences,
      imageValidatedTokens: collected.imageValidatedTokens,
      imageTitle: collected.imageTitle,
      rawEvents: collected.rawEvents,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      reasoningEffortRequested: context.requestedEffort,
      conversationId: context.conversationId ?? null,
      title: collected.title,
      usage: collected.usage
    };
  }

  /**
   * Build the partial-result payload attached to errors raised after some data was received,
   * so the API layer can stream an `error` event and finish without fabricating completion.
   * @param {Record<string, any>} collected
   * @param {Record<string, any>} context
   * @param {{ eventIndex?: number, sourceMap?: Map<string, any> }} [options]
   */
  _buildPartial(collected, context, options = {}) {
    const sources = options.sourceMap ? [...options.sourceMap.values()] : [];
    return {
      content: collected.content,
      cleanContent: stripCitationMarkers(collected.content).trim(),
      markdown: citationsToMarkdown(collected.content, sources).trim(),
      reasoning: collected.reasoning,
      sources,
      images: collected.images,
      toolCalls: collected.toolCalls,
      toolResults: collected.toolResults,
      finishReason: 'error',
      eventIndex: options.eventIndex ?? null,
      rawEventCount: collected.rawEvents.length,
      lastEvents: collected.rawEvents.slice(-5).map((event) => ({
        type: event.type,
        state: event.state || null,
        name: event.name || null,
        snippet: redactSnippet(event.raw || event)
      })),
      model: context.model,
      reasoningEffort: context.reasoningEffort
    };
  }

  /**
   * Convert a `SSEProtocolError` into a `DuckError` carrying `code`, `status`, `retriable`,
   * `eventIndex`, redacted `detail` and the `partial` result.
   */
  _toProtocolDuckError(error, collected, context, eventIndex, sourceMap) {
    const upstreamType = String(error.code || '');
    const isUpstreamErr = upstreamType.startsWith('ERR_');
    const mapped = mapUpstreamError(upstreamType, error.status);
    const code = isUpstreamErr ? mapped.code : upstreamType || 'upstream_protocol_mismatch';
    const status = isUpstreamErr ? mapped.httpStatus : error.status || 502;
    const retriable = error.retriable === undefined || error.retriable === null ? mapped.retriable : Boolean(error.retriable);
    const duckError = new DuckError(error.message, {
      status,
      code,
      // Keep `type` equal to the canonical code: api-core's fallback exposes `error.type` as the
      // OpenAI `error.code` for codes it does not classify explicitly.
      type: code,
      retriable,
      eventIndex: error.eventIndex ?? eventIndex,
      detail: {
        reason: isUpstreamErr ? 'upstream_error_frame' : 'strict_protocol_violation',
        message: error.message,
        upstreamType,
        eventIndex: error.eventIndex ?? eventIndex,
        snippet: error.snippet ? redactSnippet(error.snippet) : null
      },
      upstreamType: isUpstreamErr ? upstreamType : null
    });
    duckError.partial = this._buildPartial(collected, context, { eventIndex: error.eventIndex ?? eventIndex, sourceMap });
    return duckError;
  }

  /** Convert a non-strict `error` event into a `DuckError` (same shape as strict mode). */
  _toEventDuckError(event, collected, context, eventIndex, sourceMap) {
    const mapped = mapUpstreamError(event.code, event.status);
    const duckError = new DuckError(event.message || 'upstream error frame', {
      status: mapped.httpStatus,
      code: mapped.code,
      type: mapped.code,
      retriable: mapped.retriable,
      eventIndex,
      upstreamType: event.code || null,
      detail: { reason: 'upstream_error_frame', upstreamType: event.code || null, eventIndex }
    });
    duckError.partial = this._buildPartial(collected, context, { eventIndex, sourceMap });
    return duckError;
  }

  /** Push a success image (from `generated-image` role or `ui-component/generate-image`). */
  _addImage(collected, handlers, image) {
    if (image && typeof image.b64 === 'string' && image.b64) {
      image = { ...image, format: detectImageFormat(image.b64, normalizeFormat(image.format) || 'png') };
    }
    if (!image || typeof image.b64 !== 'string' || !image.b64.length) {
      throw new SSEProtocolError('image event is missing b64 image data', {
        code: 'upstream_no_image',
        eventIndex: null,
        snippet: 'missing b64Image'
      });
    }
    collected.images.push(image);
    handlers.onImage?.({ b64: image.b64, format: image.format, modelDisplayName: image.modelDisplayName });
  }

  /** Infer a tool name for a `tool-result` whose event omits `toolName` (upstream does). */
  _findToolName(toolCalls, callId) {
    if (!callId) return null;
    const match = toolCalls.find((call) => call.callId && String(call.callId) === String(callId));
    return match ? match.name : null;
  }

  /** Pull images out of `ui-component` events (`generate-image`). */
  _handleUiComponent(event, collected, handlers, eventIndex = null) {
    if (event.name !== 'generate-image') return;
    const data = event.data || {};
    if (event.state !== 'data') return;
    if (data.type === 'image-title') {
      collected.imageTitle = data.title;
      return;
    }
    if (data.type === 'image-partial') return; // preview only
    if (data.status === 'success') {
      if (typeof data.b64Image !== 'string' || !data.b64Image.length) {
        if (this.strictProtocol) {
          throw new SSEProtocolError('generate-image success frame is missing b64Image', {
            code: 'upstream_no_image',
            eventIndex,
            snippet: redactSnippet(data)
          });
        }
        collected.imageError = 'success_without_image';
        return;
      }
      this._addImage(collected, handlers, {
        b64: data.b64Image,
        format: data.format || 'jpeg',
        modelDisplayName: data.imageModelDisplayName,
        width: data.width,
        height: data.height
      });
      return;
    }
    if (data.status === 'error') {
      collected.imageError = data.error || data.message || 'image_generation_error';
    }
  }

  /** @param {string} modelId */
  _resolveModel(modelId) {
    const entry = findModel(modelId || '');
    return entry ? entry.model : modelId || this.defaultModel;
  }

  /** @param {string} configured */
  _resolveSystemMode(configured) {
    if (configured === 'system' || configured === 'developer' || configured === 'prefix') return configured;
    return this._systemModeResolved || 'system';
  }

  /** Combine caller abort signal, the per-attempt abort controller and the request timeout. */
  _composeSignal(externalSignal, controllerSignal) {
    const signals = [];
    if (externalSignal) signals.push(externalSignal);
    if (controllerSignal) signals.push(controllerSignal);
    if (this.timeoutMs > 0 && typeof AbortSignal.timeout === 'function') signals.push(AbortSignal.timeout(this.timeoutMs));
    if (!signals.length) return undefined;
    if (signals.length === 1) return signals[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
    return signals[0];
  }

  /** Map undici/stream/abort errors to `DuckError`. */
  _mapFetchError(error, context) {
    if (error instanceof DuckError) return error;
    if (error instanceof ChallengeError) return toDuckError(error);
    const name = (error && error.name) || '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      const timedOut = !context?.signal?.aborted;
      return new DuckError(timedOut ? 'upstream request timed out' : 'request aborted', {
        status: timedOut ? 504 : 499,
        type: timedOut ? 'timeout' : 'aborted',
        retriable: timedOut,
        cause: error
      });
    }
    const message = String((error && error.message) || error);
    const retriable = /terminated|socket|network|fetch failed|ECONN|EAI_AGAIN|other side closed/i.test(message);
    return new DuckError(`upstream stream error: ${message}`, {
      status: 502,
      type: 'network_error',
      retriable,
      cause: error
    });
  }

  /**
   * Is this error the anonymous-tier rejection of `durableStream` (400 ERR_BAD_REQUEST)?
   * @param {any} error
   */
  _isDurableStreamRejection(error) {
    if (!error) return false;
    const status = error.status ?? error.httpStatus;
    if (Number(status) !== 400) return false;
    const code = String(error.code || error.type || error.upstreamType || '').toLowerCase();
    return code === 'bad_request' || code === 'err_bad_request' || code === 'invalid_request' || error.status === 400;
  }

  /** Track error stats for `health()`. @param {unknown} error @param {Record<string, any>} [extra] */
  _noteError(error, extra = {}) {
    const duckError = toDuckError(error);
    const entry = {
      status: duckError.status,
      type: duckError.type,
      code: duckError.code || null,
      upstreamType: duckError.upstreamType || null,
      retriable: Boolean(duckError.retriable),
      transportStatus: duckError.transportStatus ?? null,
      message: redactSnippet(duckError.message),
      requestId: duckError.requestId || null,
      // Redacted snippets only: never persist raw frames / base64 / tokens in logs.
      body: duckError.body ? redactSnippet(duckError.body) : null,
      eventIndex: duckError.eventIndex ?? null,
      detail: duckError.detail !== undefined ? redactSnippet(duckError.detail) : null,
      partial: duckError.partial
        ? {
            contentLength: String(duckError.partial.content || '').length,
            reasoningLength: String(duckError.partial.reasoning || '').length,
            images: Array.isArray(duckError.partial.images) ? duckError.partial.images.length : 0,
            sources: Array.isArray(duckError.partial.sources) ? duckError.partial.sources.length : 0,
            eventIndex: duckError.partial.eventIndex ?? null,
            rawEventCount: duckError.partial.rawEventCount ?? 0
          }
        : null,
      at: Date.now(),
      challengeSource: this.challenge.stats().lastSolveSource,
      // v2.2: correlate upstream errors with the stable identity (drift debugging).
      identityFingerprint: this.identitySummary().fingerprint || null,
      identityJourneyId: this.identitySummary().journeyId || this.journeyId || null,
      // v2.3: which outbound path produced the error
      proxyMode: this.proxyManager && typeof this.proxyManager.getSummary === 'function' ? this.proxyManager.getSummary().mode : 'direct',
      ...extra
    };
    this._stats.failures += 1;
    this._stats.consecutiveFailures += 1;
    this._stats.lastError = entry;
    this._stats.lastErrorAt = entry.at;
    this._stats.recentErrors.push(entry);
    if (this._stats.recentErrors.length > 20) this._stats.recentErrors.shift();
  }
}

/**
 * Convenience factory for the v2.4 identity pool: build a DuckClient bound to an in-memory
 * identity record (no identity file needed).
 * @param {Record<string, any>} identityRecord
 * @param {Record<string, any>} [config]
 * @returns {DuckClient}
 */
export function createDuckClientForIdentity(identityRecord, config = {}) {
  return new DuckClient({ ...config, identityRecord });
}

export {
  DUCK_MODELS,
  DEFAULT_MODEL,
  MODEL_ALIASES,
  findModel,
  getApiModelCatalog,
  getModelCapabilities,
  ChallengeManager,
  ChallengeError,
  DEFAULT_USER_AGENT,
  DEFAULT_BASE_URL,
  SSEProtocolError,
  IdentityStore,
  IdentityError,
  MemoryIdentityStore,
  createIdentityStore,
  ProxyManager,
  ProxyError,
  createProxyManager
};

export default DuckClient;
