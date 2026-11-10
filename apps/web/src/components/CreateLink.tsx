import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api/problem';
import type { Link as LinkT, Preview } from '../lib/api/types';
import { hostOf } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { api } from '../lib/session';
import { checkAlias, completeUrl, looksLikeUrl } from '../lib/validation';
import { IconArrow, IconClose } from './Icons';
import { QrCode, QrDownloads } from './Qr';
import { CopyButton, Favicon, ShortLink } from './ui';

/** Prévia do destino (`GET /v1/preview`) depois de 400 ms sem digitar. Nunca bloqueia o envio. */
export function DestinationPreview({ url }: { url: string }) {
  const debounced = useDebounced(url, 400);
  const target = looksLikeUrl(debounced) ? completeUrl(debounced) : null;
  const q = useQuery({
    queryKey: ['preview', target],
    queryFn: ({ signal }) => api.get<Preview>('/v1/preview', { query: { url: target! }, signal }),
    enabled: target !== null,
    staleTime: 3_600_000,
    retry: false,
  });
  if (target === null) return <div className="previa previa-vazia" aria-hidden="true" />;
  if (q.isPending) {
    return (
      <div className="previa" aria-busy="true" aria-label="Buscando a página de destino">
        <span className="favicon" />
        <span className="esqueleto" style={{ width: '60%' }} />
      </div>
    );
  }
  if (q.isError) {
    const err = q.error as ApiError;
    const blocked = err.code === 'preview_blocked';
    return (
      <div className={clsx('previa', blocked && 'previa-alerta')} role="status">
        <span className="favicon" aria-hidden="true" />
        <span>
          {blocked
            ? 'Esse endereço é de uma rede privada ou local: o link não vai abrir para quem receber.'
            : 'Não deu para ver a página agora; o link funciona mesmo assim.'}
        </span>
      </div>
    );
  }
  const p = q.data;
  return (
    <div className="previa" role="status">
      <Favicon src={p.favicon} />
      <span className="previa-texto">
        <span className="previa-titulo">{p.title ?? p.site_name ?? hostOf(p.final_url)}</span>
        <span className="suave"> · {hostOf(p.final_url)}</span>
        {p.redirects > 0 && (
          <span className="suave">
            {' '}
            · passou por {p.redirects}{' '}
            {p.redirects === 1 ? 'redirecionamento' : 'redirecionamentos'}
          </span>
        )}
      </span>
      {p.image && (
        <img className="previa-imagem" src={p.image} alt="" referrerPolicy="no-referrer" />
      )}
    </div>
  );
}

function newKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function CreateLink({ onCreated }: { onCreated?: (link: LinkT) => void }) {
  const ids = { destino: useId(), alias: useId(), titulo: useId() };
  const qc = useQueryClient();
  const [destination, setDestination] = useState('');
  const [alias, setAlias] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [destError, setDestError] = useState<string | null>(null);
  const [created, setCreated] = useState<LinkT | null>(null);
  const destRef = useRef<HTMLInputElement>(null);
  const createdRef = useRef<HTMLDivElement>(null);
  // O botão Encurtar fica desabilitado durante o envio e perde o foco; o foco vai para o Copiar do
  // resultado (como na landing), e o teclado continua dali.
  useEffect(() => {
    if (created) createdRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [created]);
  const aliasCheck = checkAlias(alias);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!looksLikeUrl(destination)) {
      setDestError(
        destination.trim() === ''
          ? 'Cole o endereço que o link curto vai abrir.'
          : 'Isso não parece um endereço da web. Ele precisa ter um domínio, como loja.com.br.',
      );
      destRef.current?.focus();
      return;
    }
    if (aliasCheck.state === 'error') return;
    setBusy(true);
    setError(null);
    setDestError(null);
    // Uma Idempotency-Key por tentativa de envio: o retry automático depois do refresh reaproveita
    // a mesma, então um 401 no meio do caminho nunca cria o link duas vezes.
    const key = newKey();
    try {
      const body: { destination: string; alias?: string; title?: string } = {
        destination: completeUrl(destination),
      };
      if (alias.trim()) body.alias = alias.trim();
      if (title.trim()) body.title = title.trim();
      const link = await api.post<LinkT>('/v1/links', body, {
        headers: { 'idempotency-key': key },
      });
      setCreated(link);
      setDestination('');
      setAlias('');
      setTitle('');
      api.forget('/v1/links');
      await qc.invalidateQueries({ queryKey: ['links'] });
      await qc.invalidateQueries({ queryKey: ['overview'] });
      onCreated?.(link);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(0, null);
      setError(apiErr);
      if (apiErr.fields.destination) destRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const destMessage = destError ?? error?.fields.destination ?? null;
  const aliasMessage =
    aliasCheck.state === 'error' ? aliasCheck.message : (error?.fields.alias ?? null);
  const general =
    error && !error.fields.destination && !error.fields.alias ? error.firstMessage : null;

  return (
    <section className="folha novo-link" id="novo-link" aria-labelledby="t-novo">
      <h2 id="t-novo" className="folha-titulo">
        Novo link
      </h2>
      <form className="novo-form" onSubmit={submit} noValidate>
        <div className="campo-grupo novo-destino">
          <label className="campo-rotulo" htmlFor={ids.destino}>
            Link para encurtar
          </label>
          <input
            ref={destRef}
            id={ids.destino}
            className="campo"
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="https://sualoja.com.br/black-friday?utm_source=instagram"
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              setDestError(null);
              if (error?.fields.destination) setError(null);
            }}
            onBlur={() => {
              if (destination.trim() && !looksLikeUrl(destination)) {
                setDestError(
                  'Isso não parece um endereço da web. Ele precisa ter um domínio, como loja.com.br.',
                );
              }
            }}
            aria-invalid={destMessage ? true : undefined}
            aria-describedby={destMessage ? `${ids.destino}-erro` : undefined}
          />
          {destMessage && (
            <p id={`${ids.destino}-erro`} className="campo-erro" role="alert">
              {destMessage}
            </p>
          )}
        </div>
        <div className="campo-grupo novo-alias">
          <label className="campo-rotulo" htmlFor={ids.alias}>
            Alias (opcional)
          </label>
          <input
            id={ids.alias}
            className="campo mono"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            placeholder="black-friday"
            value={alias}
            onChange={(e) => {
              setAlias(e.target.value);
              if (error?.fields.alias) setError(null);
            }}
            aria-invalid={aliasMessage ? true : undefined}
            aria-describedby={`${ids.alias}-msg`}
          />
          <p
            id={`${ids.alias}-msg`}
            className={
              aliasMessage ? 'campo-erro' : aliasCheck.state === 'ok' ? 'campo-ok' : 'campo-ajuda'
            }
            aria-live="polite"
          >
            {aliasMessage ??
              (aliasCheck.state === 'ok'
                ? 'Formato válido.'
                : 'Vazio: sai um nome aleatório de 7 caracteres.')}
          </p>
        </div>
        <div className="campo-grupo novo-titulo">
          <label className="campo-rotulo" htmlFor={ids.titulo}>
            Título (opcional)
          </label>
          <input
            id={ids.titulo}
            className="campo"
            maxLength={500}
            placeholder="Black Friday 2026"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primario novo-botao" disabled={busy}>
          {busy ? 'Encurtando…' : 'Encurtar'}
        </button>
      </form>
      <DestinationPreview url={destination} />
      {general && (
        <p className="campo-erro" role="alert">
          {general}
        </p>
      )}
      {created && (
        <div className="criado" role="status" ref={createdRef}>
          <div className="criado-link">
            <p className="rotulo suave">Pronto. Seu link curto:</p>
            <ShortLink url={created.short_url} className="criado-curto" />
            <p className="suave criado-destino">→ {hostOf(created.destination)}</p>
          </div>
          <div className="criado-acoes">
            <CopyButton text={created.short_url} />
            <Link
              to="/app/links/$id"
              params={{ id: String(created.id) }}
              className="btn btn-secundario"
            >
              Ver cliques <IconArrow />
            </Link>
            <button
              type="button"
              className="btn btn-fantasma btn-icone"
              aria-label="Fechar o resultado"
              onClick={() => setCreated(null)}
            >
              <IconClose />
            </button>
          </div>
          <div className="criado-qr">
            <QrCode url={created.short_url} size={88} />
            <QrDownloads url={created.short_url} slug={created.slug} />
          </div>
        </div>
      )}
    </section>
  );
}
