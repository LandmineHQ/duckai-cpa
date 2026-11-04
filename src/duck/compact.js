/**
 * Context compaction helpers (v2.11): build a summary prompt, serialize a conversation and ask a
 * Duck client to summarize it for session-level context compression.
 *
 * Design notes / differences from duck.ai's native summarizer: docs/COMPACT.md.
 */
import { DuckError } from './index.js';
import { DEFAULT_MODEL, getModelCapabilities } from './models.js';

export const DEFAULT_MAX_SUMMARY_CHARS = 4000;
export const MIN_SUMMARY_CHARS = 200;
export const MAX_SUMMARY_PROMPT_CHARS = 20000;
export const SUMMARY_PROMPT_VERSION = 1;

/**
 * duck.ai compaction model allow-list (bundle module 76036 `r`/`a`).
 * `claude-haiku-5-5` is internal-tier only (list `o`) — non-internal tiers do NOT auto-compact it.
 */
export const COMPACTION_MODELS = Object.freeze([
  'claude-haiku-4-5',
  'claude-haiku-5-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5-5',
  'claude-opus-4-8',
  'claude-opus-5-5',
  'gpt-5.4-mini',
  'gpt-5.6-terra',
  'gpt-5.6-sol'
]);
/** Models that need `tier === 'internal'` for compaction (bundle `o` list). */
export const COMPACTION_INTERNAL_ONLY = Object.freeze(['claude-haiku-5-5']);
/** Fallback pair-count rule when no activation target is supplied (bundle fallback rule). */
export const FALLBACK_MIN_NEW_PAIRS = 4;

/**
 * Whether a model participates in automatic compaction (`Ce(model, isInternal)` in the bundle).
 * gpt-6-luna is deliberately absent (duck.ai never auto-compacts it).
 * @param {string} model
 * @param {{ internalTier?: boolean } | boolean} [options]
 * @returns {boolean}
 */
export function isCompactionSupported(model, options = {}) {
  const internalTier = typeof options === 'boolean' ? options : options.internalTier === true;
  const id = String(model || '');
  if (!COMPACTION_MODELS.includes(id)) return false;
  if (COMPACTION_INTERNAL_ONLY.includes(id) && !internalTier) return false;
  return true;
}

/**
 * Read `activationTargetPairCount` from a capabilities/modelConfig object (or a raw number).
 * duck.ai supplies it via modelConfig/capabilities at runtime; static catalog models usually omit it.
 * `0` is treated as "not configured" (returns null → pair fallback); only positive integers activate.
 * @param {number | Record<string, any> | null | undefined} modelCapabilities
 * @returns {number | null} positive integer, or null when absent/zero/invalid
 */
export function getActivationTargetPairCount(modelCapabilities) {
  if (Number.isInteger(modelCapabilities) && modelCapabilities > 0) return modelCapabilities;
  if (!modelCapabilities || typeof modelCapabilities !== 'object') return null;
  const candidates = [
    modelCapabilities.activationTargetPairCount,
    modelCapabilities.capabilities && modelCapabilities.capabilities.activationTargetPairCount,
    modelCapabilities.modelConfig && modelCapabilities.modelConfig.activationTargetPairCount,
    modelCapabilities.capabilities && modelCapabilities.capabilities.compaction && modelCapabilities.capabilities.compaction.activationTargetPairCount
  ];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  return null;
}

function decodeJsonMarker(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let current = value.trim();
  const candidates = [current];
  // Tolerate single or double URL-encoding (SSE layers occasionally re-encode).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      candidates.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Locate a SUMMARY_REFRESH_HINT payload in a DONE line / marker list. */
function extractRefreshHintValue(text) {
  const bracketed = text.match(/\[SUMMARY_REFRESH_HINT:([^\]]+)\]/);
  if (bracketed) return bracketed[1];
  const encoded = text.match(/SUMMARY_REFRESH_HINT:(%7B[\s\S]*?%7D)/i);
  if (encoded) return encoded[1];
  const rawJson = text.match(/SUMMARY_REFRESH_HINT:(\{[\s\S]*?\})(?:\]|$)/);
  if (rawJson) return rawJson[1];
  const trimmed = text.trim();
  if (/^(?:%7B|\{)/i.test(trimmed) && /(?:%7D|\})\s*$/i.test(trimmed)) return trimmed;
  return null;
}

/**
 * Count pairs the way duck.ai does (`LZ` predicate: active assistant messages).
 * @param {Array<Record<string, any>>} messages
 * @returns {number}
 */
export function countPairs(messages) {
  if (!Array.isArray(messages)) return 0;
  let pairs = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'assistant') continue;
    const status = message.meta && message.meta.status !== undefined ? message.meta.status : message.status;
    if ((status === undefined ? 'active' : status) !== 'active') continue;
    pairs += 1;
  }
  return pairs;
}

/**
 * Parse duck.ai DONE-line compact markers.
 * Supports: `[SUMMARY_REFRESH_HINT:<urlencoded JSON>]`, `[SUMMARY_INVALID]`,
 * `[LIMIT_CONVERSATION]`, `[LIMIT_ACCOUNT]`, `[LIMIT_ENTITY]`, `[LIMIT_IMAGE_GENERATIONS]`,
 * `[FIXED_COST_WINDOW_USAGE:<urlencoded JSON>]`, `[ADS:<JSON>]`,
 * `[WARN_CONVERSATION_LIMIT:<n>]`, `[STOP_REASON:<word>]`.
 * Malformed JSON values are ignored (limit flags are still reported).
 * @param {string | string[] | null | undefined} input
 * @returns {{
 *   summaryRefreshHint: { baseCoveredPairCount?: number, targetPairCount: number, trigger: 'tokens', thresholdTokens?: number } | null,
 *   summaryInvalid: boolean,
 *   limitConversation: boolean, limitAccount: boolean, limitEntity: boolean, limitImageGenerations: boolean,
 *   fixedCostWindowUsage: any | null,
 *   ads: any | null,
 *   warnConversationLimit: number | null,
 *   stopReason: string | null,
 *   markers: string[]
 * }}
 */
export function parseCompactMarkers(input) {
  const text = Array.isArray(input) ? input.filter((item) => typeof item === 'string').join('\n') : typeof input === 'string' ? input : '';
  const markers = [];
  let summaryRefreshHint = null;
  let summaryInvalid = false;
  let limitConversation = false;
  let limitAccount = false;
  let limitEntity = false;
  let limitImageGenerations = false;
  let fixedCostWindowUsage = null;
  let ads = null;
  let warnConversationLimit = null;
  let stopReason = null;

  const refreshValue = extractRefreshHintValue(text);
  if (refreshValue) {
    markers.push('SUMMARY_REFRESH_HINT');
    const payload = decodeJsonMarker(refreshValue);
    if (payload && payload.trigger === 'tokens' && Number.isInteger(payload.targetPairCount) && payload.targetPairCount > 0) {
      const base = payload.baseCoveredPairCount;
      if (base === undefined || (Number.isInteger(base) && base >= 0)) {
        summaryRefreshHint = {
          ...(base !== undefined ? { baseCoveredPairCount: base } : {}),
          targetPairCount: payload.targetPairCount,
          trigger: 'tokens',
          ...(typeof payload.thresholdTokens === 'number' ? { thresholdTokens: payload.thresholdTokens } : {})
        };
      }
    }
  }
  if (text.includes('[SUMMARY_INVALID]')) {
    summaryInvalid = true;
    markers.push('SUMMARY_INVALID');
  }
  const limitMarkers = [
    ['LIMIT_CONVERSATION', () => (limitConversation = true)],
    ['LIMIT_ACCOUNT', () => (limitAccount = true)],
    ['LIMIT_ENTITY', () => (limitEntity = true)],
    ['LIMIT_IMAGE_GENERATIONS', () => (limitImageGenerations = true)]
  ];
  for (const [marker, apply] of limitMarkers) {
    if (text.includes(`[${marker}]`)) {
      markers.push(marker);
      apply();
    }
  }
  const fixed = text.match(/\[FIXED_COST_WINDOW_USAGE:([^\]]+)\]/);
  if (fixed) {
    markers.push('FIXED_COST_WINDOW_USAGE');
    fixedCostWindowUsage = decodeJsonMarker(fixed[1]);
  }
  const adsMatch = text.match(/\[ADS:([^\]]+)\]/);
  if (adsMatch) {
    markers.push('ADS');
    const parsed = decodeJsonMarker(adsMatch[1]);
    if (parsed && typeof parsed === 'object') ads = parsed;
  }
  const warn = text.match(/\[WARN_CONVERSATION_LIMIT:(\d+)\]/);
  if (warn) {
    markers.push('WARN_CONVERSATION_LIMIT');
    const value = parseInt(warn[1], 10);
    if (Number.isInteger(value)) warnConversationLimit = value;
  }
  const stop = text.match(/\[STOP_REASON:(\w+)\]/);
  if (stop) {
    markers.push('STOP_REASON');
    stopReason = stop[1];
  }
  return {
    summaryRefreshHint,
    summaryInvalid,
    limitConversation,
    limitAccount,
    limitEntity,
    limitImageGenerations,
    fixedCostWindowUsage,
    ads,
    warnConversationLimit,
    stopReason,
    markers
  };
}

/**
 * duck.ai compaction trigger (`buildBindingIfActivated`, bundle ~1715000):
 * - model must be in the compaction allow-list (`Ce`);
 * - explicit `activationTargetPairCount` → trigger iff `target > covered && target <= activePairs`;
 * - otherwise fallback (when allowed, `Og`): `activePairs - covered >= 4 && activePairs >= 4`;
 * - `triggerChars` is only kept as a legacy gateway heuristic (not duck.ai semantics).
 *
 * Supported call shapes:
 *   shouldCompact({ model, pairCount, coveredPairCount, activationTargetPairCount, allowPairFallback?, internalTier? })
 *   shouldCompact(messages, { model?, coveredPairCount?, activationTargetPairCount?, triggerChars? })
 * @param {Array<Record<string, any>> | Record<string, any>} input
 * @param {Record<string, any>} [options]
 * @returns {boolean}
 */
export function shouldCompact(input, options = {}) {
  const objectForm = !Array.isArray(input);
  const config = objectForm ? input || {} : options || {};
  const messages = objectForm ? null : input;
  const model = config.model !== undefined ? String(config.model) : null;
  if (model !== null && !isCompactionSupported(model, { internalTier: config.internalTier === true })) return false;

  const pairCount = Number.isInteger(config.pairCount) ? Math.max(0, config.pairCount) : messages ? countPairs(messages) : 0;
  const coveredPairCount = Number.isInteger(config.coveredPairCount) && config.coveredPairCount >= 0 ? config.coveredPairCount : 0;
  // `0` / null / undefined mean "no activation target configured" → fall back to the pair rule
  // (duck.ai only passes a positive target; 0 must not silently disable compaction).
  let activationTargetPairCount = config.activationTargetPairCount;
  if (activationTargetPairCount === 0 || activationTargetPairCount === null || activationTargetPairCount === undefined) {
    activationTargetPairCount = null;
  }
  if (activationTargetPairCount !== null) {
    if (!Number.isInteger(activationTargetPairCount) || activationTargetPairCount <= 0) return false;
    return activationTargetPairCount > coveredPairCount && activationTargetPairCount <= pairCount;
  }
  // Legacy char heuristic (gateway-only; duck.ai never uses chars).
  if (Number.isFinite(Number(config.triggerChars)) && Number(config.triggerChars) > 0) {
    return estimateChars(messages || []) >= Number(config.triggerChars);
  }
  const allowPairFallback = config.allowPairFallback !== false;
  if (!allowPairFallback) return false;
  return pairCount - coveredPairCount >= FALLBACK_MIN_NEW_PAIRS && pairCount >= FALLBACK_MIN_NEW_PAIRS;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Extract plain text from OpenAI-style content (string or content-parts array). */
function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part.text === 'string') return part.text;
        if (part.type === 'text' && typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return '';
}

/** Messages that participate in a summary (skip reasoning-only and empty messages). */
function summarizableMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const result = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role : '';
    if (role === 'reasoning') continue;
    const text = messageText(message.content).trim();
    if (!text) continue;
    result.push({ role: role || 'user', content: text });
  }
  return result;
}

/**
 * Serialize messages as a plain-text transcript (`[user] ...`, `[assistant] ...`).
 * Skips reasoning-only and empty messages.
 * @param {Array<Record<string, any>>} messages
 * @returns {string}
 */
export function serializeMessages(messages) {
  return summarizableMessages(messages)
    .map((message) => `[${message.role}] ${message.content}`)
    .join('\n\n');
}

/**
 * Character count of the messages that would be summarized (content only, no role prefixes).
 * @param {Array<Record<string, any>>} messages
 * @returns {number}
 */
export function estimateChars(messages) {
  return summarizableMessages(messages).reduce((total, message) => total + message.content.length, 0);
}

/**
 * Rough token estimate for prompts/character counts (conservative, language-agnostic).
 * @param {number | string} input
 * @returns {number}
 */
export function estimateTokens(input) {
  const chars = typeof input === 'number' ? input : String(input ?? '').length;
  return Math.ceil(chars / 3);
}

/**
 * Build the summarization instruction prompt.
 * @param {{ maxSummaryChars?: number, previousSummary?: string }} [options]
 * @returns {string}
 */
export function buildSummaryPrompt(options = {}) {
  const maxSummaryChars = clamp(Math.floor(Number(options.maxSummaryChars) || DEFAULT_MAX_SUMMARY_CHARS), MIN_SUMMARY_CHARS, MAX_SUMMARY_PROMPT_CHARS);
  const hasPrevious = typeof options.previousSummary === 'string' && options.previousSummary.trim().length > 0;
  const lines = [
    'You are producing a compact conversation summary for context compression.',
    'Preserve, when present: the user goals, confirmed facts, decisions made, pending work/open questions, and key numbers, identifiers, constraints, code or commands.',
    'Do not invent or guess; if something is unknown, write "unknown". Do not add greetings, opinions, or meta-commentary.',
    'Return plain text only (no markdown headings, no code fences unless quoting code). Keep it under ' + maxSummaryChars + ' characters.',
    'Prefer terse bullet lines starting with "- ". Write in the dominant language of the conversation.'
  ];
  if (hasPrevious) {
    lines.push('An existing summary is provided; merge new information into it and do not repeat unchanged details.');
  }
  return lines.join('\n');
}

/** Trim a serialized transcript to the tail so the prompt fits the model input budget. */
function fitTranscript(serialized, budget) {
  if (typeof serialized !== 'string') return '';
  if (serialized.length <= budget) return serialized;
  const marker = '[...earlier conversation truncated...]\n';
  const keep = Math.max(0, budget - marker.length);
  return marker + serialized.slice(serialized.length - keep);
}

function toDuckError(error, fallbackType = 'summary_failed') {
  if (error instanceof DuckError) {
    if (typeof error.retriable !== 'boolean') {
      error.retriable = error.status === 429 || error.status >= 500 || error.type === 'network';
    }
    return error;
  }
  const status = Number(error && error.status) || 502;
  const duckError = new DuckError(String((error && error.message) || error), {
    status,
    type: fallbackType,
    retriable: status === 429 || status >= 500,
    detail: error && error.detail,
    cause: error
  });
  return duckError;
}

/**
 * Summarize a conversation with a Duck client (non-streaming; the client aggregates SSE).
 *
 * @param {{ chat: Function, defaultModel?: string }} client DuckClient (or compatible mock)
 * @param {Array<Record<string, any>>} messages history to summarize (excluding the messages kept verbatim)
 * @param {{
 *   model?: string,
 *   maxSummaryChars?: number,
 *   previousSummary?: string,
 *   systemPrompt?: string,
 *   signal?: AbortSignal,
 *   inputCharsLimit?: number
 * }} [options]
 * @returns {Promise<{
 *   ok: true, text: string, summary: string, model: string,
 *   inputChars: number, outputChars: number, coveredMessageCount: number,
 *   previousSummaryUsed: boolean,
 *   usage: { inputChars: number, outputChars: number, estimatedInputTokens: number, estimatedOutputTokens: number },
 *   finishReason: string | null
 * }>}
 */
export async function summarizeMessages(client, messages, options = {}) {
  if (!client || typeof client.chat !== 'function') {
    throw new DuckError('summarizeMessages requires a DuckClient-like object with chat()', {
      status: 400,
      type: 'invalid_request',
      retriable: false
    });
  }
  const included = summarizableMessages(messages);
  if (!included.length) {
    throw new DuckError('messages is required and must contain at least one non-empty message', {
      status: 400,
      type: 'invalid_request',
      retriable: false
    });
  }
  const model = String(options.model || client.defaultModel || DEFAULT_MODEL);
  const capabilities = getModelCapabilities(model);
  const maxSummaryChars = clamp(
    Math.floor(Number(options.maxSummaryChars) || DEFAULT_MAX_SUMMARY_CHARS),
    MIN_SUMMARY_CHARS,
    MAX_SUMMARY_PROMPT_CHARS
  );
  const rawPrevious = options.previousSummary;
  const previousSummary = typeof rawPrevious === 'string'
    ? rawPrevious.trim()
    : rawPrevious && typeof rawPrevious.text === 'string'
      ? rawPrevious.text.trim()
      : '';
  const previousVersion = Number.isFinite(Number(options.previousSummaryVersion))
    ? Number(options.previousSummaryVersion)
    : rawPrevious && Number.isFinite(Number(rawPrevious.version))
      ? Number(rawPrevious.version)
      : 0;

  // Preferred path: Duck.ai native summarizer (POST /duckchat/v1/summarize), but only for models
  // in duck.ai's compaction allow-list (`Ce`); e.g. gpt-6-luna upstream returns
  // ERR_MODEL_UNAVAILABLE (404) because it never auto-compacts.
  const nativeSupported = isCompactionSupported(model, { internalTier: options.internalTier === true });
  if (nativeSupported && typeof client.summarizeNative === 'function') {
    try {
      const native = await client.summarizeNative({
        model,
        messages,
        newMessages: options.newMessages,
        previousSummary: previousSummary ? { text: previousSummary, version: previousVersion } : null,
        targetPairCount: options.targetPairCount,
        coveredPairCount: options.coveredPairCount,
        systemPromptMode: options.systemPromptMode,
        systemPrompt: options.systemPrompt,
        extraHeaders: options.extraHeaders,
        signal: options.signal
      });
      const nativeText = String((native && native.text) || '').trim();
      if (!nativeText) {
        throw new DuckError('native summarizer returned an empty summary', { status: 502, type: 'empty_summary', retriable: true });
      }
      const text = nativeText.slice(0, maxSummaryChars);
      const outputChars = text.length;
      const inputChars = estimateChars(included) + previousSummary.length;
      return {
        ok: true,
        text,
        summary: text,
        model,
        inputChars,
        outputChars,
        coveredMessageCount: included.length,
        coveredPairCount: native.coveredPairCount ?? null,
        previousSummaryUsed: Boolean(previousSummary),
        previousSummaryVersion: previousVersion || null,
        summaryVersion: native.version ?? null,
        fixedCostWindowUsage: native.fixedCostWindowUsage ?? null,
        native: true,
        fallbackReason: null,
        usage: {
          inputChars,
          outputChars,
          estimatedInputTokens: estimateTokens(inputChars),
          estimatedOutputTokens: estimateTokens(outputChars)
        },
        finishReason: 'stop'
      };
    } catch (nativeError) {
      // Rate-limit / challenge failures would also hit the chat fallback: surface them directly
      // instead of burning another upstream request (caller handles Retry-After).
      const nativeStatus = Number(nativeError && (nativeError.transportStatus ?? nativeError.httpStatus ?? nativeError.status));
      if (nativeStatus === 418 || nativeStatus === 429) {
        throw nativeError;
      }
      // Fall back to a normal chat summary (e.g. endpoint missing on an older upstream / 4xx).
      const fallbackReason = (nativeError && (nativeError.code || nativeError.type || nativeError.message)) || 'native_unavailable';
      try {
        return await summarizeWithChat(client, included, {
          model,
          maxSummaryChars,
          previousSummary,
          previousVersion,
          capabilities,
          options,
          fallbackReason
        });
      } catch (chatError) {
        if (chatError instanceof DuckError) {
          chatError.nativeError = {
            code: nativeError && nativeError.code,
            type: nativeError && nativeError.type,
            status: nativeError && nativeError.status,
            message: String((nativeError && nativeError.message) || nativeError)
          };
        }
        throw chatError;
      }
    }
  }

  return summarizeWithChat(client, included, {
    model,
    maxSummaryChars,
    previousSummary,
    previousVersion,
    capabilities,
    options,
    fallbackReason: nativeSupported ? null : 'compaction_unsupported_model'
  });
}

/** Chat-completion fallback summarizer. */
async function summarizeWithChat(client, included, context) {
  const { model, maxSummaryChars, previousSummary, previousVersion, capabilities, options, fallbackReason } = context;
  const prompt = options.systemPrompt && String(options.systemPrompt).trim()
    ? String(options.systemPrompt).trim()
    : buildSummaryPrompt({ maxSummaryChars, previousSummary });
  const inputLimit = Number.isFinite(Number(options.inputCharsLimit))
    ? Math.max(1000, Math.floor(Number(options.inputCharsLimit)))
    : Math.max(1000, Number(capabilities?.maxInputChars) || 16000);
  const serialized = serializeMessages(included);
  const previousBlock = previousSummary ? `Existing summary (merge new information; do not repeat unchanged details):\n${previousSummary}\n\n` : '';
  const transcriptBudget = Math.max(500, inputLimit - prompt.length - previousBlock.length - 100);
  const transcript = fitTranscript(serialized, transcriptBudget);
  const userContent = `${prompt}\n\n${previousBlock}Conversation to summarize:\n${transcript}`;
  let result;
  try {
    result = await client.chat(
      {
        model,
        messages: [{ role: 'user', content: userContent }],
        reasoningEffort: 'none',
        signal: options.signal
      },
      {}
    );
  } catch (error) {
    throw toDuckError(error);
  }
  const rawText = typeof result === 'string'
    ? result
    : (result && (result.cleanContent ?? result.content ?? result.markdown ?? '')) || '';
  const text = String(rawText).trim().slice(0, maxSummaryChars);
  if (!text) {
    throw new DuckError('summarizer returned an empty summary', { status: 502, type: 'empty_summary', retriable: true });
  }
  const inputChars = userContent.length;
  const outputChars = text.length;
  return {
    ok: true,
    text,
    summary: text,
    model: (result && result.model) || model,
    inputChars,
    outputChars,
    coveredMessageCount: included.length,
    coveredPairCount: null,
    previousSummaryUsed: Boolean(previousSummary),
    previousSummaryVersion: previousVersion || null,
    summaryVersion: null,
    fixedCostWindowUsage: null,
    native: false,
    fallbackReason,
    usage: {
      inputChars,
      outputChars,
      estimatedInputTokens: estimateTokens(inputChars),
      estimatedOutputTokens: estimateTokens(outputChars)
    },
    finishReason: (result && result.finishReason) || null
  };
}

export default {
  buildSummaryPrompt,
  serializeMessages,
  estimateChars,
  estimateTokens,
  shouldCompact,
  summarizeMessages,
  COMPACTION_MODELS,
  COMPACTION_INTERNAL_ONLY,
  FALLBACK_MIN_NEW_PAIRS,
  isCompactionSupported,
  getActivationTargetPairCount,
  parseCompactMarkers,
  countPairs,
  DEFAULT_MAX_SUMMARY_CHARS,
  MIN_SUMMARY_CHARS,
  MAX_SUMMARY_PROMPT_CHARS,
  SUMMARY_PROMPT_VERSION
};
