/** Phase 3C：authoritative session 的 state 加载/图片回放/diff 包装（行为不变）。 */
import { badRequest } from '../../openai/errors.js';
import { diffSession, resolveEpochFlags } from '../../openai/authoritative-session.js';
import { replaySessionImages } from '../../openai/image-context.js';

/**
 * 加载 conversation_state（异常降级为 null）。调用方仍自行判断 enabled/sessionKey。
 * @param {{ responseStore: object|null, conversationSessionKey: string|null }} input
 * @returns {Promise<object|null>}
 */
export async function loadAuthoritativeState({ responseStore, conversationSessionKey }) {
  if (!responseStore?.enabled || !conversationSessionKey) return null;
  return responseStore.getConversation(conversationSessionKey).catch(() => null);
}

/** 有持久化图片时回放占位文本；否则返回原数组引用（保持既有语义）。 */
export function replaySessionImagesFromState(messages, conversationState) {
  if (!conversationState?.images?.length) return messages;
  return replaySessionImages(messages, conversationState.images);
}

/**
 * 构造并执行 diffSession；manualCompaction / ephemeral / 无 state 时返回 null。
 * noop 的报错文案/字段按 kind 参数化（chat=messages，responses=input）。
 *
 * @param {{
 *   ctx: object,
 *   body: object,
 *   state: object|null,
 *   incoming: any[],
 *   kind: 'chat'|'responses',
 *   manualCompaction: object|null,
 *   ephemeralRequest?: boolean
 * }} input
 * @returns {{ diff: object, epochFlags: object }|null}
 */
export function prepareAuthoritativeSessionDiff({
  ctx,
  body,
  state,
  incoming,
  kind,
  manualCompaction,
  ephemeralRequest = false
}) {
  if (manualCompaction || !state || ephemeralRequest) return null;
  const epochFlags = resolveEpochFlags(ctx, body);
  const diff = diffSession({
    state,
    incoming,
    requestedEpoch: epochFlags.requestedEpoch,
    fork: epochFlags.fork
  });
  if (diff.mode === 'noop') {
    throw badRequest(
      kind === 'chat' ? 'no new messages for this session' : 'no new input for this session',
      kind === 'chat' ? 'messages' : 'input',
      'no_new_messages'
    );
  }
  return { diff, epochFlags };
}

/**
 * 写回 handler 的 session 日志字段，返回 stateRepaired（供 chat 的 subsequent 逻辑使用）。
 * @param {object} log ctx.log
 * @param {object} diff
 * @returns {boolean}
 */
export function applySessionLogFields(log, diff) {
  log.sessionMode = diff.mode;
  log.sessionEpoch = diff.epoch;
  log.sessionAppended = diff.appended;
  if (diff.stateRepaired) log.sessionRepaired = true;
  return diff.stateRepaired === true;
}

export default {
  loadAuthoritativeState,
  replaySessionImagesFromState,
  prepareAuthoritativeSessionDiff,
  applySessionLogFields
};
