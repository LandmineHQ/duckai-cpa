/**
 * Phase 3A / v3：chat/responses 共用的「context PDF 装配 + client-tools.pdf + 历史展示 + injection」。
 *
 * 改进点（v3）：
 *  - 使用带 SHA1 缓存的 getOrCreateToolsPdf（默认 toolsMaxPages = 4，不再因 1 页限制轻易溢出）；
 *  - 若工具 PDF 生成失败或超页，安全回退为将工具协议文本内联注入首条 user 消息，绝不静默丢工具；
 *  - 保证先挂载 client-tools.pdf 再挂载 conversation-context.pdf，跨轮顺序固定以利前缀复用。
 */
import {
  attachPdfFile,
  getOrCreateToolsPdf,
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

function appendTextToFirstUser(messages, suffix) {
  if (!suffix) return messages;
  const idx = messages.findIndex((m) => m && m.role === 'user');
  if (idx < 0) return messages;
  return messages.map((m, i) => {
    if (i !== idx) return m;
    if (typeof m.content === 'string') return { ...m, content: `${m.content}${suffix}` };
    if (Array.isArray(m.content)) return { ...m, content: [...m.content, { type: 'text', text: suffix }] };
    return { ...m, content: String(m.content || '') + suffix };
  });
}

function makeToolsFileEntry(toolsPdf) {
  return {
    mimeType: 'application/pdf',
    filename: 'client-tools.pdf',
    b64: toolsPdf.b64 || toolsPdf.buffer.toString('base64'),
    pages: toolsPdf.pages,
    bytes: toolsPdf.bytes || toolsPdf.buffer.length,
    textChars: toolsPdf.textChars,
    text: toolsPdf.text
  };
}

/**
 * @param {{
 *   kind: 'chat'|'responses',
 *   duckMessages: Array<object>,
 *   conversation: Array<object>,
 *   historyMessages: Array<object>,
 *   clientTools: Array<{name:string}>,
 *   pdfSpillConfig: { enabled?: boolean, inputCharLimit?: number, maxPages?: number, toolsMaxPages?: number },
 *   inputCharLimit: number,
 *   scopeKey: string|null,
 *   responseStore: object|null,
 *   storedPdf: object|null,
 *   reuseStoredPdf: boolean,
 *   useClientToolsPdf?: boolean,
 *   conversationChain: string|null,
 *   compression: object|null,
 *   logger: object
 * }} input
 */
export async function assembleContextMessages(input) {
  const {
    kind,
    duckMessages: initialDuckMessages,
    conversation,
    historyMessages,
    clientTools,
    pdfSpillConfig = {},
    inputCharLimit,
    scopeKey,
    responseStore,
    storedPdf,
    reuseStoredPdf,
    conversationChain,
    compression,
    logger
  } = input;

  const toolsMaxPages = Number(pdfSpillConfig.toolsMaxPages) || 4;
  const protocolText = clientTools.length ? buildToolProtocol(clientTools) : '';
  const toolNames = clientTools.map((tool) => tool.name);

  let duckMessages = initialDuckMessages;
  let spillDisplay = null;
  let fellBackToInlineTools = false;
  const logPatch = {};

  if (reuseStoredPdf && storedPdf) {
    if (clientTools.length) {
      try {
        const toolsPdf = await getOrCreateToolsPdf({
          toolProtocol: protocolText,
          toolNames,
          maxPages: toolsMaxPages,
          includeContext: true
        });
        duckMessages = attachPdfFile(duckMessages, makeToolsFileEntry(toolsPdf));
        logPatch.toolsPdf = { pages: toolsPdf.pages, bytes: toolsPdf.bytes, cached: toolsPdf.cached };
      } catch (error) {
        logger?.warn?.('client tools PDF generation failed during context reuse; falling back to inline protocol', {
          error: error.message
        });
        if (protocolText) {
          duckMessages = appendTextToFirstUser(duckMessages, `\n\n${protocolText}`);
          fellBackToInlineTools = true;
        }
      }
    }
    const storedFile = pdfFileFromState(storedPdf);
    if (storedFile) duckMessages = attachPdfFile(duckMessages, storedFile);
    spillDisplay = duckMessages;
    logPatch.contextPdfReused = true;
    logPatch.contextPdf = { pages: storedPdf.pages, bytes: storedPdf.bytes, reused: true };
  } else if (pdfSpillConfig.enabled !== false) {
    try {
      const spill = await spillMessagesToPdf(duckMessages, {
        inputCharLimit,
        maxPages: Number(pdfSpillConfig.maxPages) || 15,
        toolsMaxPages,
        toolProtocol: protocolText,
        toolNames
      });
      if (spill) {
        duckMessages = spill.messages;
        spillDisplay = spill.messages;
        logPatch.contextPdf = spill.pdf;
        if (spill.toolsFile) {
          logPatch.toolsPdf = { pages: spill.toolsFile.pages, bytes: spill.toolsFile.bytes };
        }
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

  if (input.useClientToolsPdf && !logPatch.contextPdf && !logPatch.contextPdfReused && !fellBackToInlineTools) {
    const already = duckMessages.some(
      (message) => Array.isArray(message.files) && message.files.some((file) => file.filename === 'client-tools.pdf')
    );
    if (!already && clientTools.length) {
      try {
        const toolsPdf = await getOrCreateToolsPdf({
          toolProtocol: protocolText,
          toolNames,
          maxPages: toolsMaxPages,
          includeContext: false
        });
        duckMessages = attachPdfFile(duckMessages, makeToolsFileEntry(toolsPdf));
        duckMessages = appendTextToFirstUser(duckMessages, TOOLS_PDF_INSTRUCTION);
        spillDisplay = duckMessages;
        logPatch.toolsPdf = { pages: toolsPdf.pages, bytes: toolsPdf.bytes, cached: toolsPdf.cached };
      } catch (error) {
        logger?.warn?.('client tools PDF generation failed; falling back to inline protocol', {
          error: error.message
        });
        if (protocolText) {
          duckMessages = appendTextToFirstUser(duckMessages, `\n\n${protocolText}`);
          fellBackToInlineTools = true;
        }
      }
    }
  }

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
  const hasPdfMode = (hasContextPdf || hasToolsPdf) && !fellBackToInlineTools;
  const historyProtocolText = fellBackToInlineTools ? protocolText : hasPdfMode ? PDF_PURPOSE_TEXT : protocolText;
  const injection = {
    injected: Boolean(historyProtocolText),
    clientTools: toolNames,
    protocolText: historyProtocolText,
    protocolKind: fellBackToInlineTools ? 'text-fallback' : hasPdfMode ? 'client-tools-pdf' : 'text',
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
