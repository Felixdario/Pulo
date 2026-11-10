import { Menu } from '@base-ui/react/menu';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { clsx } from 'clsx';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import {
  CountryMap,
  DimensionList,
  endSentence,
  SeriesChart,
  SeriesTable,
  seriesSummary,
} from '../components/Charts';
import { EditLinkDialog } from '../components/EditLinkDialog';
import { HonestRuler } from '../components/HonestRuler';
import { IconEdit, IconMore, IconQr } from '../components/Icons';
import { LiveCounter } from '../components/LiveCounter';
import { QrDialog } from '../components/Qr';
import {
  Confirm,
  CopyButton,
  DbipCredit,
  ErrorBlock,
  RuleChips,
  ShortLink,
  Skeleton,
} from '../components/ui';
import { ApiError } from '../lib/api/problem';
import type {
  Link as LinkT,
  LinkPatch,
  LiveClick,
  Summary,
  Timeseries,
  TopDimension,
} from '../lib/api/types';
import { dateShort, hostOf, num, timeOnly } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { useLive } from '../lib/live';
import {
  GRANULARITY_LABEL,
  PERIOD_LABEL,
  PERIODS,
  resolvePeriod,
  utcDay,
  type Period,
} from '../lib/period';
import { ruleChips } from '../lib/rules';
import { api } from '../lib/session';
import { pageTitle } from '../title';

const route = getRouteApi('/app/links/$id');

function useLink(id: number) {
  return useQuery({
    queryKey: ['link', id],
    queryFn: async ({ signal }) => {
      const r = await api.request<LinkT>('GET', `/v1/links/${id}`, { signal });
      return { link: r.data, etag: r.etag };
    },
    retry: false,
  });
}

const statsKey = (id: number) => ['stats', id] as const;

function rangeText(from: string, to: string): string {
  return from === to
    ? `em ${dateShort(`${from}T12:00:00Z`)}`
    : `de ${dateShort(`${from}T12:00:00Z`)} a ${dateShort(`${to}T12:00:00Z`)}`;
}

/** Seletor de período: grupo de rádio, com setas do teclado. */
function PeriodPicker({
  value,
  from,
  to,
  onChange,
}: {
  value: Period;
  from: string;
  to: string;
  onChange: (p: Period, custom?: { from: string; to: string }) => void;
}) {
  const ids = { de: useId(), ate: useId() };
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + PERIODS.length) % PERIODS.length;
    refs.current[next]?.focus();
    onChange(PERIODS[next]!);
  };
  const today = utcDay(new Date());
  return (
    <div className="periodo">
      <div className="segmentos" role="radiogroup" aria-label="Período">
        {PERIODS.map((p, i) => (
          <button
            key={p}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === p}
            tabIndex={value === p ? 0 : -1}
            className="segmento"
            onClick={() => onChange(p)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {PERIOD_LABEL[p]}
          </button>
        ))}
      </div>
      {value === 'custom' && (
        <div className="periodo-datas">
          <div className="campo-grupo">
            <label className="campo-rotulo" htmlFor={ids.de}>
              De
            </label>
            <input
              id={ids.de}
              type="date"
              className="campo"
              value={from}
              max={to}
              onChange={(e) => e.target.value && onChange('custom', { from: e.target.value, to })}
            />
          </div>
          <div className="campo-grupo">
            <label className="campo-rotulo" htmlFor={ids.ate}>
              Até
            </label>
            <input
              id={ids.ate}
              type="date"
              className="campo"
              value={to}
              min={from}
              max={today}
              onChange={(e) => e.target.value && onChange('custom', { from, to: e.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Soma o clique ao vivo nos totais que incluem hoje (o ao vivo e a faixa são a mesma variável). */
function applyLiveClick(qc: QueryClient, id: number, c: LiveClick) {
  const today = utcDay(new Date());
  for (const [key, data] of qc.getQueriesData<Summary>({
    queryKey: [...statsKey(id), 'summary'],
  })) {
    if (!data || data.to < today) continue;
    qc.setQueryData<Summary>(key, {
      ...data,
      humans: data.humans + c.humans,
      total: data.total + c.total,
      all_time_humans: data.all_time_humans + c.humans,
    });
  }
}

function Numbers({ summary, loading }: { summary: Summary | undefined; loading: boolean }) {
  const cell = (label: string, value: number | undefined, note?: string, main = false) => (
    <div className={clsx('numeros-celula', main && 'numeros-principal')}>
      <dt className="rotulo suave">{label}</dt>
      <dd className={main ? 'numero' : 'figura'}>
        {loading || value === undefined ? (
          <Skeleton width="5ch" height={main ? 32 : 24} />
        ) : (
          num(value)
        )}
      </dd>
      {note && <dd className="rotulo apagada numeros-nota">{note}</dd>}
    </div>
  );
  return (
    <dl className="numeros folha">
      {cell('Humanos', summary?.humans, 'Só gente: entra no total e no limite.', true)}
      {cell(
        'Únicos por dia (soma)',
        summary?.uniques,
        'O mesmo visitante em dois dias conta duas vezes. Não guardamos IP.',
      )}
      {cell('Bots', summary?.bots, 'Crawlers e monitores, à parte.')}
      {cell('Prévias', summary?.previews, 'WhatsApp, Slack e afins montando a prévia.')}
    </dl>
  );
}

const DIMS = [
  { path: 'cities', dim: 'city', title: 'Cidades' },
  { path: 'referrers', dim: 'referrer', title: 'De onde vieram (referrer)' },
  { path: 'browsers', dim: 'browser', title: 'Navegadores' },
  { path: 'os', dim: 'os', title: 'Sistemas' },
  { path: 'devices', dim: 'device', title: 'Aparelhos' },
] as const;

function DimensionSheet({
  id,
  path,
  dim,
  title,
  days,
  limit = 10,
  showCode,
  children,
}: {
  id: number;
  path: string;
  dim: string;
  title: string;
  days: { from: string; to: string };
  limit?: number;
  showCode?: boolean;
  children?: (data: TopDimension) => ReactNode;
}) {
  const q = useQuery({
    queryKey: [...statsKey(id), 'dim', path, days.from, days.to, limit],
    queryFn: ({ signal }) =>
      api.get<TopDimension>(`/v1/links/${id}/stats/${path}`, {
        query: { from: days.from, to: days.to, limit },
        signal,
      }),
    placeholderData: (prev) => prev,
  });
  return (
    <section className="folha dim-folha" aria-labelledby={`t-${path}`}>
      <h2 id={`t-${path}`} className="folha-titulo">
        {title}
      </h2>
      {q.isPending ? (
        <ol className="lista-dim" aria-hidden="true">
          {[0, 1, 2, 3].map((k) => (
            <li key={k} className="dim">
              <Skeleton width={`${12 - k * 2}ch`} />
              <Skeleton width="4ch" />
            </li>
          ))}
        </ol>
      ) : q.isError ? (
        <ErrorBlock
          message={`Não deu para carregar ${title.toLowerCase()}.`}
          onRetry={() => void q.refetch()}
        />
      ) : (
        <>
          {children?.(q.data)}
          <DimensionList data={q.data} dim={dim} limit={10} showCode={showCode ?? false} />
        </>
      )}
    </section>
  );
}

export function LinkPage() {
  const { id: rawId } = route.useParams();
  const search = route.useSearch();
  const id = Number(rawId);
  const qc = useQueryClient();
  const navigate = useNavigate({ from: '/app/links/$id' });
  const linkQ = useLink(id);
  const link = linkQ.data?.link;
  useDocumentTitle(pageTitle(link ? link.slug : 'Link'));

  const period: Period = search.period ?? '30d';
  const resolved = resolvePeriod(period, { from: search.from, to: search.to });
  const { days } = resolved;
  const today = utcDay(new Date());

  const [editing, setEditing] = useState(
    () => typeof window !== 'undefined' && window.location.hash === '#editar',
  );
  const [editSeq, setEditSeq] = useState(0);
  const [qr, setQr] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const summary = useQuery({
    queryKey: [...statsKey(id), 'summary', days.from, days.to],
    queryFn: ({ signal }) =>
      api.get<Summary>(`/v1/links/${id}/stats/summary`, { query: days, signal }),
    enabled: Boolean(link),
    placeholderData: (prev) => prev,
  });
  const todaySummary = useQuery({
    queryKey: [...statsKey(id), 'summary', today, today],
    queryFn: ({ signal }) =>
      api.get<Summary>(`/v1/links/${id}/stats/summary`, {
        query: { from: today, to: today },
        signal,
      }),
    enabled: Boolean(link),
  });
  const series = useQuery({
    queryKey: [...statsKey(id), 'series', resolved.series],
    queryFn: ({ signal }) =>
      api.get<Timeseries>(`/v1/links/${id}/stats/timeseries`, { query: resolved.series, signal }),
    enabled: Boolean(link),
    placeholderData: (prev) => prev,
  });

  // ---------------------------------------------------------------- ao vivo
  const [recent, setRecent] = useState<{ t: number; n: number }[]>([]);
  const [pulse, setPulse] = useState(0);
  const [received, setReceived] = useState(0);
  const lastPulse = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const resync = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  useEffect(
    () => () => {
      if (resync.current) clearTimeout(resync.current);
    },
    [],
  );
  const onClick = useCallback(
    (c: LiveClick) => {
      if (c.link_id !== id) return;
      applyLiveClick(qc, id, c);
      if (c.humans > 0) {
        setRecent((r) => [
          ...r.filter((x) => Date.now() - x.t < 60_000),
          { t: Date.now(), n: c.humans },
        ]);
        setReceived((n) => n + c.humans);
        if (Date.now() - lastPulse.current >= 2_000) {
          lastPulse.current = Date.now();
          setPulse((p) => p + 1);
        }
        setNow(Date.now());
      }
      // Depois de uma rajada, relê série e dimensões (os bots e prévias vêm separados de lá).
      if (resync.current) clearTimeout(resync.current);
      resync.current = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: [...statsKey(id), 'series'] });
        void qc.invalidateQueries({ queryKey: [...statsKey(id), 'dim'] });
      }, 4_000);
    },
    [id, qc],
  );
  const onReady = useCallback(() => {
    void qc.invalidateQueries({ queryKey: [...statsKey(id), 'summary'] });
  }, [id, qc]);
  const live = useLive(id, { onClick, onReady });
  const lastMinute = recent.filter((x) => now - x.t < 60_000).reduce((a, x) => a + x.n, 0);

  // ---------------------------------------------------------------- edição
  const reloadLink = async () => {
    api.forget(`/v1/links/${id}`);
    const r = await linkQ.refetch();
    return r.data?.link;
  };

  const save = async (patch: LinkPatch, etag: string | null) => {
    const r = await api.patch<LinkT>(`/v1/links/${id}`, patch, {
      headers: etag ? { 'if-match': etag } : {},
    });
    qc.setQueryData(['link', id], { link: r.data, etag: r.etag });
    api.forget('/v1/links');
    void qc.invalidateQueries({ queryKey: ['links'] });
    toast.success('Regras salvas.');
  };

  const toggleStatus = async () => {
    if (!link) return;
    try {
      await save(
        { status: link.status === 'disabled' ? 'active' : 'disabled' },
        linkQ.data?.etag ?? null,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        toast.error('Alguém editou este link em outra aba. Recarregamos a versão atual.');
        await reloadLink();
      } else toast.error(err instanceof ApiError ? err.message : 'Não deu certo.');
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.del(`/v1/links/${id}`, {
        headers: linkQ.data?.etag ? { 'if-match': linkQ.data.etag } : {},
      });
      toast.success(`Link ${link?.slug ?? ''} apagado.`);
      api.forget('/v1/links');
      void qc.invalidateQueries({ queryKey: ['links'] });
      await navigate({ to: '/app', search: {} });
    } catch (err) {
      setDeleting(false);
      if (err instanceof ApiError && err.status === 412) {
        setConfirmDelete(false);
        toast.error(
          'Alguém editou este link em outra aba. Confira a versão atual antes de apagar.',
        );
        await reloadLink();
      } else toast.error(err instanceof ApiError ? err.message : 'Não deu certo.');
    }
  };

  if (linkQ.isError) {
    const err = linkQ.error as ApiError;
    return (
      <div className="tela-conteudo">
        {/* Só 404 e 410 dizem que o link não existe; 429, 5xx e falta de rede não (break-ui). */}
        <h1 className="titulo-tela">
          {err.status === 410
            ? 'Este link foi apagado'
            : err.status === 404
              ? 'Link não encontrado'
              : 'Não deu para abrir este link'}
        </h1>
        <ErrorBlock
          message={
            err.status === 404 || err.status === 410
              ? 'Ele não está mais na sua conta.'
              : err.message
          }
          {...(err.status >= 500 || err.status === 0 || err.status === 429
            ? { onRetry: () => void linkQ.refetch() }
            : {})}
        />
        <Link to="/app" className="btn btn-secundario">
          Voltar para os links
        </Link>
      </div>
    );
  }

  const chips = link ? ruleChips(link) : [];
  const setPeriod = (p: Period, custom?: { from: string; to: string }) =>
    void navigate({
      search: (prev) => ({
        ...prev,
        period: p === '30d' ? undefined : p,
        from: p === 'custom' ? (custom?.from ?? days.from) : undefined,
        to: p === 'custom' ? (custom?.to ?? days.to) : undefined,
      }),
      replace: true,
    });

  const rangeLabel = rangeText(days.from, days.to);
  const points = series.data?.points ?? [];
  const showUniques = Boolean(series.data?.uniques_available);

  return (
    <div className="tela-conteudo pagina-link">
      <nav aria-label="Trilha" className="trilha rotulo">
        <Link to="/app" className="link-texto">
          Links
        </Link>{' '}
        / <span className="suave">{link?.slug ?? '…'}</span>
      </nav>

      <header className="link-cabeca">
        <div className="link-identidade">
          {link ? (
            <ShortLink url={link.short_url} as="h1" className="link-titulo" />
          ) : (
            <h1 className="link-titulo">
              <Skeleton width="14ch" height={24} />
            </h1>
          )}
          <p className="link-destino suave">
            {link ? (
              <>
                →{' '}
                <a
                  href={link.destination}
                  target="_blank"
                  rel="noreferrer"
                  className="sublinhado"
                  title={link.destination}
                >
                  {hostOf(link.destination)}
                </a>
                {link.title && <span> · {link.title}</span>}
              </>
            ) : (
              <Skeleton width="20ch" />
            )}
          </p>
          {link && (
            <div className="link-acoes">
              <CopyButton text={link.short_url} />
              <button type="button" className="btn btn-secundario" onClick={() => setQr(true)}>
                <IconQr /> QR
              </button>
              <button
                type="button"
                className="btn btn-secundario"
                onClick={() => {
                  setEditSeq((n) => n + 1);
                  setEditing(true);
                }}
              >
                <IconEdit /> Editar regras
              </button>
              <Menu.Root>
                <Menu.Trigger className="btn btn-fantasma btn-icone" aria-label="Mais ações">
                  <IconMore />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner className="camada-pop" sideOffset={4} align="end">
                    <Menu.Popup className="flutuante popup menu">
                      <Menu.Item className="menu-item" onClick={() => void toggleStatus()}>
                        {link.status === 'disabled' ? 'Ativar o link' : 'Desativar o link'}
                      </Menu.Item>
                      <div className="menu-sep" role="separator" />
                      <Menu.Item
                        className="menu-item menu-item-perigo"
                        onClick={() => setConfirmDelete(true)}
                      >
                        Apagar o link
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            </div>
          )}
        </div>
        <LiveCounter
          today={todaySummary.data?.humans}
          lastMinute={lastMinute}
          pulse={pulse}
          received={received}
          state={live.state}
          pausedAt={live.pausedAt}
          onResume={live.resume}
        />
      </header>

      {link && (
        <section className="regras-linha" aria-label="Regras do link">
          {chips.length ? (
            <RuleChips chips={chips} />
          ) : (
            <p className="suave">Sem regras: todo clique vai para o destino.</p>
          )}
          {link.status === 'disabled' && (
            <p className="rotulo suave">
              Desativado: quem abrir o link vê a página de link não encontrado.
            </p>
          )}
        </section>
      )}

      <div className="periodo-linha">
        <PeriodPicker value={period} from={days.from} to={days.to} onChange={setPeriod} />
        <p className="rotulo suave periodo-texto">
          {rangeLabel} · série {GRANULARITY_LABEL[resolved.granularity]}
          {resolved.series.tz !== 'UTC' ? ' no seu fuso' : ' (dias UTC)'}. Totais e listas contam
          dias UTC inteiros.
          {summary.isFetching && summary.data
            ? ' Atualizando…'
            : summary.dataUpdatedAt
              ? ` Atualizado às ${timeOnly(new Date(summary.dataUpdatedAt))}.`
              : ''}
        </p>
      </div>

      {summary.isError && !summary.data ? (
        <ErrorBlock
          message="Não deu para carregar os totais do período."
          onRetry={() => void summary.refetch()}
        />
      ) : (
        <>
          <Numbers summary={summary.data} loading={!summary.data} />
          <div className="folha">
            <HonestRuler
              humans={summary.data?.humans ?? 0}
              bots={summary.data?.bots ?? 0}
              previews={summary.data?.previews ?? 0}
              previewApps={summary.data?.preview_apps ?? []}
              loading={!summary.data}
            />
          </div>
        </>
      )}

      <div className="grade-serie">
        <section className="folha serie-folha" aria-labelledby="t-serie">
          <div className="folha-cabeca">
            <h2 id="t-serie" className="folha-titulo">
              Cliques humanos {GRANULARITY_LABEL[resolved.granularity]}
            </h2>
            <button
              type="button"
              className="btn btn-fantasma btn-pequeno"
              aria-pressed={showTable}
              onClick={() => setShowTable((s) => !s)}
            >
              {showTable ? 'Ver gráfico' : 'Ver tabela'}
            </button>
          </div>
          <div className="serie-legenda rotulo">
            <span>
              <i className="amostra amostra-humanos" aria-hidden="true" /> Humanos
            </span>
            {showUniques ? (
              <span>
                <i className="amostra amostra-unicos" aria-hidden="true" /> Únicos do dia
              </span>
            ) : (
              <span className="apagada">Únicos só existem por dia: aparecem na série diária.</span>
            )}
          </div>
          {series.isError && !series.data ? (
            <ErrorBlock
              message="Não deu para carregar a série."
              onRetry={() => void series.refetch()}
            />
          ) : !series.data ? (
            <div className="serie-carregando" aria-hidden="true" />
          ) : (
            <>
              <p className="sr-only">{seriesSummary(points, resolved.granularity, rangeLabel)}</p>
              {showTable ? (
                <SeriesTable
                  points={points}
                  granularity={resolved.granularity}
                  showUniques={showUniques}
                />
              ) : (
                <SeriesChart
                  points={points}
                  granularity={resolved.granularity}
                  showUniques={showUniques}
                />
              )}
              {series.data.totals.humans === 0 && (
                <p className="suave serie-vazia">
                  {endSentence(`Nenhum clique humano ${rangeLabel}`)}
                </p>
              )}
            </>
          )}
        </section>

        <DimensionSheet
          id={id}
          path="countries"
          dim="country"
          title="Países"
          days={days}
          limit={100}
          showCode
        >
          {(data) => (
            <>
              <CountryMap data={data} />
              {data.items.every((i) => i.value === '(desconhecido)') && data.total > 0 && (
                <p className="rotulo suave">Sem dados de país neste ambiente.</p>
              )}
              <DbipCredit />
            </>
          )}
        </DimensionSheet>
      </div>

      <div className="grade-dims">
        {DIMS.map((d) => (
          <DimensionSheet
            key={d.path}
            id={id}
            path={d.path}
            dim={d.dim}
            title={d.title}
            days={days}
          />
        ))}
      </div>

      {link && (
        <>
          <EditLinkDialog
            key={`${link.updated_at}-${editSeq}`}
            link={link}
            etag={linkQ.data?.etag ?? null}
            open={editing}
            onOpenChange={(o) => {
              setEditing(o);
              if (!o && window.location.hash)
                history.replaceState(null, '', window.location.pathname + window.location.search);
            }}
            onSave={save}
            onReload={reloadLink}
          />
          <QrDialog url={link.short_url} slug={link.slug} open={qr} onOpenChange={setQr} />
          <Confirm
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Apagar ${link.slug}?`}
            description={
              <p>
                O link curto para de abrir na hora e o nome{' '}
                <span className="mono">{link.slug}</span> nunca mais é usado. Quem tiver o link
                impresso vai ver "não encontrado".
              </p>
            }
            confirmLabel={deleting ? 'Apagando…' : 'Apagar link'}
            busy={deleting}
            onConfirm={() => void remove()}
          />
        </>
      )}
    </div>
  );
}
