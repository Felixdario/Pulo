import QRCode from 'qrcode';

/** QR quadrado, cantos retos, tinta sobre branco e margem de 4 módulos (DESIGN.md > Cartão de link). */
const OPTIONS = {
  errorCorrectionLevel: 'M' as const,
  margin: 4,
  color: { dark: '#141414ff', light: '#ffffffff' },
};

export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { ...OPTIONS, type: 'svg' });
}

export function qrPngDataUrl(text: string, width = 1024): Promise<string> {
  return QRCode.toDataURL(text, { ...OPTIONS, width });
}

function download(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

export async function downloadQr(text: string, slug: string, format: 'png' | 'svg') {
  if (format === 'png') {
    download(await qrPngDataUrl(text), `pulo-${slug}.png`);
    return;
  }
  const svg = await qrSvg(text);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  download(url, `pulo-${slug}.svg`);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
