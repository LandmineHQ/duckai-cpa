/**
 * v2.44：把图片统一转为上游可接收的 PNG（≤ maxDimension）。
 *
 * 背景：duck.ai 的图像输入只接受 PNG/WebP（实测 JPEG data URL 返回 400 ERR_BAD_REQUEST sc22，
 * PNG 512/1024 均通过）；而 GenerateImage 返回 JPEG。因此在把上一轮生成图回填到上下文前，
 * 需要 JPEG → PNG 并缩到模型 maxDimension（默认 512，保守兼容所有模型）。
 *
 * 使用纯 JS 编解码（jpeg-js / pngjs），不引入原生依赖，Windows/Docker alpine 均可运行。
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export const DEFAULT_MAX_IMAGE_DIMENSION = 512;

function base64ToBuffer(b64) {
  return Buffer.from(String(b64 || ''), 'base64');
}

function sniffImageFormat(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buffer.slice(4, 12).toString('ascii') === 'ftypavif') return 'avif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  return null;
}

function decodeToRgba(buffer) {
  const format = sniffImageFormat(buffer);
  if (format === 'jpeg') {
    const decoded = jpeg.decode(buffer, { useTArray: true });
    return { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  }
  if (format === 'png') {
    const decoded = PNG.sync.read(buffer);
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }
  return null;
}

function resizeRgba(image, maxDimension) {
  const { width, height, data } = image;
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  if (scale >= 1) return image;
  const nextWidth = Math.max(1, Math.round(width * scale));
  const nextHeight = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(nextWidth * nextHeight * 4);
  for (let y = 0; y < nextHeight; y += 1) {
    const srcY = Math.min(height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < nextWidth; x += 1) {
      const srcX = Math.min(width - 1, Math.floor((x + 0.5) / scale));
      const src = (srcY * width + srcX) * 4;
      const dst = (y * nextWidth + x) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
    }
  }
  return { width: nextWidth, height: nextHeight, data: out };
}

/**
 * 归一化为上游可接受的 PNG data URL。
 * @param {{ b64?: string, dataUrl?: string, mimeType?: string, format?: string }} image
 * @param {{ maxDimension?: number }} [options]
 * @returns {{ mimeType: 'image/png', dataUrl: string, width?: number, height?: number } | null}
 */
export function toUpstreamPngDataUrl(image, options = {}) {
  const maxDimension = Number.isFinite(options.maxDimension)
    ? Math.max(64, Math.trunc(options.maxDimension))
    : DEFAULT_MAX_IMAGE_DIMENSION;
  let b64 = typeof image?.b64 === 'string' ? image.b64 : '';
  if (!b64 && typeof image?.dataUrl === 'string') {
    const match = image.dataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
    if (match) b64 = match[1];
  }
  if (!b64) return null;
  const buffer = base64ToBuffer(b64);
  const decoded = decodeToRgba(buffer);
  if (!decoded) return null;
  const resized = resizeRgba(decoded, maxDimension);
  const png = new PNG({ width: resized.width, height: resized.height });
  png.data = resized.data;
  const encoded = PNG.sync.write(png, { colorType: 6 });
  return {
    mimeType: 'image/png',
    dataUrl: `data:image/png;base64,${encoded.toString('base64')}`,
    width: resized.width,
    height: resized.height
  };
}

export default { toUpstreamPngDataUrl, DEFAULT_MAX_IMAGE_DIMENSION };
