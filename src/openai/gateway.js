/**
 * 统一 OpenAI Gateway 执行调度器（参考 bohrium-club-auto/internal/openai/gateway.go）。
 *
 * 将 /v1/chat/completions 与 /v1/responses（以及流式工具模式）共用的上游调用、
 * context-limit 自适应裁剪重试、以及 CDN Keepalive（流式提前开 SSE / 非流式 JSON 前导空白）
 * 收敛为单一执行通道。
 */
import { guardConversation } from './context-guard.js';

/**
 * 执行一轮上游对话请求（经由 ctx.callUpstream），统一接入：
 *  - onContextLimitRetry 激进裁剪并保留 promptMode
 *  - onUpstreamAccepted 钩子（非流式自动开启 JSON keepalive；流式工具模式立即提交 SSE 并开启心跳）
 *
 * @param {Record<string, any>} ctx
 * @param {{
 *   model: string,
 *   duckMessages: Array<Record<string, any>>,
 *   conversation?: Array<Record<string, any>>,
 *   systemPrompt?: string,
 *   reasoningEffort?: string,
 *   webSearch?: boolean,
 *   imageGeneration?: boolean,
 *   approxLocation?: boolean,
 *   handlers?: Record<string, any>,
 *   enableNonStreamKeepalive?: boolean,
 *   onUpstreamAccepted?: (info: Record<string, any>) => void,
 *   buildRetryDuckMessages?: (guardedMessages: Array<Record<string, any>>) => Array<Record<string, any>>,
 *   source?: string
 * }} params
 */
export async function executeUpstreamChatTurn(ctx, params) {
  const {
    model,
    conversation = [],
    systemPrompt = '',
    reasoningEffort = 'none',
    webSearch = false,
    imageGeneration = false,
    approxLocation = ctx.config?.tools?.location === true,
    handlers = {},
    enableNonStreamKeepalive = false,
    onUpstreamAccepted = null,
    buildRetryDuckMessages = null,
    source = null
  } = params;

  let currentDuckMessages = params.duckMessages;

  const wrappedHandlers = {
    ...handlers,
    onUpstreamAccepted(info) {
      if (enableNonStreamKeepalive) {
        if (typeof ctx.markJsonKeepaliveAccepted === 'function') {
          ctx.markJsonKeepaliveAccepted();
        } else if (typeof ctx.beginJsonKeepalive === 'function') {
          ctx.beginJsonKeepalive({}, { accepted: true });
        }
      }
      if (typeof onUpstreamAccepted === 'function') {
        onUpstreamAccepted(info);
      }
      if (typeof handlers.onUpstreamAccepted === 'function') {
        handlers.onUpstreamAccepted(info);
      }
    }
  };

  if (enableNonStreamKeepalive && typeof ctx.beginJsonKeepalive === 'function') {
    ctx.beginJsonKeepalive();
  }

  const taskFor = (messagesForCall) => (runtime) =>
    (runtime?.client || ctx.duck).chat(
      {
        model,
        messages: messagesForCall,
        reasoningEffort,
        webSearch,
        imageGeneration,
        approxLocation,
        signal: ctx.signal
      },
      wrappedHandlers
    );

  const result = await ctx.callUpstream(taskFor(currentDuckMessages), {
    model,
    ...(source ? { source } : {}),
    onContextLimitRetry:
      typeof buildRetryDuckMessages === 'function'
        ? () => {
            const guarded = guardConversation(conversation, systemPrompt, {
              ...(ctx.config?.context || {}),
              aggressive: true
            });
            currentDuckMessages = buildRetryDuckMessages(guarded.messages);
            ctx.log.contextTrimmed = true;
            return taskFor(currentDuckMessages);
          }
        : undefined
  });

  return { result, duckMessages: currentDuckMessages };
}

export default { executeUpstreamChatTurn };
