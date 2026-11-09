function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return rawKey;
  }
}

const keyOf = (part: string): string => {
  const eq = part.indexOf('=');
  return decodeKey(eq === -1 ? part : part.slice(0, eq));
};

/**
 * Anexa a query string de entrada ao destino (ADR 0002, passo 9). Se a chave já existe no destino,
 * vale a do destino: UTMs do dono não são sobrescritas por quem compartilha o link. A query do
 * destino fica byte a byte como estava; os parâmetros de entrada mantêm a ordem, as repetições e a
 * codificação originais. O fragmento (#...) do destino continua no fim.
 *
 * Chaves são comparadas depois de decodificar (`utm_source` = `utm%5Fsource`), como faria o
 * servidor de destino.
 */
export function mergeQuery(destination: string, incomingSearch: string): string {
  const incoming = incomingSearch.startsWith('?') ? incomingSearch.slice(1) : incomingSearch;
  if (incoming === '') return destination;

  const hashAt = destination.indexOf('#');
  const base = hashAt === -1 ? destination : destination.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : destination.slice(hashAt);
  const queryAt = base.indexOf('?');
  const ownQuery = queryAt === -1 ? '' : base.slice(queryAt + 1);

  const ownKeys = new Set(
    ownQuery
      .split('&')
      .filter((p) => p !== '')
      .map(keyOf),
  );
  const extra = incoming
    .split('&')
    .filter((p) => p !== '' && !ownKeys.has(keyOf(p)))
    // "#" cru encerraria a query e viraria fragmento.
    .map((p) => p.replace(/#/g, '%23'));
  if (extra.length === 0) return destination;

  let joined: string;
  if (queryAt === -1) joined = `${base}?`;
  else if (ownQuery === '' || ownQuery.endsWith('&')) joined = base;
  else joined = `${base}&`;
  return joined + extra.join('&') + hash;
}
