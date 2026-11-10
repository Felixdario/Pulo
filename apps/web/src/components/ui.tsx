import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Tooltip } from '@base-ui/react/tooltip';
import { clsx } from 'clsx';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { splitShortUrl, spellSlug } from '../lib/format';
import { useCopy } from '../lib/hooks';
import type { RuleChip } from '../lib/rules';
import { IconCheck, IconCopy } from './Icons';

export function Wordmark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span className={clsx('marca', className)} style={{ fontSize: size }}>
      pulo<span className="marca-ponto">.</span>
    </span>
  );
}

/** O link curto como objeto: domínio em suave e slug em tinta, lido letra por letra. */
export function ShortLink({
  url,
  className,
  as: As = 'span',
}: {
  url: string;
  className?: string;
  as?: 'span' | 'h1' | 'p';
}) {
  const { host, slug } = splitShortUrl(url);
  return (
    <As className={clsx('curto', className)}>
      <span className="sr-only">{spellSlug(host, slug)}</span>
      <span aria-hidden="true">
        <span className="curto-host">{host}</span>
        {/* Se não couber, quebra entre o domínio e o slug, nunca no meio do slug curto. */}
        <wbr />
        <span className="curto-slug">{slug}</span>
      </span>
    </As>
  );
}

/** Copiar: botão primário de verdade; vira "Copiado" por 2 s e o leitor de tela ouve "Link copiado". */
export function CopyButton({
  text,
  label = 'Copiar',
  className,
  variant = 'primario',
  small = false,
  announce = 'Link copiado',
  stopPropagation = false,
}: {
  text: string;
  label?: string;
  className?: string;
  variant?: 'primario' | 'secundario' | 'cartaz';
  small?: boolean;
  announce?: string;
  stopPropagation?: boolean;
}) {
  const [copied, copy] = useCopy();
  return (
    <>
      <button
        type="button"
        className={clsx(
          'btn btn-troca',
          variant === 'cartaz' ? 'btn-cartaz' : `btn-${variant}`,
          small && 'btn-pequeno',
          className,
        )}
        onClick={async (e) => {
          if (stopPropagation) e.stopPropagation();
          const ok = await copy(text);
          if (!ok) toast.error('Não deu para copiar. Selecione o link e copie à mão.');
        }}
      >
        <span aria-hidden={copied}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <IconCopy />
            {label}
          </span>
        </span>
        <span aria-hidden={!copied}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <IconCheck />
            Copiado
          </span>
        </span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? announce : ''}
      </span>
    </>
  );
}

export function RuleChips({ chips, max }: { chips: RuleChip[]; max?: number }) {
  if (chips.length === 0) return null;
  const shown = max ? chips.slice(0, max) : chips;
  const rest = max ? chips.slice(max) : [];
  return (
    <ul className="chips" aria-label="Regras">
      {shown.map((c) => (
        <li key={c.key}>
          <Hint text={c.sentence}>
            <span
              className={clsx(
                'chip',
                c.tone === 'aviso' && 'chip-aviso',
                c.tone === 'negativo' && 'chip-negativo',
              )}
            >
              {c.text}
            </span>
          </Hint>
        </li>
      ))}
      {rest.length > 0 && (
        <li>
          <Hint text={rest.map((c) => c.sentence).join(' ')}>
            <span className="chip">+{rest.length}</span>
          </Hint>
        </li>
      )}
    </ul>
  );
}

/** Dica de hover/foco. Complementar: a mesma informação existe em texto em outro lugar. */
export function Hint({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={<span tabIndex={0} />} className="dica-gatilho">
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6} className="camada-pop">
          <Tooltip.Popup className="flutuante popup dica">{text}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function DbipCredit({ className }: { className?: string }) {
  return (
    <p className={clsx('rotulo suave credito', className)}>
      <a className="link-texto" href="https://db-ip.com" target="_blank" rel="noreferrer">
        IP Geolocation by DB-IP
      </a>{' '}
      (DB-IP Lite, CC BY 4.0)
    </p>
  );
}

export function Skeleton({ width = '4ch', height }: { width?: string | number; height?: number }) {
  return (
    <span
      className="esqueleto"
      aria-hidden="true"
      style={{ width, ...(height ? { height } : {}) }}
    />
  );
}

export function ErrorBlock({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={clsx('bloco-erro', className)} role="alert">
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="btn btn-secundario btn-pequeno" onClick={onRetry}>
          Tentar de novo
        </button>
      )}
    </div>
  );
}

export function Favicon({ src }: { src: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="favicon" aria-hidden="true" />;
  return (
    <img
      className="favicon"
      src={src}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** Confirmação de ação irreversível, com o nome do objeto na frase. */
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy = false,
  danger = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  danger?: boolean;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fundo-dialogo camada" />
        <AlertDialog.Popup className="flutuante dialogo camada">
          <AlertDialog.Title className="dialogo-titulo">{title}</AlertDialog.Title>
          <AlertDialog.Description className="dialogo-texto" render={<div />}>
            {description}
          </AlertDialog.Description>
          <div className="dialogo-acoes">
            <AlertDialog.Close className="btn btn-secundario">Cancelar</AlertDialog.Close>
            <button
              type="button"
              className={clsx('btn', danger ? 'btn-perigo' : 'btn-primario')}
              onClick={onConfirm}
              disabled={busy}
            >
              {confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
