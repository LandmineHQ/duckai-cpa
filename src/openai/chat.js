/**
 * POST /v1/chat/completions — OpenAI Chat Completions compatible handler.
 *
 * Responsibilities:
 *   - message normalization (string / typed parts, system+developer merging)
 *   - model + reasoning_effort resolution against the duck.ai catalog
 *   - tools mapping: web_search → webSearch, image_generation → imageGeneration
 *   - streaming (OpenAI chunk format, reasoning_content deltas) and non-streaming
 *   - citation marker cleanup + url_citation annotations / sources extension
 *   - estimated usage (4 chars ≈ 1 token)
 */

import crypto from 'node:crypto';
import { resolveConfiguredPrompt } from '../duck/prompt.js';
import {
  resolveModel,
  resolveReasoningEffort,
  parseTools,
  modelSupportsTool,
  getModelToolPolicy
} from './models.js';
import {
  badRequest,
  conflict,
  OpenAIError,
  buildEstimatedUsage,
  genId,
  normalizeFinishReason,
  nowSec,
  toOpenAIError,
  errorPayload
} from './errors.js';

import { guardConversation } from './context-guard.js';
import { detectImageFormat, normalizeFormat, imageDataUri, imageMimeType } from '../duck/image-format.js';
import {
  buildToolProtocol,
  formatToolCallsForHistory,
  formatToolResult,
  normalizeToolDefinitions,
  parseToolCalls,
  stripToolCallText
} from './tool-protocol.js';
import { countMessagesTokens, countTextTokens } from './tokens.js';
import { spillMessagesToPdf } from './context-spill.js';
import {
  buildCompactedSystemPrompt,
  evaluateCompactionTrigger,
  getCompactConfig,
  splitForCompact,
  summarizeConversation
} from './compact.js';

const MAX_SOURCES = 50;

/* ------------------------------------------------------------------ */
/* Citation handling                                                   */
/* ------------------------------------------------------------------ */

const COMPLETE_CITATION_RE = /<citation\b[^>]*?src\s*=\s*["']?([^"'\s>]+)["']?[^>]*>\s*<\/citation>/gi;
const EMPTY_CITATION_RE = /<citation\b[^>]*>\s*<\/citation>/gi;
const LOOSE_CITATION_TAG_RE = /<\/?citation\b[^>]*>/gi;

/** Replace `<citation src="N"></citation>` markers in a complete text. */
export function cleanCitationText(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(COMPLETE_CITATION_RE, (_match, src) => (src ? `[${src}]` : ''))
    .replace(EMPTY_CITATION_RE, '')
    .replace(LOOSE_CITATION_TAG_RE, '');
}

const CITATION_PREFIX = '<citation';

/**
 * Streaming-safe citation filter. Text deltas may split the marker anywhere, so
 * a trailing fragment that could be the beginning of a marker is held back until
 * the next delta (or flushed at end of stream).
 */
export function createCitationFilter() {
  let pending = '';

  function findHold(text) {
    let searchFrom = 0;
    for (;;) {
      const openIndex = text.indexOf(CITATION_PREFIX, searchFrom);
      if (openIndex === -1) break;
      const closeIndex = text.indexOf('</citation>', openIndex);
      if (closeIndex === -1) return text.length - openIndex;
      searchFrom = closeIndex + '</citation>'.length;
    }
    for (let len = CITATION_PREFIX.length - 1; len > 0; len -= 1) {
      if (text.endsWith(CITATION_PREFIX.slice(0, len))) return len;
    }
    return 0;
  }

  return {
    process(delta, { flush = false } = {}) {
      if (typeof delta === 'string' && delta) pending += delta;
      if (!pending) return '';
      if (flush) {
        const flushed = cleanCitationText(pending);
        pending = '';
        return flushed;
      }
      let cleaned = pending.replace(COMPLETE_CITATION_RE, (_match, src) => (src ? `[${src}]` : ''));
      cleaned = cleaned.replace(EMPTY_CITATION_RE, '');
      const hold = findHold(cleaned);
      if (hold > 0) {
        const out = cleaned.slice(0, cleaned.length - hold);
        pending = cleaned.slice(cleaned.length - hold);
        return out;
      }
      pending = '';
      return cleaned;
    }
  };
}

/* ------------------------------------------------------------------ */
/* Content / message normalization                                     */
/* ------------------------------------------------------------------ */

const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text']);

/**
 * Normalize message content to plain text.
 * Accepts a string or an array of parts; non-text parts (images/files) are
 * ignored because the duck.ai text chat is the only upstream capability.
 */
export function normalizeContent(content) {
  return normalizeContentParts(content).text;
}

/**
 * v2.44：文本 + 图片 part 一起归一化（图片用于上游多模态输入 / 生图回放）。
 * 仅接受 data:image/*；远程 URL 不在这里下载（避免 SSRF/额外网络）。
 * @returns {{ text: string, images: Array<{mimeType:string,dataUrl:string}> }}
 */
export function normalizeContentParts(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (content == null) return { text: '', images: [] };
  if (typeof content === 'number' || typeof content === 'boolean') return { text: String(content), images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const parts = [];
  const images = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const type = typeof part.type === 'string' ? part.type.toLowerCase() : '';
    if (TEXT_PART_TYPES.has(type)) {
      const text = typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : '';
      if (text) parts.push(text);
      continue;
    }
    if (type === 'image_url' || type === 'input_image' || type === 'image') {
      const image = normalizeImagePart(part);
      if (image) images.push(image);
    }
  }
  return { text: parts.join('\n'), images };
}

/** @returns {{mimeType:string,dataUrl:string}|null} */
export function normalizeImagePart(part) {
  if (!part || typeof part !== 'object') return null;
  let raw = '';
  if (typeof part.image_url === 'string') raw = part.image_url;
  else if (part.image_url && typeof part.image_url === 'object' && typeof part.image_url.url === 'string') raw = part.image_url.url;
  else if (typeof part.image === 'string') raw = part.image;
  else if (typeof part.url === 'string') raw = part.url;
  raw = raw.trim();
  if (!raw.startsWith('data:image/')) return null;
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
  if (!match) return null;
  return { mimeType: match[1], dataUrl: raw };
}

/**
 * Normalize OpenAI chat `messages` into system parts + a user/assistant history.
 * @returns {{systemParts: string[], conversation: Array<{role:string,content:string}>, promptChars: number}}
 */
export function normalizeChatMessages(rawMessages, { allowEmptyUser = false } = {}) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw badRequest('"messages" must be a non-empty array', 'messages', 'messages_required');
  }

  const systemParts = [];
  const conversation = [];
  let userMessages = 0;

  rawMessages.forEach((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw badRequest(`messages[${index}] must be an object`, 'messages');
    }
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    const normalized = normalizeContentParts(message.content);
    const content = normalized.text;
    const images = normalized.images;
    if (role === 'system' || role === 'developer') {
      if (content.trim()) systemParts.push(content);
      return;
    }
    if (role === 'user') {
      userMessages += 1;
      conversation.push({ role: 'user', content, ...(images.length ? { images } : {}) });
      return;
    }
    if (role === 'assistant') {
      // v2.44：客户端回放 tool_calls 时编码成文本（duck.ai 没有 tool role）
      const toolText = formatToolCallsForHistory(message.tool_calls);
      const merged = [content, toolText].filter(Boolean).join('\n');
      conversation.push({ role: 'assistant', content: merged, ...(images.length ? { images } : {}) });
      return;
    }
    if (role === 'tool' || role === 'function') {
      // v2.44：客户端执行完工具后回传 role:"tool" → 编码为上游可读 user 文本
      const name = typeof message.name === 'string' ? message.name : '';
      conversation.push({
        role: 'user',
        content: formatToolResult({ name, result: message.content })
      });
      return;
    }
    throw badRequest(`messages[${index}].role "${role || '(missing)'}" is not supported`, 'messages');
  });

  const hasUserText = conversation.some((message) => message.role === 'user' && message.content.trim());
  if (!allowEmptyUser && (userMessages === 0 || !hasUserText)) {
    throw badRequest('messages must contain at least one non-empty user message', 'messages');
  }

  const promptChars =
    systemParts.reduce((sum, part) => sum + part.length, 0) +
    conversation.reduce((sum, message) => sum + message.content.length, 0);

  return { systemParts, conversation, promptChars };
}

/** Combine configured prompt (duck.ai generator / custom / none) + per-model prompt + request system parts. */
export function composeSystemPrompt(config, resolvedModel, parts = []) {
  const collected = [];
  const defaults = config?.prompts?.defaults;
  const gatewayPrompt = resolveConfiguredPrompt(config);
  if (typeof gatewayPrompt === 'string' && gatewayPrompt.trim()) collected.push(gatewayPrompt.trim());
  if (defaults && typeof defaults === 'object') {
    const perModel = defaults[resolvedModel.id] ?? defaults[resolvedModel.requested];
    if (typeof perModel === 'string' && perModel.trim()) collected.push(perModel.trim());
  }
  for (const part of parts) {
    if (typeof part === 'string' && part.trim()) collected.push(part.trim());
  }
  return collected.join('\n\n');
}

/**
 * Build the DuckClient message list. `prompts.mode === 'inline'` is the fallback
 * for upstream deployments that reject the `system` role: instructions are
 * prepended to the first user message instead.
 */
export function buildDuckMessages({ systemPrompt = '', conversation = [], promptMode = 'system' } = {}) {
  const messages = [];
  const history = conversation.map((message) => ({
    role: message.role,
    content: message.content,
    ...(Array.isArray(message.images) && message.images.length ? { images: message.images } : {}),
    ...(Array.isArray(message.files) && message.files.length ? { files: message.files } : {})
  }));
  if (systemPrompt && systemPrompt.trim()) {
    if (promptMode === 'inline') {
      const firstUser = history.findIndex((message) => message.role === 'user');
      if (firstUser === -1) {
        history.unshift({ role: 'user', content: `[系统指令] ${systemPrompt}` });
      } else {
        history[firstUser] = {
          ...history[firstUser],
          role: 'user',
          content: `[系统指令] ${systemPrompt}\n\n[用户] ${history[firstUser].content}`
        };
      }
    } else {
      messages.push({ role: 'system', content: systemPrompt });
    }
  }
  messages.push(...history);
  return messages;
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/**
 * v2.45：把客户端工具协议附加到“第一条 user 消息”（稳定前缀）。
 *
 * 为什么不是最后一条：协议若只加在当轮最后一条 user 上，下一轮该消息变成历史时协议会消失，
 * 上游看到的历史文本发生变化 → 前缀缓存（duck.ai 的 prompt cache）失效。
 * 固定在第一条 user 上，只要工具列表不变，每次请求的历史前缀逐字节一致。
 * @param {Array<{role:string, content:string}>} messages
 * @param {string} protocol
 */
export function injectProtocolIntoFirstUser(messages, protocol) {
  if (!Array.isArray(messages) || !protocol) return messages;
  const firstUserIndex = messages.findIndex((message) => message && message.role === 'user');
  if (firstUserIndex < 0) return messages;
  return messages.map((message, index) =>
    index === firstUserIndex
      ? { ...message, content: `${message.content}\n\n${protocol}` }
      : message
  );
}

/**
 * Resolve capability flags from the request (`tools` array + `web_search` /
 * `image_generation` shortcuts) and validate them against config + model.
 */
export function resolveToolFlags(config, model, body = {}, gatewayToolPolicy = null) {
  const policy = gatewayToolPolicy || getModelToolPolicy(config);
  // v2.23：dropUnsupported 默认 true（静默清理）；false 时才报错
  const strict = policy.dropUnsupported === false;
  const parsed = parseTools(config, body.tools);
  const requestedWebSearch = parsed.webSearch || body.web_search === true || body.webSearch === true;
  const requestedImage = parsed.imageGeneration || body.image_generation === true || body.imageGeneration === true;

  // v2.22：每模型工具开关（只能关闭上游支持的 tool）
  const perModel = policy.perModel?.[model?.id] && typeof policy.perModel[model.id] === 'object' ? policy.perModel[model.id] : {};
  const dropped = [];
  const decide = (tool, requested) => {
    if (!requested) return false;
    if (!modelSupportsTool(model, tool)) {
      dropped.push({ tool, reason: 'model_not_supported' });
      return false;
    }
    if (perModel[tool] === false) {
      dropped.push({ tool, reason: 'admin_disabled' });
      return false;
    }
    if (config?.tools?.[tool === 'web_search' ? 'webSearch' : 'imageGeneration'] === false) {
      dropped.push({ tool, reason: 'server_disabled' });
      return false;
    }
    return true;
  };
  const webSearch = decide('web_search', requestedWebSearch);
  const imageGeneration = decide('image_generation', requestedImage);
  for (const type of parsed.unsupported) {
    dropped.push({ tool: type, reason: 'unsupported_type' });
  }

  if (strict && dropped.length) {
    const first = dropped[0];
    const messages = {
      unsupported_type: `Unsupported tool type(s): ${dropped
        .filter((item) => item.reason === 'unsupported_type')
        .map((item) => item.tool)
        .join(', ')}. Only "web_search" and "image_generation" are supported.`,
      model_not_supported: `Model "${model?.id}" does not support ${first.tool}`,
      admin_disabled: `${first.tool} is disabled for model "${model?.id}" in model configuration`,
      server_disabled: `${first.tool} is disabled in server configuration`
    };
    const codes = {
      unsupported_type: 'unsupported_tool',
      model_not_supported: 'tool_not_supported',
      admin_disabled: 'tool_not_supported',
      server_disabled: 'tool_disabled'
    };
    throw badRequest(messages[first.reason], 'tools', codes[first.reason]);
  }
  // v2.39：function tools 由网关处理，不受上游 modelSupportsTool 限制
  return { webSearch, imageGeneration, dropped };
}

/* ------------------------------------------------------------------ */
/* Usage tracking (v2.24)                                              */
/* ------------------------------------------------------------------ */

/** 把本次请求的 token 用量挂到 ctx.log，供 store 在写日志时累计。 */
export function recordUsageOnLog(ctx, usage) {
  if (!ctx || !usage || typeof usage !== 'object') return;
  const prompt = Math.max(0, Math.trunc(Number(usage.prompt_tokens) || 0));
  const completion = Math.max(0, Math.trunc(Number(usage.completion_tokens) || 0));
  const total = Math.max(0, Math.trunc(Number(usage.total_tokens) || prompt + completion));
  if (!total) return;
  ctx.log.tokens = { prompt, completion, total, estimated: usage.estimated !== false };
}

/**
 * v2.31：把本次对话写入「会话历史」（SQLite，只读）。
 * 记录：身份 + sessionKey + 模型 + system 提示词 + 本轮消息（用户 + 助手）。
 */
export function recordHistoryOnLog(
  ctx,
  { messages = [], assistantText = '', model = null, images = [], toolCalls = [], reasoning = '', sources = [] } = {}
) {
  try {
    const record = ctx?.history?.record;
    if (typeof record !== 'function') return;
    const normalized = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      if (!message || !message.role) continue;
      let content = '';
      if (typeof message.content === 'string') content = message.content;
      else if (Array.isArray(message.content)) {
        content = message.content
          .map((part) => (typeof part === 'string' ? part : part && (part.text || part.content) ? part.text || part.content : ''))
          .filter(Boolean)
          .join('\n');
      }
      const files = Array.isArray(message.files)
        ? message.files
            .filter((file) => file && (file.filename || file.mimeType))
            .slice(0, 4)
            .map((file) => ({
              filename: String(file.filename || 'attachment'),
              mimeType: String(file.mimeType || 'application/octet-stream'),
              ...(Number.isFinite(Number(file.pages)) ? { pages: Number(file.pages) } : {}),
              ...(Number.isFinite(Number(file.bytes)) ? { bytes: Number(file.bytes) } : {})
            }))
        : [];
      if (!content && !files.length) continue;
      normalized.push({ role: String(message.role), content, ...(files.length ? { files } : {}) });
    }
    // v2.36：助手消息附带工具调用（位置/生图/联网）、生成图片与思考过程，供「会话历史」只读展示。
    if (assistantText || images.length || toolCalls.length) {
      const assistant = { role: 'assistant', content: String(assistantText || '') };
      if (reasoning) assistant.reasoning = String(reasoning);
      if (Array.isArray(images) && images.length) {
        assistant.images = images
          .filter((image) => image && typeof image.b64 === 'string' && image.b64)
          .slice(0, 4)
          .map((image) => ({ b64: image.b64, format: image.format || 'png', model: image.model || null }));
      }
      if (Array.isArray(toolCalls) && toolCalls.length) {
        assistant.toolCalls = toolCalls.slice(0, 20).map((call) => ({
          name: call && call.name ? String(call.name) : 'tool',
          callId: call && call.callId ? String(call.callId) : null,
          ...(call && call.args !== undefined ? { args: call.args } : {}),
          ...(call && call.result !== undefined ? { result: call.result } : {})
        }));
      }
      if (Array.isArray(sources) && sources.length) {
        assistant.sources = sources.slice(0, 20).map((source) => ({
          url: String(source.url || ''),
          title: source.title ? String(source.title) : null
        }));
      }
      normalized.push(assistant);
    }
    if (!normalized.length) return;
    record({
      identityId: ctx.log?.identityId || ctx.identityRoute?.identityId || null,
      identityLabel: ctx.log?.identityLabel || null,
      sessionKey: ctx.sessionKey || null,
      model: model || ctx.log?.model || null,
      systemPrompt: typeof ctx.systemPromptSnapshot === 'string' ? ctx.systemPromptSnapshot : null,
      messages: normalized,
      injection: ctx.historyInjection || null,
      ts: Date.now()
    });
  } catch {
    // 历史记录失败不影响主流程
  }
}

/* ------------------------------------------------------------------ */
/* Sources / images                                                    */
/* ------------------------------------------------------------------ */

function asResultArray(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  if (value && Array.isArray(value.citations)) return value.citations;
  return [];
}

/** Normalize one citation/search result into `{url,title,...}`. */
export function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url =
    typeof raw.url === 'string' && raw.url
      ? raw.url
      : typeof raw.href === 'string' && raw.href
        ? raw.href
        : typeof raw.link === 'string' && raw.link
          ? raw.link
          : '';
  if (!url) return null;
  const source = { url };
  const title =
    typeof raw.title === 'string' && raw.title
      ? raw.title
      : typeof raw.site === 'string' && raw.site
        ? raw.site
        : url;
  source.title = title;
  for (const field of ['snippet', 'domain', 'root_domain', 'site_name', 'published', 'id']) {
    if (raw[field] !== undefined && raw[field] !== null) source[field] = raw[field];
  }
  return source;
}

/** Merge one or more source lists, dedupe by URL, cap at MAX_SOURCES. */
export function mergeSources(...lists) {
  const byUrl = new Map();
  for (const list of lists) {
    for (const raw of asResultArray(list)) {
      const source = normalizeSource(raw);
      if (source && !byUrl.has(source.url)) byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()].slice(0, MAX_SOURCES);
}

/** OpenAI `url_citation` annotations from normalized sources. */
export function buildAnnotations(sources) {
  return sources
    .filter((source) => source && source.url)
    .map((source) => ({
      type: 'url_citation',
      url_citation: {
        url: source.url,
        title: source.title || source.url
      }
    }));
}

/**
 * v2.35：OpenAI Chat Completions 没有官方的「assistant 返回图片」字段，主流 OpenAI 兼容网关
 * （OpenRouter / LobeChat / OpenWebUI 等）使用 `message.images`：
 *   { type: "image_url", image_url: { url: "data:<mime>;base64,<b64>" } }
 * 这里同时保留 b64_json/format（旧客户端与调试用），并修正真实 MIME（duck.ai 实际返回 JPEG）。
 */
export function toChatImage(image) {
  const format = detectImageFormat(image.b64, normalizeFormat(image.format) || 'png');
  return {
    type: 'image_url',
    image_url: { url: imageDataUri(image.b64, format) },
    b64_json: image.b64,
    format,
    mime_type: imageMimeType(format),
    ...(Number.isFinite(image.width) ? { width: image.width } : {}),
    ...(Number.isFinite(image.height) ? { height: image.height } : {}),
    ...(image.model ? { model: image.model } : {})
  };
}

/**
 * v2.37：把「工具调用 + 审批决策 + 生成图片」归一化成统一的 toolCalls 列表。
 * 会话历史与连接测试共用（前端 ChatMessageBubble 展示）。
 * @param {{ toolCalls?: any[], approvals?: any[], images?: any[] }} [source]
 * @returns {Array<{name: string, callId?: string, args?: string, result?: string}>}
 */
export function normalizeToolCalls({ toolCalls = [], approvals = [], images = [] } = {}) {
  const list = [];
  const toText = (value) => {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!call || typeof call !== 'object') continue;
    const item = { name: String(call.name || 'tool') };
    if (call.callId) item.callId = String(call.callId);
    if (call.args !== undefined) item.args = toText(call.args);
    if (call.result !== undefined) item.result = toText(call.result);
    list.push(item);
  }
  for (const approval of Array.isArray(approvals) ? approvals : []) {
    if (!approval || approval.approved === null || approval.approved === undefined) continue;
    list.push({
      name: String(approval.toolName || approval.purpose || 'approval'),
      result: approval.approved ? '已批准' : '已拒绝'
    });
  }
  if (Array.isArray(images) && images.length && !list.some((item) => /generate|image/i.test(item.name))) {
    list.unshift({ name: 'GenerateImage', result: `已生成 ${images.length} 张图片` });
  }
  return list;
}

/** Normalize images emitted by DuckClient (`{b64, format, ...}`). */
export function normalizeImage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const b64 =
    typeof raw.b64 === 'string'
      ? raw.b64
      : typeof raw.b64Image === 'string'
        ? raw.b64Image
        : typeof raw.b64_json === 'string'
          ? raw.b64_json
          : typeof raw.result === 'string'
            ? raw.result
            : '';
  if (!b64) return null;
  const format =
    typeof raw.format === 'string' && raw.format
      ? raw.format.toLowerCase().replace(/^image\//, '')
      : 'png';
  return {
    b64,
    format,
    ...(Number.isFinite(raw.width) ? { width: raw.width } : {}),
    ...(Number.isFinite(raw.height) ? { height: raw.height } : {}),
    ...(typeof raw.modelDisplayName === 'string' && raw.modelDisplayName
      ? { model: raw.modelDisplayName }
      : typeof raw.model === 'string' && raw.model
        ? { model: raw.model }
        : {})
  };
}

export function mergeImages(...lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists) {
    for (const raw of Array.isArray(list) ? list : []) {
      const image = normalizeImage(raw);
      if (!image || seen.has(image.b64)) continue;
      seen.add(image.b64);
      result.push(image);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Headers / payload helpers                                           */
/* ------------------------------------------------------------------ */

function setResolutionHeaders(ctx, resolved, reasoning) {
  try {
    ctx.res.setHeader('X-Duckai-Model', resolved.id);
    ctx.res.setHeader('X-Duckai-Reasoning-Effort', reasoning.effort);
    if (reasoning.adjusted) {
      ctx.res.setHeader('X-Duckai-Reasoning-Adjusted', 'true');
      if (reasoning.note) ctx.res.setHeader('X-Duckai-Reasoning-Note', encodeURIComponent(reasoning.note));
    }
  } catch {
    // Headers may already be sent if a handler failed late; ignore.
  }
}

export function buildChatCompletion({
  id,
  created,
  model,
  content,
  reasoning,
  sources,
  images,
  finishReason,
  usage,
  toolCalls
}) {
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  const message = {
    role: 'assistant',
    content: hasToolCalls && !content ? null : content || '',
    refusal: null
  };
  if (hasToolCalls) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning_content = reasoning;
  if (sources && sources.length) {
    message.annotations = buildAnnotations(sources);
    message.sources = sources;
  }
  if (images && images.length) message.images = images.map(toChatImage);
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: hasToolCalls ? 'tool_calls' : normalizeFinishReason(finishReason)
      }
    ],
    usage,
    system_fingerprint: null
  };
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, any>} ctx request context built by src/http/server.js
 */
export async function handleChatCompletions(req, res, ctx) {
  ctx.log.endpoint = 'POST /v1/chat/completions';
  const body = ctx.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  const resolved = resolveModel(ctx.config, body.model);
  ctx.log.model = resolved.id;

  const messages = normalizeChatMessages(body.messages);
  ctx.log.promptChars = messages.promptChars;

  const reasoning = resolveReasoningEffort(resolved.model, body.reasoning_effort ?? body.reasoning?.effort);
  const flags = resolveToolFlags(ctx.config, resolved.model, body);
  if (flags.dropped && flags.dropped.length) ctx.log.droppedTools = flags.dropped;
  // v2.44：客户端工具（Codex/DSH 文件工具）——Completions 形状自动归一化
  const clientTools =
    ctx.config?.tools?.clientFunctionCalling?.enabled === false ? [] : normalizeToolDefinitions(body.tools);
  if (clientTools.length) ctx.log.clientTools = clientTools.map((tool) => tool.name);
  let systemPrompt = composeSystemPrompt(ctx.config, resolved, messages.systemParts);
  // v2.11: routed identity is needed before compaction (summary is an upstream call).
  if (typeof ctx.selectIdentity === 'function') {
    const paidModel =
      ctx.config?.duck?.allowPaidModels === true && (resolved.paid === true || resolved.model?.paid === true);
    await ctx.selectIdentity({ paidModel });
  }
  // v2.47：服务端会话模式。默认 stateless；需要显式开启（config conversations.mode=server，
  // 或请求头 X-Conversation-Mode: server / X-Conversation-Delta: true）。
  const headerMode = String(ctx.req?.headers?.['x-conversation-mode'] || '').toLowerCase();
  const deltaRequested = String(ctx.req?.headers?.['x-conversation-delta'] || body.conversation_delta || '') === 'true';
  const configuredMode = ctx.config?.conversations?.mode || 'stateless';
  const conversationMode = deltaRequested
    ? 'server'
    : headerMode === 'server'
      ? 'server'
      : headerMode === 'stateless'
        ? 'stateless'
        : configuredMode === 'server'
          ? 'server'
          : 'stateless';
  const responseStore = ctx.responsesStore || null;
  if (conversationMode === 'server' && !ctx.sessionKey) {
    throw badRequest(
      'conversation mode "server" requires an X-Session-Id header (or session_id in body)',
      'X-Session-Id',
      'session_required'
    );
  }
  let storedConversation = null;
  if (conversationMode === 'server' && responseStore?.enabled && ctx.sessionKey) {
    storedConversation = await responseStore.getConversation(ctx.sessionKey);
  }
  if (ctx.sessionKey) {
    try {
      ctx.res.setHeader('X-Session-Id', ctx.sessionKey);
    } catch {
      // headers may already be sent
    }
  }

  let requestConversation = messages.conversation;
  let compactedInfo = null;
  const pdfSpillConfig = ctx.config?.context?.pdfSpill || {};
  const pdfSpillPlanned =
    pdfSpillConfig.enabled !== false &&
    messages.conversation.length > 1 &&
    messages.promptChars + String(systemPrompt || '').length >
      (Number(pdfSpillConfig.inputCharLimit) || 20000);
  if (!storedConversation && !pdfSpillPlanned && ctx.sessionKey && ctx.chatSummaries) {
    const compactConfig = getCompactConfig(ctx.config);
    const split = splitForCompact(messages.conversation, compactConfig.keepRecentMessages);
    if (compactConfig.enabled && split.compactable) {
      let previousSummary = null;
      try {
        previousSummary = await ctx.chatSummaries.get(ctx.sessionKey);
      } catch {
        previousSummary = null;
      }
      const triggerEval = evaluateCompactionTrigger({
        config: ctx.config,
        messages: messages.conversation,
        summary: previousSummary,
        model: resolved
      });
      if (triggerEval.should) {
        try {
          const historyChars = split.history.reduce((sum, message) => sum + String(message.content || '').length, 0);
          const summary = await summarizeConversation(ctx, {
            history: split.history,
            model: compactConfig.model || resolved.id,
            maxSummaryChars: compactConfig.maxSummaryChars,
            systemPrompt,
            previousSummary,
            trigger: triggerEval.trigger || 'tokens',
            savedChars: historyChars,
            anchorId: split.history[split.history.length - 1]?.id || null
          });
          await ctx.chatSummaries.set(ctx.sessionKey, summary);
          systemPrompt = buildCompactedSystemPrompt(systemPrompt, summary);
          requestConversation = split.recent;
          compactedInfo = summary;
          ctx.log.compacted = true;
          ctx.log.summaryChars = summary.text.length;
          ctx.log.coveredMessageCount = summary.coveredMessageCount;
        } catch (error) {
          ctx.logger?.warn?.('session compaction failed; falling back to trim', {
            error: error.message,
            code: error.code || null
          });
          ctx.log.compactError = error.message;
        }
      } else if (previousSummary) {
        systemPrompt = buildCompactedSystemPrompt(systemPrompt, previousSummary);
        requestConversation = split.recent;
        compactedInfo = previousSummary;
        ctx.log.compacted = true;
        ctx.log.summaryChars = previousSummary.text.length;
        ctx.log.coveredMessageCount = previousSummary.coveredMessageCount;
      }
    }
  }
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const toolsHash = crypto.createHash('sha1').update(JSON.stringify(clientTools)).digest('hex');
  let canonicalBefore = rawMessages;
  let tailRaw = rawMessages;
  let canonicalForSave = rawMessages;
  let duckMessages;
  let historyMessages;
  let retryConversation = messages.conversation;
  let prefixReused = false;

  if (storedConversation) {
    const storedCanonical = Array.isArray(storedConversation.canonical) ? storedConversation.canonical : [];
    let prefixMatch = false;
    if (storedCanonical.length > 0 && rawMessages.length >= storedCanonical.length) {
      try {
        prefixMatch =
          JSON.stringify(rawMessages.slice(0, storedCanonical.length)) === JSON.stringify(storedCanonical);
      } catch {
        prefixMatch = false;
      }
    }
    if (prefixMatch) {
      tailRaw = rawMessages.slice(storedCanonical.length);
      canonicalBefore = rawMessages;
    } else if (String(ctx.req?.headers?.['x-conversation-delta'] || body.conversation_delta || '') === 'true') {
      tailRaw = rawMessages;
      canonicalBefore = [...storedCanonical, ...rawMessages];
    } else {
      throw conflict(
        'conversation session conflict: request history does not match the stored session; start a new session, or send only the delta with X-Conversation-Delta: true',
        'conversation_session_conflict'
      );
    }
    if (!tailRaw.length) {
      throw badRequest('no new messages for this session', 'messages', 'no_new_messages');
    }
    const reusablePrefix =
      Array.isArray(storedConversation.upstream) &&
      storedConversation.upstream.length > 0 &&
      storedConversation.toolsHash === toolsHash &&
      (storedConversation.systemPrompt || '') === (systemPrompt || '');
    if (reusablePrefix) {
      const tail = normalizeChatMessages(tailRaw, { allowEmptyUser: true });
      if (tail.systemParts.length === 0) {
        duckMessages = [...storedConversation.upstream, ...tail.conversation];
        canonicalForSave = canonicalBefore;
        try {
          retryConversation = normalizeChatMessages(canonicalBefore, { allowEmptyUser: true }).conversation;
        } catch {
          retryConversation = tail.conversation;
        }
        historyMessages = messages.conversation;
        prefixReused = true;
        ctx.log.conversationChain = 'prefix-reuse';
      }
    }
  }

  if (!prefixReused) {
    const rebuild = storedConversation ? normalizeChatMessages(canonicalBefore) : messages;
    const guarded = pdfSpillPlanned
      ? { messages: rebuild.conversation, trimmed: false }
      : guardConversation(rebuild.conversation, systemPrompt, ctx.config?.context || {});
    historyMessages = guarded.messages;
    ctx.historyMessages = historyMessages;
    if (guarded.trimmed) ctx.log.contextTrimmed = true;
    let upstreamMessages = guarded.messages;
    if (clientTools.length) {
      upstreamMessages = injectProtocolIntoFirstUser(guarded.messages, buildToolProtocol(clientTools));
    }
    duckMessages = buildDuckMessages({
      systemPrompt,
      conversation: upstreamMessages,
      promptMode: ctx.config?.prompts?.mode
    });
    canonicalForSave = storedConversation ? canonicalBefore : rebuild.conversation;
    retryConversation = guarded.messages;
    ctx.log.conversationChain = storedConversation ? 'rebuild' : 'stateless';
  }
  let spillDisplay = null;
  if (pdfSpillConfig.enabled !== false) {
    try {
      const spill = await spillMessagesToPdf(duckMessages, {
        inputCharLimit: Number(pdfSpillConfig.inputCharLimit) || 20000,
        maxPages: Number(pdfSpillConfig.maxPages) || 15
      });
      if (spill) {
        duckMessages = spill.messages;
        spillDisplay = spill.messages;
        ctx.log.contextPdf = spill.pdf;
        ctx.log.contextPdfMoved = spill.movedMessages;
      }
    } catch (error) {
      if (error && error.code === 'context_pdf_capacity_exceeded') {
        throw new OpenAIError('上下文超过 PDF 容量（15 页），请调用 /v1/compact 手动压缩后重试', {
          status: 413,
          type: 'invalid_request_error',
          code: 'context_pdf_capacity_exceeded',
          param: 'messages'
        });
      }
      ctx.logger?.warn?.('context PDF spill failed; continuing without spill', { error: error.message });
    }
  }
  const protocolText = clientTools.length ? buildToolProtocol(clientTools) : '';
  const historyForDisplay = spillDisplay
    ? spillDisplay.map((message) => ({
        ...message,
        content: String(message.content || '').replace(protocolText, '').trim(),
        files: message.files
      }))
    : historyMessages;
  ctx.historyMessages = historyForDisplay;
  const firstInjectedUser = duckMessages.find((message) => message && message.role === 'user');
  ctx.historyInjection = {
    injected: Boolean(protocolText),
    clientTools: clientTools.map((tool) => tool.name),
    protocolText,
    firstUserContent: firstInjectedUser && typeof firstInjectedUser.content === 'string' ? firstInjectedUser.content : '',
    upstreamMessageCount: duckMessages.length,
    chain: ctx.log.conversationChain || null
  };
  ctx.log.protocolInjected = Boolean(protocolText);
  ctx.log.upstreamMessageCount = duckMessages.length;
  ctx.chatSession = {
    enabled: conversationMode === 'server' && Boolean(responseStore?.enabled && ctx.sessionKey),
    store: responseStore,
    sessionKey: ctx.sessionKey || null,
    mode: conversationMode,
    systemPrompt,
    toolsHash,
    canonicalBefore,
    upstreamBeforeResponse: duckMessages
  };

  const stream = body.stream === true;
  ctx.log.stream = stream;
  setResolutionHeaders(ctx, resolved, reasoning);

  const params = {
    resolved,
    reasoning,
    flags,
    duckMessages,
    systemPrompt,
    conversation: canonicalForSave,
    guardedMessages: retryConversation,
    historyMessages: historyForDisplay,
    clientTools,
    promptChars: messages.promptChars,
    contextTrimmed: Boolean(ctx.log.contextTrimmed),
    compactedInfo,
    streamOptions: body.stream_options && typeof body.stream_options === 'object' ? body.stream_options : null
  };

  if (stream) {
    await streamChatCompletion(ctx, params);
  } else {
    await completeChatCompletion(ctx, params);
  }

  // v2.47：保存服务端会话（canonical + 精确 upstream 前缀），供下一轮增量/前缀复用
  const session = ctx.chatSession;
  if (session?.enabled && session.store && ctx.chatFinal) {
    const assistantCanonical =
      Array.isArray(ctx.chatFinal.toolCalls) && ctx.chatFinal.toolCalls.length
        ? { role: 'assistant', content: null, tool_calls: ctx.chatFinal.toolCalls }
        : { role: 'assistant', content: String(ctx.chatFinal.content || '') };
    const assistantUpstream =
      Array.isArray(ctx.chatFinal.toolCalls) && ctx.chatFinal.toolCalls.length
        ? { role: 'assistant', content: formatToolCallsForHistory(ctx.chatFinal.toolCalls) }
        : { role: 'assistant', content: String(ctx.chatFinal.content || '') };
    try {
      await session.store.saveConversation({
        sessionKey: session.sessionKey,
        model: resolved.id,
        mode: session.mode,
        systemPrompt: session.systemPrompt,
        canonical: [...session.canonicalBefore, assistantCanonical],
        upstream: [...session.upstreamBeforeResponse, assistantUpstream],
        toolsHash: session.toolsHash
      });
      ctx.log.conversationState = 'saved';
    } catch (error) {
      ctx.logger?.warn?.('failed to save conversation state', { error: error.message });
    }
  }
}

/**
 * 单次上游调用：收集文本/思考/来源/图片/用量（供 function calling 多轮复用）。
 * @param {Record<string, any>} ctx
 * @param {Record<string, any>} params
 * @param {{ conversation?: any[], systemPrompt?: string }} [options]
 */
async function callChatUpstreamOnce(ctx, params, { conversation, systemPrompt } = {}) {
  const collected = {
    content: '',
    reasoning: '',
    sources: [],
    images: [],
    usage: null,
    finishReason: null,
    error: null
  };
  const handlers = {
    onTextDelta(value) {
      if (typeof value === 'string') collected.content += value;
    },
    onReasoningDelta(value) {
      if (typeof value === 'string') collected.reasoning += value;
    },
    onSearchResults(results) {
      collected.sources = mergeSources(collected.sources, results);
    },
    onImage(image) {
      const normalized = normalizeImage(image);
      if (normalized) collected.images.push(normalized);
    },
    onUsage(usage) {
      collected.usage = usage;
    },
    onToolCall() {},
    onToolResult() {},
    onError(error) {
      collected.error = error;
    }
  };
  const model = params.resolved.id;
  const upstreamConversation = conversation || params.guardedMessages || params.conversation;
  const prompt = typeof systemPrompt === 'string' ? systemPrompt : params.systemPrompt;
  const taskFor = (messagesForCall) => (runtime) =>
    (runtime?.client || ctx.duck).chat(
      {
        model,
        messages: messagesForCall,
        reasoningEffort: params.reasoning.effort,
        webSearch: params.flags.webSearch,
        imageGeneration: params.flags.imageGeneration,
        approxLocation: ctx.config?.tools?.location === true,
        signal: ctx.signal
      },
      handlers
    );
  const initialMessages = conversation
    ? buildDuckMessages({
        systemPrompt: prompt,
        conversation: upstreamConversation,
        promptMode: ctx.config?.prompts?.mode
      })
    : params.duckMessages ||
      buildDuckMessages({
        systemPrompt: prompt,
        conversation: upstreamConversation,
        promptMode: ctx.config?.prompts?.mode
      });
  const result = await ctx.callUpstream(
    taskFor(initialMessages),
    {
      model,
      onContextLimitRetry: () => {
        const guarded = guardConversation(upstreamConversation, prompt, {
          ...(ctx.config?.context || {}),
          aggressive: true
        });
        ctx.log.contextTrimmed = true;
        return taskFor(
          buildDuckMessages({
            systemPrompt: prompt,
            conversation: guarded.messages,
            promptMode: ctx.config?.prompts?.mode
          })
        );
      }
    }
  );
  return { collected, result };
}

/**
 * 解析一次 chat 请求的最终结果。
 * @returns {Promise<{content:string, reasoningText:string, sources:any[], images:any[], usage:any,
 *   finishReason:string|null, collected:any, result:any}>}
 */
async function resolveChatCompletion(ctx, params) {
  const outcome = await callChatUpstreamOnce(ctx, params, {
    systemPrompt: params.systemPrompt
  });
  const { collected, result } = outcome;
  if (collected.error && !collected.content && !result) throw collected.error;

  const rawContent =
    typeof result?.content === 'string' && result.content ? result.content : collected.content;
  const clientTools = Array.isArray(params.clientTools) ? params.clientTools : [];
  const toolCalls = clientTools.length ? parseToolCalls(rawContent, clientTools) : [];
  let content = stripToolCallText(cleanCitationText(rawContent), toolCalls.length > 0);
  if (toolCalls.length && /^```|^\{|^<tool_call>/i.test(String(rawContent || '').trim())) content = '';
  const reasoningText = cleanCitationText(
    typeof result?.reasoning === 'string' && result.reasoning ? result.reasoning : collected.reasoning
  );
  const sources = mergeSources(collected.sources, result?.sources);
  const images = mergeImages(collected.images, result?.images);
  const finishReason = toolCalls.length ? 'tool_calls' : result?.finishReason || collected.finishReason;
  const usage = buildEstimatedUsage({
    promptChars: params.promptChars,
    completionChars: content.length,
    reasoningChars: reasoningText.length,
    promptTokens: countMessagesTokens(params.duckMessages || []),
    completionTokens: countTextTokens(content) + countTextTokens(reasoningText),
    upstreamUsage: collected.usage
  });
  return {
    content,
    reasoningText,
    sources,
    images,
    usage,
    finishReason,
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments }
    })),
    collected,
    result
  };
}

async function completeChatCompletion(ctx, params) {
  const resolved = await resolveChatCompletion(ctx, params);
  const { content, reasoningText, sources, images, finishReason, toolCalls } = resolved;
  const model = params.resolved.id;

  // v2.31：写入会话历史（附 function calls）
  recordHistoryOnLog(ctx, {
    messages: params.historyMessages || params.guardedMessages || params.conversation,
    assistantText: content || '',
    reasoning: reasoningText,
    images,
    sources,
    toolCalls: [
      ...normalizeToolCalls({
        toolCalls: [...(resolved.collected.toolCalls || []), ...((resolved.result && resolved.result.toolCalls) || [])],
        approvals: (resolved.result && resolved.result.approvals) || [],
        images
      }),
      ...toolCalls.map((call) => ({ name: call.function?.name || call.name, args: call.function?.arguments, result: '等待客户端执行' }))
    ],
    model
  });
  recordUsageOnLog(ctx, resolved.usage);

  const payload = buildChatCompletion({
    id: genId('chatcmpl-'),
    created: nowSec(),
    model,
    content,
    reasoning: reasoningText,
    sources,
    images,
    finishReason,
    usage: resolved.usage,
    toolCalls
  });
  ctx.chatFinal = { content, toolCalls };
  if (ctx.log.contextTrimmed) payload.context_trimmed = true;
  if (params.compactedInfo) {
    payload.compacted = true;
    payload.summary_chars = params.compactedInfo.text.length;
    payload.covered_message_count = params.compactedInfo.coveredMessageCount;
    payload.summary = params.compactedInfo;
  }
  ctx.json(200, payload);
}

/**
 * Deferred "first upstream event" gate used by the streaming handlers.
 * The SSE response headers are only written after the upstream produced its
 * first event, so a pre-stream failure (e.g. 429 rate limit) can still be
 * reported as a normal HTTP JSON error.
 */
export function createFirstEventGate() {
  let fired = false;
  let resolveFn = () => {};
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  return {
    get fired() {
      return fired;
    },
    notify() {
      if (fired) return;
      fired = true;
      resolveFn();
    },
    promise
  };
}

function sendStreamError(ctx, writer, error) {
  const normalized = toOpenAIError(error);
  ctx.log.error = normalized.message;
  try {
    writer.data(errorPayload(normalized));
    writer.data('[DONE]');
  } catch {
    // client already disconnected
  }
  writer.end();
}

/**
 * v2.44：带客户端工具的流式响应——先完整解析（需要工具 JSON），再按 OpenAI chunk 回放。
 */
async function streamChatCompletionWithTools(ctx, params) {
  const resolved = await resolveChatCompletion(ctx, params);
  const { content, reasoningText, sources, images, finishReason, toolCalls } = resolved;
  const base = {
    id: genId('chatcmpl-'),
    object: 'chat.completion.chunk',
    created: nowSec(),
    model: params.resolved.id,
    system_fingerprint: null
  };
  ctx.chatFinal = { content, toolCalls };
  const writer = ctx.openSSE();
  const emit = (delta, finish = null) => {
    if (!writer.closed) writer.data({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
  };
  emit({ role: 'assistant', content: '' });
  if (reasoningText) {
    for (let index = 0; index < reasoningText.length; index += 200) {
      emit({ reasoning_content: reasoningText.slice(index, index + 200) });
    }
  }
  if (toolCalls.length) {
    toolCalls.forEach((call, index) =>
      emit({
        tool_calls: [{
          index,
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: call.function.arguments }
        }]
      })
    );
    emit({}, 'tool_calls');
  } else {
    const text = content || '';
    for (let index = 0; index < text.length; index += 120) {
      emit({ content: text.slice(index, index + 120) });
    }
    if (sources.length) emit({ annotations: buildAnnotations(sources), sources });
    if (images.length) emit({ images: images.map(toChatImage) });
    emit({}, finishReason);
  }
  ctx.chatFinal = { content, toolCalls };
  if (params.streamOptions?.include_usage === true) {
    writer.data({ ...base, choices: [], usage: resolved.usage });
  }
  writer.data('[DONE]');
  writer.end();
}

async function streamChatCompletion(ctx, params) {
  const id = genId('chatcmpl-');
  const created = nowSec();
  const model = params.resolved.id;
  const base = { id, object: 'chat.completion.chunk', created, model, system_fingerprint: null };

  if (Array.isArray(params.clientTools) && params.clientTools.length > 0) {
    return streamChatCompletionWithTools(ctx, params);
  }

  let writer = null;
  const pendingChoices = [];
  const deliver = (choice) => {
    if (writer) {
      if (!writer.closed) writer.data({ ...base, choices: [choice] });
    } else {
      pendingChoices.push(choice);
    }
  };
  const emitDelta = (delta, finishReason = null) =>
    deliver({ index: 0, delta, logprobs: null, finish_reason: finishReason });
  const flushPendingChoices = () => {
    if (!writer) return;
    for (const choice of pendingChoices.splice(0)) {
      if (!writer.closed) writer.data({ ...base, choices: [choice] });
    }
  };

  const collected = { content: '', reasoning: '', sources: [], images: [], usage: null, error: null };
  // v2.24：流式请求的 token 统计（在结束处生成，写入 ctx.log 供概览聚合）
  let streamUsage = null;
  const textFilter = createCitationFilter();
  const reasoningFilter = createCitationFilter();
  let annotationsSent = 0;
  const imagesSent = new Set();
  const gate = createFirstEventGate();

  const sendNewAnnotations = () => {
    if (collected.sources.length <= annotationsSent) return;
    const fresh = collected.sources.slice(annotationsSent);
    annotationsSent = collected.sources.length;
    emitDelta({ annotations: buildAnnotations(fresh), sources: fresh });
  };
  const sendNewImages = () => {
    const fresh = [];
    for (const image of collected.images) {
      if (imagesSent.has(image.b64)) continue;
      imagesSent.add(image.b64);
      fresh.push(toChatImage(image));
    }
    if (fresh.length) emitDelta({ images: fresh });
  };

  const handlers = {
    onTextDelta(text) {
      const cleaned = textFilter.process(text);
      if (!cleaned) return;
      collected.content += cleaned;
      emitDelta({ content: cleaned });
    },
    onReasoningDelta(text) {
      const cleaned = reasoningFilter.process(text);
      if (!cleaned) return;
      collected.reasoning += cleaned;
      emitDelta({ reasoning_content: cleaned });
    },
    onSearchResults(results) {
      collected.sources = mergeSources(collected.sources, results);
      sendNewAnnotations();
    },
    onImage(image) {
      const normalized = normalizeImage(image);
      if (!normalized) return;
      collected.images.push(normalized);
      sendNewImages();
    },
    onUsage(usage) {
      collected.usage = usage;
    },
    onToolCall() {},
    onToolResult() {},
    onError(error) {
      collected.error = error;
    }
  };

  // Any non-error upstream callback means the stream is alive → safe to send SSE.
  const wrappedHandlers = {};
  for (const [key, handler] of Object.entries(handlers)) {
    wrappedHandlers[key] = (...args) => {
      if (key !== 'onError' && key !== 'onToolCall' && key !== 'onToolResult') gate.notify();
      handler(...args);
    };
  }

  let chatPromise;
  try {
    const taskFor = (messagesForCall) => (runtime) =>
      (runtime?.client || ctx.duck).chat(
        {
          model,
          messages: messagesForCall,
          reasoningEffort: params.reasoning.effort,
          webSearch: params.flags.webSearch,
          imageGeneration: params.flags.imageGeneration,
          approxLocation: ctx.config?.tools?.location === true,
          signal: ctx.signal
        },
        wrappedHandlers
      );
    chatPromise = Promise.resolve(
      ctx.callUpstream(taskFor(params.duckMessages), {
        model,
        onContextLimitRetry: () => {
          const guarded = guardConversation(params.conversation, params.systemPrompt, {
            ...(ctx.config?.context || {}),
            aggressive: true
          });
          params.duckMessages = buildDuckMessages({
            systemPrompt: params.systemPrompt,
            conversation: guarded.messages,
            promptMode: ctx.config?.prompts?.mode
          });
          ctx.log.contextTrimmed = true;
          return taskFor(params.duckMessages);
        }
      })
    );
  } catch (error) {
    // Nothing has been written yet → JSON error response.
    throw error;
  }

  let outcome;
  try {
    outcome = await Promise.race([
      chatPromise.then((value) => ({ kind: 'done', value })),
      gate.promise.then(() => ({ kind: 'event' }))
    ]);
  } catch (error) {
    if (!gate.fired) throw error; // upstream failed before the first event → HTTP JSON error
    writer = ctx.openSSE();
    emitDelta({ role: 'assistant', content: '' });
    flushPendingChoices();
    sendStreamError(ctx, writer, error);
    return;
  }

  writer = ctx.openSSE();
  emitDelta({ role: 'assistant', content: '' });
  flushPendingChoices();

  let result;
  if (outcome.kind === 'event') {
    try {
      result = await chatPromise;
    } catch (error) {
      sendStreamError(ctx, writer, error);
      return;
    }
  } else {
    result = outcome.value;
  }

  try {
    const textTail = textFilter.process('', { flush: true });
    if (textTail) {
      collected.content += textTail;
      emitDelta({ content: textTail });
    }
    const reasoningTail = reasoningFilter.process('', { flush: true });
    if (reasoningTail) {
      collected.reasoning += reasoningTail;
      emitDelta({ reasoning_content: reasoningTail });
    }

    if (!collected.content && typeof result?.content === 'string' && result.content) {
      const cleaned = cleanCitationText(result.content);
      if (cleaned) {
        collected.content = cleaned;
        emitDelta({ content: cleaned });
      }
    }
    if (!collected.reasoning && typeof result?.reasoning === 'string' && result.reasoning) {
      const cleaned = cleanCitationText(result.reasoning);
      if (cleaned) {
        collected.reasoning = cleaned;
        emitDelta({ reasoning_content: cleaned });
      }
    }

    collected.sources = mergeSources(collected.sources, result?.sources);
    collected.images = mergeImages(collected.images, result?.images);
    sendNewAnnotations();
    sendNewImages();

    const finishReason = normalizeFinishReason(result?.finishReason || collected.finishReason);
  // v2.31：写入会话历史（流式）
  recordHistoryOnLog(ctx, {
    messages: params.guardedMessages || params.conversation,
    assistantText: collected.content || params.content || '',
    reasoning: collected.reasoning || '',
    images: collected.images || [],
    sources: collected.sources || [],
    toolCalls: normalizeToolCalls({
      toolCalls: collected.toolCalls || [],
      approvals: collected.approvals || [],
      images: collected.images || []
    }),
    model: params.resolved.id
  });
    emitDelta({}, finishReason);
    ctx.chatFinal = { content: collected.content, toolCalls: [] };

    // v2.24：流式请求也要统计 token（无论是否 include_usage）
    streamUsage = buildEstimatedUsage({
      promptChars: params.promptChars,
      completionChars: collected.content.length,
      reasoningChars: collected.reasoning.length,
      promptTokens: countMessagesTokens(params.duckMessages || []),
      completionTokens: countTextTokens(collected.content) + countTextTokens(collected.reasoning),
      upstreamUsage: collected.usage
    });
    recordUsageOnLog(ctx, streamUsage);

    if (params.streamOptions?.include_usage === true) {
      writer.data({
        ...base,
        choices: [],
        usage: streamUsage
      });
    }

    writer.data('[DONE]');
    writer.end();
  } catch (error) {
    const normalized = toOpenAIError(error);
    ctx.log.error = normalized.message;
    try {
      writer.data(errorPayload(normalized));
      writer.data('[DONE]');
    } catch {
      // client already disconnected
    }
    writer.end();
  }
}
