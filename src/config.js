/**
 * Configuration loading / validation / merging for duckai-cpa (v2).
 *
 * Layering (lowest → highest precedence):
 *   1. DEFAULT_CONFIG (built-in, mirrors config/config.example.json)
 *   2. config/config.example.json (template, owned by Lead)
 *   3. runtime config file (default data/config.json, override DUCKAI_CPA_CONFIG_PATH)
 *   4. environment overrides: DUCKAI_CPA_HOST / PORT / ADMIN_TOKEN
 *
 * v2 breaking changes:
 *   - `auth.required` was removed (every /v1/* request requires an API key).
 *   - new `upstream` section drives the FIFO/RPS queue.
 *   - new `duck.allowPaidModels` (default false) gates paid duck.ai models.
 *
 * First start: if the runtime config file does not exist it is created from the
 * example template with a freshly generated admin token. The token is returned
 * to the caller (src/index.js prints it) and never logged by this module.
 */

import path from 'node:path';
import crypto from 'node:crypto';

import { normalizeDuckAiCustomization } from './duck/prompt.js';
import { APP_ROOT, DEFAULT_DATA_BASE } from './platform.js';
import { atomicWriteJson, readJsonFileSafe } from './store.js';

// windows 平台分支（bun exe）：源码运行时为仓库根；bun 编译 exe 中为嵌入资源
// 所在的只读虚拟根（web/、config/、package.json 都在这里）。
export const PROJECT_ROOT = APP_ROOT;

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error', 'silent']);
export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high']);
export const PROMPT_MODES = Object.freeze(['system', 'inline']);
// v2.28：提示词来源（duckai = 按源码逻辑生成；custom = 自定义；none = 不注入）
export const PROMPT_SOURCES = Object.freeze(['duckai', 'custom', 'none']);
export const PROXY_TYPES = Object.freeze(['http', 'https', 'socks4', 'socks5']);
export const POOL_STRATEGIES = Object.freeze(['hash', 'least-loaded']);
export const CONTEXT_LIMIT_MODES = Object.freeze(['trim', 'error']);

/** Built-in defaults. Kept in sync with config/config.example.json. */
export const DEFAULT_CONFIG = Object.freeze({
  server: { host: '127.0.0.1', port: 8787, cors: true },
  auth: { apiKeys: [], adminToken: 'change-me-admin-token' },
  upstream: { rps: 1, maxConcurrent: 1, queueLimit: 50, queueTimeoutMs: 300000 },
  proxy: {
    enabled: false,
    type: 'http',
    host: '127.0.0.1',
    port: 8080,
    username: '',
    password: '',
    noProxy: ['127.0.0.1', 'localhost'],
    testUrl: 'https://duck.ai/duckchat/v1/status',
    ipCheckUrl: 'https://api.ipify.org?format=json'
  },
  identity: {
    enabled: true,
    // v2.2: upstream accepts durableStream now that the public JWK carries
    // alg/use:"enc"; still auto-degrades once if an upstream 400 rejects it.
    durableStream: { enabled: true },
    sync: { enabled: false },
    deviceName: null
  },
  // v2.4 identity pool + gateway-side context guard.
  pool: {
    enabled: true,
    maxIdentities: 20,
    strategy: 'hash',
    queueLimit: 50,
    queueTimeoutMs: 300000,
    runtimeIdleMs: 600000,
    // v2.30：会话→身份绑定的缓存有效期（天）；到期未被再次使用则自动解除绑定，0=永不过期
    bindingTtlDays: 7,
    // v2.32：额度耗尽时的冷却时长（分钟）——上游未给 resetAt 时的兜底值
    quotaCooldownMinutes: 1440
  },
  context: {
    maxInputChars: 12000,
    maxMessages: 40,
    onLimit: 'trim',
    // v2.11 real compaction (duck native summarize, fallback trim).
    compact: {
      enabled: true,
      triggerChars: 200000,
      keepRecentMessages: 6,
      maxSummaryChars: 4000,
      model: null
    },
    // v2.49：自动 PDF 溢出（文本超过 inputCharLimit 时把历史移入 PDF，替代自动压缩）
    pdfSpill: {
      enabled: true,
      inputCharLimit: 20000,
      maxPages: 15
    }
  },
  duck: {
    baseUrl: 'https://duck.ai',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    defaultModel: 'gpt-6-luna',
    timeoutMs: 120000,
    allowPaidModels: false,
    challenge: { engine: 'jsdom', refreshAheadMs: 30000 },
    humanize: {
      enabled: false,
      minDelayMs: 0,
      maxDelayMs: 0,
      minIntervalMs: 0,
      concurrency: 1,
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      rateLimitCooldownMs: 60000
    }
  },
  prompts: { defaultSystemPrompt: '', defaults: {}, mode: 'inline', source: 'duckai', duckai: null },
  // v2.5 pairing policy (official DuckDuckGo account join, docs/PAIRING-IMPL.md).
  sync: { pairing: { overwriteAccount: false } },
  // v2.24：日志保留策略（条数 + 天数），可在「日志 → 危险 / 高级操作」里调整
  logging: { level: 'info', maxEntries: 500, maxAgeDays: 7 },
  // v2.31：会话历史保留天数（超过该天数未更新的会话自动清理；0 = 不清理）
  history: { retentionDays: 30 },
  // v2.21: per-model context/output overrides edited in the dashboard「模型配置」页。
  // 形如 { 'gpt-6-luna': { context_window_chars: 20000, max_input_chars: 19500, max_output_tokens: 8192 } }
  models: {
    aliases: { 'gpt-6': 'gpt-6-luna', gpt6: 'gpt-6-luna', duck: 'gpt-6-luna' },
    overrides: {},
    // v2.23：每模型工具开关 + 不支持工具的处理策略
    //   dropUnsupported=true（默认）：静默清理——请求里不可用的 tool 直接丢弃，不报错
    //   dropUnsupported=false：关闭静默清理——不可用的 tool 返回 400
    //     （unsupported_tool / tool_not_supported / tool_disabled）
    //   perModel: { 'gpt-6-luna': { web_search: false } } —— 只能关闭上游支持的 tool
    tools: { dropUnsupported: true, perModel: {} }
  },
  tools: {
    webSearch: true,
    imageGeneration: true,
    location: false,
    // v2.44：客户端工具桥（Codex/DSH 文件工具）——仅 client 模式，网关不执行工具
    clientFunctionCalling: { enabled: true }
  },
  // v2.46：Responses API response chaining（previous_response_id）
  responses: { enabled: true, retentionDays: 7 },
  // v2.47：服务端会话模式（Chat Completions，需要 X-Session-Id）
  conversations: { mode: 'auto', retentionDays: 7 }
});

/** Config paths the dashboard may edit through PUT /admin/api/config. */
export const ADMIN_EDITABLE_PATHS = Object.freeze([
  'server.cors',
  'auth.apiKeys',
  'upstream.rps',
  'upstream.maxConcurrent',
  'upstream.queueLimit',
  'upstream.queueTimeoutMs',
  'duck.defaultModel',
  'duck.timeoutMs',
  'duck.allowPaidModels',
  'proxy.enabled',
  'proxy.type',
  'proxy.host',
  'proxy.port',
  'proxy.username',
  'proxy.password',
  'proxy.noProxy',
  'proxy.testUrl',
  'proxy.ipCheckUrl',
  'identity.enabled',
  'identity.durableStream.enabled',
  'identity.sync.enabled',
  'identity.deviceName',
  'pool.enabled',
  'pool.maxIdentities',
  'pool.strategy',
  'pool.queueLimit',
  'pool.queueTimeoutMs',
  'pool.runtimeIdleMs',
  'pool.bindingTtlDays',
  'pool.quotaCooldownMinutes',
  'context.maxInputChars',
  'context.maxMessages',
  'context.onLimit',
  'context.compact.enabled',
  'context.compact.triggerChars',
  'context.compact.keepRecentMessages',
  'context.compact.maxSummaryChars',
  'context.compact.model',
  'sync.pairing.overwriteAccount',
  'logging.level',
  'logging.maxEntries',
  'logging.maxAgeDays',
  'history.retentionDays',
  'prompts.defaultSystemPrompt',
  'prompts.mode',
  'prompts.source',
  'prompts.duckai.tone',
  'prompts.duckai.length',
  'prompts.duckai.assistantRole',
  'prompts.duckai.userRole',
  'prompts.duckai.shouldSeekClarity',
  'prompts.duckai.userName',
  'prompts.duckai.assistantName',
  'prompts.duckai.additionalInstructions',
  'tools.webSearch',
  'tools.imageGeneration',
  // v2.36：是否允许上游使用「大致位置」（user-location）。默认不允许。
  'tools.location',
  // v2.44：客户端工具桥（Completions / Responses 自动转换）
  'tools.clientFunctionCalling.enabled',
  // v2.46：Responses API 响应链（previous_response_id）
  'responses.enabled',
  'responses.retentionDays',
  'conversations.mode',
  'conversations.retentionDays'
]);

/** Editable by prefix (arbitrary keys below the prefix). */
export const ADMIN_EDITABLE_PREFIXES = Object.freeze([
  'prompts.defaults.',
  'models.aliases.',
  'models.tools.perModel.',
  'duck.humanize.'
]);

const DUCK_KEYS = new Set([
  'baseUrl',
  'userAgent',
  'defaultModel',
  'timeoutMs',
  'allowPaidModels',
  'challenge',
  'humanize',
  'systemPromptMode'
]);

const HUMANIZE_NUMERIC_FIELDS = Object.freeze({
  minDelayMs: [0, 60000],
  maxDelayMs: [0, 60000],
  minIntervalMs: [0, 60000],
  concurrency: [1, 16],
  maxRetries: [0, 10],
  retryBaseDelayMs: [0, 60000],
  rateLimitCooldownMs: [0, 600000],
  rateLimitWaitMs: [0, 600000]
});

const UPSTREAM_NUMERIC_FIELDS = Object.freeze({
  rps: [0.01, 100],
  maxConcurrent: [1, 16],
  queueLimit: [0, 1000],
  queueTimeoutMs: [1000, 600000]
});

function normalizeHumanize(raw) {
  if (!isPlainObject(raw)) return undefined;  const result = {};
  if (typeof raw.enabled === 'boolean') result.enabled = raw.enabled;
  for (const [field, [min, max]] of Object.entries(HUMANIZE_NUMERIC_FIELDS)) {
    if (raw[field] === undefined) continue;
    const number = Number(raw[field]);
    if (!Number.isFinite(number) || number < min) continue;
    result[field] = Math.min(max, Math.trunc(number));
  }
  // Preserve forward-compatible keys added by duck-protocol (unknown to the gateway).
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'enabled' || key in HUMANIZE_NUMERIC_FIELDS || result[key] !== undefined) continue;
    result[key] = deepClone(value);
  }
  return result;
}

function normalizeUpstream(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const result = {};
  for (const [field, [min, max]] of Object.entries(UPSTREAM_NUMERIC_FIELDS)) {
    const value = source[field];
    if (value === undefined) {
      result[field] = DEFAULT_CONFIG.upstream[field];
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      result[field] = DEFAULT_CONFIG.upstream[field];
      continue;
    }
    result[field] = field === 'rps' ? Math.round(number * 100) / 100 : Math.trunc(number);
  }
  return result;
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Normalize config.proxy (invalid raw values fall back to defaults). */
export function normalizeProxyConfig(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const type = PROXY_TYPES.includes(String(source.type)) ? String(source.type) : DEFAULT_CONFIG.proxy.type;
  const host = toStringValue(source.host, DEFAULT_CONFIG.proxy.host).trim() || DEFAULT_CONFIG.proxy.host;
  const port = toInteger(source.port, DEFAULT_CONFIG.proxy.port, 1, 65535);
  const username = toStringValue(source.username, '').slice(0, 200);
  const password = toStringValue(source.password, '');
  const noProxySource = Array.isArray(source.noProxy) ? source.noProxy : DEFAULT_CONFIG.proxy.noProxy;
  const noProxy = [];
  for (const entry of noProxySource) {
    if (typeof entry !== 'string') continue;
    const value = entry.trim();
    if (!value || noProxy.includes(value)) continue;
    noProxy.push(value.slice(0, 253));
    if (noProxy.length >= 50) break;
  }
  return {
    enabled: toBoolean(source.enabled, false),
    type,
    host,
    port,
    username,
    password,
    noProxy,
    testUrl: isHttpUrl(source.testUrl) ? source.testUrl.trim() : DEFAULT_CONFIG.proxy.testUrl,
    ipCheckUrl: isHttpUrl(source.ipCheckUrl) ? source.ipCheckUrl.trim() : DEFAULT_CONFIG.proxy.ipCheckUrl
  };
}

/** Normalize config.pool (v2.4 identity pool). */
/** v2.31：会话历史配置。 */
export function normalizeHistoryConfig(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    retentionDays: toInteger(source.retentionDays, DEFAULT_CONFIG.history.retentionDays, 0, 3650)
  };
}

export function normalizePoolConfig(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const strategy = POOL_STRATEGIES.includes(String(source.strategy))
    ? String(source.strategy)
    : DEFAULT_CONFIG.pool.strategy;
  return {
    enabled: toBoolean(source.enabled, true),
    maxIdentities: toInteger(source.maxIdentities, DEFAULT_CONFIG.pool.maxIdentities, 1, 100),
    strategy,
    queueLimit: toInteger(source.queueLimit, DEFAULT_CONFIG.pool.queueLimit, 0, 1000),
    queueTimeoutMs: toInteger(source.queueTimeoutMs, DEFAULT_CONFIG.pool.queueTimeoutMs, 1000, 600000),
    runtimeIdleMs: toInteger(source.runtimeIdleMs, DEFAULT_CONFIG.pool.runtimeIdleMs, 10000, 86400000),
    bindingTtlDays: toInteger(source.bindingTtlDays, DEFAULT_CONFIG.pool.bindingTtlDays, 0, 365),
    quotaCooldownMinutes: toInteger(source.quotaCooldownMinutes, DEFAULT_CONFIG.pool.quotaCooldownMinutes, 1, 10080)
  };
}

/** Normalize config.context (v2.4 gateway-side context guard). */
export function normalizeContextConfig(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const onLimit = CONTEXT_LIMIT_MODES.includes(String(source.onLimit))
    ? String(source.onLimit)
    : DEFAULT_CONFIG.context.onLimit;
  const compactSource = isPlainObject(source.compact) ? source.compact : {};
  const compactModel =
    typeof compactSource.model === 'string' && compactSource.model.trim()
      ? compactSource.model.trim().slice(0, 100)
      : null;
  const pdfSpillSource = isPlainObject(source.pdfSpill) ? source.pdfSpill : {};
  return {
    maxInputChars: toInteger(source.maxInputChars, DEFAULT_CONFIG.context.maxInputChars, 1000, 200000),
    maxMessages: toInteger(source.maxMessages, DEFAULT_CONFIG.context.maxMessages, 2, 500),
    onLimit,
    compact: {
      enabled: toBoolean(compactSource.enabled, true),
      triggerChars: toInteger(
        compactSource.triggerChars,
        DEFAULT_CONFIG.context.compact.triggerChars,
        1000,
        200000
      ),
      keepRecentMessages: toInteger(
        compactSource.keepRecentMessages,
        DEFAULT_CONFIG.context.compact.keepRecentMessages,
        2,
        200
      ),
      maxSummaryChars: toInteger(
        compactSource.maxSummaryChars,
        DEFAULT_CONFIG.context.compact.maxSummaryChars,
        200,
        20000
      ),
      model: compactModel
    },
    pdfSpill: {
      enabled: toBoolean(pdfSpillSource.enabled, true),
      inputCharLimit: toInteger(
        pdfSpillSource.inputCharLimit,
        DEFAULT_CONFIG.context.pdfSpill.inputCharLimit,
        5000,
        200000
      ),
      maxPages: toInteger(pdfSpillSource.maxPages, DEFAULT_CONFIG.context.pdfSpill.maxPages, 1, 15)
    }
  };
}

/** Paths whose changes only take effect after a restart. */
export const RESTART_REQUIRED_PATHS = Object.freeze([
  'server.host',
  'server.port',
  'duck.baseUrl',
  'duck.userAgent',
  'duck.challenge.engine',
  'duck.challenge.refreshAheadMs'
]);

const PLACEHOLDER_ADMIN_TOKENS = new Set(['', 'change-me-admin-token', 'changeme', 'admin']);

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepClone(value) {
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = deepClone(item);
    return result;
  }
  return value;
}

/** Non-mutating deep merge; arrays and primitives from `patch` win. */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? deepClone(base) : deepClone(patch);
  const result = isPlainObject(base) ? deepClone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(result[key])) result[key] = deepMerge(result[key], value);
    else result[key] = deepClone(value);
  }
  return result;
}

/**
 * Mutating deep merge that preserves nested object identities (used so that a
 * long-lived DuckClient holding `config.duck` sees admin config updates).
 */
export function deepApply(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainObject(value) && isPlainObject(current)) deepApply(current, value);
    else if (Array.isArray(value) && Array.isArray(current)) current.splice(0, current.length, ...value);
    else target[key] = deepClone(value);
  }
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) delete target[key];
  }
  return target;
}

/** Flatten an object into dotted-path leaves (arrays are treated as leaves). */
export function flattenConfigPatch(value, prefix = [], out = {}) {
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) flattenConfigPatch(item, [...prefix, key], out);
  } else {
    out[prefix.join('.')] = value;
  }
  return out;
}

function setByPath(target, dotted, value) {
  const parts = dotted.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!isPlainObject(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = deepClone(value);
}

function toBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function toInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function toNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function toStringValue(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function stripTrailingSlash(url) {
  return String(url).replace(/\/+$/, '');
}

function sanitizeStringMap(value, { allowEmpty = true } = {}) {
  const result = {};
  if (!isPlainObject(value)) return result;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') continue;
    if (!allowEmpty && !item.trim()) continue;
    result[String(key)] = item;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

/**
 * 计算运行时路径。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [rootDir] 只读资源根（web/config/package.json）；默认 PROJECT_ROOT。
 * @param {string} [dataBase] 数据目录基准；默认 DEFAULT_DATA_BASE（编译 exe 为 exe 目录，源码为仓库根）。
 */
export function resolvePaths(env = process.env, rootDir = PROJECT_ROOT, dataBase = DEFAULT_DATA_BASE) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedDataBase = path.resolve(dataBase);
  const dataDir = env.DUCKAI_CPA_DATA_DIR
    ? path.resolve(resolvedDataBase, String(env.DUCKAI_CPA_DATA_DIR))
    : path.join(resolvedDataBase, 'data');
  const configPath = env.DUCKAI_CPA_CONFIG_PATH
    ? path.resolve(resolvedDataBase, String(env.DUCKAI_CPA_CONFIG_PATH))
    : path.join(dataDir, 'config.json');
  return {
    rootDir: resolvedRoot,
    dataDir,
    configPath,
    examplePath: path.join(resolvedRoot, 'config', 'config.example.json'),
    webDir: path.join(resolvedRoot, 'web'),
    packagePath: path.join(resolvedRoot, 'package.json')
  };
}

/* ------------------------------------------------------------------ */
/* Validation / normalization                                          */
/* ------------------------------------------------------------------ */

/**
 * Fill defaults, coerce + validate types. Always returns a fresh plain object
 * with the full config shape. `auth.required` is intentionally NOT part of the
 * v2 shape anymore (dropped during migration / normalization).
 */
/**
 * v2.21：模型覆盖配置的宽松规范化（模型是否存在由 admin API 校验，避免 config↔models 循环依赖）。
 * 只接受已知字段，数字裁剪到合理区间，非法值丢弃。
 */
/**
 * v2.23：模型工具策略规范化。
 * - dropUnsupported：布尔，默认 true（静默清理不可用 tool）；false 时改为报错
 * - perModel：{ modelId: { web_search?: bool, image_generation?: bool } }，只保留已知 tool 名
 */
export function normalizeModelToolPolicy(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const perModel = {};
  if (isPlainObject(source.perModel)) {
    for (const [id, value] of Object.entries(source.perModel)) {
      if (typeof id !== 'string' || !id.trim() || !isPlainObject(value)) continue;
      const entry = {};
      for (const tool of ['web_search', 'image_generation']) {
        if (typeof value[tool] === 'boolean') entry[tool] = value[tool];
      }
      if (Object.keys(entry).length) perModel[id.trim()] = entry;
    }
  }
  return { dropUnsupported: toBoolean(source.dropUnsupported, true) !== false, perModel };
}

export function normalizeModelOverrides(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof id !== 'string' || !id.trim() || !isPlainObject(value)) continue;
    const entry = {};
    const num = (input, min, max) => {
      const parsed = Number(input);
      if (!Number.isFinite(parsed)) return undefined;
      return Math.min(max, Math.max(min, Math.trunc(parsed)));
    };
    const contextChars = num(value.context_window_chars ?? value.contextWindowChars, 256, 200000);
    const inputChars = num(value.max_input_chars ?? value.maxInputChars, 64, 200000);
    const outputTokens = num(value.max_output_tokens ?? value.maxOutputTokens, 16, 131072);
    if (contextChars !== undefined) entry.context_window_chars = contextChars;
    if (inputChars !== undefined) entry.max_input_chars = inputChars;
    if (outputTokens !== undefined) entry.max_output_tokens = outputTokens;
    const behavior = value.session_limit_behavior;
    if (behavior === 'new_chat' || behavior === 'summarize_and_continue') {
      entry.session_limit_behavior = behavior;
    }
    if (Object.keys(entry).length) out[id.trim()] = entry;
  }
  return out;
}

function normalizeConversationsConfig(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const days = Number(source.retentionDays);
  const mode = source.mode === 'server' ? 'server' : source.mode === 'auto' ? 'auto' : 'stateless';
  return {
    mode,
    retentionDays: Number.isFinite(days) ? Math.min(365, Math.max(0, Math.floor(days))) : 7
  };
}

function normalizeResponsesConfig(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const days = Number(source.retentionDays);
  return {
    enabled: source.enabled !== false,
    retentionDays: Number.isFinite(days) ? Math.min(365, Math.max(0, Math.floor(days))) : 7
  };
}

export function normalizeConfig(raw = {}) {
  const source = isPlainObject(raw) ? deepMerge(DEFAULT_CONFIG, raw) : deepClone(DEFAULT_CONFIG);

  const server = isPlainObject(source.server) ? source.server : {};
  const auth = isPlainObject(source.auth) ? source.auth : {};
  const duck = isPlainObject(source.duck) ? source.duck : {};
  const challenge = isPlainObject(duck.challenge) ? duck.challenge : {};
  const prompts = isPlainObject(source.prompts) ? source.prompts : {};
  const logging = isPlainObject(source.logging) ? source.logging : {};
  const models = isPlainObject(source.models) ? source.models : {};
  const tools = isPlainObject(source.tools) ? source.tools : {};
  const identity = isPlainObject(source.identity) ? source.identity : {};
  const identityDurableStream = isPlainObject(identity.durableStream) ? identity.durableStream : {};
  const identitySync = isPlainObject(identity.sync) ? identity.sync : {};
  const deviceName =
    typeof identity.deviceName === 'string' && identity.deviceName.trim()
      ? identity.deviceName.trim().slice(0, 200)
      : null;

  const host = toStringValue(server.host, '127.0.0.1').trim() || '127.0.0.1';
  const port = toInteger(server.port, 8787, 0, 65535);
  const apiKeys = Array.isArray(auth.apiKeys)
    ? auth.apiKeys
        .map((key) => (typeof key === 'string' ? key.trim() : ''))
        .filter((key) => Boolean(key))
    : [];
  const defaultModel = toStringValue(duck.defaultModel, 'gpt-6-luna').trim() || 'gpt-6-luna';
  const logLevel = LOG_LEVELS.includes(String(logging.level)) ? String(logging.level) : 'info';
  const promptMode = PROMPT_MODES.includes(String(prompts.mode)) ? String(prompts.mode) : 'inline';
  // v2.28.1：默认来源改为 duckai（未显式设置且没有自定义提示词时）；显式设置优先。
  const hasCustomPrompt =
    typeof prompts.defaultSystemPrompt === 'string' && prompts.defaultSystemPrompt.trim().length > 0;
  const promptSource = PROMPT_SOURCES.includes(String(prompts.source))
    ? String(prompts.source)
    : hasCustomPrompt
      ? 'custom'
      : 'duckai';
  const duckaiCustomization = normalizeDuckAiCustomization(prompts.duckai);
  const humanize = normalizeHumanize(duck.humanize);
  const upstream = normalizeUpstream(source.upstream);
  const proxy = normalizeProxyConfig(source.proxy);
  const pool = normalizePoolConfig(source.pool);
  const context = normalizeContextConfig(source.context);
  const sync = isPlainObject(source.sync) ? source.sync : {};
  const syncPairing = isPlainObject(sync.pairing) ? sync.pairing : {};
  const duckExtras = {};
  for (const [key, value] of Object.entries(duck)) {
    if (DUCK_KEYS.has(key)) continue;
    duckExtras[key] = deepClone(value);
  }

  return {
    server: {
      host,
      port,
      cors: toBoolean(server.cors, true)
    },
    auth: {
      apiKeys,
      adminToken: toStringValue(auth.adminToken, '').trim()
    },
    upstream,
    proxy,
    pool,
    context,
    sync: { pairing: { overwriteAccount: toBoolean(syncPairing.overwriteAccount, false) } },
    identity: {
      enabled: toBoolean(identity.enabled, true),
      durableStream: { enabled: toBoolean(identityDurableStream.enabled, true) },
      sync: { enabled: toBoolean(identitySync.enabled, false) },
      deviceName
    },
    duck: {
      baseUrl: stripTrailingSlash(toStringValue(duck.baseUrl, 'https://duck.ai').trim() || 'https://duck.ai'),
      userAgent: toStringValue(duck.userAgent, DEFAULT_CONFIG.duck.userAgent),
      defaultModel,
      timeoutMs: toInteger(duck.timeoutMs, 120000, 1000, 600000),
      allowPaidModels: toBoolean(duck.allowPaidModels, false),
      challenge: {
        engine: toStringValue(challenge.engine, 'jsdom'),
        refreshAheadMs: toInteger(challenge.refreshAheadMs, 30000, 0, 600000)
      },
      ...(humanize && Object.keys(humanize).length ? { humanize } : {}),
      ...(typeof duck.systemPromptMode === 'string' && duck.systemPromptMode
        ? { systemPromptMode: duck.systemPromptMode }
        : {}),
      ...duckExtras
    },
    prompts: {
      defaultSystemPrompt: toStringValue(prompts.defaultSystemPrompt, ''),
      defaults: sanitizeStringMap(prompts.defaults),
      mode: promptMode,
      source: promptSource,
      duckai: duckaiCustomization
    },
    logging: {
      level: logLevel,
      maxEntries: toInteger(logging.maxEntries, 500, 10, 20000),
      // 0 = 不按时间淘汰；否则 1–365 天
      maxAgeDays: toInteger(logging.maxAgeDays, 7, 0, 365)
    },
    // v2.31：会话历史保留天数（0 = 永不清理）
    history: normalizeHistoryConfig(source.history),
    models: {
      aliases: sanitizeStringMap(models.aliases),
      overrides: normalizeModelOverrides(models.overrides),
      tools: normalizeModelToolPolicy(models.tools)
    },
    tools: {
      webSearch: toBoolean(tools.webSearch, true),
      imageGeneration: toBoolean(tools.imageGeneration, true),
      // v2.36：定位能力（对应 duck.ai bundle 的 canUseApproxLocation）；默认不允许
      location: toBoolean(tools.location, false),
      // v2.44：客户端工具桥（默认开启；网关只解析/转发 tool_calls，不执行工具）
      clientFunctionCalling: {
        enabled: toBoolean(tools.clientFunctionCalling?.enabled, true)
      }
    },
    // v2.46：Responses API response chaining
    responses: normalizeResponsesConfig(source.responses),
    // v2.47：服务端会话（Chat Completions 需要显式 session id）
    conversations: normalizeConversationsConfig(source.conversations)
  };
}

/* ------------------------------------------------------------------ */
/* Legacy migration                                                    */
/* ------------------------------------------------------------------ */

/**
 * v1 → v2 config migration (destructive on purpose, no compatibility layer):
 *   - drop `auth.required` (v2 always requires API keys)
 *   - `upstream` / `duck.allowPaidModels` / v2 humanize defaults are filled by normalizeConfig.
 * @returns {{raw: Record<string, any>, changed: boolean, notes: string[]}}
 */
export function migrateConfig(raw) {
  const notes = [];
  if (!isPlainObject(raw)) return { raw, changed: false, notes };
  const next = deepClone(raw);
  if (isPlainObject(next.auth) && Object.prototype.hasOwnProperty.call(next.auth, 'required')) {
    delete next.auth.required;
    notes.push('removed auth.required (v2 always requires API keys)');
  }
  return { raw: next, changed: notes.length > 0, notes };
}

/* ------------------------------------------------------------------ */
/* Admin-config patch application                                      */
/* ------------------------------------------------------------------ */

function assertEditableValue(dotted, value) {
  const fail = (expected) => {
    const error = new Error(`invalid value for "${dotted}" (expected ${expected})`);
    error.status = 400;
    throw error;
  };
  switch (dotted) {
    case 'server.host':
    case 'duck.baseUrl':
    case 'duck.userAgent':
      if (typeof value !== 'string' || !value.trim()) fail('non-empty string');
      if (dotted === 'duck.baseUrl') {
        try {
          // eslint-disable-next-line no-new
          new URL(value);
        } catch {
          fail('absolute URL');
        }
      }
      return;
    case 'server.port': {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail('port 0-65535');
      return;
    }
    case 'server.cors':
    case 'tools.webSearch':
    case 'tools.imageGeneration':
    case 'tools.location':
    case 'tools.clientFunctionCalling.enabled':
    case 'responses.enabled':
    case 'duck.allowPaidModels':
    case 'identity.enabled':
    case 'identity.durableStream.enabled':
    case 'identity.sync.enabled':
      if (typeof value !== 'boolean') fail('boolean');
      return;
    case 'responses.retentionDays': {
      const days = Number(value);
      if (!Number.isInteger(days) || days < 0 || days > 365) fail('integer 0-365');
      return;
    }
    case 'conversations.retentionDays': {
      const days = Number(value);
      if (!Number.isInteger(days) || days < 0 || days > 365) fail('integer 0-365');
      return;
    }
    case 'conversations.mode':
      if (value !== 'auto' && value !== 'server' && value !== 'stateless') fail('"auto" | "server" | "stateless"');
      return;
    case 'identity.deviceName':
      if (value !== null && (typeof value !== 'string' || value.length > 200)) fail('string (max 200) or null');
      return;
    case 'proxy.enabled':
      if (typeof value !== 'boolean') fail('boolean');
      return;
    case 'proxy.type':
      if (!PROXY_TYPES.includes(String(value))) fail(PROXY_TYPES.join('|'));
      return;
    case 'proxy.host':
      if (typeof value !== 'string' || !value.trim() || value.length > 253) fail('non-empty hostname/IP (max 253)');
      return;
    case 'proxy.port': {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail('integer port 1-65535');
      return;
    }
    case 'proxy.username':
      if (typeof value !== 'string' || value.length > 200) fail('string (max 200)');
      return;
    case 'proxy.password':
      if (typeof value !== 'string' || value.length > 500) fail('string (max 500)');
      return;
    case 'proxy.noProxy':
      if (
        !Array.isArray(value) ||
        value.length > 50 ||
        value.some((item) => typeof item !== 'string' || item.length > 253)
      ) {
        fail('array of strings (max 50 entries)');
      }
      return;
    case 'proxy.testUrl':
    case 'proxy.ipCheckUrl':
      if (!isHttpUrl(value)) fail('http(s) URL');
      return;
    case 'pool.enabled':
      if (typeof value !== 'boolean') fail('boolean');
      return;
    case 'pool.strategy':
      if (!POOL_STRATEGIES.includes(String(value))) fail(POOL_STRATEGIES.join('|'));
      return;
    case 'pool.maxIdentities': {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > 100) fail('integer 1-100');
      return;
    }
    case 'pool.queueLimit': {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0 || number > 1000) fail('integer 0-1000');
      return;
    }
    case 'pool.queueTimeoutMs':
    case 'pool.runtimeIdleMs':
    case 'pool.bindingTtlDays':
    case 'pool.quotaCooldownMinutes': {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1000) fail('integer >= 1000');
      return;
    }
    case 'context.maxInputChars': {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1000 || number > 200000) fail('integer 1000-200000');
      return;
    }
    case 'context.maxMessages': {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 2 || number > 500) fail('integer 2-500');
      return;
    }
    case 'context.onLimit':
      if (!CONTEXT_LIMIT_MODES.includes(String(value))) fail(CONTEXT_LIMIT_MODES.join('|'));
      return;
    case 'context.compact.enabled':
      if (typeof value !== 'boolean') fail('boolean');
      return;
    case 'context.compact.model':
      if (value !== null && (typeof value !== 'string' || value.length > 100)) fail('string (max 100) or null');
      return;
    case 'context.compact.triggerChars': {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1000 || number > 200000) fail('integer 1000-200000');
      return;
    }
    case 'context.compact.keepRecentMessages': {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 2 || number > 200) fail('integer 2-200');
      return;
    }
    case 'context.compact.maxSummaryChars': {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 200 || number > 20000) fail('integer 200-20000');
      return;
    }
    case 'sync.pairing.overwriteAccount':
      if (typeof value !== 'boolean') fail('boolean');
      return;
    case 'auth.apiKeys':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
        fail('array of non-empty strings');
      }
      return;
    case 'upstream.rps':
    case 'upstream.maxConcurrent':
    case 'upstream.queueLimit':
    case 'upstream.queueTimeoutMs': {
      const field = dotted.split('.')[1];
      const [min, max] = UPSTREAM_NUMERIC_FIELDS[field];
      const number = Number(value);
      if (!Number.isFinite(number) || number < min || number > max) fail(`number ${min}-${max}`);
      return;
    }
    case 'duck.defaultModel':
      if (typeof value !== 'string' || !value.trim()) fail('non-empty string');
      return;
    case 'duck.timeoutMs':
    case 'logging.maxEntries':
    case 'history.retentionDays': {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) fail('positive number');
      return;
    }
    case 'logging.level':
      if (!LOG_LEVELS.includes(String(value))) fail(LOG_LEVELS.join('|'));
      return;
    case 'prompts.defaultSystemPrompt':
      if (typeof value !== 'string') fail('string');
      return;
    case 'prompts.mode':
      if (!PROMPT_MODES.includes(String(value))) fail(PROMPT_MODES.join('|'));
      return;
    case 'prompts.source':
      if (!PROMPT_SOURCES.includes(String(value))) fail(PROMPT_SOURCES.join('|'));
      return;
    case 'prompts.duckai.shouldSeekClarity':
      if (typeof value !== 'boolean') fail('boolean');
      return;
    case 'prompts.duckai.tone':
    case 'prompts.duckai.length':
    case 'prompts.duckai.assistantRole':
    case 'prompts.duckai.userRole':
      if (typeof value !== 'string' || !value.trim()) fail('non-empty string');
      return;
    case 'prompts.duckai.userName':
    case 'prompts.duckai.assistantName':
    case 'prompts.duckai.additionalInstructions':
      if (typeof value !== 'string') fail('string');
      return;
    case 'duck.challenge.engine':
      if (typeof value !== 'string' || !value.trim()) fail('string');
      return;
    case 'duck.challenge.refreshAheadMs': {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) fail('non-negative number');
      return;
    }
    default:
      if (dotted.startsWith('prompts.defaults.') || dotted.startsWith('models.aliases.')) {
        if (typeof value !== 'string') fail('string');
        return;
      }
      if (dotted.startsWith('duck.humanize.')) {
        const field = dotted.slice('duck.humanize.'.length);
        if (field === 'enabled') {
          if (typeof value !== 'boolean') fail('boolean');
          return;
        }
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) fail('non-negative number');
        return;
      }
      throw Object.assign(new Error(`config field "${dotted}" is not editable`), { status: 400 });
  }
}

/**
 * Apply a partial config patch in place on the live config object.
 * Upstream queue settings are read live by the queue, so they apply immediately.
 * @returns {{changed: boolean, restartRequired: boolean, restartPaths: string[], ignored: string[]}}
 */
export function applyConfigPatch(config, patch) {
  if (!isPlainObject(patch)) {
    const error = new Error('request body must be a JSON object');
    error.status = 400;
    throw error;
  }
  const leaves = flattenConfigPatch(patch);
  const ignored = [];
  const restartPaths = [];
  const changes = [];

  for (const [dotted, value] of Object.entries(leaves)) {
    const editable =
      ADMIN_EDITABLE_PATHS.includes(dotted) ||
      ADMIN_EDITABLE_PREFIXES.some((prefix) => dotted.startsWith(prefix));
    const restartOnly = RESTART_REQUIRED_PATHS.includes(dotted);
    if (dotted === 'auth.required') {
      ignored.push(dotted);
      continue;
    }
    if (!editable && !restartOnly) {
      ignored.push(dotted);
      continue;
    }
    assertEditableValue(dotted, value);
    const current = dotted.split('.').reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), config);
    if (JSON.stringify(current) === JSON.stringify(value)) continue;
    setByPath(config, dotted, value);
    changes.push(dotted);
    if (restartOnly || dotted.startsWith('duck.humanize.')) restartPaths.push(dotted);
  }

  const normalized = normalizeConfig(config);
  deepApply(config, normalized);

  return {
    changed: changes.length > 0,
    restartRequired: restartPaths.length > 0,
    restartPaths,
    ignored,
    changes
  };
}

/* ------------------------------------------------------------------ */
/* Environment overrides                                               */
/* ------------------------------------------------------------------ */

export function applyEnvOverrides(config, env = process.env) {
  if (env.DUCKAI_CPA_HOST) {
    const host = String(env.DUCKAI_CPA_HOST).trim();
    if (!host) throw new Error('DUCKAI_CPA_HOST must not be empty');
    config.server.host = host;
  }
  if (env.DUCKAI_CPA_PORT !== undefined && env.DUCKAI_CPA_PORT !== '') {
    const port = Number(env.DUCKAI_CPA_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`DUCKAI_CPA_PORT must be an integer 0-65535, got "${env.DUCKAI_CPA_PORT}"`);
    }
    config.server.port = port;
  }
  if (env.DUCKAI_CPA_ADMIN_TOKEN) {
    const token = String(env.DUCKAI_CPA_ADMIN_TOKEN).trim();
    if (!token) throw new Error('DUCKAI_CPA_ADMIN_TOKEN must not be empty');
    config.auth.adminToken = token;
  }
  return config;
}

/* ------------------------------------------------------------------ */
/* Redaction / tokens                                                  */
/* ------------------------------------------------------------------ */

const REDACTED = 'sk-***';

/** Same shape as store keyPreview: `sk-duck-...abcd`. */
export function redactKeyPreview(key) {
  if (typeof key !== 'string' || !key) return REDACTED;
  if (key.length <= 16) return REDACTED;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

/**
 * Return a copy safe to expose to the dashboard.
 * (v2 config never contains auth.required; API keys are previews only.)
 */
export function redactConfig(config) {
  const clone = deepClone(config);
  if (isPlainObject(clone.auth)) {
    clone.auth.apiKeys = Array.isArray(clone.auth.apiKeys) ? clone.auth.apiKeys.map(redactKeyPreview) : [];
    clone.auth.adminToken = REDACTED;
  }
  if (isPlainObject(clone.proxy)) {
    // v2.3: never echo the proxy password; expose a boolean instead.
    clone.proxy.hasAuth = Boolean(clone.proxy.password);
    delete clone.proxy.password;
  }
  return clone;
}

export function generateAdminToken() {
  return `admin_${crypto.randomBytes(24).toString('hex')}`;
}

export function isPlaceholderAdminToken(token) {
  return PLACEHOLDER_ADMIN_TOKENS.has(String(token || '').trim());
}

/* ------------------------------------------------------------------ */
/* Load / reset                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   rootDir?: string,
 *   logger?: {info?: Function, warn?: Function, debug?: Function}
 * }} [options]
 */
export async function loadConfig({ env = process.env, rootDir = PROJECT_ROOT, logger = null } = {}) {
  const paths = resolvePaths(env, rootDir);

  const example = await readJsonFileSafe(paths.examplePath, {}, (error) =>
    logger?.warn?.(`could not read config example: ${error.message}`)
  );
  const template = normalizeConfig(deepMerge(DEFAULT_CONFIG, isPlainObject(example) ? example : {}));

  const existingRaw = await readJsonFileSafe(
    paths.configPath,
    null,
    (error) => logger?.warn?.(`could not read runtime config ${paths.configPath}: ${error.message}`)
  );
  const firstRun = !isPlainObject(existingRaw);
  const migration = migrateConfig(firstRun ? {} : existingRaw);
  // v1 → v2: old configs have no `upstream` section and use the DuckClient-level
  // humanize pacing. v2 lets the RPS queue control pacing, so reset humanize to
  // the v2 example defaults (disabled) instead of carrying stale delays over.
  const legacyWithoutUpstream = !firstRun && !isPlainObject(existingRaw?.upstream);
  if (legacyWithoutUpstream && isPlainObject(migration.raw.duck)) {
    if (migration.raw.duck.humanize !== undefined) {
      delete migration.raw.duck.humanize;
      migration.notes.push('reset duck.humanize to v2 defaults (RPS queue handles upstream pacing)');
      migration.changed = true;
    }
  }
  // v2.2: add identity defaults for existing configs (persisted once).
  if (!firstRun && !isPlainObject(existingRaw?.identity)) {
    migration.notes.push('added identity defaults (enabled/durableStream/sync/deviceName)');
    migration.changed = true;
  }
  // v2.3: add proxy defaults for existing configs (persisted once).
  if (!firstRun && !isPlainObject(existingRaw?.proxy)) {
    migration.notes.push('added proxy defaults (disabled by default)');
    migration.changed = true;
  }
  // v2.4: add identity pool + context guard defaults (persisted once).
  if (!firstRun && (!isPlainObject(existingRaw?.pool) || !isPlainObject(existingRaw?.context))) {
    migration.notes.push('added identity pool + context guard defaults');
    migration.changed = true;
  }
  if (migration.notes.length > 0) {
    logger?.info?.('migrated legacy config', { notes: migration.notes, path: paths.configPath });
  }

  const merged = normalizeConfig(deepMerge(template, migration.raw));
  let generatedAdminToken = null;
  if (firstRun || isPlaceholderAdminToken(merged.auth.adminToken)) {
    generatedAdminToken = generateAdminToken();
    merged.auth.adminToken = generatedAdminToken;
  }

  // Persist only the file-backed layer, before env overrides are applied.
  if (firstRun || generatedAdminToken || migration.changed) {
    try {
      await atomicWriteJson(paths.configPath, merged);
    } catch (error) {
      if (error && error.code === 'EACCES') {
        const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
        error.message += ` (process UID ${uid}; make ${paths.dataDir || 'the data directory'} writable by that UID, e.g. sudo chown -R 1000:1000 ./data, or use a named volume)`;
      }
      throw error;
    }
    logger?.info?.(`created/updated runtime config at ${paths.configPath}`, { firstRun });
  }

  const config = deepClone(merged);
  applyEnvOverrides(config, env);
  if (env.DUCKAI_CPA_ADMIN_TOKEN) {
    logger?.debug?.('admin token overridden by DUCKAI_CPA_ADMIN_TOKEN');
  }

  return { config, paths, firstRun, generatedAdminToken, migrated: migration.changed, migrationNotes: migration.notes };
}

/**
 * Build a fresh config from the example template for POST /admin/api/config/reset.
 * The current admin token is preserved (so the dashboard session stays valid) and
 * API keys can be carried over from the key store.
 */
export async function resetConfig({ env = process.env, rootDir = PROJECT_ROOT, currentConfig, apiKeys } = {}) {
  const paths = resolvePaths(env, rootDir);
  const example = await readJsonFileSafe(paths.examplePath, {}, null);
  const fresh = normalizeConfig(deepMerge(DEFAULT_CONFIG, isPlainObject(example) ? example : {}));
  if (currentConfig?.auth?.adminToken) fresh.auth.adminToken = currentConfig.auth.adminToken;
  if (isPlaceholderAdminToken(fresh.auth.adminToken)) fresh.auth.adminToken = generateAdminToken();
  if (Array.isArray(apiKeys)) fresh.auth.apiKeys = apiKeys.filter((key) => typeof key === 'string' && key);
  const config = deepClone(fresh);
  applyEnvOverrides(config, env);
  return { config, paths };
}
