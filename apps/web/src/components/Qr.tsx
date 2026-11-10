import { Dialog } from '@base-ui/react/dialog';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { downloadQr, qrSvg } from '../lib/qr';
import { IconClose, IconDownload } from './Icons';
import { ShortLink } from './ui';

/** QR do link curto com download em PNG e SVG. O SVG vem do pacote `qrcode`, nunca de entrada. */
export function QrCode({ url, size = 160 }: { url: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    qrSvg(url).then(
      (s) => alive && setSvg(s),
      () => alive && setSvg(null),
    );
    return () => {
      alive = false;
    };
  }, [url]);
  return (
    <div
      className="qr"
      role="img"
      aria-label={`QR code de ${url}`}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

export function QrDownloads({ url, slug }: { url: string; slug: string }) {
  const save = (format: 'png' | 'svg') =>
    downloadQr(url, slug, format).catch(() => toast.error('Não deu para gerar o arquivo do QR.'));
  return (
    <div className="qr-baixar">
      <button type="button" className="btn btn-secundario btn-pequeno" onClick={() => save('png')}>
        <IconDownload /> PNG
      </button>
      <button type="button" className="btn btn-secundario btn-pequeno" onClick={() => save('svg')}>
        <IconDownload /> SVG
      </button>
    </div>
  );
}

export function QrDialog({
  url,
  slug,
  open,
  onOpenChange,
}: {
  url: string;
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fundo-dialogo camada" />
        <Dialog.Popup className="flutuante dialogo camada qr-dialogo">
          <div className="dialogo-topo">
            <Dialog.Title className="dialogo-titulo">QR code</Dialog.Title>
            <Dialog.Close className="btn btn-fantasma btn-icone" aria-label="Fechar">
              <IconClose />
            </Dialog.Close>
          </div>
          <Dialog.Description className="dialogo-texto">
            Leva para <ShortLink url={url} />. Imprima com pelo menos 2 cm de lado.
          </Dialog.Description>
          <div className="qr-corpo">
            <QrCode url={url} size={240} />
            <QrDownloads url={url} slug={slug} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
