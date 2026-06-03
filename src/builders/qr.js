import QRCode from 'qrcode';

// Генерирует PNG-буфер QR-кода для строки vpn:// (его сканирует мобильный клиент).
export function buildQrPng(text) {
  return QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
  });
}
