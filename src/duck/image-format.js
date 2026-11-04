/**
 * v2.35：图片格式探测与 MIME 映射。
 *
 * duck.ai 的 GenerateImage 实际返回的是 **JPEG**（base64 以 `/9j/` 开头），但 SSE 帧里
 * 往往不带 format（或写成 png）。OpenAI 客户端（尤其 `response_format:"url"`）需要正确的
 * MIME；否则 data URI 会被声明成 image/png，浏览器/客户端解码可能失败。
 */

const MIME_BY_FORMAT = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp'
};

/**
 * 根据 base64 前几个字节判断真实图片格式；无法判断时返回 fallback。
 * @param {string} b64
 * @param {string} [fallback]
 * @returns {string}
 */
export function detectImageFormat(b64, fallback = 'png') {
  const normalizedFallback = normalizeFormat(fallback) || 'png';
  if (typeof b64 !== 'string' || b64.length < 16) return normalizedFallback;
  let head;
  try {
    head = Buffer.from(b64.slice(0, 32), 'base64');
  } catch {
    return normalizedFallback;
  }
  if (head.length < 4) return normalizedFallback;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return 'gif';
  if (head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (head.slice(4, 12).toString('ascii').includes('ftyp')) return 'avif';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  return normalizedFallback;
}

/** 规范化 format 字符串（去掉 image/ 前缀、小写、jpg→jpeg）。 */
export function normalizeFormat(format) {
  if (typeof format !== 'string' || !format) return '';
  const value = format.toLowerCase().replace(/^image\//, '').trim();
  return value === 'jpg' ? 'jpeg' : value;
}

/** format → MIME；未知格式按 png 处理。 */
export function imageMimeType(format) {
  return MIME_BY_FORMAT[normalizeFormat(format)] || 'image/png';
}

/** 生成 data URI（供 OpenAI `image_url` 或 `url` 字段使用）。 */
export function imageDataUri(b64, format) {
  return `data:${imageMimeType(format)};base64,${b64}`;
}
