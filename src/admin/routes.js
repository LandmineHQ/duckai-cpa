/**
 * Admin API for duckai-cpa v2 (`/admin/api/*`).
 *
 * Contract: docs/ADMIN_API_V2.md. Authentication is enforced by
 * src/http/server.js before this module runs (admin token only).
 *
 * Routes:
 *   GET    /admin/api/overview
 *   GET    /admin/api/config            PUT /admin/api/config      POST /admin/api/config/reset
 *   GET    /admin/api/logs?kind=                                 DELETE /admin/api/logs?kind=
 *   GET    /admin/api/keys              POST /admin/api/keys       DELETE /admin/api/keys/:id
 *   GET    /admin/api/models
 *   GET    /admin/api/health
 *   GET    /admin/api/test/sessions     POST /admin/api/test/sessions
 *   GET    /admin/api/test/sessions/:id PATCH ...                  DELETE ...
 *   POST   /admin/api/test/sessions/:id/messages   (SSE)
 *
 * v2 BREAKING: the old single-shot `POST /admin/api/test` route is removed (404).
 */

import {
  isPaidModel,
  resolveModel,
  resolveReasoningEffort
} from '../openai/models.js';
import {
  buildDuckMessages,
  cleanCitationText,
  composeSystemPrompt,
  createCitationFilter,
  createFirstEventGate,
  mergeImages,
  mergeSources,
  normalizeImage,
  normalizeToolCalls
} from '../openai/chat.js';
import { generateId } from './sessions.js';
import { guardConversation } from '../openai/context-guard.js';
import {
  buildCompactedSystemPrompt,
  evaluateCompactionTrigger,
  getCompactConfig,
  parseCompactionMarkers,
  splitForCompact,
  summarizeConversation
} from '../openai/compact.js';
import { handleIdentityRoutes } from './identity-routes.js';
import { handleProxyRoutes } from './proxy-routes.js';
import { handleIdentityPoolRoutes } from './identity-pool-routes.js';
import { handleSubscriptionRoutes } from './subscriptions-routes.js';
import { friendlyErrorMessage, methodNotAllowed, requireMethod } from './routes/helpers.js';
import { handleHealth, handleOverview } from './routes/overview.js';
import { handleModels, handleModelsConfig, handleModelsConfigReset, handleModelsRefresh } from './routes/models.js';
import { handleGetConfig, handlePutConfig, handleResetConfig } from './routes/config.js';
import { handleLogs, handleLogsDownload, handleLogsRetention, handleUsage } from './routes/logs.js';
import { handleKeys } from './routes/keys.js';
import { handleHistory } from './routes/history.js';
import { badRequest, conflict, normalizeFinishReason, notFound, toOpenAIError } from '../openai/errors.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function sessionBusyError(sessionId) {
  const error = conflict(`Session "${sessionId}" is already streaming a response`, 'session_busy');
  error.headers = { ...(error.headers || {}), 'Retry-After': '1', 'X-Duckai-Retriable': 'true' };
  error.retriable = true;
  return error;
}

/* ------------------------------------------------------------------ */
/* Overview / health / models                                          */
/* ------------------------------------------------------------------ */




/**
 * v2.22 危险操作：把模型配置**全部**重置为默认值（覆盖参数 + 工具开关 + 严格模式）。
 * 前端「模型配置 → 危险操作」卡片使用，需要二次确认后调用。
 */

/**
 * v2.22 刷新模型目录/上游能力：
 * - 模型元数据是**内置静态表**（src/duck/models.js，随版本发布），无法从上游拉取；
 * - 本端点会重新读取上游 `/duckchat/v1/capabilities`（flags/实验）并返回快照，便于确认
 *   上游是否有新的实验/开关；同时返回当前模型数量与目录来源，避免误以为能"刷新模型列表"。
 */

/**
 * v2.21 模型配置页：每个模型的上下文/输出上限覆盖（默认 duck.ai 实测值）。
 *   GET  /admin/api/models/config  → { items:[{id,defaults,override,effective}], limits, defaults }
 *   PUT  /admin/api/models/config  ← { overrides: { modelId: { ... } | null } }（整体替换）
 */

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */




/* ------------------------------------------------------------------ */
/* Logs                                                                */
/* ------------------------------------------------------------------ */


/**
 * v2.24：日志下载。`GET /admin/api/logs/download?kind=upstream|admin&format=json|jsonl|csv`
 * 附件下载，包含当前缓冲区内的全部日志（受保留策略约束）。
 */

/**
 * v2.24：日志保留策略。
 *   GET  /admin/api/logs/retention → { maxEntries, maxAgeDays, upstreamCount, adminCount }
 *   PUT  /admin/api/logs/retention ← { maxEntries, maxAgeDays }（立即裁剪并持久化）
 */

/** v2.24：token 消耗总览（分模型 / 分身份×模型）。 */


/* ------------------------------------------------------------------ */
/* API keys                                                            */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Connection-test sessions                                            */
/* ------------------------------------------------------------------ */

/**
 * Validate per-turn overrides (model / reasoningEffort / webSearch / imageGeneration)
 * shared by session creation, messages and retry.
 * @returns {Record<string, any>} normalized override patch
 */
function validateTurnOverrides(ctx, body) {
  const patch = {};
  let resolvedModel = null;
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !body.model.trim()) {
      throw badRequest('"model" must be a non-empty string', 'model');
    }
    resolvedModel = resolveModel(ctx.config, body.model);
    patch.model = resolvedModel.id;
  }
  if (body.reasoningEffort !== undefined) {
    if (typeof body.reasoningEffort !== 'string') {
      throw badRequest('"reasoningEffort" must be a string', 'reasoningEffort');
    }
    const modelForEffort = resolvedModel || resolveModel(ctx.config, body.model !== undefined ? body.model : undefined);
    const reasoning = resolveReasoningEffort(modelForEffort.model, body.reasoningEffort, {
      param: 'reasoningEffort'
    });
    patch.reasoningEffort = reasoning.effort;
  }
  for (const field of ['webSearch', 'imageGeneration']) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'boolean') throw badRequest(`"${field}" must be a boolean`, field);
    patch[field] = body[field];
  }
  return patch;
}

/**
 * Validate session settings fields from a create/patch body.
 * @returns {Record<string, any>} patch with normalized values
 */
function validateSessionSettings(ctx, body, { isCreate = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object');
  }
  const patch = validateTurnOverrides(ctx, body);
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw badRequest('"title" must be a string', 'title');
    patch.title = body.title;
  }
  if (isCreate) {
    if (!patch.model) patch.model = resolveModel(ctx.config, undefined).id;
    if (!patch.reasoningEffort) patch.reasoningEffort = 'none';
    if (patch.webSearch === undefined) patch.webSearch = false;
    if (patch.imageGeneration === undefined) patch.imageGeneration = false;
  }
  return patch;
}

/**
 * Build a legal, alternating user/assistant history for DuckClient.
 * - filters non user/assistant roles
 * - drops failed assistant messages (error set) to avoid replaying them
 * - merges consecutive same-role messages so the upstream always sees alternation
 * @param {Array<Record<string, any>>} historyMessages
 * @param {{ appendUserContent?: string }} [options]
 * @returns {Array<{role: 'user'|'assistant', content: string}>}
 */
function buildConversation(historyMessages, { appendUserContent } = {}) {
  /** @type {Array<{role: 'user'|'assistant', content: string}>} */
  const conversation = [];
  const push = (role, text) => {
    if (!text || !text.trim()) return;
    if (conversation.length > 0 && conversation[conversation.length - 1].role === role) {
      conversation[conversation.length - 1].content = `${conversation[conversation.length - 1].content}\n\n${text}`;
      return;
    }
    conversation.push({ role, content: text });
  };
  for (const message of Array.isArray(historyMessages) ? historyMessages : []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (message.role === 'assistant' && message.error) continue; // never replay failed turns
    push(message.role, typeof message.content === 'string' ? message.content : '');
  }
  while (conversation.length > 0 && conversation[0].role === 'assistant') conversation.shift();
  if (appendUserContent !== undefined) push('user', appendUserContent);
  return conversation;
}


async function handleSessions(ctx, parts) {
  if (parts.length === 0) {
    if (ctx.method === 'GET' || ctx.method === 'HEAD') {
      ctx.json(200, { items: await ctx.sessions.listSessions() });
      return;
    }
    if (ctx.method === 'POST') {
      const patch = validateSessionSettings(ctx, ctx.body, { isCreate: true });
      // v2.29：创建时不预绑定身份。身份在**首次请求**按模型要求路由后再回填，
      // 避免「先绑到 free 身份 → 付费模型 403」。
      const session = await ctx.sessions.createSession(patch);
      ctx.json(201, { session });
      return;
    }
    throw methodNotAllowed(ctx, 'GET, POST');
  }

  // v2.31：批量删除连接测试会话
  if (parts.length === 1 && parts[0] === 'bulk-delete') {
    requireMethod(ctx, ['POST']);
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id) : [];
    if (!ids.length) throw badRequest('"ids" is required and must be a non-empty array', 'ids', 'ids_required');
    const deleted = [];
    const missing = [];
    for (const id of ids) {
      const ok = await ctx.sessions.deleteSession(id);
      if (ok) deleted.push(id);
      else missing.push(id);
    }
    ctx.json(200, { ok: true, deleted, missing, deletedCount: deleted.length });
    return;
  }

  const sessionId = decodeURIComponent(parts[0]);
  if (parts.length === 1) {
    if (ctx.method === 'GET' || ctx.method === 'HEAD') {
      const session = await ctx.sessions.getSession(sessionId);
      if (!session) throw notFound(`Session "${sessionId}" not found`, 'session_not_found');
      const compactConfig = getCompactConfig(ctx.config);
      const compactSplit = splitForCompact(buildConversation(session.messages), compactConfig.keepRecentMessages);
      ctx.json(200, {
        session,
        messages: session.messages,
        summary: session.summary ?? null,
        compactable: compactSplit.history.length > 0
      });
      return;
    }
    if (ctx.method === 'PATCH') {
      const patch = validateSessionSettings(ctx, ctx.body);
      const session = await ctx.sessions.updateSession(sessionId, patch);
      if (!session) throw notFound(`Session "${sessionId}" not found`, 'session_not_found');
      ctx.json(200, { session });
      return;
    }
    if (ctx.method === 'DELETE') {
      const deleted = await ctx.sessions.deleteSession(sessionId);
      if (!deleted) throw notFound(`Session "${sessionId}" not found`, 'session_not_found');
      ctx.json(200, { ok: true });
      return;
    }
    throw methodNotAllowed(ctx, 'GET, PATCH, DELETE');
  }

  if (parts.length === 2 && parts[1] === 'compact') {
    requireMethod(ctx, ['POST']);
    await handleSessionCompact(ctx, sessionId);
    return;
  }

  if (parts.length === 2 && parts[1] === 'summary') {
    requireMethod(ctx, ['PATCH', 'POST', 'DELETE']);
    await handleSessionSummary(ctx, sessionId);
    return;
  }

  if (parts.length === 2 && parts[1] === 'messages') {
    requireMethod(ctx, ['POST']);
    await handleSessionMessage(ctx, sessionId);
    return;
  }

  if (parts.length === 4 && parts[1] === 'messages' && parts[3] === 'retry') {
    requireMethod(ctx, ['POST']);
    await handleSessionRetry(ctx, sessionId, decodeURIComponent(parts[2]));
    return;
  }

  throw notFound(`Unknown admin endpoint: ${ctx.method} ${ctx.pathname}`);
}

/**
 * POST /admin/api/test/sessions/:id/compact — force real summarization of the
 * older part of the conversation (v2.11). Returns the persisted summary.
 */
async function handleSessionCompact(ctx, sessionId) {
  const session = await ctx.sessions.getSession(sessionId);
  if (!session) throw notFound(`Session "${sessionId}" not found`, 'session_not_found');
  const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
  const compactConfig = getCompactConfig(ctx.config);
  const conversation = buildConversation(session.messages);
  const split = splitForCompact(conversation, compactConfig.keepRecentMessages);
  if (!split.history.length) {
    // 短会话没有可压缩历史：按 no-op 返回，前端显示“无需压缩”，不要把按钮点击变成错误。
    ctx.json(200, {
      ok: true,
      skipped: true,
      reason: 'nothing_to_compact',
      messageCount: session.messages.length,
      summary: session.summary ?? null,
      summaryChars: session.summary?.text?.length || 0,
      coveredMessageCount: 0,
      coveredPairCount: 0,
      trigger: 'manual',
      session
    });
    return;
  }
  const resolved = resolveModel(ctx.config, body.model !== undefined ? body.model : session.model || undefined);
  if (typeof ctx.selectIdentity === 'function') {
    await ctx.selectIdentity({ sessionKey: sessionId, paidModel: isPaidModel(resolved.id), rebindPaid: true });
  }
  const systemPrompt = composeSystemPrompt(ctx.config, resolved, []);
  let summary;
  try {
    const historyChars = split.history.reduce((sum, message) => sum + String(message.content || '').length, 0);
    summary = await summarizeConversation(ctx, {
      history: split.history,
      model: compactConfig.model || resolved.id,
      maxSummaryChars: compactConfig.maxSummaryChars,
      systemPrompt,
      previousSummary: session.summary || null,
      trigger: 'manual',
      savedChars: historyChars,
      tokenThreshold: session.pendingCompaction?.thresholdTokens ?? null,
      anchorId: split.history[split.history.length - 1]?.id || null
    });
  } catch (error) {
    ctx.logger?.warn?.('manual compact failed', { error: error.message, code: error.code || null });
    throw error;
  }
  const updated = await ctx.sessions.updateSession(sessionId, {
    summary,
    contextTrimmed: true,
    pendingCompaction: null,
    summaryInvalid: false
  });
  ctx.json(200, {
    ok: true,
    summary,
    summaryChars: summary.text.length,
    coveredMessageCount: summary.coveredMessageCount,
    coveredPairCount: summary.coveredPairCount,
    trigger: 'manual',
    session: updated
  });
}

/**
 * PATCH/DELETE /admin/api/test/sessions/:id/summary — edit or clear the
 * persisted compaction summary from the UI folding block (v2.12).
 */
async function handleSessionSummary(ctx, sessionId) {
  const session = await ctx.sessions.getSession(sessionId);
  if (!session) throw notFound(`Session "${sessionId}" not found`, 'session_not_found');
  if (ctx.method === 'DELETE') {
    const updated = await ctx.sessions.updateSession(sessionId, {
      summary: null,
      pendingCompaction: null,
      summaryInvalid: false
    });
    ctx.json(200, { ok: true, cleared: true, summary: null, session: updated });
    return;
  }
  const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
  const text = typeof body.text === 'string' ? body.text : typeof body.summary?.text === 'string' ? body.summary.text : '';
  if (!text.trim()) throw badRequest('"text" is required', 'text', 'invalid_summary');
  if (text.length > 20000) throw badRequest('"text" is too long (max 20000 chars)', 'text', 'invalid_summary');
  const previous = session.summary || {};
  const summary = {
    text: text.trim(),
    version: Number.isFinite(body.version) ? body.version : previous.version || 1,
    coveredMessageCount: Number.isFinite(body.coveredMessageCount)
      ? body.coveredMessageCount
      : previous.coveredMessageCount || 0,
    coveredPairCount: Number.isFinite(body.coveredPairCount) ? body.coveredPairCount : previous.coveredPairCount || 0,
    anchorId: body.anchorId ?? previous.anchorId ?? null,
    baseCompactionId: body.baseCompactionId ?? previous.baseCompactionId ?? null,
    trigger: 'manual',
    savedChars: Number.isFinite(body.savedChars) ? body.savedChars : previous.savedChars || 0,
    tokenThreshold: Number.isFinite(body.tokenThreshold) ? body.tokenThreshold : previous.tokenThreshold ?? null,
    model: body.model ?? previous.model ?? null
  };
  const updated = await ctx.sessions.updateSession(sessionId, {
    summary,
    pendingCompaction: null,
    summaryInvalid: false
  });
  ctx.json(200, { ok: true, summary: updated?.summary ?? summary, session: updated });
}

/**
 * Shared SSE generation for one assistant turn (used by messages + retry).
 * Caller must hold the session stream lock and pass conversation ending with the
 * user prompt to answer.
 *
 * SSE: session → delta / reasoning / search / image → done | error
 * Pre-first-event failures append an error assistant message, record upstream
 * stats and re-throw (server turns it into an HTTP JSON error).
 */
async function generateAssistantReply(ctx, params) {
  const {
    sessionId,
    userMessage,
    conversation,
    resolved,
    reasoning,
    webSearch,
    imageGeneration,
    retryOf = null
  } = params;
  ctx.log.model = resolved.id;
  // v2.33：连接测试的日志 sessionKey 用会话 id，便于与「会话历史/身份」对照
  if (ctx.log) ctx.log.sessionKey = sessionId;
  if (ctx) ctx.sessionKey = ctx.sessionKey || sessionId;
  let systemPrompt = composeSystemPrompt(ctx.config, resolved, []);
  if (ctx) ctx.systemPromptSnapshot = systemPrompt;
  // v2.11: compaction needs the routed identity (upstream summarize call).
  // v2.29：按模型是否需要订阅来路由；连接测试允许把已绑定的 free 身份改绑到订阅身份。
  const paidModel = isPaidModel(resolved.id);
  let identityRoute = null;
  if (typeof ctx.selectIdentity === 'function') {
    identityRoute = await ctx.selectIdentity({ sessionKey: sessionId, paidModel, rebindPaid: true });
    if (identityRoute?.identityId) {
      try {
        await ctx.sessions.updateSession(sessionId, {
          identityId: identityRoute.identityId,
          identityLabel: identityRoute.label ?? null
        });
      } catch (error) {
        ctx.logger?.warn?.('failed to persist session identity after routing', { error: error.message });
      }
    }
  }
  let activeConversation = conversation;
  let compactedInfo = null;
  const compactConfig = getCompactConfig(ctx.config);
  const compactSplit = splitForCompact(conversation, compactConfig.keepRecentMessages);
  if (compactConfig.enabled && compactSplit.compactable) {
    let previousSummary = null;
    let sessionState = null;
    try {
      sessionState = await ctx.sessions.getSession(sessionId);
      previousSummary = sessionState?.summary ?? null;
    } catch {
      previousSummary = null;
    }
    const triggerEval = evaluateCompactionTrigger({
      config: ctx.config,
      messages: conversation,
      summary: previousSummary,
      model: resolved
    });
    const shouldSummarize = params.forceCompact === true || triggerEval.should;
    if (shouldSummarize) {
      try {
        const historyChars = compactSplit.history.reduce((sum, message) => sum + String(message.content || '').length, 0);
        const summary = await summarizeConversation(ctx, {
          history: compactSplit.history,
          model: compactConfig.model || resolved.id,
          maxSummaryChars: compactConfig.maxSummaryChars,
          systemPrompt,
          previousSummary,
          trigger: params.forceCompact === true ? 'manual' : triggerEval.trigger || 'tokens',
          savedChars: historyChars,
          tokenThreshold: sessionState?.pendingCompaction?.thresholdTokens ?? null,
          anchorId: compactSplit.history[compactSplit.history.length - 1]?.id || null
        });
        await ctx.sessions.updateSession(sessionId, {
          summary,
          contextTrimmed: true,
          pendingCompaction: null,
          summaryInvalid: false
        });
        systemPrompt = buildCompactedSystemPrompt(systemPrompt, summary);
        activeConversation = compactSplit.recent;
        compactedInfo = {
          compacted: true,
          summary,
          summaryChars: summary.text.length,
          coveredMessageCount: summary.coveredMessageCount,
          coveredPairCount: summary.coveredPairCount,
          trigger: summary.trigger
        };
        ctx.log.compacted = true;
        ctx.log.summaryChars = summary.text.length;
        ctx.log.coveredMessageCount = summary.coveredMessageCount;
      } catch (error) {
        ctx.logger?.warn?.('context compaction failed; falling back to trim', {
          error: error.message,
          code: error.code || null
        });
        ctx.log.compactError = error.message;
      }
    } else if (previousSummary) {
      systemPrompt = buildCompactedSystemPrompt(systemPrompt, previousSummary);
      activeConversation = compactSplit.recent;
      compactedInfo = {
        compacted: true,
        summary: previousSummary,
        summaryChars: previousSummary.text.length,
        coveredMessageCount: previousSummary.coveredMessageCount,
        coveredPairCount: previousSummary.coveredPairCount,
        trigger: previousSummary.trigger
      };
      ctx.log.compacted = true;
      ctx.log.summaryChars = previousSummary.text.length;
      ctx.log.coveredMessageCount = previousSummary.coveredMessageCount;
    }
  }
  const guarded = guardConversation(activeConversation, systemPrompt, ctx.config?.context || {});
  if (guarded.trimmed) {
    ctx.log.contextTrimmed = true;
    void ctx.sessions.updateSession(sessionId, { contextTrimmed: true }).catch?.(() => {});
  }
  const duckMessages = buildDuckMessages({
    systemPrompt,
    conversation: guarded.messages,
    promptMode: ctx.config?.prompts?.mode
  });
  ctx.log.promptChars =
    systemPrompt.length + activeConversation.reduce((sum, message) => sum + message.content.length, 0);

  const assistantMessageId = generateId('msg_');
  const startedAt = Date.now();
  const textFilter = createCitationFilter();
  const reasoningFilter = createCitationFilter();
  const collected = { content: '', reasoning: '', sources: [], images: [], usage: null };
  let sourcesSent = 0;
  let imagesSent = 0;
  let writer = null;
  const pendingEvents = [];
  const gate = createFirstEventGate();

  const dispatch = (event) => {
    if (writer) {
      if (!writer.closed) writer.data(event);
    } else {
      pendingEvents.push(event);
    }
  };
  const dispatchFreshSources = () => {
    if (collected.sources.length <= sourcesSent) return;
    const fresh = collected.sources.slice(sourcesSent);
    sourcesSent = collected.sources.length;
    dispatch({ type: 'search', results: fresh });
  };
  const dispatchFreshImages = () => {
    if (collected.images.length <= imagesSent) return;
    const fresh = collected.images.slice(imagesSent);
    imagesSent = collected.images.length;
    for (const image of fresh) {
      dispatch({
        type: 'image',
        b64: image.b64,
        format: image.format,
        ...(Number.isFinite(image.width) ? { width: image.width } : {}),
        ...(Number.isFinite(image.height) ? { height: image.height } : {})
      });
    }
  };

  const handlers = {
    onTextDelta(text) {
      const cleaned = textFilter.process(text);
      if (!cleaned) return;
      collected.content += cleaned;
      dispatch({ type: 'delta', text: cleaned });
    },
    onReasoningDelta(text) {
      const cleaned = reasoningFilter.process(text);
      if (!cleaned) return;
      collected.reasoning += cleaned;
      dispatch({ type: 'reasoning', text: cleaned });
    },
    onSearchResults(results) {
      collected.sources = mergeSources(collected.sources, results);
      dispatchFreshSources();
    },
    onImage(image) {
      const normalized = normalizeImage(image);
      if (!normalized) return;
      collected.images.push(normalized);
      dispatchFreshImages();
    },
    onUsage(usage) {
      collected.usage = usage;
    },
    onToolCall() {},
    onToolResult() {},
    onError() {}
  };

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
          model: resolved.id,
          messages: messagesForCall,
          reasoningEffort: reasoning.effort,
          webSearch,
          imageGeneration,
          signal: ctx.signal
        },
        wrappedHandlers
      );
    chatPromise = Promise.resolve(
      ctx.callUpstream(taskFor(duckMessages), {
        model: resolved.id,
        source: 'admin-test',
        onContextLimitRetry: async () => {
          // v2.11: upstream conversation-limit → try real compaction first; only
          // fall back to aggressive trim if summarization fails.
          const compactConfig2 = getCompactConfig(ctx.config);
          const split2 = splitForCompact(conversation, compactConfig2.keepRecentMessages);
          if (compactConfig2.enabled && split2.compactable) {
            try {
              const previousSession = await ctx.sessions.getSession(sessionId);
              const summary = await summarizeConversation(ctx, {
                history: split2.history,
                model: compactConfig2.model || resolved.id,
                maxSummaryChars: compactConfig2.maxSummaryChars,
                systemPrompt,
                previousSummary: previousSession?.summary || null
              });
              await ctx.sessions.updateSession(sessionId, { summary, contextTrimmed: true });
              const retrySystemPrompt = buildCompactedSystemPrompt(systemPrompt, summary);
              compactedInfo = {
                compacted: true,
                summary,
                summaryChars: summary.text.length,
                coveredMessageCount: summary.coveredMessageCount
              };
              ctx.log.compacted = true;
              ctx.log.summaryChars = summary.text.length;
              ctx.log.coveredMessageCount = summary.coveredMessageCount;
              return taskFor(
                buildDuckMessages({
                  systemPrompt: retrySystemPrompt,
                  conversation: split2.recent,
                  promptMode: ctx.config?.prompts?.mode
                })
              );
            } catch (compactError) {
              ctx.logger?.warn?.('compact-on-limit failed; falling back to trim', {
                error: compactError.message,
                code: compactError.code || null
              });
            }
          }
          const retryGuarded = guardConversation(conversation, systemPrompt, {
            ...(ctx.config?.context || {}),
            aggressive: true
          });
          ctx.log.contextTrimmed = true;
          const retryMessages = buildDuckMessages({
            systemPrompt,
            conversation: retryGuarded.messages,
            promptMode: ctx.config?.prompts?.mode
          });
          return taskFor(retryMessages);
        }
      })
    );
  } catch (error) {
    throw error;
  }

  const appendErrorAssistant = async (partial = {}) => {
    try {
      await ctx.sessions.appendMessage(sessionId, {
        id: assistantMessageId,
        role: 'assistant',
        content: partial.content || '',
        reasoning: partial.reasoning || '',
        reasoningEncrypted: partial.reasoningEncrypted === true,
        sources: partial.sources || [],
        images: partial.images || [],
        model: resolved.id,
        ts: Date.now(),
        latencyMs: Math.max(0, Date.now() - startedAt),
        queueWaitMs: ctx.log.queueWaitMs,
        finishReason: 'error',
        error: partial.error || 'upstream error',
        ...(retryOf ? { retriedFrom: retryOf } : {})
      });
    } catch (appendError) {
      ctx.logger?.warn?.('failed to append session error assistant message', { error: appendError.message });
    }
  };

  let outcome;
  try {
    outcome = await Promise.race([
      chatPromise.then((value) => ({ kind: 'done', value })),
      gate.promise.then(() => ({ kind: 'event' }))
    ]);
  } catch (error) {
    // Failure before any upstream event: persist an error turn, then return a
    // normal JSON error (429/502/403…) instead of HTTP 200 + SSE.
    const normalized = toOpenAIError(error);
    ctx.log.error = normalized.message;
    if (normalized.errorDetail) ctx.log.errorDetail = normalized.errorDetail;
    await appendErrorAssistant({ error: normalized.message });
    ctx.recordUpstream({
      status: normalized.status,
      error: normalized.message,
      errorDetail: normalized.errorDetail,
      model: resolved.id,
      latencyMs: Date.now() - startedAt,
      stream: true
    });
    throw error;
  }

  writer = ctx.openSSE();
  ctx.log.stream = true;
  dispatch({
    type: 'session',
    sessionId,
    userMessageId: userMessage.id,
    assistantMessageId,
    ...(retryOf ? { retryOf } : {})
  });
  for (const event of pendingEvents.splice(0)) writer.data(event);

  let result;
  if (outcome.kind === 'event') {
    try {
      result = await chatPromise;
    } catch (error) {
      const normalized = toOpenAIError(error);
      ctx.log.error = normalized.message;
      if (normalized.errorDetail) ctx.log.errorDetail = normalized.errorDetail;
      const latencyMs = Date.now() - startedAt;
      await appendErrorAssistant({
        content: collected.content,
        reasoning: collected.reasoning,
        sources: collected.sources,
        images: collected.images,
        error: normalized.message
      });
      dispatch({ type: 'error', message: normalized.message, code: normalized.code ?? null, status: normalized.status });
      writer.end();
      ctx.recordUpstream({
        status: normalized.status,
        error: normalized.message,
        errorDetail: normalized.errorDetail,
        model: resolved.id,
        latencyMs,
        stream: true
      });
      return;
    }
  } else {
    result = outcome.value;
  }

  const textTail = textFilter.process('', { flush: true });
  if (textTail) {
    collected.content += textTail;
    dispatch({ type: 'delta', text: textTail });
  }
  const reasoningTail = reasoningFilter.process('', { flush: true });
  if (reasoningTail) {
    collected.reasoning += reasoningTail;
    dispatch({ type: 'reasoning', text: reasoningTail });
  }
  if (!collected.content && typeof result?.content === 'string' && result.content) {
    const cleaned = cleanCitationText(result.content);
    if (cleaned) {
      collected.content = cleaned;
      dispatch({ type: 'delta', text: cleaned });
    }
  }
  if (!collected.reasoning && typeof result?.reasoning === 'string' && result.reasoning) {
    const cleaned = cleanCitationText(result.reasoning);
    if (cleaned) {
      collected.reasoning = cleaned;
      dispatch({ type: 'reasoning', text: cleaned });
    }
  }

  collected.sources = mergeSources(collected.sources, result?.sources);
  dispatchFreshSources();
  collected.images = mergeImages(collected.images, result?.images);
  dispatchFreshImages();

  // v2.12: parse server DONE markers (refresh hint / invalid / limit) and persist.
  const markerInfo = parseCompactionMarkers(collected.content || '');
  collected.content = markerInfo.text;
  let pendingCompaction = null;
  let summaryInvalid = false;
  if (markerInfo.summaryRefreshHint) {
    pendingCompaction = { ...markerInfo.summaryRefreshHint, updatedAt: Date.now() };
    ctx.log.pendingCompaction = pendingCompaction;
    void ctx.sessions
      .updateSession(sessionId, { pendingCompaction })
      .catch?.(() => {});
  }
  if (markerInfo.summaryInvalid) {
    summaryInvalid = true;
    ctx.log.summaryInvalid = true;
    void ctx.sessions.updateSession(sessionId, { summaryInvalid: true }).catch?.(() => {});
  }
  if (markerInfo.limitConversation) {
    ctx.log.limitConversation = true;
  }

  const latencyMs = Date.now() - startedAt;
  const assistantMessage = {
    id: assistantMessageId,
    role: 'assistant',
    content: collected.content,
    reasoning: collected.reasoning,
    reasoningEncrypted: result?.reasoningEncrypted === true,
    sources: collected.sources,
    images: collected.images,
    // v2.37：连接测试与「会话历史」共用同一套工具调用展示（位置/生图/联网）
    toolCalls: normalizeToolCalls({
      toolCalls: [...(collected.toolCalls || []), ...((result && result.toolCalls) || [])],
      approvals: (result && result.approvals) || [],
      images: collected.images
    }),
    model: resolved.id,
    ts: Date.now(),
    latencyMs,
    queueWaitMs: ctx.log.queueWaitMs,
    finishReason: normalizeFinishReason(result?.finishReason),
    identityId: ctx.log.identityId ?? null,
    identityLabel: ctx.log.identityLabel ?? null,
    ...(ctx.log.contextTrimmed ? { contextTrimmed: true } : {}),
    ...(compactedInfo
      ? {
          compacted: true,
          summaryChars: compactedInfo.summaryChars,
          coveredMessageCount: compactedInfo.coveredMessageCount,
          coveredPairCount: compactedInfo.coveredPairCount,
          compactTrigger: compactedInfo.trigger
        }
      : {}),
    ...(pendingCompaction ? { pendingCompaction } : {}),
    ...(summaryInvalid ? { summaryInvalid: true } : {}),
    ...(retryOf ? { retriedFrom: retryOf } : {})
  };

  // v2.31：写入会话历史（只读页面按身份分组展示）
  try {
    if (ctx.history?.record) {
      const transcript = [
        ...(Array.isArray(conversation) ? conversation : []).map((message) => ({
          role: message.role,
          content: message.content
        })),
        {
          role: 'assistant',
          content: assistantMessage.content || '',
          reasoning: assistantMessage.reasoning || '',
          images: assistantMessage.images || [],
          sources: assistantMessage.sources || [],
          toolCalls: assistantMessage.toolCalls || []
        }
      ].filter((message) => message.role && (message.content === '' || message.content || (message.images && message.images.length)));
      ctx.history.record({
        identityId: ctx.log?.identityId || null,
        identityLabel: ctx.log?.identityLabel || null,
        sessionKey: sessionId,
        model: ctx.log?.model || resolved.id,
        systemPrompt,
        messages: transcript,
        ts: Date.now()
      });
    }
  } catch (error) {
    ctx.logger?.warn?.('failed to record conversation history', { error: error.message });
  }

  try {
    await ctx.sessions.appendMessage(sessionId, assistantMessage);
  } catch (error) {
    ctx.log.error = error.message;
    dispatch({ type: 'error', message: error.message, code: error.code || null, status: error.status || 400 });
    writer.end();
    return;
  }

  dispatch({
    type: 'done',
    message: assistantMessage,
    latencyMs,
    queueWaitMs: ctx.log.queueWaitMs,
    identityId: ctx.log.identityId ?? null,
    identityLabel: ctx.log.identityLabel ?? null,
    ...(compactedInfo
      ? {
          compacted: true,
          summaryChars: compactedInfo.summaryChars,
          coveredMessageCount: compactedInfo.coveredMessageCount,
          coveredPairCount: compactedInfo.coveredPairCount,
          compactTrigger: compactedInfo.trigger,
          summary: compactedInfo.summary
        }
      : {}),
    ...(pendingCompaction ? { pendingCompaction } : {}),
    ...(summaryInvalid ? { summaryInvalid: true } : {})
  });
  writer.end();
  ctx.recordUpstream({
    status: 200,
    model: resolved.id,
    latencyMs,
    stream: true,
    identityId: ctx.log.identityId ?? null,
    identityLabel: ctx.log.identityLabel ?? null
  });
}

/**
 * POST /admin/api/test/sessions/:id/messages — add one user turn and stream the
 * assistant answer (SSE: session → delta/reasoning/search/image → done|error).
 */
async function handleSessionMessage(ctx, sessionId) {
  ctx.log.endpoint = `POST /admin/api/test/sessions/${sessionId}/messages`;
  const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) throw badRequest('"content" is required and must be a non-empty string', 'content', 'content_required');

  const existing = await ctx.sessions.getSession(sessionId);
  if (!existing) throw notFound(`Session "${sessionId}" not found`, 'session_not_found');
  if (!ctx.sessions.beginStream(sessionId)) {
    throw sessionBusyError(sessionId);
  }
  try {
    const resolved = resolveModel(ctx.config, body.model !== undefined ? body.model : existing.model || undefined);
    const reasoning = resolveReasoningEffort(
      resolved.model,
      body.reasoningEffort !== undefined ? body.reasoningEffort : existing.reasoningEffort || 'none',
      { param: 'reasoningEffort' }
    );
    const webSearch = body.webSearch !== undefined ? body.webSearch === true : existing.webSearch === true;
    const imageGeneration =
      body.imageGeneration !== undefined ? body.imageGeneration === true : existing.imageGeneration === true;

    const conversation = buildConversation(existing.messages, { appendUserContent: content });
    // Persist the user turn first (auto-title happens on the first user message).
    const userMessage = await ctx.sessions.appendMessage(sessionId, {
      role: 'user',
      content,
      model: resolved.id,
      ts: Date.now()
    });
    await generateAssistantReply(ctx, {
      sessionId,
      userMessage,
      conversation,
      resolved,
      reasoning,
      webSearch,
      imageGeneration
    });
  } finally {
    ctx.sessions.endStream(sessionId);
  }
}

/**
 * POST /admin/api/test/sessions/:id/messages/:messageId/retry — regenerate an
 * assistant turn (SSE, same events as messages; `session.retryOf` is set).
 *
 * Validation: session 404 / message 404 / non-assistant 409 / no preceding user
 * 400 / concurrent stream in the same session 409 `session_busy`.
 * The session is truncated to the target's user prompt (target + everything after
 * is removed), optional body overrides are persisted, then the upstream is called
 * again through the shared RPS queue.
 */
async function handleSessionRetry(ctx, sessionId, messageId) {
  ctx.log.endpoint = `POST /admin/api/test/sessions/${sessionId}/messages/${messageId}/retry`;

  const existing = await ctx.sessions.getSession(sessionId);
  if (!existing) throw notFound(`Session "${sessionId}" not found`, 'session_not_found');
  const targetIndex = existing.messages.findIndex((message) => message.id === messageId);
  if (targetIndex === -1) {
    throw notFound(`Message "${messageId}" not found in session "${sessionId}"`, 'message_not_found');
  }
  if (existing.messages[targetIndex].role !== 'assistant') {
    throw conflict('Only assistant messages can be retried', 'message_not_assistant');
  }
  let userIndex = -1;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    if (existing.messages[index].role === 'user') {
      userIndex = index;
      break;
    }
  }
  if (userIndex === -1) {
    throw badRequest('No preceding user message found for this assistant message', 'messageId', 'invalid_history');
  }

  if (!ctx.sessions.beginStream(sessionId)) {
    throw sessionBusyError(sessionId);
  }
  try {
    const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
    const overrides = validateTurnOverrides(ctx, body);
    if (Object.keys(overrides).length > 0) {
      await ctx.sessions.updateSession(sessionId, overrides);
    }

    const prepared = await ctx.sessions.prepareRetry(sessionId, messageId);
    if (!prepared.ok) {
      if (prepared.reason === 'message_not_found') {
        throw notFound(`Message "${messageId}" not found in session "${sessionId}"`, 'message_not_found');
      }
      throw badRequest('Unable to prepare retry for this message', 'messageId', 'invalid_history');
    }

    const updated = prepared.session;
    const resolved = resolveModel(ctx.config, updated.model || undefined);
    const reasoning = resolveReasoningEffort(resolved.model, updated.reasoningEffort || 'none', {
      param: 'reasoningEffort'
    });
    const webSearch = updated.webSearch === true;
    const imageGeneration = updated.imageGeneration === true;
    // After truncation the history ends with the target turn's user prompt.
    const conversation = buildConversation(updated.messages);
    await generateAssistantReply(ctx, {
      sessionId,
      userMessage: prepared.userMessage,
      conversation,
      resolved,
      reasoning,
      webSearch,
      imageGeneration,
      retryOf: messageId
    });
  } finally {
    ctx.sessions.endStream(sessionId);
  }
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {Record<string, any>} ctx request context from src/http/server.js
 * @param {string} route path after `/admin/api` (e.g. `/overview`, `/keys/key_1`)
 * @param {string} method HTTP method
 */
export async function handleAdminRequest(ctx, route, method) {
  const parts = String(route || '/')
    .split('/')
    .filter(Boolean);
  const head = parts[0] || '';

  // v2.2 identity / sync & backup / subscription (docs/IDENTITY-SYNC.md §3).
  if (head === 'identity' || head === 'sync' || head === 'subscription') {
    return handleIdentityRoutes(ctx, parts, method);
  }
  // v2.3 proxy (docs/PROXY.md §3).
  if (head === 'proxy') {
    return handleProxyRoutes(ctx, parts, method);
  }
  // v2.4 identity pool (docs/IDENTITY-POOL.md §5).
  if (head === 'identities') {
    return handleIdentityPoolRoutes(ctx, parts, method);
  }
  // v2.15 first-class subscriptions (docs/ADMIN_API_V2.md §21).
  if (head === 'subscriptions') {
    return handleSubscriptionRoutes(ctx, parts, method);
  }

  switch (head) {
    case 'overview':
      if (parts.length !== 1) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleOverview(ctx);
    case 'config':
      if (parts.length === 1) {
        if (method === 'GET' || method === 'HEAD') return handleGetConfig(ctx);
        if (method === 'PUT' || method === 'POST') return handlePutConfig(ctx);
        throw methodNotAllowed(ctx, 'GET, PUT');
      }
      if (parts.length === 2 && parts[1] === 'reset') return handleResetConfig(ctx);
      throw notFound(`Unknown admin endpoint: ${method} ${route}`);
    case 'logs':
      if (parts.length === 2 && parts[1] === 'download') return handleLogsDownload(ctx);
      if (parts.length === 2 && parts[1] === 'retention') return handleLogsRetention(ctx);
      if (parts.length !== 1) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleLogs(ctx);
    case 'usage':
      if (parts.length !== 1) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleUsage(ctx);
    case 'keys':
      if (parts.length > 2) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleKeys(ctx, parts[1] || null);
    // v2.28：duck.ai 默认提示词生成器（源码逻辑）
    case 'prompts': {
      if (parts.length >= 2 && parts[1] === 'duckai') {
        if (parts.length === 2) {
          requireMethod(ctx, ['GET', 'HEAD']);
          const { promptOptionCatalog } = await import('../duck/prompt.js');
          ctx.json(200, promptOptionCatalog());
          return;
        }
        if (parts.length === 3 && parts[2] === 'preview') {
          requireMethod(ctx, ['POST']);
          const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
          const { buildDuckAiPrompt, normalizeDuckAiCustomization } = await import('../duck/prompt.js');
          const customization = normalizeDuckAiCustomization(body?.customization ?? body);
          const prompt = buildDuckAiPrompt(customization);
          ctx.json(200, { ok: true, customization, prompt, length: prompt.length });
          return;
        }
      }
      throw notFound(`Unknown admin endpoint: ${method} ${route}`);
    }
    case 'models':
      if (parts.length === 2 && parts[1] === 'config') return handleModelsConfig(ctx);
      if (parts.length === 3 && parts[1] === 'config' && parts[2] === 'reset') {
        return handleModelsConfigReset(ctx);
      }
      if (parts.length === 2 && parts[1] === 'refresh') return handleModelsRefresh(ctx);
      if (parts.length !== 1) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleModels(ctx);
    case 'history':
      return handleHistory(ctx, parts, method, route);    case 'health':
      if (parts.length !== 1) throw notFound(`Unknown admin endpoint: ${method} ${route}`);
      return handleHealth(ctx);
    case 'test':
      if (parts[1] === 'sessions') return handleSessions(ctx, parts.slice(2));
      // v2 BREAKING: the old POST /admin/api/test single-shot endpoint is gone.
      throw notFound(`Unknown admin endpoint: ${method} ${route}`);
    default:
      throw notFound(`Unknown admin endpoint: ${method} ${route}`);
  }
}

// Re-exported for tests / tooling.
export { friendlyErrorMessage };
