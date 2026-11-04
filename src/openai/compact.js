/**
 * v2.11 real context compaction (duck.ai native summarize).
 *
 * Duck-protocol exposes `DuckClient.summarizeMessages()` (and will expose the
 * native `/duckchat/v1/summarize` variant); this module builds the split/summary
 * shape, calls the client through the identity queue and normalizes the result.
 * Failure must fall back to the existing trim guard in the caller.
 */

import { OpenAIError } from './errors.js';
import {
  COMPACTION_MODELS as DUCK_COMPACTION_MODELS,
  countPairs as duckCountPairs,
  getActivationTargetPairCount as duckGetActivationTargetPairCount,
  isCompactionSupported as duckIsCompactionSupported,
  parseCompactMarkers as duckParseCompactMarkers,
  shouldCompact as duckShouldCompact
} from '../duck/compact.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function contentChars(messages) {
  return (Array.isArray(messages) ? messages : []).reduce(
    (sum, message) => sum + String(message?.content || '').length,
    0
  );
}

export function getCompactConfig(config) {
  const compact = config?.context?.compact;
  return {
    enabled: compact?.enabled !== false,
    // v2.12: chars are only a safety fallback; primary trigger is pair-based.
    triggerChars: Number.isFinite(compact?.triggerChars) ? compact.triggerChars : 200000,
    keepRecentMessages: Number.isFinite(compact?.keepRecentMessages) ? compact.keepRecentMessages : 6,
    maxSummaryChars: Number.isFinite(compact?.maxSummaryChars) ? compact.maxSummaryChars : 4000,
    model: typeof compact?.model === 'string' && compact.model.trim() ? compact.model.trim() : null
  };
}

/* ------------------------------------------------------------------ */
/* v2.12 duck.ai trigger semantics (model whitelist + pair counts)     */
/* ------------------------------------------------------------------ */

/** Models for which duck.ai auto-compacts (source: duck compact.js, v2.12). */
export const COMPACTION_SUPPORTED_MODELS = Object.freeze([
  ...(Array.isArray(DUCK_COMPACTION_MODELS) && DUCK_COMPACTION_MODELS.length
    ? DUCK_COMPACTION_MODELS
    : [
        'claude-haiku-4-5',
        'claude-haiku-5-5',
        'claude-sonnet-4-6',
        'claude-sonnet-5-5',
        'claude-opus-4-8',
        'claude-opus-5-5',
        'gpt-5.4-mini',
        'gpt-5.6-terra',
        'gpt-5.6-sol'
      ])
]);

export function isCompactionSupportedModel(model) {
  const id = typeof model === 'string' ? model : model?.id || model?.model || '';
  try {
    return duckIsCompactionSupported(id) === true;
  } catch {
    return COMPACTION_SUPPORTED_MODELS.includes(String(id));
  }
}

export function getActivationTargetPairCount(model) {
  const raw = typeof model === 'object' && model ? model : {};
  const explicit = raw.activationTargetPairCount ?? raw.capabilities?.activationTargetPairCount;
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  try {
    const value = duckGetActivationTargetPairCount(raw.capabilities || raw || {});
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  } catch {
    return 0;
  }
}

export function countPairs(messages) {
  try {
    const value = duckCountPairs(messages);
    if (Number.isFinite(value)) return value;
  } catch {
    // fall through
  }
  const list = Array.isArray(messages) ? messages : [];
  return Math.floor(list.length / 2);
}

/**
 * Decide whether a turn should auto-compact (delegates to duck compact.js).
 * Rules (v2.12): whitelist models only; activation target when provided;
 * otherwise 4 new pairs fallback; chars are a large safety fallback only.
 */
export function evaluateCompactionTrigger({ config, messages, summary = null, model = null } = {}) {
  const cfg = getCompactConfig(config);
  const modelId = typeof model === 'string' ? model : model?.id || model?.model || null;
  const supported = isCompactionSupportedModel(modelId || model);
  const activePairs = countPairs(messages);
  const coveredPairCount = Number.isFinite(summary?.coveredPairCount) ? Math.max(0, summary.coveredPairCount) : 0;
  const activationTargetPairCount = getActivationTargetPairCount(model);
  const chars = contentChars(messages);
  const charFallback = cfg.triggerChars > 0 && chars > cfg.triggerChars;
  let pairTrigger = false;
  try {
    pairTrigger =
      duckShouldCompact({
        model: modelId || model,
        pairCount: activePairs,
        coveredPairCount,
        activationTargetPairCount: activationTargetPairCount > 0 ? activationTargetPairCount : null,
        allowPairFallback: true,
        messageCount: Array.isArray(messages) ? messages.length : 0
      }) === true;
  } catch {
    pairTrigger =
      activationTargetPairCount > 0
        ? coveredPairCount < activationTargetPairCount && activePairs >= activationTargetPairCount
        : activePairs >= 4 && activePairs - coveredPairCount >= 4;
  }
  const should = cfg.enabled && supported && (pairTrigger || charFallback);
  return {
    should,
    supported,
    activePairs,
    coveredPairCount,
    activationTargetPairCount,
    charFallback,
    pairTrigger,
    trigger: should ? (pairTrigger ? 'tokens' : 'chars') : null,
    chars,
    thresholdChars: cfg.triggerChars
  };
}

/** Decode up to 3 rounds of URL encoding and parse a hint JSON value. */
function parseHintJson(raw) {
  let candidate = typeof raw === 'string' ? raw.trim() : '';
  for (let attempt = 0; attempt < 4 && candidate; attempt += 1) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return null;
    } catch {
      try {
        candidate = decodeURIComponent(candidate);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function normalizeHint(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    baseCoveredPairCount: Number.isFinite(parsed.baseCoveredPairCount) ? parsed.baseCoveredPairCount : null,
    targetPairCount: Number.isFinite(parsed.targetPairCount) ? parsed.targetPairCount : null,
    thresholdTokens: Number.isFinite(parsed.thresholdTokens) ? parsed.thresholdTokens : null,
    trigger: typeof parsed.trigger === 'string' ? parsed.trigger : null
  };
}

/** Parse server DONE markers; returns cleaned text plus extracted state. */
export function parseCompactionMarkers(input) {
  let text = typeof input === 'string' ? input : '';
  let summaryRefreshHint = null;
  let summaryInvalid = false;
  let limitConversation = false;
  // Prefer duck's robust parser (single/double URL encoding, value-only, etc.).
  let duckMarkers = null;
  try {
    duckMarkers = typeof duckParseCompactMarkers === 'function' ? duckParseCompactMarkers(text) : null;
  } catch {
    duckMarkers = null;
  }
  if (duckMarkers?.summaryRefreshHint) {
    summaryRefreshHint = {
      baseCoveredPairCount: Number.isFinite(duckMarkers.summaryRefreshHint.baseCoveredPairCount)
        ? duckMarkers.summaryRefreshHint.baseCoveredPairCount
        : null,
      targetPairCount: Number.isFinite(duckMarkers.summaryRefreshHint.targetPairCount)
        ? duckMarkers.summaryRefreshHint.targetPairCount
        : null,
      thresholdTokens: Number.isFinite(duckMarkers.summaryRefreshHint.thresholdTokens)
        ? duckMarkers.summaryRefreshHint.thresholdTokens
        : null,
      trigger: typeof duckMarkers.summaryRefreshHint.trigger === 'string' ? duckMarkers.summaryRefreshHint.trigger : null
    };
  }
  if (duckMarkers?.summaryInvalid === true) summaryInvalid = true;
  if (duckMarkers?.limitConversation === true) limitConversation = true;
  const hintMatch = /\[SUMMARY_REFRESH_HINT:([^\]]+)\]/s.exec(text);
  if (hintMatch) {
    const raw = hintMatch[1];
    const parsed = parseHintJson(raw);
    if (!summaryRefreshHint) summaryRefreshHint = normalizeHint(parsed);
    text = text.replace(hintMatch[0], '');
  }
  if (!summaryRefreshHint) {
    // Tolerate `SUMMARY_REFRESH_HINT:<encoded JSON>` without brackets and
    // value-only hint lines (double URL encoding supported).
    const prefixed = /SUMMARY_REFRESH_HINT:(\{.*\}|%7B[^\s]*)/s.exec(text);
    if (prefixed) {
      summaryRefreshHint = normalizeHint(parseHintJson(prefixed[1]));
      text = text.replace(prefixed[0], '');
    } else {
      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('%7B')) {
        const parsed = parseHintJson(trimmed);
        if (parsed && Number.isFinite(parsed.targetPairCount)) {
          summaryRefreshHint = normalizeHint(parsed);
          text = '';
        }
      }
    }
  }
  if (/\[SUMMARY_INVALID\]/.test(text)) {
    summaryInvalid = true;
    text = text.replace(/\[SUMMARY_INVALID\]/g, '');
  }
  if (/(\[LIMIT_CONVERSATION\]|ERR_CONVERSATION_LIMIT)/.test(text)) {
    limitConversation = true;
    text = text.replace(/\[LIMIT_CONVERSATION\]/g, '').replace(/ERR_CONVERSATION_LIMIT/g, '');
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), summaryRefreshHint, summaryInvalid, limitConversation };
}


/**
 * Split history for compaction: everything except the most recent keepRecent
 * messages is summarized; the recent messages are sent verbatim.
 */
export function splitForCompact(conversation, keepRecentMessages) {
  const messages = Array.isArray(conversation) ? conversation : [];
  const keep = Math.max(2, Number.isFinite(keepRecentMessages) ? keepRecentMessages : 6);
  if (messages.length <= keep) return { history: [], recent: messages, compactable: false };
  return {
    history: messages.slice(0, messages.length - keep),
    recent: messages.slice(messages.length - keep),
    compactable: true
  };
}

export function shouldCompactConversation(config, conversation, systemPrompt = '') {
  const cfg = getCompactConfig(config);
  if (!cfg.enabled) return false;
  const chars = contentChars(conversation) + String(systemPrompt || '').length;
  return chars > cfg.triggerChars;
}

/** Prefix the summary into the system prompt (initial context). */
export function buildCompactedSystemPrompt(systemPrompt, summary) {
  const base = typeof systemPrompt === 'string' ? systemPrompt : '';
  const text = summary && typeof summary.text === 'string' ? summary.text.trim() : '';
  if (!text) return base;
  return `${base ? `${base}\n\n` : ''}[对话摘要]\n${text}\n[/对话摘要]`;
}

export function normalizeSummary(raw, { model = null, coveredMessageCount = 0, previous = null } = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const text = typeof source.text === 'string' ? source.text : typeof raw === 'string' ? raw : '';
  // Duck native returns `summaryVersion`; chat fallback uses `version`.
  const versionSource = Number.isFinite(source.summaryVersion)
    ? source.summaryVersion
    : Number.isFinite(source.version)
      ? source.version
      : Number.isFinite(previous?.version)
        ? previous.version
        : 1;
  const coveredMessageCountValue = Number.isFinite(source.coveredMessageCount)
    ? source.coveredMessageCount
    : Number.isFinite(source.coveredPairCount)
      ? source.coveredPairCount * 2
      : coveredMessageCount;
  return {
    text: text.trim(),
    version: versionSource,
    coveredMessageCount: Math.max(0, Math.trunc(coveredMessageCountValue)),
    coveredPairCount: Number.isFinite(source.coveredPairCount)
      ? Math.max(0, Math.trunc(source.coveredPairCount))
      : Math.floor(Math.max(0, Math.trunc(coveredMessageCountValue)) / 2),
    anchorId: typeof source.anchorId === 'string' && source.anchorId ? source.anchorId : null,
    baseCompactionId:
      typeof source.baseCompactionId === 'string' && source.baseCompactionId ? source.baseCompactionId : null,
    trigger: ['tokens', 'manual', 'limit', 'chars'].includes(source.trigger) ? source.trigger : 'manual',
    // v2.19: anchor fields so the UI can render the summary fold at the position where compaction
    // actually happened (DSH-web style) instead of pinning it to the top of the conversation.
    anchorIndex: Math.max(0, Math.trunc(coveredMessageCountValue)),
    anchorMessageId:
      typeof source.anchorMessageId === 'string' && source.anchorMessageId
        ? source.anchorMessageId
        : typeof source.anchorId === 'string' && source.anchorId
          ? source.anchorId
          : null,
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : Date.now(),
    savedChars: Number.isFinite(source.savedChars) ? Math.max(0, Math.trunc(source.savedChars)) : 0,
    tokenThreshold: Number.isFinite(source.tokenThreshold) ? Math.max(0, Math.trunc(source.tokenThreshold)) : null,
    model: typeof source.model === 'string' && source.model ? source.model : model,
    updatedAt: Date.now()
  };
}

/**
 * Call duck-protocol's summarizer through the routed identity queue.
 * @returns {Promise<{text:string,version:number,coveredMessageCount:number,coveredPairCount:number,model:string|null,usage:any}>}
 */
export async function summarizeConversation(ctx, params = {}) {
  const {
    history = [],
    model = null,
    maxSummaryChars = 4000,
    systemPrompt = '',
    previousSummary = null,
    trigger = 'manual',
    savedChars = 0,
    tokenThreshold = null,
    anchorId = null,
    baseCompactionId = null
  } = params;
  if (!Array.isArray(history) || history.length === 0) {
    throw new OpenAIError('nothing to summarize', {
      status: 400,
      type: 'invalid_request_error',
      code: 'nothing_to_compact'
    });
  }
  const request = {
    messages: history.map((message) => ({ role: message.role, content: message.content })),
    model: model || undefined,
    maxSummaryChars,
    systemPrompt: systemPrompt || undefined,
    previousSummary: previousSummary || undefined
  };
  const run = async (runtime) => {
    const client = runtime?.client || ctx.duck;
    if (client && typeof client.summarizeConversation === 'function') {
      return client.summarizeConversation(request);
    }
    if (client && typeof client.summarizeMessages === 'function') {
      return client.summarizeMessages(request);
    }
    throw new OpenAIError('duck-protocol summarize API is not available', {
      status: 503,
      type: 'upstream_error',
      code: 'compact_unavailable',
      hint: 'duck-protocol summarizeMessages 未就绪；已回退为裁剪'
    });
  };
  const raw = await ctx.callUpstream(run, { model: model || undefined });
  const source = isPlainObject(raw) ? raw : {};
  const text =
    typeof source.text === 'string'
      ? source.text
      : typeof source.summary === 'string'
        ? source.summary
        : '';
  if (!text.trim()) {
    throw new OpenAIError('summarizer returned an empty summary', {
      status: 502,
      type: 'upstream_error',
      code: 'empty_summary'
    });
  }
  const coveredMessageCount = Number.isFinite(source.coveredMessageCount)
    ? source.coveredMessageCount
    : history.length;
  return normalizeSummary(
    {
      ...source,
      text,
      coveredMessageCount,
      trigger,
      savedChars,
      tokenThreshold,
      anchorId,
      baseCompactionId,
      model: source.model || model
    },
    { model, coveredMessageCount, previous: previousSummary }
  );
}

/** Parse an upstream `[SUMMARY_REFRESH_HINT:{...}]` marker if present. */
export function parseSummaryRefreshHint(text) {
  if (typeof text !== 'string') return null;
  const match = /\[SUMMARY_REFRESH_HINT:(\{.*?\})\]/s.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return {
      baseCoveredPairCount: Number.isFinite(parsed.baseCoveredPairCount) ? parsed.baseCoveredPairCount : null,
      targetPairCount: Number.isFinite(parsed.targetPairCount) ? parsed.targetPairCount : null,
      thresholdTokens: Number.isFinite(parsed.thresholdTokens) ? parsed.thresholdTokens : null,
      trigger: typeof parsed.trigger === 'string' ? parsed.trigger : null
    };
  } catch {
    return null;
  }
}

/**
 * v2.21：把 OpenAI messages 规范化为摘要输入。
 * - content 为字符串或 [{type:'text',text}] 数组
 * - 只保留 user/assistant；system/developer 拼成系统提示
 */
export function normalizeCompactMessages(rawMessages) {
  const messages = [];
  const systemParts = [];
  for (const message of Array.isArray(rawMessages) ? rawMessages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '').toLowerCase();
    let text = '';
    if (typeof message.content === 'string') {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = message.content
        .filter((part) => part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text'))
        .map((part) => String(part.text || ''))
        .join('\n');
    }
    if (!text.trim()) continue;
    if (role === 'system' || role === 'developer') {
      systemParts.push(text.trim());
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    messages.push({ role, content: text });
  }
  return { messages, systemPrompt: systemParts.join('\n\n') };
}

/**
 * POST /v1/compact —— 由客户端显式请求上下文压缩。
 * 网关不再在 409 会话上限时自动压缩；客户端先调用本接口拿摘要，再用摘要作为
 * system prompt 并只携带最近消息重新发起 /v1/chat/completions。
 */
export async function handleCompact(req, res, ctx) {
  ctx.log.endpoint = 'POST /v1/compact';
  const body = ctx.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OpenAIError('请求体必须是 JSON 对象', {
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_request'
    });
  }
  const normalized = normalizeCompactMessages(body.messages);
  const compactConfig = getCompactConfig(ctx.config);
  const history = normalized.messages.slice(0, Math.max(0, normalized.messages.length - (Number(body.keep_recent_messages ?? compactConfig.keepRecentMessages) || 0)));
  if (!history.length) {
    throw new OpenAIError('没有可压缩的历史消息（至少需要超过 keep_recent_messages 的 user/assistant 消息）', {
      status: 400,
      type: 'invalid_request_error',
      code: 'nothing_to_compact',
      param: 'messages'
    });
  }
  if (typeof ctx.selectIdentity === 'function') {
    // 压缩走匿名可用的模型；付费模型不做跨档位调度，由上游返回错误。
    await ctx.selectIdentity({ paidModel: false });
  }
  const requestedModel =
    typeof body.model === 'string' && body.model.trim()
      ? body.model.trim().replace(/^duck-/, '')
      : compactConfig.model || null;
  const previous = body.previous_summary;
  const previousSummary =
    typeof previous === 'string'
      ? { text: previous, version: 1, coveredMessageCount: 0 }
      : previous && typeof previous === 'object' && typeof previous.text === 'string'
        ? previous
        : null;
  const historyChars = history.reduce((sum, message) => sum + message.content.length, 0);
  const summary = await summarizeConversation(ctx, {
    history,
    model: requestedModel,
    maxSummaryChars: Number.isFinite(Number(body.max_summary_chars))
      ? Number(body.max_summary_chars)
      : compactConfig.maxSummaryChars,
    systemPrompt: typeof body.system_prompt === 'string' ? body.system_prompt : normalized.systemPrompt,
    previousSummary,
    trigger: 'client',
    savedChars: historyChars
  });
  ctx.json(200, {
    object: 'compaction',
    model: summary.model || body.model || null,
    summary: {
      text: summary.text,
      version: summary.version,
      covered_message_count: summary.coveredMessageCount,
      covered_pair_count: summary.coveredPairCount,
      trigger: 'client',
      saved_chars: summary.savedChars,
      model: summary.model,
      anchor_id: summary.anchorId
    },
    kept_messages: normalized.messages.slice(history.length),
    usage: {
      input_chars: historyChars,
      summary_chars: summary.text.length
    }
  });
}

export default {
  getCompactConfig,
  splitForCompact,
  shouldCompactConversation,
  buildCompactedSystemPrompt,
  normalizeSummary,
  summarizeConversation,
  parseSummaryRefreshHint,
  normalizeCompactMessages,
  handleCompact
};
