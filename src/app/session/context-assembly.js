/**
 * Phase 3A：chat/responses 共用的「context PDF 装配 + client-tools.pdf + 历史展示 + injection」。
 *
 * 只消费调用方已算好的会话状态；不做 session resolve / diff / epoch / 压缩决策，
 * 不改 PDF 生成器、scope/hash/gating。逐行搬移 chat/responses 的重复块，保持 I1–I10。
 */
import {
  attachPdfFile,
  createToolsPdf,
  pdfFileFromState,
  sanitizeFileMetadata,
  spillMessagesToPdf,
  stripSpillInstruction,
  PDF_PURPOSE_TEXT,
  hashConversationPrefix
} from '../../openai/context-spill.js';
import { buildToolProtocol } from '../../openai/tool-protocol.js';
import { OpenAIError } from '../../openai/errors.js';

const CAPACITY_MESSAGE = '上下文超过 PDF 容量（15 页），请调用 /v1/compact 手动压缩后重试';
const TOOLS_PDF_INSTRUCTION =
  '\n\n[系统提示] 附件 client-tools.pdf 是本次会话的客户端工具说明，请先阅读再按需调用工具。';

/**
 * @param {{
 *   kind: 'chat'|'responses',
 *   duckMessages: Array<object>,
 *   conversation: Array<object>,
 *   historyMessages: Array<object>,
 *   clientTools: Array<{name:string}>,
 *   pdfSpillConfig: { enabled?: boolean, inputCharLimit?: number, maxPages?: number },
 *   inputCharLimit: number,
 *   scopeKey: string|null,
 *   responseStore: object|null,
 *   storedPdf: object|null,
 *   reuseStoredPdf: boolean,
 *   conversationChain: string|null,
 *   compression: object|null,
 *   logger: object
 * }} input
 * @returns {Promise<{
 *   duckMessages: Array<object>,
 *   displayMessages: Array<object>,
 *   injection: object,
 *   logPatch: object,
 *   savedContextPdf: boolean
 * }>}
 */
export async function assembleContextMessages(input) {
  const {
    kind,
    duckMessages: initialDuckMessages,
    conversation,
    historyMessages,
    clientTools,
    pdfSpillConfig,
    inputCharLimit,
    scopeKey,
    responseStore,
    storedPdf,
    reuseStoredPdf,
    conversationChain,
    compression,
    logger
  } = input;

  let duckMessages = initialDuckMessages;
  let spillDisplay = null;
  const logPatch = {};

  if (reuseStoredPdf && storedPdf) {
    const storedFile = pdfFileFromState(storedPdf);
    if (storedFile) duckMessages = attachPdfFile(duckMessages, storedFile);
    if (clientTools.length) {
      try {
        const toolsPdf = await createToolsPdf({
          toolProtocol: buildToolProtocol(clientTools),
          toolNames: clientTools.map((tool) => tool.name),
          maxPages: 1
        });
        duckMessages = attachPdfFile(duckMessages, {
          mimeType: 'application/pdf',
          filename: 'client-tools.pdf',
          b64: toolsPdf.buffer.toString('base64'),
          pages: toolsPdf.pages,
          bytes: toolsPdf.buffer.length,
          textChars: toolsPdf.textChars,
          text: toolsPdf.text
        });
      } catch (error) {
        logger?.warn?.('client tools PDF generation failed', { error: error.message });
      }
    }
    spillDisplay = duckMessages;
    logPatch.contextPdfReused = true;
    logPatch.contextPdf = { pages: storedPdf.pages, bytes: storedPdf.bytes, reused: true };
  } else if (pdfSpillConfig.enabled !== false) {
    try {
      const spill = await spillMessagesToPdf(duckMessages, {
        inputCharLimit,
        maxPages: Number(pdfSpillConfig.maxPages) || 15,
        toolProtocol: clientTools.length ? buildToolProtocol(clientTools) : '',
        toolNames: clientTools.map((tool) => tool.name)
      });
      if (spill) {
        duckMessages = spill.messages;
        spillDisplay = spill.messages;
        logPatch.contextPdf = spill.pdf;
        logPatch.contextPdfMoved = spill.movedMessages;
        if (responseStore?.enabled && scopeKey && spill.file) {
          let coveredCount = conversation.length;
          for (let i = conversation.length - 1; i >= 0; i--) {
            if (conversation[i].role === 'user') {
              coveredCount = i;
              break;
            }
          }
          await responseStore.saveContextPdf({
            scopeKey,
            filename: spill.file.filename,
            mimeType: spill.file.mimeType,
            pages: spill.pdf.pages,
            bytes: spill.pdf.bytes,
            textChars: spill.pdf.textChars,
            textContent: spill.file.text || '',
            coveredCount,
            coveredHash: hashConversationPrefix(conversation.slice(0, coveredCount)),
            pdfB64: spill.file.b64
          });
          logPatch.contextPdfSaved = true;
        }
      }
    } catch (error) {
      if (error && error.code === 'context_pdf_capacity_exceeded') {
        throw new OpenAIError(CAPACITY_MESSAGE, {
          status: 413,
          type: 'invalid_request_error',
          code: 'context_pdf_capacity_exceeded',
          param: kind === 'chat' ? 'messages' : 'input'
        });
      }
      logger?.warn?.('context PDF spill failed; continuing without spill', { error: error.message });
    }
  }

  if (input.useClientToolsPdf && !logPatch.contextPdf && !logPatch.contextPdfReused) {
    const already = duckMessages.some(
      (message) => Array.isArray(message.files) && message.files.some((file) => file.filename === 'client-tools.pdf')
    );
    if (!already) {
      try {
        const toolsPdf = await createToolsPdf({
          toolProtocol: buildToolProtocol(clientTools),
          toolNames: clientTools.map((tool) => tool.name),
          maxPages: 1,
          includeContext: false
        });
        duckMessages = attachPdfFile(duckMessages, {
          mimeType: 'application/pdf',
          filename: 'client-tools.pdf',
          b64: toolsPdf.buffer.toString('base64'),
          pages: toolsPdf.pages,
          bytes: toolsPdf.buffer.length,
          textChars: toolsPdf.textChars,
          text: toolsPdf.text
        });
        const firstUser = duckMessages.find((message) => message.role === 'user');
        if (firstUser) {
          duckMessages = duckMessages.map((message) =>
            message === firstUser ? { ...message, content: String(message.content || '') + TOOLS_PDF_INSTRUCTION } : message
          );
        }
        spillDisplay = duckMessages;
        logPatch.toolsPdf = { pages: toolsPdf.pages, bytes: toolsPdf.buffer.length };
      } catch (error) {
        logger?.warn?.('client tools PDF generation failed', { error: error.message });
      }
    }
  }

  const protocolText = clientTools.length ? buildToolProtocol(clientTools) : '';
  const displayMessages = spillDisplay
    ? spillDisplay.map((message) => ({
        ...message,
        content: stripSpillInstruction(String(message.content || '').replace(protocolText, '')),
        files: sanitizeFileMetadata(message.files)
      }))
    : historyMessages;
  const firstInjectedUser = duckMessages.find((message) => message && message.role === 'user');
  const hasContextPdf = Boolean(logPatch.contextPdf);
  const hasToolsPdf = Boolean(logPatch.toolsPdf);
  const hasPdfMode = hasContextPdf || hasToolsPdf;
  const historyProtocolText = hasPdfMode ? PDF_PURPOSE_TEXT : protocolText;
  const injection = {
    injected: Boolean(historyProtocolText),
    clientTools: clientTools.map((tool) => tool.name),
    protocolText: historyProtocolText,
    protocolKind: hasPdfMode ? 'client-tools-pdf' : 'text',
    firstUserContent: firstInjectedUser && typeof firstInjectedUser.content === 'string' ? firstInjectedUser.content : '',
    upstreamMessageCount: duckMessages.length,
    chain: conversationChain || null,
    contextPdf: logPatch.contextPdf || null,
    toolsPdf: logPatch.toolsPdf || null,
    contextPdfReused: logPatch.contextPdfReused === true,
    ...(compression ? { compression } : {})
  };
  logPatch.protocolInjected = Boolean(protocolText && !hasPdfMode);
  logPatch.clientToolsPdf = hasPdfMode && clientTools.length > 0;
  logPatch.upstreamMessageCount = duckMessages.length;

  return {
    duckMessages,
    displayMessages,
    injection,
    logPatch,
    savedContextPdf: logPatch.contextPdfSaved === true
  };
}

export default { assembleContextMessages };
