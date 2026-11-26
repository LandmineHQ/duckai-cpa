/**
 * 客户端上传图片压缩工具：在发送给后端（4MB body 限制）和 duck.ai（PNG ≤512px）之前，
 * 用 Canvas 将大图等比缩放并转为紧凑 PNG data URL。
 */
export async function readImageFileAsDataUrl(file: File, maxDimension = 1024): Promise<string> {
  const rawUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片文件失败'));
    reader.readAsDataURL(file);
  });

  if (typeof document === 'undefined' || !rawUrl.startsWith('data:image/')) {
    return rawUrl;
  }

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('无法解码图片'));
      el.src = rawUrl;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return rawUrl;
    const scale = Math.min(1, maxDimension / Math.max(w, h));
    const targetW = Math.max(1, Math.round(w * scale));
    const targetH = Math.max(1, Math.round(h * scale));
    if (scale === 1 && rawUrl.startsWith('data:image/png;base64,') && rawUrl.length < 900_000) {
      return rawUrl;
    }
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return rawUrl;
    ctx.drawImage(img, 0, 0, targetW, targetH);
    const pngUrl = canvas.toDataURL('image/png');
    if (pngUrl.length <= 1_400_000) return pngUrl;
    return canvas.toDataURL('image/jpeg', 0.88);
  } catch {
    return rawUrl;
  }
}
