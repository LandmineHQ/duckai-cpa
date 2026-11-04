// Duck.ai model catalog (source: duck.ai web bundle; recon 2026-11-01; v2 paid/free split).
//
// Owned by the "duck-protocol" teammate. Keep in sync with docs/PROTOCOL.md and
// docs/ADMIN_API_V2.md §4.
//
// v2 fields (per model):
//   tier                     'free' | 'plus' | 'pro'      — minimum subscription tier
//   paid                     boolean                      — requires a Duck.ai subscription (Plus/Pro)
//   available                boolean                      — usable on an anonymous/public upstream session
//   requires_subscription    boolean                      — alias of `paid` (ADMIN_API_V2 §4 spelling)
//   supportedReasoningEfforts string[]                    — upstream `reasoningEffort` whitelist
//   tools                    string[]                    — API-level tool names ('web_search' | 'image_generation')
//   supportedTools           string[]                    — upstream tool names (WebSearch / GenerateImage / …)
//   displayName              string                       — human readable name
//
// Free (anonymous) models — ADMIN_API_V2 §4: gpt-6-luna, gpt-5.4-mini, claude-haiku-4-5,
// mistral-small-2603, tinfoil/gpt-oss-120b, tinfoil/gemma4-31b.
// Paid (Plus/Pro) models: gpt-5.6-terra, gpt-5.6-sol, claude-sonnet-5-5, claude-opus-5-5.

const FREE_TIER = Object.freeze({ tier: 'free', paid: false, available: true, requires_subscription: false });

/** @type {Array<Record<string, any>>} */
export const DUCK_MODELS = [
  {
    model: 'gpt-6-luna',
    modelName: 'GPT-6',
    modelVariant: 'Luna',
    displayName: 'GPT-6 Luna',
    shortName: '6 Luna',
    createdBy: 'OpenAI',
    modelType: 'reasoning',
    ...FREE_TIER,
    reasoningEfforts: ['none', 'low'],
    supportedReasoningEfforts: ['none', 'low'],
    tools: ['web_search', 'image_generation'],
    supportedTools: ['WebSearch', 'RelatedSearchTerms', 'FindInDocument', 'ReadDocument', 'ReadDocumentSelection', 'LocationPrompt', 'GenerateImage'],
    tiers: ['free', 'plus', 'pro'],
    default: true,
    costRank: 1
  },
  {
    model: 'gpt-5.4-mini',
    modelName: 'GPT-5.4',
    modelVariant: 'mini',
    displayName: 'GPT-5.4 mini',
    shortName: '5.4 mini',
    createdBy: 'OpenAI',
    modelType: 'reasoning',
    ...FREE_TIER,
    reasoningEfforts: ['none', 'low', 'medium'],
    supportedReasoningEfforts: ['none', 'low', 'medium'],
    tools: ['web_search', 'image_generation'],
    supportedTools: ['WebSearch', 'RelatedSearchTerms', 'FindInDocument', 'ReadDocument', 'ReadDocumentSelection', 'LocationPrompt', 'GenerateImage'],
    tiers: ['free', 'plus', 'pro'],
    costRank: 5
  },
  {
    model: 'claude-haiku-4-5',
    modelName: 'Claude',
    modelVariant: 'Haiku 4.5',
    displayName: 'Claude Haiku 4.5',
    shortName: 'Haiku 4.5',
    createdBy: 'Anthropic',
    modelType: 'reasoning',
    ...FREE_TIER,
    reasoningEfforts: ['none', 'low'],
    supportedReasoningEfforts: ['none', 'low'],
    tools: ['web_search'],
    supportedTools: ['WebSearch', 'RelatedSearchTerms', 'FindInDocument', 'ReadDocument', 'ReadDocumentSelection', 'LocationPrompt'],
    tiers: ['free', 'plus', 'pro'],
    costRank: 7
  },
  {
    model: 'mistral-small-2603',
    modelName: 'Mistral',
    modelVariant: 'Small 4',
    displayName: 'Mistral Small 4',
    shortName: 'Mistral',
    createdBy: 'Mistral AI',
    modelType: 'general',
    ...FREE_TIER,
    reasoningEfforts: [],
    supportedReasoningEfforts: [],
    tools: [],
    supportedTools: [],
    tiers: ['free', 'plus', 'pro'],
    isOpenSource: true,
    costRank: 3
  },
  {
    model: 'tinfoil/gpt-oss-120b',
    modelName: 'gpt-oss',
    modelVariant: '120B',
    displayName: 'gpt-oss 120B',
    shortName: 'gpt-oss',
    createdBy: 'OpenAI',
    modelType: 'reasoning',
    ...FREE_TIER,
    reasoningEfforts: ['low'],
    supportedReasoningEfforts: ['low'],
    tools: ['web_search'],
    supportedTools: ['WebSearch', 'LocationPrompt', 'FindInDocument', 'ReadDocument', 'ReadDocumentSelection'],
    tiers: ['free', 'plus', 'pro'],
    isOpenSource: true,
    isEncrypted: true,
    costRank: 6
  },
  {
    model: 'tinfoil/gemma4-31b',
    modelName: 'Gemma 4',
    modelVariant: '31B',
    displayName: 'Gemma 4 31B',
    shortName: 'Gemma',
    createdBy: 'Google',
    modelType: 'reasoning',
    ...FREE_TIER,
    reasoningEfforts: ['none', 'low'],
    supportedReasoningEfforts: ['none', 'low'],
    tools: ['web_search'],
    supportedTools: ['WebSearch', 'LocationPrompt', 'FindInDocument', 'ReadDocument', 'ReadDocumentSelection'],
    tiers: ['free', 'plus', 'pro'],
    isOpenSource: true,
    isEncrypted: true,
    costRank: 4
  },
  {
    model: 'gpt-5.6-terra',
    modelName: 'GPT-5.6',
    modelVariant: 'Terra',
    displayName: 'GPT-5.6 Terra',
    shortName: '5.6 Terra',
    createdBy: 'OpenAI',
    modelType: 'reasoning',
    tier: 'plus',
    paid: true,
    available: false,
    requires_subscription: true,
    reasoningEfforts: ['none', 'low', 'medium'],
    supportedReasoningEfforts: ['none', 'low', 'medium'],
    tools: ['web_search', 'image_generation'],
    supportedTools: ['WebSearch', 'RelatedSearchTerms', 'FindInDocument', 'ReadDocument', 'ReadDocumentSelection', 'LocationPrompt', 'GenerateImage'],
    tiers: ['plus', 'pro'],
    costRank: 8
  },
  {
    model: 'gpt-5.6-sol',
    modelName: 'GPT-5.6',
    modelVariant: 'Sol',
    displayName: 'GPT-5.6 Sol',
    shortName: '5.6-Sol',
    createdBy: 'OpenAI',
    modelType: 'reasoning',
    tier: 'pro',
    paid: true,
    available: false,
    requires_subscription: true,
    reasoningEfforts: ['none', 'low', 'medium'],
    supportedReasoningEfforts: ['none', 'low', 'medium'],
    tools: ['web_search', 'image_generation'],
    supportedTools: ['WebSearch', 'RelatedSearchTerms', 'FindInDocument', 'ReadDocument', 'ReadDocumentSelection', 'LocationPrompt', 'GenerateImage'],
    tiers: ['pro'],
    costRank: 10
  },
  {
    model: 'claude-sonnet-5-5',
    modelName: 'Claude',
    modelVariant: 'Sonnet 5.5',
    displayName: 'Claude Sonnet 5.5',
    shortName: 'Sonnet 5.5',
    createdBy: 'Anthropic',
    modelType: 'reasoning',
    tier: 'plus',
    paid: true,
    available: false,
    requires_subscription: true,
    reasoningEfforts: ['none', 'low'],
    supportedReasoningEfforts: ['none', 'low'],
    tools: ['web_search', 'image_generation'],
    supportedTools: ['WebSearch', 'RelatedSearchTerms', 'FindInDocument', 'ReadDocument', 'ReadDocumentSelection', 'LocationPrompt', 'GenerateImage', 'WritingBlocks'],
    tiers: ['plus', 'pro'],
    costRank: 9
  },
  {
    model: 'claude-opus-5-5',
    modelName: 'Claude',
    modelVariant: 'Opus 5.5',
    displayName: 'Claude Opus 5.5',
    shortName: 'Opus 5.5',
    createdBy: 'Anthropic',
    modelType: 'reasoning',
    tier: 'pro',
    paid: true,
    available: false,
    requires_subscription: true,
    reasoningEfforts: ['none', 'low', 'medium'],
    supportedReasoningEfforts: ['none', 'low', 'medium'],
    tools: ['web_search', 'image_generation'],
    supportedTools: ['WebSearch', 'RelatedSearchTerms', 'FindInDocument', 'ReadDocument', 'ReadDocumentSelection', 'LocationPrompt', 'GenerateImage', 'WritingBlocks'],
    tiers: ['pro'],
    costRank: 11
  }
];

// ---------------------------------------------------------------------------
// v2.11 context/compact metadata
// ---------------------------------------------------------------------------

/**
 * v2.20 实测（docs/CONTEXT-TOKENS.md §B，scripts/limit-probe-gateway.mjs）：
 *   - 单条消息：19,500 字符通过 / 19,600 字符被拒（中英文同一字符边界 → 按字符不按 token）
 *   - duck.ai 前端 `inputCharLimit`=16,000 是 UI 软限制，不是服务端硬限制
 *   - 输出长度实测下界：gpt-6-luna 6,427 字符、gpt-5.4-mini 4,335 字符
 */
export const DEFAULT_CONTEXT_WINDOW_CHARS = 20000;
/** 单条消息实测安全值（19,500 通过；19,600 被上游拒绝）。 */
export const DEFAULT_MAX_INPUT_CHARS = 19500;
/** No upstream output-token value is published in the catalog → conservative estimate. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

for (const model of DUCK_MODELS) {
  if (!Number.isFinite(model.contextWindowChars)) model.contextWindowChars = DEFAULT_CONTEXT_WINDOW_CHARS;
  if (!Number.isFinite(model.maxInputChars)) model.maxInputChars = DEFAULT_MAX_INPUT_CHARS;
  if (model.inputCharLimit === undefined) model.inputCharLimit = 16000;
  if (!Number.isFinite(model.maxOutputTokens)) {
    model.maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
    model.maxOutputTokensEstimated = true;
  } else if (model.maxOutputTokensEstimated === undefined) {
    model.maxOutputTokensEstimated = false;
  }
  const tools = Array.isArray(model.tools) ? model.tools : [];
  model.capabilities = {
    webSearch: tools.includes('web_search'),
    imageGeneration: tools.includes('image_generation'),
    reasoningEfforts: [...(model.supportedReasoningEfforts || [])],
    tier: model.tier,
    contextWindowChars: model.contextWindowChars,
    maxInputChars: model.maxInputChars,
    maxOutputTokens: model.maxOutputTokens,
    maxOutputTokensEstimated: model.maxOutputTokensEstimated
  };
}

export const DEFAULT_MODEL = 'gpt-6-luna';

export const MODEL_ALIASES = {
  'gpt-6': 'gpt-6-luna',
  gpt6: 'gpt-6-luna',
  duck: 'gpt-6-luna'
};

/** Free (anonymous) models exposed by the gateway catalog. */
export const FREE_MODELS = DUCK_MODELS.filter((model) => !model.paid).map((model) => model.model);

/** Subscription-only (Plus/Pro) models. Requests need `duck.allowPaidModels=true`. */
export const PAID_MODELS = DUCK_MODELS.filter((model) => model.paid).map((model) => model.model);

/**
 * @param {string | null | undefined} id
 * @returns {Record<string, any> | null}
 */
export function findModel(id) {
  if (!id) return null;
  const normalized = MODEL_ALIASES[id] || id;
  const prefixed = normalized.startsWith('duck-') ? normalized.slice(5) : normalized;
  return (
    DUCK_MODELS.find((model) => model.model === normalized) ||
    DUCK_MODELS.find((model) => model.model === prefixed) ||
    null
  );
}

/** @param {string | null | undefined} id */
export function isPaidModel(id) {
  const model = findModel(id);
  return Boolean(model && model.paid);
}

/** @param {string | null | undefined} id @returns {'free'|'plus'|'pro'|null} */
export function getModelTier(id) {
  const model = findModel(id);
  return model ? model.tier : null;
}

/** @param {string | null | undefined} id */
export function getModelDisplayName(id) {
  const model = findModel(id);
  return model ? model.displayName : null;
}

/**
 * Resolve gateway availability for a model request.
 *
 * - unknown model → `{ found: false, available: false, reason: 'unknown_model' }`
 * - free model    → `{ found: true, available: true, paid: false }`
 * - paid model    → available only when `allowPaidModels` is true; otherwise
 *                   `{ found: true, available: false, paid: true, reason: 'model_requires_subscription' }`
 *
 * @param {string | null | undefined} id
 * @param {{ allowPaidModels?: boolean }} [options]
 * @returns {{ found: boolean, available: boolean, paid: boolean, requiresSubscription: boolean, tier: string|null, model: Record<string, any>|null, reason: string|null }}
 */
export function resolveModelAvailability(id, options = {}) {
  const model = findModel(id);
  if (!model) {
    return { found: false, available: false, paid: false, requiresSubscription: false, tier: null, model: null, reason: 'unknown_model' };
  }
  const allowPaidModels = options.allowPaidModels === true;
  const available = model.paid ? allowPaidModels : model.available !== false;
  return {
    found: true,
    available,
    paid: Boolean(model.paid),
    requiresSubscription: Boolean(model.requires_subscription),
    tier: model.tier,
    model,
    reason: available ? null : 'model_requires_subscription'
  };
}

/** Catalog shaped for `GET /v1/models` consumers (ADMIN_API_V2 §4 field names). */
export function getApiModelCatalog() {
  return DUCK_MODELS.map((model) => ({
    ...model,
    id: model.model,
    owned_by: model.createdBy,
    display_name: model.displayName,
    reasoning: model.modelType === 'reasoning',
    supported_reasoning_efforts: [...model.supportedReasoningEfforts],
    requires_subscription: Boolean(model.requires_subscription)
  }));
}

/**
 * Model capability descriptor (v2.11). Unknown model ids yield `null`.
 * @param {string | null | undefined} id
 * @returns {null | {
 *   model: string, displayName: string, tier: string, paid: boolean,
 *   webSearch: boolean, imageGeneration: boolean, reasoningEfforts: string[],
 *   contextWindowChars: number, maxInputChars: number,
 *   maxOutputTokens: number, maxOutputTokensEstimated: boolean,
 *   capabilities: Record<string, any>
 * }}
 */
export function getModelCapabilities(id) {
  const model = findModel(id);
  if (!model) return null;
  const capabilities = model.capabilities || {};
  return {
    model: model.model,
    displayName: model.displayName,
    tier: model.tier,
    paid: Boolean(model.paid),
    webSearch: capabilities.webSearch === true,
    imageGeneration: capabilities.imageGeneration === true,
    reasoningEfforts: [...(capabilities.reasoningEfforts || model.supportedReasoningEfforts || [])],
    contextWindowChars: capabilities.contextWindowChars ?? model.contextWindowChars ?? DEFAULT_CONTEXT_WINDOW_CHARS,
    maxInputChars: capabilities.maxInputChars ?? model.maxInputChars ?? DEFAULT_CONTEXT_WINDOW_CHARS,
    maxOutputTokens: capabilities.maxOutputTokens ?? model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    maxOutputTokensEstimated: capabilities.maxOutputTokensEstimated ?? model.maxOutputTokensEstimated !== false,
    capabilities: { ...capabilities }
  };
}
