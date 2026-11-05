/**
 * OpenAI-compatible error type + small shared helpers.
 *
 * Every handler throws `OpenAIError` (or lets a `DuckError` bubble up); the HTTP
 * layer converts them into OpenAI-style JSON bodies and records the request in
 * the store. Upstream (`DuckError`) details are mapped to HTTP statuses while
 * keeping the upstream message but never its stack / internal fields.
 */

import crypto from 'node:crypto';

export class OpenAIError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   status?: number, type?: string, code?: string|null, param?: string|null,
   *   headers?: Record<string,string>|null, hint?: string|null, detail?: unknown|null,
   *   cause?: unknown
   * }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'OpenAIError';
    this.status = Number.isInteger(options.status) ? options.status : 400;
    this.type = options.type || 'invalid_request_error';
    this.code = options.code ?? null;
    this.param = options.param ?? null;
    this.headers = options.headers || null;
    // v2.2/v2.5: human-readable hint + machine detail (also surfaced by errorPayload).
    this.hint = typeof options.hint === 'string' && options.hint ? options.hint : null;
    this.detail = options.detail !== undefined && options.detail !== null ? options.detail : null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function badRequest(message, param = null, code = null) {
  return new OpenAIError(message, { status: 400, type: 'invalid_request_error', code, param });
}

export function unauthorized(message = 'Missing or invalid API key', code = 'invalid_api_key', param = null) {
  return new OpenAIError(message, { status: 401, type: 'authentication_error', code, param });
}

/** 409 conflict (v2.1: retry target invalid / session busy). */
export function conflict(message, code = 'conflict', param = null) {
  return new OpenAIError(message, { status: 409, type: 'invalid_request_error', code, param });
}

/**
 * v2: paid duck.ai models are rejected locally unless `duck.allowPaidModels=true`.
 * @param {string} modelId
 */
export function modelRequiresSubscription(modelId) {
  return new OpenAIError(
    `Model ${modelId} requires a Duck.ai subscription (Plus/Pro) and is disabled on this gateway.`,
    {
      status: 403,
      type: 'model_unavailable',
      code: 'model_requires_subscription',
      param: 'model'
    }
  );
}

/** Gateway queue overflow/timeout → 429 with code + Retry-After. */
export function queueError(error) {
  const code = error.code === 'queue_timeout' ? 'queue_timeout' : 'queue_full';
  const converted = new OpenAIError(
    typeof error.message === 'string' && error.message ? error.message : 'Upstream queue is busy; retry later',
    {
      status: 429,
      type: 'rate_limit_error',
      code,
      cause: error
    }
  );
  const retryAfter = Math.max(1, Math.trunc(Number(error.retryAfter) || 1));
  converted.headers = {
    'Retry-After': String(retryAfter),
    'X-Duckai-Queue': code
  };
  return converted;
}

export function forbidden(message = 'Forbidden', code = 'forbidden') {
  return new OpenAIError(message, { status: 403, type: 'permission_error', code });
}

export function notFound(message = 'Not found', code = 'not_found') {
  return new OpenAIError(message, { status: 404, type: 'invalid_request_error', code });
}

export function methodNotAllowed(method, allow = 'GET') {
  return new OpenAIError(`Method ${method} not allowed`, {
    status: 405,
    type: 'invalid_request_error',
    code: 'method_not_allowed',
    headers: { Allow: allow }
  });
}

export function payloadTooLarge(message = 'Request body too large') {
  return new OpenAIError(message, { status: 413, type: 'invalid_request_error', code: 'payload_too_large' });
}

export function rateLimited(message = 'Rate limited by upstream', retryAfter = undefined) {
  const error = new OpenAIError(message, {
    status: 429,
    type: 'rate_limit_exceeded',
    code: 'rate_limit_exceeded'
  });
  if (Number.isFinite(Number(retryAfter)) && Number(retryAfter) > 0) {
    error.headers = { 'Retry-After': String(retryAfter) };
  }
  return error;
}

export function serverError(message = 'Internal server error', cause = undefined) {
  return new OpenAIError(message, { status: 500, type: 'server_error', code: 'internal_error', cause });
}

export function isOpenAIError(error) {
  return error instanceof OpenAIError || Boolean(error && error.name === 'OpenAIError');
}

export function isAbortError(error) {
  if (!error) return false;
  return error.name === 'AbortError' || error.name === 'AbortSignal' || error.code === 'ABORT_ERR';
}

export function isDuckError(error) {
  if (!error) return false;
  return error.name === 'DuckError' || (typeof error.status === 'number' && typeof error.type === 'string' && 'retriable' in error);
}

export function isQueueError(error) {
  return Boolean(
    error &&
      (error.name === 'QueueError' || error.code === 'queue_full' || error.code === 'queue_timeout') &&
      typeof error.status === 'number'
  );
}

/** v2.4: identity pool errors (duck-protocol PoolError / queue errors). */
export function isPoolError(error) {
  if (!error) return false;
  if (error.name === 'PoolError' || error.name === 'IdentityPoolError') return true;
  return (
    typeof error.code === 'string' &&
    [
      'identity_not_found',
      'identity_in_use',
      'identity_limit_reached',
      'pool_full',
      'invalid_identity',
      'model_requires_subscription',
      'identity_unavailable',
      'no_identity_available',
      'identity_pool_unavailable',
      'queue_full',
      'queue_timeout'
    ].includes(error.code) &&
    typeof error.status === 'number'
  );
}

/**
 * v2 strict upstream error codes → gateway HTTP error mapping.
 * Codes are matched case-insensitively; the output `code` is canonical.
 */
const DUCK_CODE_MAP = Object.freeze({
  upstream_protocol_mismatch: { status: 502, type: 'upstream_error', code: 'upstream_protocol_mismatch' },
  protocol_mismatch: { status: 502, type: 'upstream_error', code: 'upstream_protocol_mismatch' },
  upstream_no_image: { status: 502, type: 'upstream_error', code: 'upstream_no_image' },
  no_image: { status: 502, type: 'upstream_error', code: 'upstream_no_image' },
  content_filter: { status: 403, type: 'content_filter', code: 'content_filter' },
  err_refusal: { status: 403, type: 'content_filter', code: 'content_filter' },
  err_moderation: { status: 403, type: 'content_filter', code: 'content_filter' },
  refusal: { status: 403, type: 'content_filter', code: 'content_filter' },
  moderation: { status: 403, type: 'content_filter', code: 'content_filter' },
  upstream_anomaly_check: { status: 429, type: 'rate_limit_error', code: 'upstream_anomaly_check' },
  err_anomaly: { status: 429, type: 'rate_limit_error', code: 'upstream_anomaly_check' },
  anomaly_check: { status: 429, type: 'rate_limit_error', code: 'upstream_anomaly_check' },
  err_account_limit: { status: 403, type: 'permission_error', code: 'upstream_subscription_required' },
  upstream_subscription_required: { status: 403, type: 'permission_error', code: 'upstream_subscription_required' },
  err_rate_limit: { status: 429, type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' },
  upstream_rate_limited: { status: 429, type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' },
  // v2.4 context limits (docs/IDENTITY-POOL.md §7)
  conversation_limit_reached: { status: 409, type: 'invalid_request_error', code: 'conversation_limit_reached' },
  err_conversation_limit: { status: 409, type: 'invalid_request_error', code: 'conversation_limit_reached' },
  limit_conversation: { status: 409, type: 'invalid_request_error', code: 'conversation_limit_reached' },
  err_limit_conversation: { status: 409, type: 'invalid_request_error', code: 'conversation_limit_reached' },
  input_limit_reached: { status: 413, type: 'invalid_request_error', code: 'input_limit_reached' },
  err_input_limit: { status: 413, type: 'invalid_request_error', code: 'input_limit_reached' },
  // v2.20: upstream returns 429/ERR_INPUT_LIMIT-like for oversized single input; expose it as
  // OpenAI-style 413 context_length_exceeded instead of a generic 502 upstream_error.
  context_length_exceeded: { status: 413, type: 'invalid_request_error', code: 'context_length_exceeded' },
  // v2.4 identity pool routing
  model_requires_subscription: { status: 403, type: 'model_unavailable', code: 'model_requires_subscription' },
  no_identity_available: { status: 503, type: 'identity_unavailable', code: 'no_identity_available' },
  identity_unavailable: { status: 503, type: 'identity_unavailable', code: 'identity_unavailable' },
  identity_not_found: { status: 404, type: 'invalid_request_error', code: 'identity_not_found' },
  identity_in_use: { status: 409, type: 'invalid_request_error', code: 'identity_in_use' },
  identity_limit_reached: { status: 400, type: 'invalid_request_error', code: 'identity_limit_reached' },
  pool_full: { status: 409, type: 'invalid_request_error', code: 'pool_full' },
  identity_pool_unavailable: { status: 503, type: 'identity_pool_unavailable', code: 'identity_pool_unavailable' }
});

function classifyDuckError(error) {
  const rawCode =
    (typeof error.code === 'string' && error.code) ||
    (typeof error.type === 'string' && error.type) ||
    '';
  const key = rawCode.trim().toLowerCase();
  const mapped = DUCK_CODE_MAP[key];
  if (mapped) {
    // Anomaly checks can be 403 when the upstream explicitly says so.
    if (mapped.code === 'upstream_anomaly_check' && Number(error.status) === 403) {
      return { ...mapped, status: 403, type: 'permission_error' };
    }
    return mapped;
  }
  return null;
}

/** Map an upstream DuckError HTTP status to a gateway-facing status. */
function mapUpstreamStatus(status) {
  const value = Number(status);
  if (value === 401) return 401;
  if (value === 403) return 403;
  if (value === 408) return 504;
  if (value === 429) return 429;
  // Everything else upstream (incl. 400/418 challenge) becomes a bad gateway.
  return 502;
}

function upstreamErrorType(status) {
  switch (status) {
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 429:
      return 'rate_limit_exceeded';
    case 504:
      return 'upstream_timeout';
    default:
      return 'upstream_error';
  }
}

/** Normalize a retryAfter value (seconds or milliseconds) to whole seconds. */
function normalizeRetryAfter(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  // Upstream clients generally report milliseconds; HTTP Retry-After is seconds.
  return number > 600 ? Math.ceil(number / 1000) : Math.ceil(number);
}

/**
 * Convert any thrown value into an OpenAIError with a safe public message.
 * Never leaks stacks or internal object fields.
 */
export function toOpenAIError(error) {
  if (isOpenAIError(error)) return error;

  if (isQueueError(error)) {
    return queueError(error);
  }

  if (isPoolError(error)) {
    const classified = DUCK_CODE_MAP[String(error.code || '').toLowerCase()];
    const status = classified ? classified.status : error.status;
    const converted = new OpenAIError(
      typeof error.message === 'string' && error.message.trim() ? error.message.trim() : 'Identity pool request failed',
      {
        status,
        type: classified ? classified.type : status >= 500 ? 'identity_unavailable' : 'invalid_request_error',
        code: classified ? classified.code : error.code || 'identity_pool_error',
        hint: typeof error.hint === 'string' ? error.hint : null,
        detail: error.detail !== undefined ? error.detail : null,
        cause: error
      }
    );
    if (error.status === 429 && Number.isFinite(Number(error.retryAfter ?? error.retryAfterMs))) {
      converted.headers = { 'Retry-After': String(normalizeRetryAfter(error.retryAfter ?? error.retryAfterMs) || 1) };
    }
    return converted;
  }

  if (isDuckError(error)) {
    const classified = classifyDuckError(error);
    const status = classified ? classified.status : mapUpstreamStatus(error.status);
    const message =
      typeof error.message === 'string' && error.message.trim()
        ? error.message.trim()
        : 'Upstream request to duck.ai failed';
    const code = classified ? classified.code : typeof error.type === 'string' && error.type ? error.type : 'upstream_error';
    const converted = new OpenAIError(message, {
      status,
      type: classified ? classified.type : upstreamErrorType(status),
      code,
      hint: typeof error.hint === 'string' ? error.hint : null,
      detail: error.detail !== undefined ? error.detail : null,
      cause: error
    });
    const headers = {};
    if (error.retriable === true) headers['X-Duckai-Retriable'] = 'true';
    const retryAfter = normalizeRetryAfter(
      error.retryAfter ?? error.retry_after ?? error.retryAfterMs ?? error.headers?.['retry-after']
    );
    if (retryAfter) headers['Retry-After'] = String(retryAfter);
    if (Number.isFinite(Number(error.retryAt))) headers['X-Duckai-Retry-At'] = String(Math.trunc(Number(error.retryAt)));
    if (Object.keys(headers).length > 0) converted.headers = headers;
    // v2.44：上游协议错误（尤其 400）在日志里保留 redact 后的响应体，便于排查
    converted.errorDetail = {
      upstreamType: typeof error.upstreamType === 'string' ? error.upstreamType : null,
      transportStatus: Number.isInteger(error.transportStatus) ? error.transportStatus : null,
      upstreamBody: typeof error.body === 'string' ? error.body : null
    };
    return converted;
  }

  if (isAbortError(error)) {
    return new OpenAIError('Request aborted by client', { status: 499, type: 'aborted', code: 'client_closed_request', cause: error });
  }

  // Errors carrying an HTTP-ish status (config validation, etc.).
  if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 600) {
    return new OpenAIError(typeof error.message === 'string' && error.message ? error.message : 'Request failed', {
      status: error.status,
      type: error.status >= 500 ? 'server_error' : 'invalid_request_error',
      code: typeof error.code === 'string' ? error.code : null,
      headers: error.headers || null,
      hint: typeof error.hint === 'string' ? error.hint : null,
      detail: error.detail !== undefined ? error.detail : typeof error.detail === 'string' ? error.detail : null,
      cause: error
    });
  }

  if (error instanceof SyntaxError) {
    return new OpenAIError(`Invalid JSON in request body: ${error.message}`, {
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_json',
      cause: error
    });
  }

  return serverError('Internal server error', error);
}

/** `{ error: { message, type, code, param } }` payload for a JSON response. */
export function errorPayload(error) {
  const normalized = toOpenAIError(error);
  return {
    error: {
      message: normalized.message,
      type: normalized.type,
      code: normalized.code ?? null,
      param: normalized.param ?? null,
      ...(typeof normalized.hint === 'string' && normalized.hint ? { hint: normalized.hint } : {}),
      ...(typeof normalized.detail === 'string' && normalized.detail ? { detail: normalized.detail } : {}),
      ...(Number.isFinite(Number(normalized.retryAfterMs)) ? { retryAfterMs: Number(normalized.retryAfterMs) } : {}),
      ...(typeof normalized.identityId === 'string' && normalized.identityId ? { identityId: normalized.identityId } : {}),
      ...(typeof normalized.deviceName === 'string' && normalized.deviceName ? { deviceName: normalized.deviceName } : {}),
      // v2.27：删除绑定了订阅的身份时的诊断字段
      ...(typeof normalized.subscriptionId === 'string' && normalized.subscriptionId
        ? { subscriptionId: normalized.subscriptionId }
        : {}),
      ...(typeof normalized.subscriptionTier === 'string' && normalized.subscriptionTier
        ? { subscriptionTier: normalized.subscriptionTier }
        : {}),
      ...(typeof normalized.subscriptionLabel === 'string' && normalized.subscriptionLabel
        ? { subscriptionLabel: normalized.subscriptionLabel }
        : {})
    }
  };
}

/* ------------------------------------------------------------------ */
/* Misc helpers shared by the OpenAI handlers                          */
/* ------------------------------------------------------------------ */

export function genId(prefix, bytes = 12) {
  return `${prefix}${crypto.randomBytes(bytes).toString('hex')}`;
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** ~4 characters per token, per the task's estimation rule. */
export function estimateTokensFromChars(chars) {
  const value = Number(chars);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.ceil(value / 4));
}

export function estimateTokensFromText(text) {
  return estimateTokensFromChars(typeof text === 'string' ? text.length : 0);
}

/**
 * Build an OpenAI-style usage object from character counts.
 * `estimated: true` + `estimation: 'chars/4'` make the approximation explicit.
 */
export function buildEstimatedUsage({
  promptChars = 0,
  completionChars = 0,
  reasoningChars = 0,
  promptTokens = null,
  completionTokens = null,
  upstreamUsage = null
} = {}) {
  const prompt_tokens = Number.isFinite(Number(promptTokens))
    ? Math.max(0, Math.trunc(Number(promptTokens)))
    : estimateTokensFromChars(promptChars);
  const completion_tokens = Number.isFinite(Number(completionTokens))
    ? Math.max(0, Math.trunc(Number(completionTokens)))
    : estimateTokensFromChars(completionChars + reasoningChars);
  const usage = {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    estimated: true,
    estimation: Number.isFinite(Number(promptTokens)) ? 'tokenizer' : 'chars/4'
  };
  if (upstreamUsage && (Number.isFinite(upstreamUsage.inputTokens) || Number.isFinite(upstreamUsage.outputTokens))) {
    usage.upstream = {
      input_tokens: Number.isFinite(upstreamUsage.inputTokens) ? upstreamUsage.inputTokens : null,
      output_tokens: Number.isFinite(upstreamUsage.outputTokens) ? upstreamUsage.outputTokens : null
    };
  }
  return usage;
}

export function normalizeFinishReason(reason) {
  const value = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  switch (value) {
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'tool_calls':
    case 'tool_call':
    case 'tool-calls':
      return 'tool_calls';
    case 'stop':
    case 'end_turn':
    case 'complete':
    case 'completed':
    case '':
      return 'stop';
    default:
      return 'stop';
  }
}
