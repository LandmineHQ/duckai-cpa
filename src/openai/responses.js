/**
 * POST /v1/responses — OpenAI Responses API compatible handler.
 *
 * Non-streaming: a `response` object with `output` items (reasoning summary,
 * assistant message with `output_text` parts + url_citation annotations, image
 * generation calls), `output_text`, `usage` and an extra top-level `annotations`.
 *
 * Streaming: the official event sequence with monotonically increasing
 * `sequence_number`:
 *   response.created → response.in_progress →
 *   [reasoning item/summary events] → response.output_item.added →
 *   response.content_part.added → response.output_text.delta →
 *   response.output_text.done → response.content_part.done →
 *   response.output_item.done → response.completed
 * plus `response.image_generation_call.*` events for generated images.
 */

import {
  composeSystemPrompt,
  buildDuckMessages,
  normalizeContent,
  mergeSources,
  mergeImages,
  normalizeImage,
  buildAnnotations,
  cleanCitationText,
  createCitationFilter,
  createFirstEventGate,
  resolveToolFlags,
  recordUsageOnLog,
  normalizeContentParts,
  normalizeImagePart,
  injectProtocolIntoFirstUser
} from './chat.js';
import {
  buildToolProtocol,
  formatToolCallsForHistory,
  formatToolResult,
  normalizeToolDefinitions,
  parseToolCalls,
  stripToolCallText
} from './tool-protocol.js';
import { resolveModel, resolveReasoningEffort } from './models.js';
import { guardConversation } from './context-guard.js';
import { normalizeToolCalls, recordHistoryOnLog } from './chat.js';
import {
  badRequest,
  buildEstimatedUsage,
  genId,
  nowSec,
  toOpenAIError,
  errorPayload,
  isAbortError
} from './errors.js';

const IGNORED_INPUT_ITEM_TYPES = new Set([
  'item_reference',
  'computer_call',
  'computer_call_output',
  'local_shell_call',
  'local_shell_call_output',
  'file_search_call',
  'code_interpreter_call',
  'mcp_call',
  'mcp_list_tools',
  'mcp_approval_request',
  'mcp_approval_response',
  'reasoning'
]);

/* ------------------------------------------------------------------ */
/* Input normalization                                                 */
/* ------------------------------------------------------------------ */

function pushContentItem(item, systemParts, conversation, state = { pendingImages: [] }) {
  if (typeof item === 'string') {
    conversation.push({ role: 'user', content: item, ...(state.pendingImages.length ? { images: state.pendingImages.splice(0) } : {}) });
    return 'user';
  }
  if (!item || typeof item !== 'object') {
    throw badRequest('Each entry of "input" must be a string or an object', 'input');
  }

  const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';

  // Content parts passed directly (some SDK helpers do this).
  if (type === 'input_text' || type === 'text' || type === 'output_text') {
    const normalized = normalizeContentParts(item);
    conversation.push({ role: 'user', content: normalized.text });
    return 'user';
  }
  if (type === 'input_image') {
    // v2.44：图像输入 → 真实 image part（data URL），交给上游多模态
    const image = normalizeImagePart(item);
    if (image) state.pendingImages.push(image);
    return null;
  }
  if (type === 'input_file') return null;
  // v2.44：上一轮 image_generation_call → 保留真实图片，挂到下一轮 user 消息上。
  if (type === 'image_generation_call') {
    const format = typeof item.output_format === 'string' && item.output_format ? item.output_format : 'png';
    const b64 = typeof item.result === 'string' ? item.result : '';
    if (b64) {
      const mime = format === 'jpg' || format === 'jpeg' ? 'image/jpeg' : `image/${format.replace(/^image\//, '')}`;
      state.pendingImages.push({ mimeType: mime, dataUrl: `data:${mime};base64,${b64}` });
    }
    return 'image';
  }
  // v2.44：客户端工具历史回放
  if (type === 'function_call') {
    const name = typeof item.name === 'string' ? item.name : 'tool';
    const args = typeof item.arguments === 'string' ? item.arguments : '{}';
    conversation.push({ role: 'assistant', content: formatToolCallsForHistory([{ name, arguments: args }]) });
    return 'assistant';
  }
  if (type === 'function_call_output') {
    conversation.push({ role: 'user', content: formatToolResult({ result: item.output }) });
    return 'user';
  }
  if (IGNORED_INPUT_ITEM_TYPES.has(type)) return null;

  if (type === 'message' || (!type && (item.role || item.content !== undefined))) {
    const role = typeof item.role === 'string' ? item.role.toLowerCase() : 'user';
    const normalized = normalizeContentParts(item.content);
    const content = normalized.text;
    const images = normalized.images;
    if (role === 'system' || role === 'developer') {
      if (content.trim()) systemParts.push(content);
      return 'system';
    }
    if (role === 'user') {
      conversation.push({ role: 'user', content, ...(images.length || state.pendingImages.length ? { images: [...state.pendingImages.splice(0), ...images] } : {}) });
      return 'user';
    }
    if (role === 'assistant') {
      conversation.push({ role: 'assistant', content, ...(images.length ? { images } : {}) });
      return 'assistant';
    }
    throw badRequest(`Unsupported input message role "${role}"`, 'input');
  }

  throw badRequest(`Unsupported input item type "${type || '(missing)'}"`, 'input');
}

/**
 * @returns {{systemParts: string[], conversation: Array<{role:string,content:string}>, promptChars: number}}
 */
export function normalizeResponsesInput(input) {
  const systemParts = [];
  const conversation = [];
  const state = { pendingImages: [] };

  if (typeof input === 'string') {
    if (input.trim()) conversation.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) pushContentItem(item, systemParts, conversation, state);
    if (state.pendingImages.length) {
      conversation.push({ role: 'user', content: '（上一轮生成的图片）', images: state.pendingImages.splice(0) });
    }
  } else {
    throw badRequest('"input" must be a string or an array of message items', 'input');
  }

  const hasUserText =
    conversation.some((message) => message.role === 'user' && message.content.trim()) ||
    conversation.some((message) => message.role === 'user' && Array.isArray(message.images) && message.images.length);
  if (!hasUserText) {
    throw badRequest('"input" must contain at least one non-empty user message', 'input');
  }

  const promptChars =
    systemParts.reduce((sum, part) => sum + part.length, 0) +
    conversation.reduce((sum, message) => sum + message.content.length, 0);

  return { systemParts, conversation, promptChars };
}

/* ------------------------------------------------------------------ */
/* Output item builders                                                */
/* ------------------------------------------------------------------ */

function buildReasoningItem(id, text, status = 'completed') {
  return {
    id,
    type: 'reasoning',
    status,
    summary: status === 'completed' ? [{ type: 'summary_text', text: text || '' }] : []
  };
}

function buildMessageItem(id, text, annotations, status = 'completed') {
  const part = { type: 'output_text', text: text || '', annotations: annotations || [], logprobs: [] };
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: status === 'completed' ? [part] : []
  };
}

function buildFunctionCallItem(id, call, status = 'completed') {
  return {
    id,
    type: 'function_call',
    status,
    call_id: call.id,
    name: call.function && call.function.name ? call.function.name : call.name || 'tool',
    arguments: status === 'completed' ? (call.function ? call.function.arguments : call.arguments) || '{}' : ''
  };
}

function buildImageItem(id, image, status = 'completed') {
  return {
    id,
    type: 'image_generation_call',
    status,
    result: status === 'completed' ? image.b64 : null,
    output_format: image.format || 'png',
    ...(Number.isFinite(image.width) ? { width: image.width } : {}),
    ...(Number.isFinite(image.height) ? { height: image.height } : {}),
    ...(image.model ? { model: image.model } : {})
  };
}

function makeResponseObject({
  id,
  createdAt,
  model,
  status,
  output,
  outputText,
  usage,
  annotations,
  body,
  reasoningEffort,
  reasoningText,
  error = null
}) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    background: false,
    error,
    incomplete_details: null,
    instructions: typeof body?.instructions === 'string' ? body.instructions : null,
    max_output_tokens: Number.isFinite(Number(body?.max_output_tokens)) ? Number(body.max_output_tokens) : null,
    metadata: body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {},
    model,
    output,
    output_text: outputText || '',
    parallel_tool_calls: false,
    previous_response_id: body?.previous_response_id ?? null,
    reasoning: {
      effort: reasoningEffort,
      summary: reasoningText ? [{ type: 'summary_text', text: reasoningText }] : []
    },
    store: false,
    temperature: Number.isFinite(Number(body?.temperature)) ? Number(body.temperature) : null,
    text: { format: { type: 'text' } },
    tool_choice: body?.tool_choice ?? 'auto',
    tools: Array.isArray(body?.tools) ? body.tools : [],
    top_p: Number.isFinite(Number(body?.top_p)) ? Number(body.top_p) : null,
    truncation: 'disabled',
    usage,
    user: typeof body?.user === 'string' ? body.user : null,
    annotations: annotations || []
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
export async function handleResponses(req, res, ctx) {
  ctx.log.endpoint = 'POST /v1/responses';
  const body = ctx.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  const resolved = resolveModel(ctx.config, body.model);
  ctx.log.model = resolved.id;

  const input = normalizeResponsesInput(body.input);
  ctx.log.promptChars = input.promptChars;

  if (body.instructions != null && typeof body.instructions !== 'string') {
    throw badRequest('"instructions" must be a string', 'instructions');
  }
  const reasoning = resolveReasoningEffort(
    resolved.model,
    body.reasoning?.effort ?? body.reasoning_effort,
    { param: 'reasoning.effort' }
  );
  const flags = resolveToolFlags(ctx.config, resolved.model, body);
  // v2.44：客户端工具（Responses 形状自动归一化）
  const clientTools =
    ctx.config?.tools?.clientFunctionCalling?.enabled === false ? [] : normalizeToolDefinitions(body.tools);
  if (clientTools.length) ctx.log.clientTools = clientTools.map((tool) => tool.name);

  const systemPrompt = composeSystemPrompt(ctx.config, resolved, [
    typeof body.instructions === 'string' ? body.instructions : '',
    ...input.systemParts
  ]);
  const guarded = guardConversation(input.conversation, systemPrompt, ctx.config?.context || {});
  if (guarded.trimmed) ctx.log.contextTrimmed = true;
  let upstreamMessages = guarded.messages;
  if (clientTools.length) {
    upstreamMessages = injectProtocolIntoFirstUser(guarded.messages, buildToolProtocol(clientTools));
  }
  const duckMessages = buildDuckMessages({
    systemPrompt,
    conversation: upstreamMessages,
    promptMode: ctx.config?.prompts?.mode
  });
  if (typeof ctx.selectIdentity === 'function') {
    const paidModel =
      ctx.config?.duck?.allowPaidModels === true && (resolved.paid === true || resolved.model?.paid === true);
    await ctx.selectIdentity({ paidModel });
  }

  const stream = body.stream === true;
  ctx.log.stream = stream;

  try {
    ctx.res.setHeader('X-Duckai-Model', resolved.id);
    ctx.res.setHeader('X-Duckai-Reasoning-Effort', reasoning.effort);
    if (reasoning.adjusted) {
      ctx.res.setHeader('X-Duckai-Reasoning-Adjusted', 'true');
      if (reasoning.note) ctx.res.setHeader('X-Duckai-Reasoning-Note', encodeURIComponent(reasoning.note));
    }
  } catch {
    // ignore header failures
  }

  const params = {
    body,
    resolved,
    reasoning,
    flags,
    duckMessages,
    systemPrompt,
    conversation: guarded.messages,
    upstreamMessages,
    historyMessages: guarded.messages,
    clientTools,
    contextTrimmed: guarded.trimmed,
    promptChars: input.promptChars
  };

  if (stream) await streamResponse(ctx, params);
  else await completeResponse(ctx, params);
}

async function collectResponse(ctx, params) {
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
    onTextDelta(text) {
      if (typeof text === 'string') collected.content += text;
    },
    onReasoningDelta(text) {
      if (typeof text === 'string') collected.reasoning += text;
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
  const result = await ctx.callUpstream(taskFor(params.duckMessages), {
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
  });

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
  return {
    content,
    reasoningText,
    sources,
    images,
    usage: collected.usage,
    finishReason: toolCalls.length ? 'tool_calls' : result?.finishReason,
    toolCalls
  };
}

async function completeResponse(ctx, params) {
  const { content, reasoningText, sources, images, usage: upstreamUsage, toolCalls } = await collectResponse(ctx, params);
  const annotations = buildAnnotations(sources);
  const output = [];
  // v2.40：只有图片时补一条文字说明（Codex 等只渲染 message 的客户端不会显示空消息）
  const fallbackText =
    !content && images.length
      ? `已生成 ${images.length} 张图片（base64 位于 image_generation_call.result 字段）。`
      : '';
  const outputText = content || fallbackText;

  if (reasoningText) output.push(buildReasoningItem(genId('rs_'), reasoningText));
  if (content || annotations.length || images.length === 0 || fallbackText) {
    if (content || annotations.length || !toolCalls.length) {
      output.push(buildMessageItem(genId('msg_'), outputText, annotations));
    }
  }
  for (const call of toolCalls) output.push(buildFunctionCallItem(genId('fc_'), call));
  for (const image of images) output.push(buildImageItem(genId('ig_'), image));

  const usage = buildEstimatedUsage({
    promptChars: params.promptChars,
    completionChars: content.length,
    reasoningChars: reasoningText.length,
    upstreamUsage
  });
  recordUsageOnLog(ctx, usage);
  // Responses API uses input_tokens / output_tokens.
  const responsesUsage = {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    estimated: true,
    estimation: usage.estimation
  };

  const payload = makeResponseObject({
    id: genId('resp_'),
    createdAt: nowSec(),
    model: params.resolved.id,
    status: 'completed',
    output,
    outputText,
    usage: responsesUsage,
    annotations,
    body: params.body,
    reasoningEffort: params.reasoning.effort,
    reasoningText
  });
  if (ctx.log.contextTrimmed) payload.context_trimmed = true;
  // v2.33：/v1/responses 也写入会话历史（此前只有 chat/completions 记录）
  recordHistoryOnLog(ctx, {
    messages: params.historyMessages || params.conversation,
    assistantText: content || '',
    reasoning: reasoningText,
    images,
    sources,
    toolCalls: toolCalls.map((call) => ({
      name: call.function?.name || call.name,
      args: call.function?.arguments,
      result: '等待客户端执行'
    })),
    model: params.resolved.id
  });
  ctx.json(200, payload);
}

/**
 * v2.44：带客户端工具的 Responses 流式响应。
 * 工具调用需要完整 JSON，所以先收集再按官方事件序列回放（文本/工具/图片）。
 */
async function streamResponseWithTools(ctx, params) {
  const collected = await collectResponse(ctx, params);
  const responseId = genId('resp_');
  const createdAt = nowSec();
  const writer = ctx.openSSE();
  let sequence = 0;
  const emit = (type, data = {}) => {
    const event = { type, sequence_number: sequence, ...data };
    sequence += 1;
    if (!writer.closed) writer.event(type, event);
  };

  const { content, reasoningText, sources, images, toolCalls, usage: upstreamUsage } = collected;
  const annotations = buildAnnotations(sources);
  const output = [];
  if (reasoningText) output.push(buildReasoningItem(genId('rs_'), reasoningText));
  const fallbackText =
    !content && images.length
      ? `已生成 ${images.length} 张图片（base64 位于 image_generation_call.result 字段）。`
      : '';
  const outputText = content || fallbackText;
  if (content || annotations.length || (!toolCalls.length && !images.length) || fallbackText) {
    output.push(buildMessageItem(genId('msg_'), outputText, annotations));
  }
  for (const call of toolCalls) output.push(buildFunctionCallItem(genId('fc_'), call));
  for (const image of images) output.push(buildImageItem(genId('ig_'), image));

  const usage = buildEstimatedUsage({
    promptChars: params.promptChars,
    completionChars: content.length,
    reasoningChars: reasoningText.length,
    upstreamUsage
  });
  recordUsageOnLog(ctx, usage);
  const responsesUsage = {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    estimated: true,
    estimation: usage.estimation
  };
  const payload = makeResponseObject({
    id: responseId,
    createdAt,
    model: params.resolved.id,
    status: 'completed',
    output,
    outputText,
    usage: responsesUsage,
    annotations,
    body: params.body,
    reasoningEffort: params.reasoning.effort,
    reasoningText
  });

  const inProgress = { ...payload, status: 'in_progress' };
  emit('response.created', { response: inProgress });
  emit('response.in_progress', { response: inProgress });

  let outputIndex = 0;
  if (reasoningText) {
    const item = output[outputIndex];
    emit('response.output_item.added', { response_id: responseId, output_index: outputIndex, item });
    emit('response.reasoning_summary_part.added', {
      response_id: responseId,
      item_id: item.id,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' }
    });
    emit('response.reasoning_summary_text.delta', {
      response_id: responseId,
      item_id: item.id,
      output_index: outputIndex,
      summary_index: 0,
      delta: reasoningText
    });
    emit('response.reasoning_summary_text.done', {
      response_id: responseId,
      item_id: item.id,
      output_index: outputIndex,
      summary_index: 0,
      text: reasoningText
    });
    emit('response.reasoning_summary_part.done', {
      response_id: responseId,
      item_id: item.id,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: reasoningText }
    });
    emit('response.output_item.done', { response_id: responseId, output_index: outputIndex, item });
    outputIndex += 1;
  }

  const messageItem = output.find((item) => item.type === 'message');
  if (messageItem) {
    emit('response.output_item.added', { response_id: responseId, output_index: outputIndex, item: { ...messageItem, status: 'in_progress', content: [] } });
    emit('response.content_part.added', {
      response_id: responseId,
      item_id: messageItem.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
    if (outputText) {
      emit('response.output_text.delta', {
        response_id: responseId,
        item_id: messageItem.id,
        output_index: outputIndex,
        content_index: 0,
        delta: outputText,
        logprobs: []
      });
    }
    emit('response.output_text.done', {
      response_id: responseId,
      item_id: messageItem.id,
      output_index: outputIndex,
      content_index: 0,
      text: outputText
    });
    emit('response.content_part.done', {
      response_id: responseId,
      item_id: messageItem.id,
      output_index: outputIndex,
      content_index: 0,
      part: messageItem.content[0]
    });
    emit('response.output_item.done', { response_id: responseId, output_index: outputIndex, item: messageItem });
    outputIndex += 1;
  }

  for (const call of toolCalls) {
    const item = output.find((entry) => entry.type === 'function_call' && entry.call_id === call.id);
    if (!item) continue;
    emit('response.output_item.added', {
      response_id: responseId,
      output_index: outputIndex,
      item: { ...item, status: 'in_progress', arguments: '' }
    });
    emit('response.function_call_arguments.delta', {
      response_id: responseId,
      item_id: item.id,
      output_index: outputIndex,
      delta: item.arguments
    });
    emit('response.function_call_arguments.done', {
      response_id: responseId,
      item_id: item.id,
      output_index: outputIndex,
      arguments: item.arguments
    });
    emit('response.output_item.done', { response_id: responseId, output_index: outputIndex, item });
    outputIndex += 1;
  }

  for (const image of images) {
    const item = output.find((entry) => entry.type === 'image_generation_call' && entry.result === image.b64);
    if (!item) continue;
    emit('response.output_item.added', { response_id: responseId, output_index: outputIndex, item });
    emit('response.image_generation_call.completed', {
      response_id: responseId,
      item_id: item.id,
      output_index: outputIndex,
      result: image.b64
    });
    emit('response.output_item.done', { response_id: responseId, output_index: outputIndex, item });
    outputIndex += 1;
  }

  recordHistoryOnLog(ctx, {
    messages: params.historyMessages || params.conversation,
    assistantText: content || '',
    reasoning: reasoningText,
    images,
    sources,
    toolCalls: toolCalls.map((call) => ({
      name: call.function?.name || call.name,
      args: call.function?.arguments,
      result: '等待客户端执行'
    })),
    model: params.resolved.id
  });
  emit('response.completed', { response: payload });
  writer.end();
}

async function streamResponse(ctx, params) {
  if (Array.isArray(params.clientTools) && params.clientTools.length > 0) {
    return streamResponseWithTools(ctx, params);
  }

  const responseId = genId('resp_');
  const createdAt = nowSec();
  const model = params.resolved.id;
  const body = params.body;
  let sequence = 0;
  let writer = null;
  const pendingEvents = [];
  const gate = createFirstEventGate();

  const emit = (type, data = {}) => {
    const event = { type, sequence_number: sequence, ...data };
    sequence += 1;
    if (writer) {
      if (!writer.closed) writer.event(type, event);
    } else {
      pendingEvents.push(event);
    }
  };
  const flushPendingEvents = () => {
    if (!writer) return;
    for (const event of pendingEvents.splice(0)) {
      if (!writer.closed) writer.event(event.type, event);
    }
  };

  const outputItems = [];
  const annotations = [];
  const sourcesStore = [];
  let annotationsSent = 0;
  let content = '';
  let reasoningText = '';

  const textFilter = createCitationFilter();
  const reasoningFilter = createCitationFilter();

  let upstreamUsage = null;
  let collectedError = null;

  let reasoningItem = null;
  let reasoningIndex = -1;
  let messageItem = null;
  let messageIndex = -1;
  let messagePartAdded = false;

  const makeSnapshot = (status, { usage = null, error = null } = {}) => {
    const output = outputItems.map((entry) => entry.item);
    return makeResponseObject({
      id: responseId,
      createdAt,
      model,
      status,
      output,
      outputText: content,
      usage,
      annotations,
      body,
      reasoningEffort: params.reasoning.effort,
      reasoningText,
      error
    });
  };

  const ensureReasoningItem = () => {
    if (reasoningItem) return reasoningItem;
    reasoningIndex = outputItems.length;
    reasoningItem = buildReasoningItem(genId('rs_'), '', 'in_progress');
    outputItems.push({ index: reasoningIndex, item: reasoningItem, kind: 'reasoning' });
    emit('response.output_item.added', {
      response_id: responseId,
      output_index: reasoningIndex,
      item: { ...reasoningItem }
    });
    emit('response.reasoning_summary_part.added', {
      response_id: responseId,
      item_id: reasoningItem.id,
      output_index: reasoningIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' }
    });
    return reasoningItem;
  };

  const ensureMessageItem = () => {
    if (messageItem) return messageItem;
    messageIndex = outputItems.length;
    messageItem = buildMessageItem(genId('msg_'), '', [], 'in_progress');
    outputItems.push({ index: messageIndex, item: messageItem, kind: 'message' });
    emit('response.output_item.added', {
      response_id: responseId,
      output_index: messageIndex,
      item: { ...messageItem }
    });
    messagePartAdded = true;
    emit('response.content_part.added', {
      response_id: responseId,
      item_id: messageItem.id,
      output_index: messageIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
    return messageItem;
  };

  const rebuildAnnotations = () => {
    const built = buildAnnotations(sourcesStore);
    annotations.length = 0;
    annotations.push(...built);
  };

  const flushAnnotations = () => {
    if (annotations.length <= annotationsSent) return;
    const item = ensureMessageItem();
    for (let index = annotationsSent; index < annotations.length; index += 1) {
      emit('response.output_text.annotation.added', {
        response_id: responseId,
        item_id: item.id,
        output_index: messageIndex,
        content_index: 0,
        annotation_index: index,
        annotation: annotations[index]
      });
    }
    annotationsSent = annotations.length;
  };

  const addImages = (imageList) => {
    for (const image of imageList) {
      const exists = outputItems.some((entry) => entry.kind === 'image' && entry.item.result === image.b64);
      if (exists) continue;
      const index = outputItems.length;
      const item = buildImageItem(genId('ig_'), image, 'in_progress');
      outputItems.push({ index, item, kind: 'image' });
      emit('response.output_item.added', {
        response_id: responseId,
        output_index: index,
        item: { ...item }
      });
      emit('response.image_generation_call.in_progress', {
        response_id: responseId,
        item_id: item.id,
        output_index: index
      });
      item.status = 'completed';
      item.result = image.b64;
      emit('response.image_generation_call.completed', {
        response_id: responseId,
        item_id: item.id,
        output_index: index,
        result: image.b64
      });
      emit('response.output_item.done', {
        response_id: responseId,
        output_index: index,
        item: { ...item }
      });
    }
  };

  emit('response.created', { response: makeSnapshot('in_progress') });
  emit('response.in_progress', { response: makeSnapshot('in_progress') });

  const handlers = {
    onTextDelta(text) {
      const cleaned = textFilter.process(text);
      if (!cleaned) return;
      const item = ensureMessageItem();
      content += cleaned;
      emit('response.output_text.delta', {
        response_id: responseId,
        item_id: item.id,
        output_index: messageIndex,
        content_index: 0,
        delta: cleaned,
        logprobs: []
      });
    },
    onReasoningDelta(text) {
      const cleaned = reasoningFilter.process(text);
      if (!cleaned) return;
      const item = ensureReasoningItem();
      reasoningText += cleaned;
      emit('response.reasoning_summary_text.delta', {
        response_id: responseId,
        item_id: item.id,
        output_index: reasoningIndex,
        summary_index: 0,
        delta: cleaned
      });
    },
    onSearchResults(results) {
      const merged = mergeSources(sourcesStore, results);
      sourcesStore.length = 0;
      sourcesStore.push(...merged);
      rebuildAnnotations();
      flushAnnotations();
    },
    onImage(image) {
      const normalized = normalizeImage(image);
      if (!normalized) return;
      addImages([normalized]);
    },
    onUsage(usage) {
      upstreamUsage = usage;
    },
    onToolCall() {},
    onToolResult() {},
    onError(error) {
      collectedError = error;
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

  let result;
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
    throw error; // no SSE headers yet → JSON error
  }

  let outcome;
  try {
    outcome = await Promise.race([
      chatPromise.then((value) => ({ kind: 'done', value })),
      gate.promise.then(() => ({ kind: 'event' }))
    ]);
  } catch (error) {
    if (!gate.fired) throw error; // pre-stream failure → HTTP JSON error (429 etc.)
    writer = ctx.openSSE();
    flushPendingEvents();
    const normalized = toOpenAIError(error);
    ctx.log.error = normalized.message;
    emit('response.failed', {
      response: makeSnapshot('failed', {
        error: { code: normalized.code || normalized.type, message: normalized.message }
      })
    });
    emit('error', {
      code: normalized.code || normalized.type,
      message: normalized.message,
      param: normalized.param ?? null
    });
    writer.end();
    return;
  }

  writer = ctx.openSSE();
  flushPendingEvents();

  if (outcome.kind === 'event') {
    try {
      result = await chatPromise;
    } catch (error) {
      const normalized = toOpenAIError(error);
      ctx.log.error = normalized.message;
      emit('response.failed', {
        response: makeSnapshot('failed', {
          error: { code: normalized.code || normalized.type, message: normalized.message }
        })
      });
      emit('error', {
        code: normalized.code || normalized.type,
        message: normalized.message,
        param: normalized.param ?? null
      });
      writer.end();
      return;
    }
  } else {
    result = outcome.value;
  }

  try {
    const textTail = textFilter.process('', { flush: true });
    if (textTail) {
      const item = ensureMessageItem();
      content += textTail;
      emit('response.output_text.delta', {
        response_id: responseId,
        item_id: item.id,
        output_index: messageIndex,
        content_index: 0,
        delta: textTail,
        logprobs: []
      });
    }
    const reasoningTail = reasoningFilter.process('', { flush: true });
    if (reasoningTail) {
      const item = ensureReasoningItem();
      reasoningText += reasoningTail;
      emit('response.reasoning_summary_text.delta', {
        response_id: responseId,
        item_id: item.id,
        output_index: reasoningIndex,
        summary_index: 0,
        delta: reasoningTail
      });
    }

    if (!content && typeof result?.content === 'string' && result.content) {
      const cleaned = cleanCitationText(result.content);
      if (cleaned) {
        const item = ensureMessageItem();
        content = cleaned;
        emit('response.output_text.delta', {
          response_id: responseId,
          item_id: item.id,
          output_index: messageIndex,
          content_index: 0,
          delta: cleaned,
          logprobs: []
        });
      }
    }
    if (!reasoningText && typeof result?.reasoning === 'string' && result.reasoning) {
      const cleaned = cleanCitationText(result.reasoning);
      if (cleaned) {
        const item = ensureReasoningItem();
        reasoningText = cleaned;
        emit('response.reasoning_summary_text.delta', {
          response_id: responseId,
          item_id: item.id,
          output_index: reasoningIndex,
          summary_index: 0,
          delta: cleaned
        });
      }
    }

    // Merge sources that arrived only in the final result.
    const finalSources = mergeSources(sourcesStore, result?.sources);
    sourcesStore.length = 0;
    sourcesStore.push(...finalSources);
    rebuildAnnotations();
    flushAnnotations();

    const addedImageB64 = new Set(
      outputItems
        .filter((entry) => entry.kind === 'image')
        .map((entry) => entry.item.result)
        .filter(Boolean)
    );
    const extraImages = mergeImages(result?.images).filter((image) => !addedImageB64.has(image.b64));
    if (extraImages.length) addImages(extraImages);

    // v2.40：只有图片时补一条文字说明，避免客户端显示空消息
    const hasImageItems = outputItems.some((entry) => entry.kind === 'image');
    if (!content && hasImageItems) {
      content = `已生成 ${outputItems.filter((entry) => entry.kind === 'image').length} 张图片（base64 位于 image_generation_call.result 字段）。`;
    }
    // Ensure a message item exists even for empty text.
    if (!messageItem && annotations.length === 0 && !hasImageItems) {
      ensureMessageItem();
    }
    if (!messageItem && (annotations.length > 0 || hasImageItems)) {
      ensureMessageItem();
      emit('response.output_text.done', {
        response_id: responseId,
        item_id: messageItem.id,
        output_index: messageIndex,
        content_index: 0,
        text: content
      });
      const part = { type: 'output_text', text: content, annotations: [...annotations], logprobs: [] };
      emit('response.content_part.done', {
        response_id: responseId,
        item_id: messageItem.id,
        output_index: messageIndex,
        content_index: 0,
        part
      });
    }

    // Finalize reasoning item.
    if (reasoningItem) {
      reasoningItem.status = 'completed';
      reasoningItem.summary = [{ type: 'summary_text', text: reasoningText }];
      emit('response.reasoning_summary_text.done', {
        response_id: responseId,
        item_id: reasoningItem.id,
        output_index: reasoningIndex,
        summary_index: 0,
        text: reasoningText
      });
      emit('response.reasoning_summary_part.done', {
        response_id: responseId,
        item_id: reasoningItem.id,
        output_index: reasoningIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: reasoningText }
      });
      emit('response.output_item.done', {
        response_id: responseId,
        output_index: reasoningIndex,
        item: { ...reasoningItem, summary: [{ type: 'summary_text', text: reasoningText }] }
      });
    }

    // Finalize message item.
    if (messageItem) {
      const part = { type: 'output_text', text: content, annotations: [...annotations], logprobs: [] };
      messageItem.status = 'completed';
      messageItem.content = [part];
      emit('response.output_text.done', {
        response_id: responseId,
        item_id: messageItem.id,
        output_index: messageIndex,
        content_index: 0,
        text: content
      });
      emit('response.content_part.done', {
        response_id: responseId,
        item_id: messageItem.id,
        output_index: messageIndex,
        content_index: 0,
        part
      });
      emit('response.output_item.done', {
        response_id: responseId,
        output_index: messageIndex,
        item: { ...messageItem, content: [part] }
      });
    }

    const usage = buildEstimatedUsage({
      promptChars: params.promptChars,
      completionChars: content.length,
      reasoningChars: reasoningText.length,
      upstreamUsage
    });
    recordUsageOnLog(ctx, usage);
    const responsesUsage = {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      estimated: true,
      estimation: usage.estimation
    };

    // v2.33：流式 /v1/responses 也写入历史
    const historyImages = outputItems
      .filter((entry) => entry.kind === 'image' && entry.item && entry.item.result)
      .map((entry) => ({ b64: entry.item.result, format: entry.item.output_format || 'jpeg', model: entry.item.model || null }));
    recordHistoryOnLog(ctx, {
      messages: params.conversation,
      assistantText: content || '',
      reasoning: reasoningText,
      images: historyImages,
      sources: sourcesStore,
      toolCalls: [],
      model: params.resolved.id
    });
    emit('response.completed', {
      response: makeSnapshot('completed', { usage: responsesUsage })
    });
    writer.end();
  } catch (error) {
    const normalized = toOpenAIError(error);
    ctx.log.error = normalized.message;
    try {
      if (!writer.closed) {
        const failedResponse = makeSnapshot('failed', {
          error: { code: normalized.code || normalized.type, message: normalized.message }
        });
        emit('response.failed', { response: failedResponse });
        emit('error', {
          code: normalized.code || normalized.type,
          message: normalized.message,
          param: normalized.param ?? null
        });
      }
    } catch {
      // client already disconnected
    }
    void isAbortError(error);
    writer.end();
  }
}
