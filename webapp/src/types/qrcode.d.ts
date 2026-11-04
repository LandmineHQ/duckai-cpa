declare module 'qrcode' {
  export interface QrToDataUrlOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: 'low' | 'medium' | 'quartile' | 'high' | 'L' | 'M' | 'Q' | 'H';
    color?: { dark?: string; light?: string };
    type?: string;
    canvas?: HTMLCanvasElement;
  }

  export function toDataURL(
    text: string,
    options: QrToDataUrlOptions,
    callback: (error: Error | null, url: string) => void
  ): void;
  export function toDataURL(text: string, callback: (error: Error | null, url: string) => void): void;

  const QRCode: {
    toDataURL: typeof toDataURL;
  };

  export default QRCode;
}
