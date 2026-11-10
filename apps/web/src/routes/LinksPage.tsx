import { Menu } from '@base-ui/react/menu';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CreateLink } from '../components/CreateLink';
import { IconMore, IconSearch } from '../components/Icons';
import { QrDialog } from '../components/Qr';
import { Confirm, CopyButton, ErrorBlock, RuleChips, ShortLink } from '../components/ui';
import { ApiError } from '../lib/api/problem';
import type { LinkListItem, LinkPage } from '../lib/api/types';
import { dateShort, middleTruncate, num, prettyUrl, timeOnly } from '../lib/format';
import { useDebounced, useDocumentTitle } from '../lib/hooks';
import { ruleChips } from '../lib/rules';
import { api } from '../lib/session';
import { pageTitle } from '../title';
import { linksQuery, type LinksSearch } from './links-search';

const route = getRouteApi('/app/');

const STATUS: { value: LinksSearch['status']; label: string }[] = [
  { value: undefined, label: 'Todos' },
  { value: 'active', label: 'Ativos' },
  { value: 'disabled', label: 'Desativados' },
  { value: 'expired', label: 'Expirados' },
];

const SORTS = [
  { value: 'created_at:desc', label: 'Mais recentes' },
  { value: 'created_at:asc', label: 'Mais antigos' },
  { value: 'clicks:desc', label: 'Mais cliques' },
  { value: 'clicks:asc', label: 'Menos cliques' },
  { value: 'title:asc', label: 'Título (A–Z)' },
  { value: 'title:desc', label: 'Título (Z–A)' },
];

function useLinks(search: LinksSearch) {
  const query = linksQuery(search);
  return useInfiniteQuery({
    queryKey: ['links', query],
    queryFn: ({ pageParam, signal }) =>
      api.get<LinkPage>('/v1/links', {
        query: { ...query, cursor: pageParam ?? undefined },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.has_more ? last.next_cursor : null),
    placeholderData: (prev) => prev,
  });
}

function Filters({ search }: { search: LinksSearch }) {
  const navigate = useNavigate({ from: '/app/' });
  const ids = { busca: useId(), senha: useId(), ordem: useId(), de: useId(), ate: useId() };
  const [q, setQ] = useState(search.q ?? '');
  const debounced = useDebounced(q, 300);
  const set = (patch: Partial<LinksSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  useEffect(() => {
    const next = debounced.trim() || undefined;
    if (next !== search.q) void set({ q: next });
    // Só reage ao texto digitado; a URL é a fonte da verdade do resto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const sortValue = `${search.sort ?? 'created_at'}:${search.order ?? (search.sort === 'title' ? 'asc' : 'desc')}`;

  return (
    <div className="filtros">
      <div className="filtros-linha">
        <div className="busca">
          <label htmlFor={ids.busca} className="sr-only">
            Buscar nos títulos, slugs e destinos
          </label>
          <IconSearch />
          <input
            id={ids.busca}
            className="campo busca-campo"
            type="search"
            placeholder="Buscar por título, slug ou destino"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="segmentos" role="group" aria-label="Status">
          {STATUS.map((s) => (
            <button
              key={s.label}
              type="button"
              className="segmento"
              aria-pressed={search.status === s.value}
              onClick={() => void set({ status: s.value })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="filtros-linha filtros-mais">
        <div className="campo-grupo">
          <label className="campo-rotulo" htmlFor={ids.senha}>
            Senha
          </label>
          <select
            id={ids.senha}
            className="campo"
            value={search.senha ?? ''}
            onChange={(e) =>
              void set({ senha: (e.target.value || undefined) as LinksSearch['senha'] })
            }
          >
            <option value="">Com ou sem</option>
            <option value="com">Com senha</option>
            <option value="sem">Sem senha</option>
          </select>
        </div>
        <div className="campo-grupo">
          <label className="campo-rotulo" htmlFor={ids.de}>
            Criado de
          </label>
          <input
            id={ids.de}
            className="campo"
            type="date"
            value={search.de ?? ''}
            max={search.ate}
            onChange={(e) => void set({ de: e.target.value || undefined })}
          />
        </div>
        <div className="campo-grupo">
          <label className="campo-rotulo" htmlFor={ids.ate}>
            até
          </label>
          <input
            id={ids.ate}
            className="campo"
            type="date"
            value={search.ate ?? ''}
            min={search.de}
            onChange={(e) => void set({ ate: e.target.value || undefined })}
          />
        </div>
        <div className="campo-grupo">
          <label className="campo-rotulo" htmlFor={ids.ordem}>
            Ordenar por
          </label>
          <select
            id={ids.ordem}
            className="campo"
            value={sortValue}
            onChange={(e) => {
              const [sort, order] = e.target.value.split(':') as [
                NonNullable<LinksSearch['sort']>,
                NonNullable<LinksSearch['order']>,
              ];
              void set({
                sort: sort === 'created_at' ? undefined : sort,
                order: order === (sort === 'title' ? 'asc' : 'desc') ? undefined : order,
              });
            }}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function RowActions({ link }: { link: LinkListItem }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [qr, setQr] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    api.forget('/v1/links');
    return qc.invalidateQueries({ queryKey: ['links'] });
  };
  const toggle = async () => {
    const next = link.status === 'disabled' ? 'active' : 'disabled';
    try {
      await api.patch(`/v1/links/${link.id}`, { status: next });
      toast.success(next === 'disabled' ? 'Link desativado.' : 'Link ativado.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não deu certo.');
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/v1/links/${link.id}`);
      setConfirm(false);
      toast.success(`Link ${link.slug} apagado.`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não deu certo.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="linha-acoes" onClick={(e) => e.stopPropagation()}>
      <CopyButton text={link.short_url} variant="secundario" small />
      <Menu.Root>
        <Menu.Trigger
          className="btn btn-fantasma btn-icone btn-pequeno"
          aria-label={`Mais ações para ${link.slug}`}
        >
          <IconMore />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="camada-pop" sideOffset={4} align="end">
            <Menu.Popup className="flutuante popup menu">
              <Menu.Item
                className="menu-item"
                onClick={() =>
                  void navigate({ to: '/app/links/$id', params: { id: String(link.id) } })
                }
              >
                Ver cliques
              </Menu.Item>
              <Menu.Item
                className="menu-item"
                onClick={() =>
                  void navigate({
                    to: '/app/links/$id',
                    params: { id: String(link.id) },
                    hash: 'editar',
                  })
                }
              >
                Editar regras
              </Menu.Item>
              <Menu.Item className="menu-item" onClick={() => setQr(true)}>
                QR code
              </Menu.Item>
              <Menu.Item className="menu-item" onClick={() => void toggle()}>
                {link.status === 'disabled' ? 'Ativar' : 'Desativar'}
              </Menu.Item>
              <div className="menu-sep" role="separator" />
              <Menu.Item className="menu-item menu-item-perigo" onClick={() => setConfirm(true)}>
                Apagar
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <QrDialog url={link.short_url} slug={link.slug} open={qr} onOpenChange={setQr} />
      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title={`Apagar ${link.slug}?`}
        description={
          <p>
            O link curto para de abrir na hora e o nome <span className="mono">{link.slug}</span>{' '}
            nunca mais é usado. Os cliques já contados somem do painel.
          </p>
        }
        confirmLabel={busy ? 'Apagando…' : 'Apagar link'}
        busy={busy}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function Row({ link }: { link: LinkListItem }) {
  const navigate = useNavigate();
  const chips = ruleChips(link);
  const disabled = link.status !== 'active' || link.is_expired;
  return (
    <tr
      className={clsx('linha', disabled && 'linha-inativa')}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button,[role="menu"]')) return;
        void navigate({ to: '/app/links/$id', params: { id: String(link.id) } });
      }}
    >
      <td className="col-link">
        <Link to="/app/links/$id" params={{ id: String(link.id) }} className="linha-curto">
          <ShortLink url={link.short_url} />
        </Link>
        <span className="linha-titulo suave" title={link.title ?? prettyUrl(link.destination)}>
          {link.title ?? prettyUrl(link.destination)}
        </span>
      </td>
      <td className="col-destino">
        <span className="destino" title={prettyUrl(link.destination)}>
          {middleTruncate(prettyUrl(link.destination), 34)}
        </span>
      </td>
      <td className="col-regras">
        {chips.length > 0 ? (
          <RuleChips chips={chips} max={3} />
        ) : (
          <span className="apagada">—</span>
        )}
      </td>
      <td className="col-num num">
        {num(link.click_count)}
        {/* Só no celular, onde a coluna perde o cabeçalho. */}
        <span className="col-num-unidade" aria-hidden="true">
          {link.click_count === 1 ? ' humano' : ' humanos'}
        </span>
      </td>
      <td className="col-data suave">{dateShort(link.created_at)}</td>
      <td className="col-acoes">
        <RowActions link={link} />
      </td>
    </tr>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }, (_, i) => (
        <tr key={i} className="linha" aria-hidden="true">
          <td className="col-link">
            <span className="esqueleto" style={{ width: 160 }} />
            <span className="esqueleto linha-titulo" style={{ width: 220, height: 12 }} />
          </td>
          <td className="col-destino">
            <span className="esqueleto" style={{ width: 180 }} />
          </td>
          <td className="col-regras">
            <span className="esqueleto" style={{ width: 80, height: 22 }} />
          </td>
          <td className="col-num">
            <span className="esqueleto" style={{ width: 40 }} />
          </td>
          <td className="col-data">
            <span className="esqueleto" style={{ width: 48 }} />
          </td>
          <td className="col-acoes" />
        </tr>
      ))}
    </>
  );
}

export function LinksPage() {
  useDocumentTitle(pageTitle('Links'));
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/app/' });
  const links = useLinks(search);
  const overview = useQuery({
    queryKey: ['overview', 'count'],
    queryFn: () => api.get<{ links_total: number }>('/v1/overview', { query: { limit: 1 } }),
  });
  const sentinel = useRef<HTMLDivElement>(null);
  const filtered = Boolean(search.q || search.status || search.senha || search.de || search.ate);
  const items = links.data?.pages.flatMap((p) => p.data) ?? [];

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = links;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const total = overview.data?.links_total;

  return (
    <div className="tela-conteudo">
      <header className="tela-cabeca">
        <h1 className="titulo-tela">
          Links{' '}
          {total !== undefined && (
            <span className="titulo-contagem suave">
              {num(total)} {total === 1 ? 'link' : 'links'}
            </span>
          )}
        </h1>
      </header>

      <CreateLink />

      <section className="folha lista" aria-labelledby="t-lista">
        <h2 id="t-lista" className="sr-only">
          Seus links
        </h2>
        <Filters key={search.q ?? ''} search={search} />
        {/* Busca nova que falhou mostra o erro, não a lista da busca anterior (placeholder). */}
        {links.isError && (!links.data || links.isPlaceholderData) ? (
          <ErrorBlock
            message={`Não deu para carregar os links. ${(links.error as ApiError).message}`}
            onRetry={() => void links.refetch()}
          />
        ) : !links.isPending && items.length === 0 ? (
          <div className="lista-vazia">
            {filtered ? (
              <>
                <p>
                  {search.q
                    ? `Nenhum link com "${search.q}" nos títulos, slugs ou destinos.`
                    : 'Nenhum link com esses filtros.'}
                </p>
                <button
                  type="button"
                  className="btn btn-secundario"
                  onClick={() => void navigate({ search: {}, replace: true })}
                >
                  Limpar busca
                </button>
              </>
            ) : (
              <>
                <p>
                  Você ainda não criou nenhum link. Cole um endereço aqui em cima: o link curto sai
                  na hora, e os cliques de gente aparecem nesta lista.
                </p>
                <button
                  type="button"
                  className="btn btn-primario"
                  onClick={() =>
                    document.querySelector<HTMLInputElement>('#novo-link input')?.focus()
                  }
                >
                  Criar o primeiro link
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="tabela-quadro" tabIndex={0} role="region" aria-label="Tabela de links">
            <table className="tabela" aria-busy={links.isFetching || undefined}>
              <thead>
                <tr>
                  <th scope="col">Link</th>
                  <th scope="col" className="col-destino">
                    Destino
                  </th>
                  <th scope="col" className="col-regras">
                    Regras
                  </th>
                  <th scope="col" className="col-num">
                    Humanos (total)
                  </th>
                  <th scope="col" className="col-data">
                    Criado
                  </th>
                  <th scope="col" className="col-acoes">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {links.isPending ? <SkeletonRows /> : items.map((l) => <Row key={l.id} link={l} />)}
              </tbody>
            </table>
          </div>
        )}
        <div ref={sentinel} className="lista-pe">
          {hasNextPage && (
            <button
              type="button"
              className="btn btn-secundario"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
            </button>
          )}
          {!hasNextPage && items.length > 0 && !links.isError && (
            <p className="rotulo apagada">
              {items.length === 1 ? '1 link' : `${num(items.length)} links`}
              {filtered ? ' com esses filtros' : ''}. Fim da lista.
            </p>
          )}
          {/* A página seguinte falhou: a lista carregada fica, e o pé oferece tentar de novo. */}
          {links.isFetchNextPageError && (
            <ErrorBlock
              message={`Não deu para carregar mais links. ${(links.error as ApiError).message}`}
              onRetry={() => void fetchNextPage()}
            />
          )}
          {/* A atualização em segundo plano falhou (sem rede, por exemplo): mostra o que já tinha. */}
          {links.isRefetchError && !links.isPlaceholderData && (
            <ErrorBlock
              message={`Não deu para atualizar a lista; estes são os links carregados às ${timeOnly(new Date(links.dataUpdatedAt))}. ${(links.error as ApiError).message}`}
              onRetry={() => void links.refetch()}
            />
          )}
        </div>
      </section>
    </div>
  );
}
