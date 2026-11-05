/**
 * v2.58：图片-only 与跨轮图片上下文。
 *
 * 客户端可能只回放占位文本（“已生成 N 张图片（base64 位于 image_generation_call.result 字段）”），
 * 而不是 image_generation_call / image part；这里从会话状态取出真实图片并挂到下一轮 user 上。
 */

const IMAGE_PLACEHOLDER_RE = /(已生成\s*\d+\s*张图片|base64\s*位于\s*image_generation_call\.result)/i;

export function isImagePlaceholderText(text) {
  return IMAGE_PLACEHOLDER_RE.test(String(text || ''));
}

export function normalizeStoredImage(image) {
  if (!image || typeof image !== 'object') return null;
  const b64 = typeof image.b64 === 'string' ? image.b64 : '';
  if (!b64) return null;
  const format =
    typeof image.format === 'string' && image.format
      ? image.format.toLowerCase().replace(/^image\//, '')
      : 'png';
  return {
    b64,
    format,
    mimeType: typeof image.mimeType === 'string' && image.mimeType ? image.mimeType : format === 'jpg' ? 'image/jpeg' : `image/${format}`,
    ...(typeof image.model === 'string' && image.model ? { model: image.model } : {})
  };
}

/** 合并图片并去重（最多 8 张）。 */
export function mergeStoredImages(...lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const image = normalizeStoredImage(item);
      if (!image || seen.has(image.b64)) continue;
      seen.add(image.b64);
      result.push(image);
      if (result.length >= 8) return result;
    }
  }
  return result;
}

/**
 * 若 conversation 中存在图片占位文本，则把会话已保存的真实图片挂到最后一个 user 消息。
 * 返回新数组（不修改入参）；无占位文本时原样返回。
 */
export function replaySessionImages(conversation, storedImages) {
  const messages = Array.isArray(conversation) ? conversation : [];
  const images = mergeStoredImages(storedImages);
  if (!images.length || !messages.length) return messages;
  let hasPlaceholder = false;
  const replaced = messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    if (!isImagePlaceholderText(message.content)) return message;
    hasPlaceholder = true;
    return { ...message, content: '（上一轮生成的图片）', images: mergeStoredImages(message.images, images) };
  });
  if (!hasPlaceholder) return messages;
  let targetIndex = -1;
  for (let index = replaced.length - 1; index >= 0; index -= 1) {
    if (replaced[index]?.role === 'user') {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) {
    return [
      ...replaced,
      { role: 'user', content: '（上一轮生成的图片）', images }
    ];
  }
  const target = replaced[targetIndex];
  return replaced.map((message, index) =>
    index === targetIndex
      ? { ...message, images: mergeStoredImages(message.images, images) }
      : message
  );
}

export function extractGeneratedImages(images) {
  return mergeStoredImages(images);
}

export default {
  isImagePlaceholderText,
  replaySessionImages,
  mergeStoredImages,
  extractGeneratedImages
};
