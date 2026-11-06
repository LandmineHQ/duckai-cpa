/** Phase 3B：chat/responses 共用的 manual compaction 准备逻辑（行为不变）。 */
import {
  buildCompressionRecord,
  buildManualCompactionPdf,
  loadReusableCompactionPdf
} from '../../openai/conversation-compact.js';
import { pdfScopeKey } from '../../openai/context-spill.js';
import { OpenAIError } from '../../openai/errors.js';

/**
 * marker 检测后的 PDF 复用/生成 + compression record。
 * hot 的应用（chat normalize/systemParts/promptChars、responses chainedConversation）留在各 handler。
 *
 * @param {{
 *   kind: 'chat'|'responses',
 *   conversationSessionKey: string|null,
 *   conversationState: object|null,
 *   marker: object,
 *   responseStore: object|null
 * }} input
 * @returns {Promise<{
 *   manualCompaction: { marker: object, scopeKey: string, contextPdfState: object, compression: object },
 *   logPatch: { manualCompaction: true, compression: object }
 * }>}
 */
export async function prepareManualCompaction({
  kind,
  conversationSessionKey,
  conversationState,
  marker,
  responseStore
}) {
  const manualScope = pdfScopeKey({
    kind,
    sessionKey: conversationSessionKey,
    conversation: marker.before
  });
  let pdfResult = null;
  if (
    conversationState?.compression?.summaryHash === marker.summaryHash &&
    conversationState.contextPdfScope
  ) {
    pdfResult = await loadReusableCompactionPdf({
      responsesStore: responseStore,
      compression: conversationState.compression,
      scopeKey: conversationState.contextPdfScope
    });
  }
  const effectiveScope = pdfResult?.scopeKey || manualScope;
  if (!pdfResult) {
    try {
      pdfResult = await buildManualCompactionPdf({
        marker,
        responsesStore: responseStore,
        scopeKey: effectiveScope
      });
    } catch (error) {
      if (error && error.code === 'context_pdf_capacity_exceeded') {
        throw new OpenAIError('会话历史超过 PDF 容量（15 页），无法生成压缩上下文 PDF', {
          status: 413,
          type: 'invalid_request_error',
          code: 'context_pdf_capacity_exceeded',
          param: kind === 'chat' ? 'messages' : 'input'
        });
      }
      throw error;
    }
  }
  const compression = buildCompressionRecord({
    marker,
    pdfFile: pdfResult.file || pdfResult.state,
    trigger: 'manual',
    reused: pdfResult.generated === false,
    scopeKey: effectiveScope
  });
  return {
    manualCompaction: {
      marker,
      scopeKey: effectiveScope,
      contextPdfState: pdfResult.state,
      compression
    },
    logPatch: {
      manualCompaction: true,
      compression: {
        trigger: 'manual',
        summaryHash: compression.summaryHash,
        coveredMessageCount: compression.coveredMessageCount,
        contextPdf: compression.contextPdf,
        reused: compression.reused
      }
    }
  };
}

/**
 * 手动压缩后的 epoch/sessionMode（chat/responses 原先逐字相同的两段）。
 * @param {{ conversationState?: object|null, manualCompaction: object }} input
 * @returns {{ sessionEpoch: number, sessionMode: 'compact-reuse'|'compact-epoch' }}
 */
export function resolveManualCompactionEpoch({ conversationState = null, manualCompaction }) {
  const sameCompression =
    conversationState?.compression?.summaryHash &&
    conversationState.compression.summaryHash === manualCompaction.compression.summaryHash &&
    manualCompaction.compression.reused === true;
  return {
    sessionEpoch: sameCompression ? conversationState?.epoch || 0 : (conversationState?.epoch || 0) + 1,
    sessionMode: sameCompression ? 'compact-reuse' : 'compact-epoch'
  };
}

export default { prepareManualCompaction, resolveManualCompactionEpoch };
