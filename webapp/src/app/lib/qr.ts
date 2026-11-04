import QRCode from 'qrcode';

/**
 * 本地生成 PNG data URL（qrcode，不请求任何外部二维码服务）。
 * 使用 callback API 以兼容 qrcode 的浏览器构建（没有 Promise 返回）。
 */
export async function makeQrDataUrl(text: string, width = 220): Promise<string> {
  if (!text) throw new Error('二维码内容为空');
  return new Promise<string>((resolve, reject) => {
    try {
      QRCode.toDataURL(
        text,
        {
          width,
          margin: 1,
          errorCorrectionLevel: 'M',
          color: { dark: '#111827', light: '#ffffff' }
        },
        (error, url) => {
          if (error || !url) reject(error || new Error('二维码生成失败'));
          else resolve(url);
        }
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error('二维码生成失败'));
    }
  });
}

/** 下载 data URL 图片（二维码 PNG 等）。 */
export function downloadDataUrl(filename: string, dataUrl: string): void {
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
