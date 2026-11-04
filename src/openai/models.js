/**
 * Model catalog + request-side model resolution for the OpenAI-compatible layer.
 *
 * Source of truth is `src/duck/models.js` (owned by duck-protocol). The upstream
 * client may expose a richer catalog via `getModelCatalog()`; when it does we
 * normalize it, otherwise we fall back to the static catalog.
 */

import { DUCK_MODELS, DEFAULT_MODEL, MODEL_ALIASES } from '../duck/models.js';
import { REASONING_EFFORTS } from '../config.js';
import { badRequest, genId, modelRequiresSubscription, nowSec } from './errors.js';
import { isCompactionSupportedModel } from './compact.js';

export const MODEL_CREATED_AT = 1735689600; // 2025-01-01, stable "created" for /v1/models
export const TOOL_WEB_SEARCH = 'web_search';
export const TOOL_IMAGE_GENERATION = 'image_generation';

/** Free / paid (Plus/Pro) duck.ai models — v2 contract, docs/ADMIN_API_V2.md §4. */
export const FREE_MODEL_IDS = Object.freeze([
  'gpt-6-luna',
  'gpt-5.4-mini',
  'claude-haiku-4-5',
  'mistral-small-2603',
  'tinfoil/gpt-oss-120b',
  'tinfoil/gemma4-31b'
]);

export const PAID_MODEL_IDS = Object.freeze([
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'claude-sonnet-5-5',
  'claude-opus-5-5'
]);

export function isPaidModel(id) {
  return PAID_MODEL_IDS.includes(String(id || ''));
}

/** Model tier badge: free / plus / pro. */
export function modelTier(id, entry = null) {
  if (!isPaidModel(id)) return 'free';
  const tiers = Array.isArray(entry?.tiers) ? entry.tiers : [];
  if (tiers.includes('plus')) return 'plus';
  return 'pro';
}

/** Paid models are only available when `duck.allowPaidModels=true`. */
export function isModelAvailable(config, entryOrId) {
  const id = typeof entryOrId === 'string' ? entryOrId : entryOrId?.id;
  if (!isPaidModel(id)) return true;
  return config?.duck?.allowPaidModels === true;
}

/** Add v2 free/paid metadata to a normalized catalog entry. */
export function decorateModelEntry(config, entry) {
  const paid = isPaidModel(entry.id);
  return {
    ...entry,
    paid,
    tier: modelTier(entry.id, entry),
    available: !paid || config?.duck?.allowPaidModels === true,
    requires_subscription: paid,
    display_name: entry.name,
    supported_reasoning_efforts: entry.reasoningEfforts
  };
}

const REASONING_RANK = Object.freeze({ none: 0, minimal: 1, low: 2, medium: 3, high: 4 });

/* ------------------------------------------------------------------ */
/* Catalog normalization                                               */
/* ------------------------------------------------------------------ */

export function normalizeToolName(tool) {
  const value = typeof tool === 'string' ? tool.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  if (value === 'websearch' || value === 'web_search' || value === 'web_search_preview') return TOOL_WEB_SEARCH;
  if (value === 'generateimage' || value === 'generate_image' || value === 'image_generation' || value === 'imagegen') {
    return TOOL_IMAGE_GENERATION;
  }
  return null;
}

export function normalizeToolList(tools) {
  if (!Array.isArray(tools)) return [];
  const result = new Set();
  for (const tool of tools) {
    const normalized = normalizeToolName(tool);
    if (normalized) result.add(normalized);
  }
  // Preserve a stable, meaningful order.
  return [TOOL_WEB_SEARCH, TOOL_IMAGE_GENERATION].filter((tool) => result.has(tool));
}

function displayName(raw) {
  if (typeof raw.name === 'string' && raw.name.trim()) return raw.name.trim();
  const parts = [raw.modelName, raw.modelVariant].filter((part) => typeof part === 'string' && part.trim());
  if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').trim();
  return raw.model || raw.id || 'unknown';
}

/**
 * v2.20 context capability defaults, based on real conversation measurement
 * (docs/CONTEXT-TOKENS.md §B, scripts/limit-probe-gateway.mjs):
 *   - 单条消息实测：19,500 字符通过、19,600 字符被拒（中/英文同一字符边界 → 按字符不按 token）
 *   - duck.ai 前端 inputCharLimit=16,000 只是 UI 软限制，不是服务端硬限制
 *   - 输出长度实测下界：gpt-6-luna 6,427 字符 / gpt-5.4-mini 4,335 字符（"尽量长"写作请求）
 *   - 输出 token 上限无客户端常量 → 4096 为估算值（保留 estimated 标记）
 */
export const DEFAULT_CONTEXT_WINDOW_CHARS = 20000;
/** v2.21: 模型配置页允许的字段与上下限（与 src/config.js 的规范化保持一致）。 */
export const MODEL_CONFIG_LIMITS = Object.freeze({
  context_window_chars: { min: 256, max: 200000, step: 100 },
  max_input_chars: { min: 64, max: 200000, step: 100 },
  max_output_tokens: { min: 16, max: 131072, step: 1 }
});
export const SESSION_LIMIT_BEHAVIORS = Object.freeze(['summarize_and_continue', 'new_chat']);
/** v2.22：网关当前支持（可被开关）的工具名。 */
export const TOOL_NAMES = Object.freeze(['web_search', 'image_generation']);
export const DEFAULT_MAX_INPUT_CHARS = 19500;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const CHARS_PER_TOKEN_ESTIMATE = 3;

function modelContextCapabilities(raw, id, reasoningEfforts, tools, tier) {
  const upstreamCaps = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  const contextWindowChars = Number.isFinite(upstreamCaps.contextWindowChars)
    ? upstreamCaps.contextWindowChars
    : Number.isFinite(raw.contextWindowChars)
      ? raw.contextWindowChars
      : Number.isFinite(raw.maxInputChars)
        ? raw.maxInputChars
        : Number.isFinite(raw.inputCharLimit)
          ? raw.inputCharLimit
          : DEFAULT_CONTEXT_WINDOW_CHARS;
  const maxOutputTokens = Number.isFinite(upstreamCaps.maxOutputTokens)
    ? upstreamCaps.maxOutputTokens
    : Number.isFinite(raw.maxOutputTokens)
      ? raw.maxOutputTokens
      : DEFAULT_MAX_OUTPUT_TOKENS;
  // v2.21 修复：上游 catalog 若通过 capabilities 给出 maxOutputTokens 并显式标 estimated:false，
  // 不能因为 raw.maxOutputTokens 缺失就误判成估算值（api-core 复核发现）。
  const maxOutputTokensEstimated =
    upstreamCaps.maxOutputTokensEstimated === true ||
    raw.maxOutputTokensEstimated === true ||
    (!Number.isFinite(raw.maxOutputTokens) && !Number.isFinite(upstreamCaps.maxOutputTokens));
  const maxInputChars = Number.isFinite(upstreamCaps.maxInputChars)
    ? upstreamCaps.maxInputChars
    : Number.isFinite(raw.maxInputChars)
      ? raw.maxInputChars
      : DEFAULT_MAX_INPUT_CHARS;
  const maxInputTokensEstimate = Math.max(1, Math.floor(maxInputChars / CHARS_PER_TOKEN_ESTIMATE));
  const inputCharLimit = Number.isFinite(raw.inputCharLimit) ? raw.inputCharLimit : contextWindowChars;
  const compactionSupported =
    raw.compactionSupported === true || upstreamCaps.compactionSupported === true || isCompactionSupportedModel(id);
  const activationSource =
    raw.activationTargetPairCount ?? upstreamCaps.activationTargetPairCount;
  const activationTargetPairCount =
    Number.isFinite(activationSource) && activationSource > 0 ? Math.trunc(activationSource) : 0;
  // v2.20: how a model behaves when the chat reaches its maximum length.
  // - summarize_and_continue: duck.ai offers "Summarize and Continue" (compaction whitelist)
  // - new_chat: upstream errors with DUCKCHAT_ERROR_CONVERSATION_LIMIT → user must start a new chat
  //   (no automatic new session in the protocol; see docs/CONTEXT-TOKENS.md)
  const sessionLimitBehavior = compactionSupported ? 'summarize_and_continue' : 'new_chat';
  // Token thresholds are computed server-side and only delivered at runtime via
  // [SUMMARY_REFRESH_HINT].thresholdTokens; no client-side constant exists.
  const compactionTrigger = compactionSupported ? 'tokens' : null;
  const compactionThresholdTokens = null;
  return {
    contextWindowChars,
    maxInputChars,
    maxInputTokensEstimate,
    maxOutputTokens,
    maxOutputTokensEstimated,
    inputCharLimit,
    compactionSupported,
    activationTargetPairCount,
    sessionLimitBehavior,
    compactionTrigger,
    compactionThresholdTokens,
    capabilities: {
      webSearch: tools.includes(TOOL_WEB_SEARCH),
      imageGeneration: tools.includes(TOOL_IMAGE_GENERATION),
      reasoningEfforts,
      tier,
      contextWindowChars,
      maxInputChars,
      maxOutputTokens,
      maxOutputTokensEstimated,
      inputCharLimit,
      compactionSupported,
      activationTargetPairCount,
      sessionLimitBehavior,
      compactionTrigger,
      compactionThresholdTokens
    }
  };
}

/** Normalize one catalog entry (static or provided by DuckClient). */
export function normalizeModelEntry(raw = {}) {
  const id = String(raw.model || raw.id || raw.modelName || '').trim();
  const reasoningEfforts = Array.isArray(raw.reasoningEfforts)
    ? REASONING_EFFORTS.filter((effort) => raw.reasoningEfforts.includes(effort))
    : Array.isArray(raw.supportedReasoningEffort)
      ? REASONING_EFFORTS.filter((effort) => raw.supportedReasoningEffort.includes(effort))
      : [];
  const upstreamTools = Array.isArray(raw.tools) ? raw.tools.map(String) : [];
  const tools = normalizeToolList(upstreamTools);
  const tier = modelTier(id, raw);
  const capabilityFields = modelContextCapabilities(raw, id, reasoningEfforts, tools, tier);
  return {
    id,
    name: displayName(raw),
    display_name: displayName(raw),
    shortName: typeof raw.shortName === 'string' ? raw.shortName : undefined,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : 'duck.ai',
    modelType: typeof raw.modelType === 'string' ? raw.modelType : reasoningEfforts.length ? 'reasoning' : 'general',
    reasoningEfforts,
    supported_reasoning_efforts: reasoningEfforts,
    reasoning: reasoningEfforts.length > 0,
    paid: isPaidModel(id),
    tier,
    requires_subscription: isPaidModel(id),
    tools,
    upstreamTools,
    tiers: Array.isArray(raw.tiers) ? raw.tiers.map(String) : [],
    default: raw.default === true,
    costRank: Number.isFinite(raw.costRank) ? raw.costRank : null,
    isOpenSource: raw.isOpenSource === true,
    isEncrypted: raw.isEncrypted === true,
    ...capabilityFields
  };
}

/** v2.21：把 config.models.overrides[id] 应用到模型条目（返回新对象）。 */
export function applyModelOverride(entry, override) {
  if (!entry || !override || typeof override !== 'object') return entry;
  const next = { ...entry, capabilities: { ...(entry.capabilities || {}) } };
  const contextChars = Number(override.context_window_chars);
  const inputChars = Number(override.max_input_chars);
  const outputTokens = Number(override.max_output_tokens);
  const behavior = override.session_limit_behavior;
  if (Number.isFinite(contextChars) && contextChars > 0) {
    next.contextWindowChars = Math.trunc(contextChars);
    next.capabilities.contextWindowChars = next.contextWindowChars;
  }
  if (Number.isFinite(inputChars) && inputChars > 0) {
    next.maxInputChars = Math.trunc(inputChars);
    next.maxInputTokensEstimate = Math.max(1, Math.floor(next.maxInputChars / CHARS_PER_TOKEN_ESTIMATE));
    next.inputCharLimit = Math.min(Number(next.inputCharLimit) || next.maxInputChars, next.maxInputChars);
    next.capabilities.maxInputChars = next.maxInputChars;
    next.capabilities.maxInputTokens = next.maxInputTokensEstimate;
  }
  if (Number.isFinite(outputTokens) && outputTokens > 0) {
    next.maxOutputTokens = Math.trunc(outputTokens);
    next.maxOutputTokensEstimated = false;
    next.capabilities.maxOutputTokens = next.maxOutputTokens;
    next.capabilities.maxOutputTokensEstimated = false;
  }
  if (behavior === 'new_chat' || behavior === 'summarize_and_continue') {
    next.sessionLimitBehavior = behavior;
    next.capabilities.sessionLimitBehavior = behavior;
  }
  return next;
}

export function getModelOverrides(config) {
  const overrides = config?.models?.overrides;
  return overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
}

/**
 * v2.22：校验 admin 提交的工具策略。
 * @returns {{ policy: {strictUnsupported:boolean, perModel:Record<string,Record<string,boolean>>}, errors: string[] }}
 */
export function validateModelToolPolicy(raw, catalogItems = []) {
  if (raw === undefined || raw === null) return { policy: null, errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { policy: null, errors: ['tools 必须是对象'] };
  if (raw.strictUnsupported !== undefined) {
    return { policy: null, errors: ['tools.strictUnsupported 已废弃，请使用 tools.dropUnsupported（true=静默清理）'] };
  }
  const errors = [];
  const byId = new Map((Array.isArray(catalogItems) ? catalogItems : []).map((item) => [item.id, item]));
  const perModel = {};
  if (raw.perModel !== undefined) {
    if (raw.perModel === null || typeof raw.perModel !== 'object' || Array.isArray(raw.perModel)) {
      errors.push('tools.perModel 必须是对象');
    } else {
      for (const [id, value] of Object.entries(raw.perModel)) {
        const item = byId.get(id);
        if (!item) {
          errors.push(`未知模型: ${id}`);
          continue;
        }
        if (value === null) continue;
        if (typeof value !== 'object' || Array.isArray(value)) {
          errors.push(`tools.perModel.${id} 必须是对象或 null`);
          continue;
        }
        const entry = {};
        for (const [tool, flag] of Object.entries(value)) {
          if (!TOOL_NAMES.includes(tool)) {
            errors.push(`tools.perModel.${id}.${tool}: 未知 tool（仅支持 ${TOOL_NAMES.join(' / ')}）`);
            continue;
          }
          if (typeof flag !== 'boolean') {
            errors.push(`tools.perModel.${id}.${tool}: 必须是布尔值`);
            continue;
          }
          const supported = new Set(item.tools_supported || item.tools || []);
          if (!supported.has(tool)) {
            errors.push(`模型 "${id}" 不支持 ${tool}（可选项：${[...supported].join(', ') || '无'}）`);
            continue;
          }
          entry[tool] = flag;
        }
        if (Object.keys(entry).length) perModel[id] = entry;
      }
    }
  }
  let dropUnsupported = null;
  if (raw.dropUnsupported !== undefined) {
    if (typeof raw.dropUnsupported !== 'boolean') errors.push('tools.dropUnsupported 必须是布尔值');
    else dropUnsupported = raw.dropUnsupported;
  }
  return { policy: { dropUnsupported, perModel }, errors };
}

/** 模型配置页数据：每个模型的 duck.ai 默认值 + 当前覆盖值 + 允许范围。 */
export function modelConfigPayload(config) {
  const overrides = getModelOverrides(config);
  const toolPolicy = getModelToolPolicy(config);
  const items = getStaticCatalog().map((entry) => {
    const override = overrides[entry.id];
    const effective = applyModelOverride(entry, override);
    const toolState = effectiveModelTools(config, entry);
    return {
      id: entry.id,
      name: entry.name,
      tier: entry.tier,
      paid: entry.paid,
      compaction_supported: entry.compactionSupported === true,
      // v2.29：该模型可接受的推理等级（来自 duck.ai capabilities / 静态目录）
      reasoning_efforts: Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts : [],
      reasoning_efforts_supported: Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length > 0,
      session_limit_behavior: entry.sessionLimitBehavior || (entry.compactionSupported ? 'summarize_and_continue' : 'new_chat'),
      defaults: {
        context_window_chars: entry.contextWindowChars,
        max_input_chars: entry.maxInputChars,
        input_char_limit: entry.inputCharLimit,
        max_output_tokens: entry.maxOutputTokens,
        max_output_tokens_estimated: entry.maxOutputTokensEstimated === true
      },
      override: override || null,
      // v2.22：只暴露上游支持的 tool；enabled 表示管理员开关后的生效状态
      tools: TOOL_NAMES.map((tool) => ({
        name: tool,
        supported: toolState.supported.includes(tool),
        enabled: toolState.enabled.includes(tool)
      })),
      tools_supported: toolState.supported,
      tools_enabled: toolState.enabled,
      tools_disabled: toolState.disabled,
      effective: {
        context_window_chars: effective.contextWindowChars,
        max_input_chars: effective.maxInputChars,
        max_input_tokens: effective.maxInputTokensEstimate,
        max_output_tokens: effective.maxOutputTokens,
        max_output_tokens_estimated: effective.maxOutputTokensEstimated === true,
        session_limit_behavior: effective.sessionLimitBehavior
      }
    };
  });
  return {
    object: 'model_config',
    limits: MODEL_CONFIG_LIMITS,
    // v2.23：drop_unsupported_tool=true（默认）= 静默清理；false = 报错 400
    drop_unsupported_tool: toolPolicy.dropUnsupported !== false,
    tool_names: TOOL_NAMES,
    defaults: {
      context_window_chars: DEFAULT_CONTEXT_WINDOW_CHARS,
      max_input_chars: DEFAULT_MAX_INPUT_CHARS,
      max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      session_limit_behavior: 'new_chat'
    },
    items
  };
}

/**
 * 校验并规范化 admin 提交的 overrides；返回 { overrides, errors }。
 * 未知模型 / 未知字段 / 越界值都会报错（整体 400）。
 */
export function validateModelOverrides(raw, catalogIds = new Set(DUCK_MODELS.map((model) => model.model))) {
  if (raw === undefined || raw === null) return { overrides: {}, errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { overrides: {}, errors: ['overrides 必须是对象'] };
  }
  const overrides = {};
  const errors = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!catalogIds.has(id)) {
      errors.push(`未知模型: ${id}`);
      continue;
    }
    if (value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${id}: 配置必须是对象或 null`);
      continue;
    }
    const entry = {};
    const checkNumber = (field, input) => {
      const bounds = MODEL_CONFIG_LIMITS[field];
      if (input === undefined || input === null || input === '') return undefined;
      const parsed = Number(input);
      if (!Number.isFinite(parsed)) {
        errors.push(`${id}.${field}: 必须是数字`);
        return undefined;
      }
      if (parsed < bounds.min || parsed > bounds.max) {
        errors.push(`${id}.${field}: 需在 ${bounds.min}–${bounds.max} 之间`);
        return undefined;
      }
      return Math.trunc(parsed);
    };
    const contextChars = checkNumber('context_window_chars', value.context_window_chars);
    const inputChars = checkNumber('max_input_chars', value.max_input_chars);
    const outputTokens = checkNumber('max_output_tokens', value.max_output_tokens);
    if (contextChars !== undefined) entry.context_window_chars = contextChars;
    if (inputChars !== undefined) entry.max_input_chars = inputChars;
    if (outputTokens !== undefined) entry.max_output_tokens = outputTokens;
    if (value.session_limit_behavior !== undefined) {
      if (!SESSION_LIMIT_BEHAVIORS.includes(value.session_limit_behavior)) {
        errors.push(`${id}.session_limit_behavior: 只允许 ${SESSION_LIMIT_BEHAVIORS.join(' / ')}`);
      } else {
        entry.session_limit_behavior = value.session_limit_behavior;
      }
    }
    if (entry.max_input_chars !== undefined && entry.context_window_chars !== undefined && entry.max_input_chars > entry.context_window_chars) {
      errors.push(`${id}: max_input_chars 不能大于 context_window_chars`);
    }
    overrides[id] = entry;
  }
  return { overrides, errors };
}

/** Static catalog from src/duck/models.js. */
export function getStaticCatalog() {
  return DUCK_MODELS.map((model) => normalizeModelEntry(model));
}

/** Prefer the upstream client's catalog, falling back to the static one. */
export function getCatalog(ctx = {}) {
  try {
    const fromDuck = ctx.duck?.getModelCatalog?.();
    if (Array.isArray(fromDuck) && fromDuck.length > 0) {
      const normalized = fromDuck.map((model) => normalizeModelEntry(model)).filter((model) => model.id);
      if (normalized.length > 0) return normalized;
    }
  } catch {
    // Fall through to static catalog.
  }
  return getStaticCatalog();
}

export function getAliasMap(config) {
  const configured = config?.models?.aliases;
  return {
    ...MODEL_ALIASES,
    ...(configured && typeof configured === 'object' && !Array.isArray(configured) ? configured : {})
  };
}

export function defaultModelId(config) {
  const configured = config?.duck?.defaultModel;
  return typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_MODEL;
}

function resolveAliasTarget(aliasMap, id) {
  let current = String(id).trim();
  const seen = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || seen.has(current)) break;
    seen.add(current);
    const mapped = aliasMap[current];
    if (typeof mapped === 'string' && mapped.trim()) {
      current = mapped.trim();
      continue;
    }
    if (current.startsWith('duck-')) {
      current = current.slice(5);
      continue;
    }
    break;
  }
  return current;
}

/**
 * Resolve a requested model id (canonical, `duck-` prefixed or configured alias)
 * into a catalog entry. Throws a 400 OpenAIError for unknown models.
 */
export function resolveModel(config, requestedId, { param = 'model' } = {}) {
  const raw = requestedId == null || requestedId === '' ? defaultModelId(config) : String(requestedId).trim();
  if (!raw) throw badRequest('Missing required parameter: "model"', param, 'model_required');

  const aliasMap = getAliasMap(config);
  const target = resolveAliasTarget(aliasMap, raw);
  const catalog = getStaticCatalog();
  const model =
    catalog.find((entry) => entry.id === target) ||
    catalog.find((entry) => entry.id === target.toLowerCase()) ||
    catalog.find((entry) => entry.id.toLowerCase() === target.toLowerCase()) ||
    null;

  if (!model) {
    const available = catalog.map((entry) => entry.id).join(', ');
    throw badRequest(`Unknown model "${raw}". Available models: ${available}`, param, 'model_not_found');
  }

  // v2: paid (Plus/Pro) models are rejected locally unless explicitly enabled.
  if (isPaidModel(model.id) && config?.duck?.allowPaidModels !== true) {
    throw modelRequiresSubscription(model.id);
  }

  return {
    requested: raw,
    id: model.id,
    model: decorateModelEntry(config, model),
    aliased: model.id !== raw,
    resolvedFrom: target !== raw ? target : undefined
  };
}

/**
 * Validate/normalize a reasoning effort against the model's supported list.
 * Invalid enum values → 400. Valid-but-unsupported values are downgraded to the
 * nearest supported effort (max supported when above the range), with a note that
 * the API layer surfaces through response headers.
 */
export function resolveReasoningEffort(model, requested, { param = 'reasoning_effort' } = {}) {
  const requestedEffort = requested == null || requested === '' ? 'none' : String(requested).trim().toLowerCase();
  if (!REASONING_EFFORTS.includes(requestedEffort)) {
    throw badRequest(
      `Invalid ${param}: "${requested}". Expected one of: ${REASONING_EFFORTS.join(', ')}`,
      param,
      'invalid_reasoning_effort'
    );
  }

  const supported = Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts : [];
  if (requestedEffort === 'none') {
    return { effort: 'none', requested: requestedEffort, adjusted: false, note: null };
  }
  if (supported.length === 0) {
    return {
      effort: 'none',
      requested: requestedEffort,
      adjusted: true,
      note: `model "${model?.id || 'unknown'}" has no reasoning support; using "none"`
    };
  }
  if (supported.includes(requestedEffort)) {
    return { effort: requestedEffort, requested: requestedEffort, adjusted: false, note: null };
  }

  const supportedSorted = [...supported].sort((a, b) => REASONING_RANK[a] - REASONING_RANK[b]);
  const min = supportedSorted[0];
  const max = supportedSorted[supportedSorted.length - 1];
  const requestedRank = REASONING_RANK[requestedEffort];
  let effort;
  if (requestedRank < REASONING_RANK[min]) {
    effort = min;
  } else if (requestedRank > REASONING_RANK[max]) {
    effort = max;
  } else {
    // Nearest supported effort; ties prefer the higher effort.
    let best = supportedSorted[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of supportedSorted) {
      const distance = Math.abs(REASONING_RANK[candidate] - requestedRank);
      if (distance < bestDistance || (distance === bestDistance && REASONING_RANK[candidate] > REASONING_RANK[best])) {
        best = candidate;
        bestDistance = distance;
      }
    }
    effort = best;
  }

  return {
    effort,
    requested: requestedEffort,
    adjusted: effort !== requestedEffort,
    note: `model "${model?.id || 'unknown'}" supports reasoning_effort ${supportedSorted.join('/')}; using "${effort}"`
  };
}

/** Does the model support a normalized tool (`web_search` / `image_generation`)? */
/** v2.23：读取「模型工具策略」配置（dropUnsupported + perModel）。 */
export function getModelToolPolicy(config) {
  const raw = config?.models?.tools;
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const perModel =
    source.perModel && typeof source.perModel === 'object' && !Array.isArray(source.perModel) ? source.perModel : {};
  return { dropUnsupported: source.dropUnsupported !== false, perModel };
}

/** 某模型的上游支持工具（静态目录）与管理员开关后的生效工具。 */
export function effectiveModelTools(config, entry) {
  const supported = Array.isArray(entry?.tools) ? entry.tools.filter(Boolean) : [];
  const { perModel } = getModelToolPolicy(config);
  const override = perModel[entry?.id] && typeof perModel[entry.id] === 'object' ? perModel[entry.id] : {};
  const enabled = supported.filter((tool) => override[tool] !== false);
  const disabled = supported.filter((tool) => override[tool] === false);
  return { supported, enabled, disabled };
}

export function modelSupportsTool(model, tool) {
  const normalized = normalizeToolName(tool);
  if (!normalized) return false;
  return Array.isArray(model?.tools) && model.tools.includes(normalized);
}

/**
 * Parse an OpenAI `tools` array into gateway capability flags.
 * Only web_search / image_generation are supported; other tool types are
 * rejected with a clear error (function calling is not proxied).
 */
export function parseTools(config, tools, { param = 'tools' } = {}) {
  // v2.22：只做解析与归类，不再因为「不支持的 tool」抛错——
  // 由 resolveToolFlags 按 models.tools.strictUnsupported 决定丢弃还是报错。
  const result = { webSearch: false, imageGeneration: false, unsupported: [], malformed: [] };
  if (tools == null) return result;
  if (!Array.isArray(tools)) throw badRequest(`"${param}" must be an array`, param, 'invalid_tools');

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      throw badRequest(`Each entry of "${param}" must be an object`, param, 'invalid_tools');
    }
    const type = typeof tool.type === 'string' ? tool.type.trim().toLowerCase() : '';
    if (type === 'web_search' || type === 'web_search_preview' || type === 'websearch') {
      result.webSearch = true;
    } else if (type === 'image_generation') {
      result.imageGeneration = true;
    } else if (type === 'function') {
      // v2.44：客户端工具（function calling 桥）由 ./tool-protocol.js 处理；
      // 这里不算 unsupported，避免 strict 模式误报 400。
    } else {
      result.unsupported.push(type || '(missing type)');
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* GET /v1/models                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build the OpenAI list payload. Only canonical ids and their `duck-` prefixed
 * variants are listed; configured aliases (e.g. `gpt-6`, `gpt6`, `duck`) remain
 * resolvable by the handlers but are intentionally not listed to avoid duplicate
 * models in clients. `default_model` is resolved (never an alias id).
 */
export function listModelsPayload(config) {
  const catalog = getStaticCatalog();
  const aliasMap = getAliasMap(config);
  const overrides = getModelOverrides(config);
  const entries = [];
  const seen = new Set();

  const pushEntry = (id, entry, aliasOf = null) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    entries.push({
      id,
      object: 'model',
      created: MODEL_CREATED_AT,
      owned_by: entry.createdBy,
      created_by: entry.createdBy,
      name: entry.name,
      display_name: entry.name,
      paid: entry.paid,
      tier: entry.tier,
      available: isModelAvailable(config, entry),
      requires_subscription: entry.paid,
      reasoning: entry.reasoning,
      supported_reasoning_efforts: entry.reasoningEfforts,
      supportedReasoningEffort: entry.reasoningEfforts,
      model_type: entry.modelType,
      tools: effectiveModelTools(config, entry).enabled,
      tools_supported: effectiveModelTools(config, entry).supported,
      tools_disabled: effectiveModelTools(config, entry).disabled,
      tiers: entry.tiers,
      // v2.11 capabilities (OpenAI-compatible top-level fields + rich object).
      context_window: entry.maxInputTokensEstimate,
      context_window_chars: entry.contextWindowChars,
      max_input_tokens: entry.maxInputTokensEstimate,
      max_input_chars: entry.maxInputChars,
      input_char_limit: entry.inputCharLimit,
      compaction_supported: entry.compactionSupported === true,
      activation_target_pair_count: entry.activationTargetPairCount,
      compaction_trigger: entry.compactionTrigger ?? null,
      compaction_threshold_tokens: entry.compactionThresholdTokens ?? null,
      session_limit_behavior: entry.sessionLimitBehavior ?? (entry.compactionSupported ? 'summarize_and_continue' : 'new_chat'),
      max_output_tokens: entry.maxOutputTokens,
      max_output_tokens_estimated: entry.maxOutputTokensEstimated === true,
      capabilities: entry.capabilities,
      default: entry.id === defaultModelId(config) || entry.default,
      ...(aliasOf ? { alias_of: aliasOf } : {}),
      ...(entry.isOpenSource ? { is_open_source: true } : {}),
      ...(entry.isEncrypted ? { is_encrypted: true } : {})
    });
  };

  for (const entry of catalog) {
    const effective = applyModelOverride(entry, overrides[entry.id]);
    pushEntry(entry.id, effective);
    pushEntry(`duck-${entry.id}`, effective, entry.id);
  }

  return {
    object: 'list',
    data: entries,
    // Extra metadata for dashboards; OpenAI clients ignore unknown fields.
    default_model: resolveAliasTarget(aliasMap, defaultModelId(config))
  };
}

export async function handleListModels(req, res, ctx) {
  ctx.log.endpoint = 'GET /v1/models';
  ctx.json(200, listModelsPayload(ctx.config));
}

/** Short catalog used by admin overview/models. */
export function adminCatalogItems(config) {
  const overrides = getModelOverrides(config);
  return getStaticCatalog().map((entry) => {
    const decorated = decorateModelEntry(config, applyModelOverride(entry, overrides[entry.id]));
    return {
      id: decorated.id,
      name: decorated.name,
      display_name: decorated.display_name,
      createdBy: decorated.createdBy,
      modelType: decorated.modelType,
      paid: decorated.paid,
      tier: decorated.tier,
      available: decorated.available,
      requires_subscription: decorated.requires_subscription,
      reasoning: decorated.reasoning,
      reasoningEfforts: decorated.reasoningEfforts,
      supported_reasoning_efforts: decorated.supported_reasoning_efforts,
      supportedReasoningEffort: decorated.supported_reasoning_efforts,
      tools: effectiveModelTools(config, decorated).enabled,
      tools_supported: effectiveModelTools(config, decorated).supported,
      tools_disabled: effectiveModelTools(config, decorated).disabled,
      upstreamTools: decorated.upstreamTools,
      tiers: decorated.tiers,
      context_window: decorated.maxInputTokensEstimate,
      context_window_chars: decorated.contextWindowChars,
      max_input_tokens: decorated.maxInputTokensEstimate,
      max_output_tokens: decorated.maxOutputTokens,
      max_output_tokens_estimated: decorated.maxOutputTokensEstimated === true,
      max_input_chars: decorated.maxInputChars,
      input_char_limit: decorated.inputCharLimit,
      compaction_supported: decorated.compactionSupported === true,
      activation_target_pair_count: decorated.activationTargetPairCount,
      compaction_trigger: decorated.compactionTrigger ?? null,
      compaction_threshold_tokens: decorated.compactionThresholdTokens ?? null,
      session_limit_behavior:
        decorated.sessionLimitBehavior ?? (decorated.compactionSupported ? 'summarize_and_continue' : 'new_chat'),
      capabilities: decorated.capabilities,
      default: decorated.id === resolveAliasTarget(getAliasMap(config), defaultModelId(config)),
      costRank: decorated.costRank
    };
  });
}

/** Convenience for tests / diagnostics. */
export function modelId() {
  return genId('model_');
}

export function timestamp() {
  return nowSec();
}
