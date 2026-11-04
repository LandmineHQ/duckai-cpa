/**
 * v2.39：网关级 function calling（OpenAI tools[].function）。
 *
 * 背景：duck.ai 上游没有 OpenAI 的 `tools` schema 通道（只支持固定内置工具：WebSearch /
 * GenerateImage / LocationPrompt / 浏览器工具等）。因此网关把客户端声明的 function tools
 * 注入系统提示词，要求模型按 JSON 协议输出工具调用；网关解析后：
 *  - mode=client：把调用转成 OpenAI `tool_calls` 返回，客户端执行后以 role:"tool" 消息回传；
 *  - mode=auto：网关直接调用 MCP server 执行工具，把结果回填给模型并继续（最多 maxRounds 轮）。
 */

import crypto from 'node:crypto';

const TOOL_PROTOCOL = `[工具调用协议]
你可以使用以下外部工具（仅在确实需要时调用）：
%s
需要调用工具时，**只输出且仅输出**一个 JSON 对象（可放在 \`\`\`json 代码块中），格式：
{"tool_call":{"name":"<工具名>","arguments":{...}}}
不要输出其它文字或解释。
工具结果会以用户消息 \`[tool_result name=...]\` 的形式提供给你，然后请基于结果回答用户。
如果不需要调用工具，直接正常回答用户。`;

const TOOL_ITEM = `- 名称: %s
  描述: %s
  参数 JSON Schema: %s`;

/**
 * @param {Array<{name:string, description?:string, parameters?:object}>} tools
 * @returns {string}
 */
export function buildToolProtocol(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const items = tools
    .map((tool) =>
      TOOL_ITEM.replace('%s', tool.name)
        .replace('%s', tool.description || '(无描述)')
        .replace('%s', JSON.stringify(tool.parameters || { type: 'object', properties: {} }))
    )
    .join('\n');
  return TOOL_PROTOCOL.replace('%s', items);
}

/** 把工具定义规整为统一结构（来自 OpenAI `tools[].function`）。 */
export function normalizeFunctionTools(rawTools) {
  if (!Array.isArray(rawTools)) return [];
  const tools = [];
  for (const raw of rawTools) {
    if (!raw || typeof raw !== 'object') continue;
    const fn = raw.type === 'function' ? raw.function : raw.function || raw;
    if (!fn || typeof fn !== 'object') continue;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
    if (tools.some((item) => item.name === name)) continue;
    tools.push({
      name,
      description: typeof fn.description === 'string' ? fn.description.slice(0, 2000) : '',
      parameters:
        fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters)
          ? fn.parameters
          : { type: 'object', properties: {} }
    });
    if (tools.length >= 64) break;
  }
  return tools;
}

function tryParseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 从模型输出文本中解析工具调用。
 * 支持：
 *  - {"tool_call":{"name":"x","arguments":{...}}}
 *  - {"name":"x","arguments":{...}}（仅当文本基本只有该 JSON 时）
 *  - <tool_call>{"name":...}</tool_call> / ```json {...}```
 * @returns {{name:string, arguments:object} | null}
 */
export function parseToolCall(text, tools = []) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const names = new Set(tools.map((tool) => tool.name));
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const tag = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (tag) candidates.push(tag[1]);
  candidates.push(text);
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    const value = tryParseJson(String(candidate).trim());
    if (!value) continue;
    const call = value.tool_call || value.toolCall || value;
    const name = typeof call.name === 'string' ? call.name.trim() : '';
    if (!name) continue;
    if (names.size && !names.has(name)) continue;
    let args = call.arguments ?? call.args ?? call.parameters ?? {};
    if (typeof args === 'string') args = tryParseJson(args) || {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    return { name, arguments: args };
  }
  return null;
}

/** 构造 OpenAI `tool_calls` 条目。 */
export function buildToolCall(name, args) {
  return {
    id: `call_${crypto.randomBytes(12).toString('hex')}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args && typeof args === 'object' ? args : {})
    }
  };
}

/** 工具结果 → 回填给模型的用户消息文本。 */
export function formatToolResult(name, content, isError = false) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const body = text.length > 20000 ? `${text.slice(0, 20000)}…(truncated)` : text;
  return `[tool_result name="${name}"${isError ? ' error="true"' : ''}]\n${body}`;
}

/** 把带 tool 角色/assistant.tool_calls 的会话转换为上游可用的 user/assistant 文本。 */
export function buildUpstreamConversation(conversation = []) {
  const result = [];
  for (const message of Array.isArray(conversation) ? conversation : []) {
    if (!message || !message.role) continue;
    if (message.role === 'tool') {
      const label = message.name ? ` name="${message.name}"` : '';
      result.push({ role: 'user', content: `[tool_result${label}]\n${message.content || ''}` });
      continue;
    }
    result.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '') });
  }
  return result;
}

/**
 * 创建 function calling 解析器。
 * @param {{
 *   tools: Array<{name:string, description?:string, parameters?:object}>,
 *   mode?: 'client'|'auto',
 *   maxRounds?: number,
 *   mcp?: { available?: boolean, callTool?: (name: string, args: object) => Promise<{content:string, isError?:boolean}> } | null,
 *   logger?: any
 * }} options
 */
export function createFunctionCallRunner({ tools, mode = 'client', maxRounds = 4, mcp = null, logger = null } = {}) {
  const activeTools = Array.isArray(tools) ? tools : [];
  return {
    /**
     * @param {{ outcome: {collected: any, result: any}, conversation: any[], systemPrompt: string }} initial
     * @param {(request: {conversation: any[], systemPrompt: string}) => Promise<{collected:any, result:any}>} callModel
     * @returns {Promise<{outcome:{collected:any, result:any}, toolCalls: any[], executed: any[]}>}
     */
    async run(initial, callModel) {
      let outcome = initial.outcome;
      let conversation = initial.conversation;
      const systemPrompt = initial.systemPrompt;
      const executed = [];
      const rounds = Math.min(8, Math.max(0, Number.isFinite(maxRounds) ? maxRounds : 4));

      for (let round = 0; round <= rounds; round += 1) {
        const collected = outcome.collected || {};
        const rawContent =
          typeof outcome.result?.content === 'string' && outcome.result.content
            ? outcome.result.content
            : typeof collected.content === 'string'
              ? collected.content
              : '';
        const parsed = parseToolCall(rawContent, activeTools);
        if (!parsed) {
          // 模型没有请求工具：最终回答（auto 模式的内部执行记录不进 tool_calls）
          return { outcome, toolCalls: [], executed };
        }
        const call = buildToolCall(parsed.name, parsed.arguments);

        if (mode !== 'auto') {
          // 客户端模式：把 tool_calls 返回给客户端执行（下一轮用 messages[role=tool] 回传）
          return { outcome, toolCalls: [call], executed };
        }

        // auto 模式：网关通过 MCP 执行工具
        let content = '';
        let isError = false;
        try {
          if (!mcp || typeof mcp.callTool !== 'function') {
            throw Object.assign(new Error('MCP tools are not available'), { code: 'mcp_unavailable' });
          }
          const result = await mcp.callTool(parsed.name, parsed.arguments);
          content = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? result ?? '');
          isError = result?.isError === true;
        } catch (error) {
          content = `工具执行失败：${error?.message || error}`;
          isError = true;
          logger?.warn?.('function tool execution failed', { tool: parsed.name, error: error?.message });
        }
        executed.push({ ...call, result: content, isError });
        if (round === rounds) {
          // 达到轮次上限：返回最后一次模型输出（executed 仅供历史/调试）
          return { outcome, toolCalls: [], executed };
        }
        conversation = [
          ...conversation,
          { role: 'assistant', content: rawContent.trim() },
          { role: 'user', content: formatToolResult(parsed.name, content, isError) }
        ];
        outcome = await callModel({ conversation, systemPrompt });
      }
      return { outcome, toolCalls: [], executed };
    }
  };
}

/** 把 OpenAI `finish_reason` 标记为 tool_calls（当响应携带 tool_calls 时）。 */
export function isToolCallFinish(toolCalls) {
  return Array.isArray(toolCalls) && toolCalls.length > 0;
}

export const FUNCTION_TOOL_PROTOCOL_VERSION = 1;
