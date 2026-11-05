/**
 * v2.44：客户端 tools 协议桥（Completions ↔ Responses 自动归一化）。
 *
 * duck.ai 上游没有 tools schema 通道，因此网关采用“提示词协议 + 输出解析”：
 *   - 客户端可以按 Chat Completions 或 Responses 任一形状声明 tools；
 *   - 网关归一化为 CanonicalTool，注入最后一条 user 消息；
 *   - 模型输出工具调用 JSON → 网关解析；
 *   - 出口按客户端协议生成 tool_calls / function_call。
 *
 * 只做 client 模式：工具由客户端（Codex/DSH）本地执行，网关不执行、不接 MCP。
 */

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TOOLS = 64;
const MAX_CALLS = 8;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_PROTOCOL_CHARS = 12 * 1024;

/** @typedef {{ name: string, description: string, parameters: Record<string, any> }} CanonicalTool */
/** @typedef {{ id: string, type: 'function', function: { name: string, arguments: string } }} CanonicalToolCall */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把两种协议的 tools 定义归一化为 CanonicalTool[]。
 * - Chat Completions: [{ type:'function', function:{ name, description, parameters } }]
 * - Responses:        [{ type:'function', name, description, parameters }]
 * 非 function 类型忽略（内置 web_search 等由原有 flags 处理）。
 * @param {any} tools
 * @returns {CanonicalTool[]}
 */
export function normalizeToolDefinitions(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of tools) {
    if (!isPlainObject(raw)) continue;
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
    if (type !== 'function') continue;
    const fn = isPlainObject(raw.function) ? raw.function : raw;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    const parameters = isPlainObject(fn.parameters)
      ? fn.parameters
      : isPlainObject(fn.input_schema)
        ? fn.input_schema
        : { type: 'object', properties: {} };
    seen.add(name);
    out.push({
      name,
      description: typeof fn.description === 'string' ? fn.description.slice(0, 2000) : '',
      parameters
    });
    if (out.length >= MAX_TOOLS) break;
  }
  return out;
}

/**
 * 生成注入最后一条 user 消息的工具协议文本。
 * @param {CanonicalTool[]} tools
 * @returns {string}
 */
export function buildToolProtocol(tools) {
  const list = Array.isArray(tools) ? tools : [];
  if (!list.length) return '';
  const lines = [
    '[工具调用协议]',
    '你可以在需要时调用以下外部工具。工具由客户端执行，你只负责输出调用请求，不要说无法调用。',
    '需要调用时，只输出一行 JSON（不要 markdown 代码块、不要额外解释）：',
    '{"tool_call":{"name":"工具名","arguments":{...}}}',
    '一次可以输出多个调用：{"tool_calls":[{"name":"工具名","arguments":{...}},...]}',
    '如果不需要工具，正常回答即可。',
    '',
    '可用工具：'
  ];
  for (const tool of list) {
    let schema;
    try {
      schema = JSON.stringify(tool.parameters || { type: 'object', properties: {} });
    } catch {
      schema = '{"type":"object","properties":{}}';
    }
    lines.push(`- ${tool.name}: ${tool.description || '(无描述)'}；参数 schema: ${schema}`);
  }
  return lines.join('\n').slice(0, MAX_PROTOCOL_CHARS);
}

/**
 * 从模型输出中提取工具调用（兼容单调用、多调用、代码块、<tool_call> 标签）。
 * @param {string} text
 * @param {CanonicalTool[]} tools
 * @returns {Array<{ name: string, arguments: string }>}
 */
export function parseToolCalls(text, tools) {
  const source = typeof text === 'string' ? text : '';
  if (!source.trim()) return [];
  const names = new Set((Array.isArray(tools) ? tools : []).map((tool) => tool.name));
  if (!names.size) return [];

  const candidates = [];
  const pushCandidate = (raw) => {
    if (!isPlainObject(raw)) return;
    if (Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        const normalized = normalizeCall(call);
        if (normalized) candidates.push(normalized);
      }
      return;
    }
    if (isPlainObject(raw.tool_call)) {
      const normalized = normalizeCall(raw.tool_call);
      if (normalized) candidates.push(normalized);
      return;
    }
    const direct = normalizeCall(raw);
    if (direct) candidates.push(direct);
  };
  const normalizeCall = (call) => {
    if (!isPlainObject(call)) return null;
    const name = typeof call.name === 'string' ? call.name : typeof call.tool === 'string' ? call.tool : '';
    if (!NAME_RE.test(name) || !names.has(name)) return null;
    let args = call.arguments;
    if (args === undefined) args = call.args;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return null;
      }
    }
    if (args === undefined || args === null) args = {};
    if (!isPlainObject(args)) return null;
    const serialized = JSON.stringify(args);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ARGUMENT_BYTES) return null;
    return { name, arguments: serialized };
  };

  // 1) 整个文本 / 代码块 / <tool_call> 内的 JSON
  const blocks = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fence;
  while ((fence = fenceRe.exec(source))) blocks.push(fence[1]);
  const tagRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let tag;
  while ((tag = tagRe.exec(source))) blocks.push(tag[1]);
  blocks.push(source);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // 找出所有顶层 JSON 对象（支持数组/多调用）
    for (const chunk of extractJsonObjects(trimmed)) {
      try {
        pushCandidate(JSON.parse(chunk));
      } catch {
        // ignore
      }
      if (candidates.length >= MAX_CALLS) break;
    }
    if (candidates.length >= MAX_CALLS) break;
  }

  return candidates.slice(0, MAX_CALLS).map((call, index) => ({
    id: `call_${Date.now().toString(36)}_${index}_${Math.random().toString(16).slice(2, 10)}`,
    name: call.name,
    arguments: call.arguments
  }));
}

/** 从可能包含前后文本的字符串中提取平衡的 JSON 对象字符串。 */
function extractJsonObjects(text) {
  const out = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, index + 1));
          start = -1;
        }
      }
    }
  }
  if (out.length === 0) {
    // v2.60：上游可能截断/少一个闭合括号。只对明确以 tool_call/tool_calls 开头的片段做容错修复。
    for (const marker of ['{"tool_call"', '{"tool_calls"']) {
      const index = text.indexOf(marker);
      if (index < 0) continue;
      const repaired = repairTruncatedJson(text.slice(index));
      if (repaired) {
        out.push(repaired);
        break;
      }
    }
  }
  return out;
}

/** 补齐被截断 JSON 的字符串/括号；仅用于 tool_call 容错。 */
function repairTruncatedJson(text) {
  const source = String(text || '');
  const stack = [];
  let inString = false;
  let escape = false;
  for (const char of source) {
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      if (stack.length && stack[stack.length - 1] === char) stack.pop();
    }
  }
  if (!stack.length && !inString) return source;
  let repaired = source;
  if (inString) repaired += '"';
  while (stack.length) repaired += stack.pop();
  return repaired;
}

/**
 * 去掉正文中用于工具调用的 JSON，保留普通回答。
 * @param {string} content
 * @param {boolean} hasToolCalls
 */
export function stripToolCallText(content, hasToolCalls) {
  if (!hasToolCalls || typeof content !== 'string') return content;
  return content
    .replace(/```(?:json)?\s*[\s\S]*?```/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\{[\s\S]*?"tool_calls?"[\s\S]*?\}/gi, '')
    .trim();
}

/**
 * 把客户端回传的工具结果编码为上游可读文本（duck.ai 没有 tool role）。
 * @param {{ id?: string, name?: string, result?: any }} entry
 */
export function formatToolResult(entry = {}) {
  const name = typeof entry.name === 'string' && entry.name ? entry.name : 'tool';
  let result = entry.result;
  if (typeof result !== 'string') {
    try {
      result = JSON.stringify(result);
    } catch {
      result = String(result ?? '');
    }
  }
  const max = 32 * 1024;
  const text = String(result ?? '').slice(0, max);
  return `[tool_result] ${name}: ${text}`;
}

/**
 * 将 assistant 工具调用编码为上游可读文本（用于回放历史）。
 * @param {Array<{function?:{name?:string,arguments?:string}}>} toolCalls
 */
export function formatToolCallsForHistory(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return '';
  return toolCalls
    .map((call) => {
      const fn = call && call.function ? call.function : call;
      const name = typeof fn?.name === 'string' ? fn.name : 'tool';
      const args = typeof fn?.arguments === 'string' ? fn.arguments : '{}';
      return `[tool_call] ${name}(${args})`;
    })
    .join('\n');
}

export const TOOL_PROTOCOL_LIMITS = Object.freeze({
  maxTools: MAX_TOOLS,
  maxCalls: MAX_CALLS,
  maxArgumentBytes: MAX_ARGUMENT_BYTES
});
