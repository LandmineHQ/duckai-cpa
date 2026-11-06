/** Phase 3D：conversation_state 保存的 epoch/共享 payload（行为不变）。 */
import { clientViewOf, firstUserHash } from '../../openai/authoritative-session.js';

/**
 * 计算保存时的 epoch（chat/responses 原先逐字相同的 IIFE）。
 * - 优先使用本次请求已决定的 sessionEpoch；
 * - toolsHash/systemPrompt 变化时 base+1；
 * - contextPdfSaved 时 base+1；
 * - 两者都只从 base 加一次（与原逻辑一致）。
 *
 * @param {{
 *   state?: object|null,
 *   sessionEpoch?: number|null,
 *   toolsHash?: string|null,
 *   systemPrompt?: string|null,
 *   contextPdfSaved?: boolean
 * }} input
 * @returns {number}
 */
export function nextEpoch({ state = null, sessionEpoch = null, toolsHash = null, systemPrompt = null, contextPdfSaved = false }) {
  const base = state?.epoch || 0;
  let value = sessionEpoch != null ? sessionEpoch : base;
  const toolsSystemChanged =
    state &&
    ((toolsHash || null) !== (state.toolsHash || null) ||
      (systemPrompt || '') !== (state.systemPrompt || ''));
  if (toolsSystemChanged && value === base) value = base + 1;
  if (contextPdfSaved && value === base) value = base + 1;
  return value;
}

/**
 * conversation_state 保存 payload（canonical/upstream 由调用方构造，差异保留）。
 * client/firstUserHash 从 canonical 计算，字段形状与原先两处 saveConversation 调用一致。
 *
 * @param {{
 *   sessionKey: string,
 *   model: string|null,
 *   mode: string,
 *   systemPrompt: string|null,
 *   canonical: any[],
 *   upstream: any[],
 *   toolsHash: string|null,
 *   compression: object|null,
 *   contextPdfScope: string|null,
 *   compactedAt: number|null,
 *   images: any[],
 *   epoch: number
 * }} input
 * @returns {object}
 */
export function buildConversationStateWrite({
  sessionKey,
  model,
  mode,
  systemPrompt,
  canonical,
  upstream,
  toolsHash,
  compression,
  contextPdfScope,
  compactedAt,
  images,
  epoch
}) {
  return {
    sessionKey,
    model,
    mode,
    systemPrompt,
    canonical,
    upstream,
    toolsHash,
    compression,
    contextPdfScope,
    compactedAt,
    images,
    client: clientViewOf(canonical),
    firstUserHash: firstUserHash(canonical),
    epoch
  };
}

/**
 * 薄封装；save 时机/异常 catch 仍由 handler 控制。
 * @param {{ store: object, payload: object }} input
 */
export async function saveConversationState({ store, payload }) {
  return store.saveConversation(payload);
}

export default { nextEpoch, buildConversationStateWrite, saveConversationState };
