/**
 * duck.ai 上游请求严格契约校验（真实浏览器抓包基线）。
 *
 * 确保发往 POST /duckchat/v1/chat 的请求体和请求头：
 *   1. 不缺失任何必需字段（否则上游 400 或 continuation 判 incompatible）；
 *   2. 不多出任何未知/禁止字段（如 canUseWebSearch、canUploadFiles、style、aspectRatio、
 *      metadata.toolChoice.WebSearch、x-duckai-client-tools、续传带 durableStream/metadata 等）。
 */
export class DuckContractError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'DuckContractError';
    this.status = meta.status ?? 500;
    this.code = meta.code ?? 'upstream_request_contract_violation';
    this.type = meta.type ?? 'upstream_request_contract_violation';
    this.retriable = false;
    if (meta.detail !== undefined) this.detail = meta.detail;
  }
}

export const INITIAL_BODY_REQUIRED_KEYS = Object.freeze([
  'model',
  'messages',
  'canUseTools',
  'reasoningEffort',
  'canUseApproxLocation',
  'canDelegateImageGeneration',
  'canShowGreeting'
]);

export const INITIAL_BODY_ALLOWED_KEYS = new Set([
  ...INITIAL_BODY_REQUIRED_KEYS,
  'metadata',
  'durableStream'
]);

export const CONTINUATION_BODY_REQUIRED_KEYS = Object.freeze([
  ...INITIAL_BODY_REQUIRED_KEYS,
  'continuation',
  'currentAssistant'
]);

export const CONTINUATION_BODY_ALLOWED_KEYS = new Set([
  ...CONTINUATION_BODY_REQUIRED_KEYS
]);

export const REQUIRED_CHAT_HEADERS = Object.freeze([
  'user-agent',
  'accept',
  'accept-language',
  'content-type',
  'origin',
  'referer',
  'x-fe-version',
  'x-fe-signals',
  'x-vqd-hash-1',
  'x-duckai-response-id',
  'x-ddg-journey-id',
  'x-duckai-continuation',
  'x-duckai-tool-approval',
  'x-duckai-consent-purposes'
]);

export const ALLOWED_CHAT_HEADERS = new Set([
  ...REQUIRED_CHAT_HEADERS,
  'authorization'
]);

export const FORBIDDEN_CHAT_HEADERS = new Set([
  'x-duckai-client-tools'
]);

const ALLOWED_USER_PART_TYPES = new Set(['text', 'image', 'file']);
const ALLOWED_TOOL_CHOICE_KEYS = new Set(['GenerateImage']);

function validateUserMessage(msg, index, errors) {
  if (!Array.isArray(msg.content) || msg.content.length === 0) {
    errors.push(`messages[${index}].content must be a non-empty array`);
    return;
  }
  for (let pIdx = 0; pIdx < msg.content.length; pIdx += 1) {
    const part = msg.content[pIdx];
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      errors.push(`messages[${index}].content[${pIdx}] must be an object`);
      continue;
    }
    if (!ALLOWED_USER_PART_TYPES.has(part.type)) {
      errors.push(`messages[${index}].content[${pIdx}].type "${String(part.type)}" is not allowed`);
      continue;
    }
    if (part.type === 'text' && typeof part.text !== 'string') {
      errors.push(`messages[${index}].content[${pIdx}].text must be a string`);
    } else if (part.type === 'image') {
      if (typeof part.mimeType !== 'string' || !part.mimeType) {
        errors.push(`messages[${index}].content[${pIdx}].mimeType is required`);
      }
      if (typeof part.image !== 'string' || !part.image.startsWith('data:image/')) {
        errors.push(`messages[${index}].content[${pIdx}].image must be a data:image/* URI`);
      }
    } else if (part.type === 'file') {
      if (typeof part.content !== 'string' || !part.content) {
        errors.push(`messages[${index}].content[${pIdx}].content is required`);
      }
      if (part.encoding !== 'base64') {
        errors.push(`messages[${index}].content[${pIdx}].encoding must be "base64"`);
      }
      if (typeof part.mimeType !== 'string' || !part.mimeType) {
        errors.push(`messages[${index}].content[${pIdx}].mimeType is required`);
      }
      if (typeof part.filename !== 'string' || !part.filename) {
        errors.push(`messages[${index}].content[${pIdx}].filename is required`);
      }
    }
  }
}

function validateAssistantMessage(msg, index, errors) {
  if (typeof msg.content !== 'string') {
    errors.push(`messages[${index}].content must be a string (expected "" for assistant)`);
  }
  if (msg.parts === undefined) return;
  if (!Array.isArray(msg.parts)) {
    errors.push(`messages[${index}].parts must be an array`);
    return;
  }
  const genImageCount = msg.parts.filter((p) => p && p.type === 'generated-image').length;
  const genCallCount = msg.parts.filter(
    (p) => p && p.type === 'tool-invocation' && p.state === 'call' && p.toolName === 'GenerateImage'
  ).length;
  const genResultCount = msg.parts.filter(
    (p) => p && p.type === 'tool-invocation' && p.state === 'result'
  ).length;
  if (genImageCount > 0 && (genCallCount < genImageCount || genResultCount < genImageCount)) {
    errors.push(`messages[${index}].parts with generated-image must include matching GenerateImage call+result tool-invocation parts`);
  }
  for (let pIdx = 0; pIdx < msg.parts.length; pIdx += 1) {
    const part = msg.parts[pIdx];
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      errors.push(`messages[${index}].parts[${pIdx}] must be an object`);
      continue;
    }
    if (part.type === 'generated-image') {
      if (typeof part.id !== 'string' || !part.id) errors.push(`messages[${index}].parts[${pIdx}].id is required`);
      if (typeof part.result !== 'string' || !part.result) errors.push(`messages[${index}].parts[${pIdx}].result is required`);
      if (typeof part.format !== 'string' || !part.format) errors.push(`messages[${index}].parts[${pIdx}].format is required`);
      if (!(Number.isFinite(part.width) && part.width > 0)) errors.push(`messages[${index}].parts[${pIdx}].width must be > 0`);
      if (!(Number.isFinite(part.height) && part.height > 0)) errors.push(`messages[${index}].parts[${pIdx}].height must be > 0`);
    }
  }
}

/**
 * 校验 POST /duckchat/v1/chat 请求体是否严格符合真实 duck.ai 客户端协议。
 * @param {Record<string, any>} body
 * @param {{ isContinuation?: boolean, allowSystemMessages?: boolean }} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDuckChatBody(body, options = {}) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['body must be a plain JSON object'] };
  }
  const isContinuation = options.isContinuation ?? Boolean(body.continuation);
  const requiredKeys = isContinuation ? CONTINUATION_BODY_REQUIRED_KEYS : INITIAL_BODY_REQUIRED_KEYS;
  const allowedKeys = isContinuation ? CONTINUATION_BODY_ALLOWED_KEYS : INITIAL_BODY_ALLOWED_KEYS;

  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(body, key) || body[key] === undefined) {
      errors.push(`missing required body field "${key}"`);
    }
  }
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      errors.push(`unexpected/forbidden body field "${key}"${isContinuation ? ' (forbidden on continuation)' : ''}`);
    }
  }

  if (typeof body.model !== 'string' || !body.model) errors.push('body.model must be a non-empty string');
  if (body.canUseTools !== true) errors.push('body.canUseTools must be true');
  if (typeof body.reasoningEffort !== 'string') errors.push('body.reasoningEffort must be a string');
  if (body.canUseApproxLocation !== false && body.canUseApproxLocation !== null && body.canUseApproxLocation !== true) {
    errors.push('body.canUseApproxLocation must be false, null, or true');
  }
  if (body.canDelegateImageGeneration !== null && body.canDelegateImageGeneration !== true) {
    errors.push('body.canDelegateImageGeneration must be null or true');
  }
  if (body.canShowGreeting !== true) errors.push('body.canShowGreeting must be true');

  if (body.metadata !== undefined) {
    if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      errors.push('body.metadata must be an object');
    } else {
      for (const metaKey of Object.keys(body.metadata)) {
        if (metaKey !== 'toolChoice') errors.push(`unexpected body.metadata.${metaKey}`);
      }
      if (body.metadata.toolChoice !== undefined) {
        if (!body.metadata.toolChoice || typeof body.metadata.toolChoice !== 'object' || Array.isArray(body.metadata.toolChoice)) {
          errors.push('body.metadata.toolChoice must be an object');
        } else {
          for (const toolKey of Object.keys(body.metadata.toolChoice)) {
            if (!ALLOWED_TOOL_CHOICE_KEYS.has(toolKey)) {
              errors.push(`forbidden body.metadata.toolChoice.${toolKey}`);
            }
          }
        }
      }
    }
  }

  if (body.durableStream !== undefined) {
    const ds = body.durableStream;
    if (!ds || typeof ds !== 'object' || Array.isArray(ds)) {
      errors.push('body.durableStream must be an object');
    } else {
      if (typeof ds.messageId !== 'string' || !ds.messageId) errors.push('body.durableStream.messageId is required');
      if (typeof ds.conversationId !== 'string' || !ds.conversationId) errors.push('body.durableStream.conversationId is required');
      if (!ds.publicKey || typeof ds.publicKey !== 'object') errors.push('body.durableStream.publicKey is required');
    }
  }

  if (isContinuation) {
    const cont = body.continuation;
    if (!cont || typeof cont !== 'object' || Array.isArray(cont)) {
      errors.push('body.continuation must be an object');
    } else {
      if (typeof cont.token !== 'string' || !cont.token) errors.push('body.continuation.token is required');
      if (typeof cont.responseId !== 'string' || !cont.responseId) errors.push('body.continuation.responseId is required');
      if (!Array.isArray(cont.responses)) errors.push('body.continuation.responses must be an array');
    }
    const ca = body.currentAssistant;
    if (!ca || typeof ca !== 'object' || Array.isArray(ca)) {
      errors.push('body.currentAssistant must be an object');
    } else {
      if (ca.role !== 'assistant') errors.push('body.currentAssistant.role must be "assistant"');
      if (typeof ca.content !== 'string') errors.push('body.currentAssistant.content must be a string');
      if (!Array.isArray(ca.parts)) errors.push('body.currentAssistant.parts must be an array');
    }
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    errors.push('body.messages must be a non-empty array');
  } else {
    const allowSystem = options.allowSystemMessages === true;
    for (let i = 0; i < body.messages.length; i += 1) {
      const msg = body.messages[i];
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        errors.push(`messages[${i}] must be an object`);
        continue;
      }
      if (msg.role === 'user') {
        validateUserMessage(msg, i, errors);
      } else if (msg.role === 'assistant') {
        validateAssistantMessage(msg, i, errors);
      } else if (allowSystem && (msg.role === 'system' || msg.role === 'developer')) {
        if (!Array.isArray(msg.content) || msg.content.length === 0) {
          errors.push(`messages[${i}].content must be a non-empty array`);
        }
      } else {
        errors.push(`messages[${i}].role "${String(msg.role)}" is not allowed`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 校验 POST /duckchat/v1/chat 请求头是否严格符合真实 duck.ai 客户端协议。
 * @param {Record<string, any>} headers
 * @param {{ extraHeaderKeys?: string[] }} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDuckChatHeaders(headers, options = {}) {
  const errors = [];
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return { ok: false, errors: ['headers must be an object'] };
  }
  const extraSet = new Set((options.extraHeaderKeys || []).map((k) => String(k).toLowerCase()));
  const normalized = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = String(k).toLowerCase();
    normalized[lower] = v;
    if (FORBIDDEN_CHAT_HEADERS.has(lower)) {
      errors.push(`forbidden header "${lower}"`);
    } else if (!ALLOWED_CHAT_HEADERS.has(lower) && !extraSet.has(lower)) {
      errors.push(`unexpected header "${lower}"`);
    }
  }
  for (const reqKey of REQUIRED_CHAT_HEADERS) {
    const val = normalized[reqKey];
    if (typeof val !== 'string' || !val) {
      errors.push(`missing required header "${reqKey}"`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验失败立即抛出 DuckError，防止不符合契约的请求发往 duck.ai。
 */
export function assertDuckChatRequest(body, headers, options = {}) {
  const bodyCheck = validateDuckChatBody(body, options);
  const headerCheck = headers ? validateDuckChatHeaders(headers, options) : { ok: true, errors: [] };
  const errors = [...bodyCheck.errors, ...headerCheck.errors];
  if (errors.length === 0) return;
  const ErrorCtor = typeof options.ErrorCtor === 'function' ? options.ErrorCtor : DuckContractError;
  throw new ErrorCtor(`duck.ai request contract violation: ${errors.slice(0, 4).join('; ')}`, {
    status: 500,
    code: 'upstream_request_contract_violation',
    type: 'upstream_request_contract_violation',
    retriable: false,
    detail: { errors }
  });
}

export default {
  DuckContractError,
  INITIAL_BODY_REQUIRED_KEYS,
  INITIAL_BODY_ALLOWED_KEYS,
  CONTINUATION_BODY_REQUIRED_KEYS,
  CONTINUATION_BODY_ALLOWED_KEYS,
  REQUIRED_CHAT_HEADERS,
  ALLOWED_CHAT_HEADERS,
  FORBIDDEN_CHAT_HEADERS,
  validateDuckChatBody,
  validateDuckChatHeaders,
  assertDuckChatRequest
};
