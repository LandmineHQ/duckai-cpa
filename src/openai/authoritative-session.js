/**
 * v2.59：网关 authoritative session 层。
 *
 * 客户端只提供 session id + 新输入；旧完整输入仅用于 diff。网关保存 canonical，
 * 后续轮次 append-only；冲突返回 409 `session_history_mismatch`，显式 epoch/fork 才允许重建。
 */

import crypto from 'node:crypto';

const CLIENT_VIEW_MAX_CONTENT = 200000;
function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
          return String(part.text || '');
        }
        if (part.type === 'image_url' || part.type === 'input_image') return '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** 统一 OpenAI 级消息视图（用于 diff/client_json；不含图片二进制）。 */
export function normalizeClientMessages(messages = []) {
  const result = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '').toLowerCase();
    if (!['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(role)) continue;
    let content = normalizeContent(message.content);
    if (role === 'assistant' && Array.isArray(message.images) && message.images.length && !content.trim()) {
      content = '';
    }
    if (/^已生成\s*\d+\s*张图片/.test(content)) content = '';
    const entry = {
      role,
      content: content.length > CLIENT_VIEW_MAX_CONTENT ? content.slice(0, CLIENT_VIEW_MAX_CONTENT) : content
    };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      entry.tool_calls = message.tool_calls.map((call) => ({
        id: call?.id || call?.callId || null,
        type: call?.type || 'function',
        function: {
          name: call?.function?.name || call?.name || 'tool',
          arguments: call?.function?.arguments ?? call?.args ?? '{}'
        }
      }));
    }
    if (role === 'tool' || role === 'function') {
      if (typeof message.name === 'string' && message.name) entry.name = message.name;
      if (typeof message.tool_call_id === 'string' && message.tool_call_id) entry.tool_call_id = message.tool_call_id;
    }
    result.push(entry);
  }
  return result;
}

function samePrefix(a, b) {
  if (a.length > b.length) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b.slice(0, a.length));
  } catch {
    return false;
  }
}

export class SessionHistoryMismatchError extends Error {
  constructor(message = 'session history does not match the authoritative canonical state') {
    super(message);
    this.name = 'SessionHistoryMismatchError';
    this.status = 409;
    this.code = 'session_history_mismatch';
    this.type = 'invalid_request_error';
  }
}

/**
 * 对 incoming 与 state 做 diff。
 * @param {{
 *   state?: any|null,
 *   incoming: any[],
 *   requestedEpoch?: number|null,
 *   fork?: boolean
 * }} options
 * @returns {{canonical:any[], newMessages:any[], clientView:any[], epoch:number, mode:string, appended:number}}
 */
export function diffSession({ state = null, incoming = [], requestedEpoch = null, fork = false } = {}) {
  const rawIncoming = Array.isArray(incoming) ? incoming : [];
  const incomingView = normalizeClientMessages(rawIncoming);
  if (!state) {
    return { canonical: rawIncoming, newMessages: rawIncoming, clientView: incomingView, epoch: 0, mode: 'new', appended: incomingView.length };
  }
  const stateEpoch = Number.isFinite(state.epoch) ? state.epoch : 0;
  const explicitEpoch = Number.isFinite(Number(requestedEpoch)) ? Math.trunc(Number(requestedEpoch)) : null;
  if (fork === true || (explicitEpoch != null && explicitEpoch !== stateEpoch)) {
    return {
      canonical: rawIncoming,
      newMessages: rawIncoming,
      clientView: incomingView,
      epoch: explicitEpoch != null && explicitEpoch > stateEpoch ? explicitEpoch : stateEpoch + 1,
      mode: 'fork',
      appended: incomingView.length
    };
  }
  const canonical = Array.isArray(state.canonical) ? state.canonical : [];
  const savedClientRaw = Array.isArray(state.client) ? state.client : [];
  const savedClient = savedClientRaw.length ? normalizeClientMessages(savedClientRaw) : normalizeClientMessages(canonical);
  let newRaw = rawIncoming;
  let newView = incomingView;
  let mode = 'append';
  if (savedClient.length && incomingView.length >= savedClient.length) {
    if (!samePrefix(savedClient, incomingView)) {
      const toolContinuation =
        incomingView.some((message) => message.role === 'tool' || message.role === 'function') ||
        (incomingView.length === savedClient.length + 1 && incomingView[incomingView.length - 1]?.role === 'tool');
      if (toolContinuation && incomingView.length > savedClient.length) {
        // 工具续轮：客户端可能回放 assistant tool_calls 的形态与规范化后的 client 视图不完全一致；
        // 保留 canonical 前缀，仅 append 新的 tool 消息。
        newView = incomingView.slice(savedClient.length);
        newRaw = rawIncoming.slice(savedClient.length);
        mode = 'append-tool';
      } else {
        throw new SessionHistoryMismatchError(
          'session_history_mismatch: incoming history conflicts with the server canonical conversation; retry with the canonical history, session delta, or explicit fork/epoch'
        );
      }
    } else {
      newView = incomingView.slice(savedClient.length);
      newRaw = rawIncoming.slice(savedClient.length);
      mode = newView.length ? 'append-suffix' : 'noop';
    }
  } else if (savedClient.length && incomingView.length < savedClient.length) {
    // 只有「纯新输入」才允许 delta：user/tool/function，且不能夹带 assistant 回放。
    const deltaOnly =
      incomingView.length > 0 &&
      incomingView[0].role !== 'assistant' &&
      incomingView.every((message) => message.role === 'user' || message.role === 'tool' || message.role === 'function');
    if (!deltaOnly) {
      throw new SessionHistoryMismatchError(
        'session_history_mismatch: short history that is not a pure delta conflicts with the server canonical conversation; send only the newest user/tool input'
      );
    }
    mode = 'delta';
  }
  // 旧 state 没有 client_json 时：canonical 初始化，不因历史缺失炸；取 canonical 作为客户端视图。
  return {
    canonical: [...canonical, ...newRaw],
    newMessages: newRaw,
    clientView: incomingView,
    epoch: stateEpoch,
    mode,
    appended: newView.length
  };
}

/** 计算下一轮 client_json（包含 assistant/tool 输出，图片以占位文本表示）。 */
export function clientViewOf(messages = []) {
  return normalizeClientMessages(messages);
}

/** 首条 user 内容 hash（epoch 记录/缓存诊断用）。 */
export function firstUserHash(messages = []) {
  const view = normalizeClientMessages(messages);
  const first = view.find((message) => message.role === 'user');
  if (!first) return null;
  return crypto.createHash('sha1').update(String(first.content || '')).digest('hex');
}

/** 解析请求 epoch/fork（body 或 header）。 */
export function resolveEpochFlags(ctx, body, { headerName = 'x-session-epoch' } = {}) {
  const header = ctx?.req?.headers?.[headerName];
  const fromHeader = header != null && header !== '' ? Number(header) : null;
  const fromBody = body && (body.session_epoch ?? body.sessionEpoch ?? body.epoch);
  const requestedEpoch =
    fromHeader != null && Number.isFinite(Number(fromHeader))
      ? Math.trunc(Number(fromHeader))
      : fromBody != null && Number.isFinite(Number(fromBody))
        ? Math.trunc(Number(fromBody))
        : null;
  const fork =
    body?.fork === true ||
    body?.session_fork === true ||
    String(ctx?.req?.headers?.['x-session-fork'] || '').toLowerCase() === 'true';
  return { requestedEpoch, fork };
}

export default {
  normalizeClientMessages,
  diffSession,
  clientViewOf,
  firstUserHash,
  resolveEpochFlags,
  SessionHistoryMismatchError
};
