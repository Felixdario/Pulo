/** Filtros da lista de links na URL: dá para recarregar, voltar e mandar o link da busca. */
export interface LinksSearch {
  q?: string | undefined;
  status?: 'active' | 'disabled' | 'expired' | undefined;
  sort?: 'created_at' | 'clicks' | 'title' | undefined;
  order?: 'asc' | 'desc' | undefined;
  senha?: 'com' | 'sem' | undefined;
  de?: string | undefined;
  ate?: string | undefined;
}

const day = /^\d{4}-\d{2}-\d{2}$/;

export function parseLinksSearch(s: Record<string, unknown>): LinksSearch {
  const out: LinksSearch = {};
  if (typeof s.q === 'string' && s.q.trim() !== '') out.q = s.q.slice(0, 200);
  if (s.status === 'active' || s.status === 'disabled' || s.status === 'expired') {
    out.status = s.status;
  }
  if (s.sort === 'created_at' || s.sort === 'clicks' || s.sort === 'title') out.sort = s.sort;
  if (s.order === 'asc' || s.order === 'desc') out.order = s.order;
  if (s.senha === 'com' || s.senha === 'sem') out.senha = s.senha;
  if (typeof s.de === 'string' && day.test(s.de)) out.de = s.de;
  if (typeof s.ate === 'string' && day.test(s.ate)) out.ate = s.ate;
  return out;
}

/** Query de `GET /v1/links` a partir dos filtros da URL. */
export function linksQuery(s: LinksSearch) {
  return {
    q: s.q,
    status: s.status,
    sort: s.sort ?? 'created_at',
    order: s.order,
    has_password: s.senha === 'com' ? 'true' : s.senha === 'sem' ? 'false' : undefined,
    created_from: s.de,
    created_to: s.ate,
    limit: 25,
  };
}
