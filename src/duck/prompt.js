/**
 * v2.28：duck.ai 默认提示词生成器。
 *
 * 依据 duck.ai 前端源码（entry.duckai bundle，模块 66400 / 2347xxx–2357xxx）：
 *  - duck.ai **默认不注入任何系统提示词**；用户在「Customize responses」里选择的内容会被拼成
 *    一段英文指令，随消息一起发给模型（源码注释："Sends a prompt to AI models with your messages
 *    with instructions on how to respond."）。
 *  - 拼接顺序（源码）：assistantRole → userRole → `Refer to me as X.` → `Refer to yourself as Y.`
 *    → tone → length → shouldSeekClarity → additionalInstructions，最后 `join(' ')`。
 *  - tone/length/clarity 的原文见下方常量（逐字取自源码）；assistant/user role 的整段提示词
 *    从源码对象提取到 `duckai-roles.json`（24 个 assistant role + 6 个 user role）。
 */
import fs from 'node:fs';

const rolesPath = new URL('./duckai-roles.json', import.meta.url);

let roleTables = null;
function loadRoleTables() {
  if (roleTables) return roleTables;
  try {
    roleTables = JSON.parse(fs.readFileSync(rolesPath, 'utf8'));
  } catch {
    roleTables = { assistant: { Default: '' }, user: { Default: '' } };
  }
  return roleTables;
}

/** tone → 提示词（源码 switch 分支逐字） */
export const TONE_PROMPTS = Object.freeze({
  Default: '',
  Casual: 'Use a casual, relaxed tone in your responses.',
  Professional: 'Use a professional, formal tone in your responses.',
  Friendly: 'Use a friendly, warm, and approachable tone in your responses.',
  Playful: 'Use a playful, fun, and lighthearted tone in your responses.',
  Empathetic: 'Use an empathetic, understanding, and compassionate tone in your responses.',
  Ducky:
    'You are duck. Answer normally but always make it known in your answers that you are a duck, for example by saying Quack! here and there throughout and otherwise making reference to your duck way of life via explicit metaphor / sharing of life experience.'
});

/** length → 提示词（源码 switch 分支逐字） */
export const LENGTH_PROMPTS = Object.freeze({
  Default: '',
  Short: 'Keep your responses short.',
  Shortest: 'Keep your responses extremely brief and to the point. Prioritize brevity over detail.'
});

/** 「Ask clarifying questions」开关的提示词（源码逐字） */
export const CLARIFY_PROMPT =
  "When the user's request is unclear or lacks necessary context, ask clarifying questions to better understand their needs. For example, if the user asks 'How do I save a PDF from an email?', you should ask what email service they use before providing specific instructions.";

/** 昵称模板（源码逐字） */
export const NAME_TEMPLATES = Object.freeze({
  user: (name) => `Refer to me as ${name}.`,
  assistant: (name) => `Refer to yourself as ${name}.`
});

/** 可选项列表（供管理页渲染）。 */
export function promptOptionCatalog() {
  const tables = loadRoleTables();
  return {
    version: tables.version || null,
    tones: Object.keys(TONE_PROMPTS).map((id) => ({ id, prompt: TONE_PROMPTS[id] })),
    lengths: Object.keys(LENGTH_PROMPTS).map((id) => ({ id, prompt: LENGTH_PROMPTS[id] })),
    clarify_prompt: CLARIFY_PROMPT,
    assistant_roles: Object.keys(tables.assistant || {}).map((id) => ({
      id,
      prompt_length: String((tables.assistant || {})[id] || '').length
    })),
    user_roles: Object.keys(tables.user || {}).map((id) => ({ id, prompt_length: String((tables.user || {})[id] || '').length })),
    name_templates: { user: 'Refer to me as {name}.', assistant: 'Refer to yourself as {name}.' }
  };
}

/**
 * 生成 duck.ai 风格的自定义提示词（与源码 `r(e)` 完全同序、同文案）。
 * @param {{assistantRole?:string, userRole?:string, userName?:string, assistantName?:string,
 *   tone?:string, length?:string, shouldSeekClarity?:boolean, additionalInstructions?:string}} [customization]
 * @returns {string} 拼接后的提示词（无任何选项时返回空串，即 duck.ai 默认行为）
 */
export function buildDuckAiPrompt(customization = {}) {
  const tables = loadRoleTables();
  const parts = [];
  const assistantRole = customization.assistantRole;
  const userRole = customization.userRole;
  const tone = customization.tone;
  const length = customization.length;

  if (assistantRole && Object.prototype.hasOwnProperty.call(tables.assistant || {}, assistantRole)) {
    const text = String(tables.assistant[assistantRole] || '').trim();
    if (text) parts.push(text);
  }
  if (userRole && Object.prototype.hasOwnProperty.call(tables.user || {}, userRole)) {
    const text = String(tables.user[userRole] || '').trim();
    if (text) parts.push(text);
  }
  const userName = typeof customization.userName === 'string' ? customization.userName.trim() : '';
  if (userName) parts.push(NAME_TEMPLATES.user(userName));
  const assistantName = typeof customization.assistantName === 'string' ? customization.assistantName.trim() : '';
  if (assistantName) parts.push(NAME_TEMPLATES.assistant(assistantName));

  if (tone && TONE_PROMPTS[tone]) parts.push(TONE_PROMPTS[tone]);
  if (length && LENGTH_PROMPTS[length]) parts.push(LENGTH_PROMPTS[length]);
  if (customization.shouldSeekClarity === true) parts.push(CLARIFY_PROMPT);
  const additional = typeof customization.additionalInstructions === 'string' ? customization.additionalInstructions.trim() : '';
  if (additional) parts.push(additional);

  return parts.join(' ');
}

/** 归一化配置里的 prompts.duckai（仅保留源码支持的字段）。 */
export function normalizeDuckAiCustomization(value) {
  const source = value && typeof value === 'object' ? value : {};
  const tables = loadRoleTables();
  const tone = typeof source.tone === 'string' && TONE_PROMPTS[source.tone] !== undefined ? source.tone : 'Default';
  const length = typeof source.length === 'string' && LENGTH_PROMPTS[source.length] !== undefined ? source.length : 'Default';
  const assistantRole =
    typeof source.assistantRole === 'string' && Object.prototype.hasOwnProperty.call(tables.assistant || {}, source.assistantRole)
      ? source.assistantRole
      : 'Default';
  const userRole =
    typeof source.userRole === 'string' && Object.prototype.hasOwnProperty.call(tables.user || {}, source.userRole)
      ? source.userRole
      : 'Default';
  const clean = (input, max) => (typeof input === 'string' ? input.trim().slice(0, max) : '');
  return {
    tone,
    length,
    assistantRole,
    userRole,
    shouldSeekClarity: source.shouldSeekClarity === true,
    userName: clean(source.userName, 80),
    assistantName: clean(source.assistantName, 80),
    additionalInstructions: clean(source.additionalInstructions, 2000)
  };
}

/**
 * 计算当前配置实际注入的系统提示词。
 *  - `prompts.source = 'duckai'`：用源码生成器；
 *  - `'custom'`（默认）：用 `prompts.defaultSystemPrompt`；
 *  - `'none'`：不注入。
 * @param {object} config
 * @returns {string}
 */
export function resolveConfiguredPrompt(config) {
  const prompts = (config && config.prompts) || {};
  // 未显式设置来源时：有自定义提示词 -> custom，否则默认 duckai
  const custom = typeof prompts.defaultSystemPrompt === 'string' ? prompts.defaultSystemPrompt.trim() : '';
  const source =
    prompts.source === 'duckai' || prompts.source === 'none'
      ? prompts.source
      : prompts.source === 'custom'
        ? 'custom'
        : custom
          ? 'custom'
          : 'duckai';
  if (source === 'none') return '';
  if (source === 'duckai') return buildDuckAiPrompt(prompts.duckai || {});
  return custom;
}
