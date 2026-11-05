/**
 * v2.49：把旧对话渲染成会话 PDF（供 duck.ai file part 读取）。
 *
 * - 文本分页，最多 maxPages 页（Free 实测单文件 ≤15 页）；
 * - 中文用系统字体（Windows: simhei.ttf；可用 DUCKAI_PDF_FONT 覆盖）；
 * - 图片嵌入 PDF 页面并带 caption；
 * - 超过页数上限抛 PdfCapacityError，由调用方决定回退策略。
 */
import fs from 'node:fs';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const A4 = [595.28, 841.89];
const MARGIN = 32;
const FONT_SIZE = 5;
const LINE_HEIGHT = 3.2;
const LINES_PER_PAGE = 250;
const MAX_PAGES_DEFAULT = 15;

const CJK_FONT_CANDIDATES = [
  process.env.DUCKAI_PDF_FONT,
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/msyh.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/System/Library/Fonts/PingFang.ttc'
].filter(Boolean);

export class PdfCapacityError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'PdfCapacityError';
    this.code = 'context_pdf_capacity_exceeded';
    this.detail = detail;
  }
}

function readFont() {
  for (const candidate of CJK_FONT_CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) return { path: candidate, bytes: fs.readFileSync(candidate) };
    } catch {
      // try next
    }
  }
  return null;
}

function hasNonAscii(text) {
  return /[^\x00-\x7F]/.test(String(text || ''));
}

/** 逐字符断行（CJK 友好）；英文尽量按空格断。 */
function wrapText(text, font, size, maxWidth) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const out = [];
  for (const rawLine of source.split('\n')) {
    if (!rawLine) {
      out.push('');
      continue;
    }
    let line = '';
    const tokens = rawLine.match(/\s+|[^\s]+/g) || [rawLine];
    for (const token of tokens) {
      const candidate = line + token;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        out.push(line.replace(/\s+$/, ''));
        line = '';
      }
      if (font.widthOfTextAtSize(token, size) <= maxWidth) {
        line = token;
        continue;
      }
      // 长 token（中文/URL）逐字符拆
      for (const char of token) {
        const next = line + char;
        if (font.widthOfTextAtSize(next, size) <= maxWidth) line = next;
        else {
          if (line) out.push(line);
          line = char;
        }
      }
    }
    if (line) out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
        if (part.type === 'image_url' || part.type === 'input_image') return '[image]';
        if (part.type === 'file') return '[file]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function collectImages(messages) {
  const images = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const image of Array.isArray(message?.images) ? message.images : []) {
      if (image && (image.b64 || image.dataUrl)) images.push(image);
    }
  }
  return images;
}

function transcriptLines(messages) {
  const lines = [];
  lines.push('=== CONVERSATION CONTEXT (archived) ===');
  lines.push('This PDF contains the earlier conversation. Use it as context; the current question follows in the chat text.');
  lines.push('');
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role ? String(message.role).toUpperCase() : 'USER';
    const text = messageText(message).trim();
    if (!text && !(Array.isArray(message?.images) && message.images.length)) continue;
    lines.push(`[${role}]`);
    if (text) lines.push(...text.split('\n'));
    if (Array.isArray(message?.images) && message.images.length) {
      lines.push(`[images attached: ${message.images.length}]`);
    }
    lines.push('');
  }
  return lines;
}

function imageBytes(image) {
  try {
    if (typeof image?.b64 === 'string' && image.b64) {
      return { bytes: Buffer.from(image.b64, 'base64'), format: String(image.format || 'png').toLowerCase() };
    }
    if (typeof image?.dataUrl === 'string') {
      const match = image.dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (match) return { bytes: Buffer.from(match[2], 'base64'), format: match[1].toLowerCase() };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {{messages: any[], maxPages?: number, title?: string, images?: any[]}} options
 * @returns {Promise<{buffer: Buffer, pages: number, textChars: number, imageCount: number}>}
 */
export async function createContextPdf({ messages = [], maxPages = MAX_PAGES_DEFAULT, title = 'DuckAI context', images = null } = {}) {
  const fontInfo = readFont();
  const lines = transcriptLines(messages);
  const allText = lines.join('\n');
  const imageList = Array.isArray(images) ? images : collectImages(messages);
  const doc = await PDFDocument.create();
  doc.setTitle(title);

  let font;
  if (fontInfo) {
    doc.registerFontkit(fontkit);
    try {
      font = await doc.embedFont(fontInfo.bytes, { subset: true });
    } catch {
      font = null;
    }
  }
  if (!font) {
    if (hasNonAscii(allText)) {
      throw new PdfCapacityError('CJK font is required to render this context PDF', { reason: 'font_missing' });
    }
    font = await doc.embedFont(StandardFonts.Helvetica);
  }

  let page = null;
  let y = 0;
  let pageCount = 0;
  let linesOnPage = 0;
  const addPage = () => {
    if (pageCount >= maxPages) {
      throw new PdfCapacityError(`context PDF exceeds max pages (${maxPages})`, {
        pages: pageCount + 1,
        maxPages,
        textChars: allText.length,
        imageCount: imageList.length
      });
    }
    page = doc.addPage(A4);
    pageCount += 1;
    linesOnPage = 0;
    y = A4[1] - MARGIN;
    page.drawText(`Conversation context · page ${pageCount}`, {
      x: MARGIN,
      y: A4[1] - MARGIN + 6,
      size: 7,
      font,
      color: rgb(0.45, 0.45, 0.45)
    });
  };
  addPage();

  const maxWidth = A4[0] - MARGIN * 2;
  for (const line of lines) {
    const wrapped = wrapText(line, font, FONT_SIZE, maxWidth);
    if (!wrapped.length) {
      if (linesOnPage >= LINES_PER_PAGE || y - LINE_HEIGHT < MARGIN) addPage();
      else y -= LINE_HEIGHT;
      linesOnPage += 1;
      continue;
    }
    for (const part of wrapped) {
      if (linesOnPage >= LINES_PER_PAGE || y - LINE_HEIGHT < MARGIN) addPage();
      if (part) page.drawText(part, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0.05, 0.05, 0.05) });
      y -= LINE_HEIGHT;
      linesOnPage += 1;
    }
  }

  let embedded = 0;
  for (const image of imageList) {
    const data = imageBytes(image);
    if (!data) continue;
    let embeddedImage;
    try {
      const format = data.format === 'jpg' ? 'jpeg' : data.format;
      if (format === 'png') embeddedImage = await doc.embedPng(data.bytes);
      else if (format === 'jpeg' || format === 'jpg') embeddedImage = await doc.embedJpg(data.bytes);
      else continue;
    } catch {
      continue;
    }
    if (pageCount >= maxPages) {
      throw new PdfCapacityError(`context PDF images exceed max pages (${maxPages})`, {
        pages: pageCount + 1,
        maxPages,
        textChars: allText.length,
        imageCount: imageList.length
      });
    }
    const imgPage = doc.addPage(A4);
    pageCount += 1;
    const maxW = A4[0] - MARGIN * 2;
    const maxH = A4[1] - MARGIN * 2 - 24;
    const scale = Math.min(maxW / embeddedImage.width, maxH / embeddedImage.height, 1);
    const w = embeddedImage.width * scale;
    const h = embeddedImage.height * scale;
    imgPage.drawText(`Embedded image ${embedded + 1}`, { x: MARGIN, y: A4[1] - MARGIN + 6, size: 7, font, color: rgb(0.45, 0.45, 0.45) });
    imgPage.drawImage(embeddedImage, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
    embedded += 1;
  }

  const buffer = Buffer.from(await doc.save());
  return { buffer, pages: pageCount, textChars: allText.length, imageCount: embedded };
}

export default { createContextPdf, PdfCapacityError };


/** v2.50：独立的 client tools 说明 PDF（第一页工具说明，避免占用 context PDF 页数）。 */
export async function createToolsPdf({ toolProtocol = '', toolNames = [], maxPages = 1 } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle('DuckAI client tools');
  const fontInfo = readFont();
  let font;
  if (fontInfo) {
    doc.registerFontkit(fontkit);
    try { font = await doc.embedFont(fontInfo.bytes, { subset: true }); } catch { font = null; }
  }
  if (!font) font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = [
    'CLIENT TOOLS / 客户端工具说明',
    '',
    '本 PDF 说明本次会话可用的客户端工具。',
    '另一个 PDF（context）是会话历史上下文。',
    '请读取 context PDF 的全部页面，不要只读第一页/摘要。',
    ''
  ];
  if (toolNames.length) lines.push('可用工具：' + toolNames.join(', '));
  if (toolProtocol) {
    lines.push('', '工具调用协议：', ...String(toolProtocol).split('\n'));
  }
  let page = doc.addPage(A4);
  let y = A4[1] - MARGIN;
  let pageCount = 1;
  const maxWidth = A4[0] - MARGIN * 2;
  for (const line of lines) {
    const wrapped = wrapText(line, font, FONT_SIZE, maxWidth);
    for (const part of wrapped) {
      if (y - LINE_HEIGHT < MARGIN) {
        if (pageCount >= maxPages) throw new PdfCapacityError('client tools PDF exceeds max pages', { maxPages });
        page = doc.addPage(A4); pageCount += 1; y = A4[1] - MARGIN;
      }
      if (part) page.drawText(part, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0.05, 0.05, 0.05) });
      y -= LINE_HEIGHT;
    }
  }
  const text = lines.join('\n');
  return { buffer: Buffer.from(await doc.save()), pages: pageCount, textChars: text.length, text };
}
