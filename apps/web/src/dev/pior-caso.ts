/**
 * break-ui (fase 8): o painel "Demo data / Worst case", **só em `vite dev`**.
 *
 * `main.tsx` importa este módulo dentro de `if (import.meta.env.MODE === 'development')`. No
 * `vite build` a condição vira `false`, o import some e este arquivo nem entra no dist (conferido com
 * grep no build e pelo e2e, que roda contra o build).
 *
 * O pior caso entra pela mesma fronteira que os dados de verdade: um `fetch` embrulhado troca o
 * corpo JSON das respostas da API (lista, link, estatísticas, chaves). Nada no componente muda.
 * Os valores respeitam os limites da API (título 500, alias 64, destino 4.096, nome da chave 100,
 * até 50 regras de país) e são coisas que alguém de verdade cola.
 *
 * Estados: Demo (sem troca), Pior caso, Vazio, Um. A escolha fica na URL (`?dados=pior`) e no
 * sessionStorage, então sobrevive ao reload e à navegação do router.
 */
import type {
  ApiKey,
  Link,
  LinkListItem,
  LinkPage,
  Summary,
  Timeseries,
  TopDimension,
} from '../lib/api/types';

export type Modo = 'demo' | 'pior' | 'vazio' | 'um';
const MODOS: { modo: Modo; rotulo: string }[] = [
  { modo: 'demo', rotulo: 'Demo data' },
  { modo: 'pior', rotulo: 'Worst case' },
  { modo: 'vazio', rotulo: 'Vazio' },
  { modo: 'um', rotulo: 'Um' },
];
const CHAVE = 'pulo-dados';

function lerModo(): Modo {
  const daUrl = new URLSearchParams(window.location.search).get('dados');
  const valido = (v: string | null): v is Modo => MODOS.some((m) => m.modo === v);
  if (valido(daUrl)) {
    try {
      sessionStorage.setItem(CHAVE, daUrl);
    } catch {
      /* sem storage: vale a URL */
    }
    return daUrl;
  }
  try {
    const v = sessionStorage.getItem(CHAVE);
    return valido(v) ? v : 'demo';
  } catch {
    return 'demo';
  }
}

// ------------------------------------------------------------------ valores

/** URL de 2.000 caracteres: rastreio de anúncio com UTMs, gclid e um `redirect` codificado. */
export const URL_2000 = (() => {
  const base =
    'https://www.lojaexemplo.com.br/colecao/black-friday-2026/tenis-de-corrida-masculino-amortecimento-maximo?utm_source=instagram&utm_medium=stories&utm_campaign=bf26-lancamento-colecao-verao&utm_content=criativo-07-video-vertical&utm_term=tenis%20corrida&gclid=';
  const gclid = 'Cj0KCQiA4NWrBhD-ARIsAFCKwWt8sZq3vYpL0mXc9eR2fTgHjK1lN4oP6uQ7wS8xV0yA3bC5dE';
  let s =
    base +
    gclid +
    '&redirect=' +
    encodeURIComponent('https://checkout.lojaexemplo.com.br/carrinho?itens=');
  let i = 0;
  while (s.length < 2000) s += `sku-${String(48213 + i++).padStart(6, '0')}%2C`;
  return s.slice(0, 2000);
})();

/** Título no limite da API (500): briefing colado inteiro no campo de título. */
export const TITULO_500 = (
  'Campanha Black Friday 2026 — coleção de verão, tênis de corrida e acessórios: link da bio do Instagram, ' +
  'stories patrocinados de quinta a domingo, criativo 07 (vídeo vertical de 15 s), público lookalike de ' +
  'compradores dos últimos 180 dias, exclusão de quem comprou na semana, verba dividida entre SP, RJ e MG, ' +
  'aprovado pelo jurídico em 03/11 com a ressalva do frete grátis só para o Sudeste; revisar o cupom ' +
  'BF26VERAO antes de subir, e lembrar a equipe de atendimento sobre a troca em 30 dias'
).slice(0, 500);

const TITULO_EMOJI = '🎉🔥 Liquidação 東京店 · متجر القاهرة · Магазин у дома 🇧🇷👩🏽‍💻';
const TITULO_VIET = 'Đặng Thị Ngọc Hân — Ưu đãi cuối tuần cho khách hàng thân thiết';
const ALIAS_64 = 'black-friday-2026-colecao-verao-tenis-corrida-bio-instagram-sp1';

const PAISES_50 = (
  'BR AR UY PY CL BO PE EC CO VE MX US CA PT ES FR DE IT GB IE NL BE LU CH AT ' +
  'PL CZ SK HU RO BG GR TR JP KR CN TW HK SG MY TH VN PH ID IN ZA NG KE EG MA'
).split(' ');

function piorLink<T extends Link>(l: T, i: number): T {
  const variantes: Partial<LinkListItem>[] = [
    {
      destination: URL_2000,
      title: TITULO_500,
      click_count: 5_000_000,
      max_clicks: 1_000_000_000,
      has_password: true,
      expires_at: new Date(Date.now() + 36 * 3_600_000).toISOString(),
      rules: {
        geo: [{ countries: PAISES_50, url: URL_2000 }],
        device: [
          { match: 'ios', url: 'https://apps.apple.com/br/app/loja-exemplo/id1234567890' },
          {
            match: 'android',
            url: 'https://play.google.com/store/apps/details?id=br.com.lojaexemplo',
          },
          { match: 'tablet', url: URL_2000 },
        ],
      },
    },
    { destination: 'https://a.co', title: null, click_count: 0 },
    {
      // Como a API guarda: host em punycode e caminho percent-encoded (parser WHATWG).
      destination: new URL('https://ação.example.com.br/promoção/日本語').href,
      title: TITULO_EMOJI,
      click_count: 1,
    },
    {
      slug: ALIAS_64,
      short_url: `${new URL(l.short_url).origin}/${ALIAS_64}`,
      title: TITULO_VIET,
      click_count: 1_284,
      status: 'disabled',
    },
    {
      title: 'Benachrichtigungseinstellungen-Kampagnenübersicht',
      click_count: 999_999_999,
      is_expired: true,
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ];
  return { ...l, ...(variantes[i % variantes.length] as Partial<T>) };
}

/** No formato da API: `<país>/<cidade>`. */
const CIDADES = [
  'BR/Santa Rita do Passa Quatro',
  'BR/São José dos Campos',
  'JP/東京',
  'EG/القاهرة',
  'GB/Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch',
  'VN/Thành phố Hồ Chí Minh',
  'BR/(desconhecido)',
  '(desconhecido)',
  'BR/Rio de Janeiro',
  'PL/Kraków',
  'CH/Zürich',
  'RU/Москва',
];
const REFERRERS = [
  'l.instagram.com',
  '(direto)',
  'news.department.region.example.co.uk',
  'app:com.google.android.gm',
  'web.whatsapp.com',
  'blog-de-receitas-veganas-faceis-para-o-dia-a-dia.com.br',
  't.co',
];
const NAVEGADORES = [
  'Chrome',
  'Facebook In-App Browser for Android',
  'Samsung Internet',
  'Safari',
  'Instagram',
];

function piorDim(d: TopDimension): TopDimension {
  const nomes =
    d.dimension === 'city'
      ? CIDADES
      : d.dimension === 'referrer'
        ? REFERRERS
        : d.dimension === 'browser'
          ? NAVEGADORES
          : d.dimension === 'country'
            ? [...PAISES_50, '(desconhecido)']
            : d.items.map((x) => x.value);
  if (nomes.length === 0) return d;
  const total = 5_000_000;
  let resto = total;
  const items = nomes.slice(0, d.dimension === 'country' ? 100 : 10).map((value, i) => {
    const n = i === nomes.length - 1 ? resto : Math.floor(resto * 0.42);
    resto -= n;
    return { value, n, share: n / total };
  });
  return { ...d, total, items, others: Math.max(0, resto) };
}

function piorSerie(t: Timeseries): Timeseries {
  const points = t.points.map((p, i) => {
    const humans = 120_000 + ((i * 7919) % 90_000);
    return {
      ...p,
      humans,
      total: humans + 40_000,
      bots: 30_000,
      previews: 10_000,
      uniques: p.uniques === null ? null : Math.round(humans * 0.83),
    };
  });
  const sum = (k: 'humans' | 'total' | 'bots' | 'previews') => points.reduce((a, p) => a + p[k], 0);
  return {
    ...t,
    points,
    totals: {
      ...t.totals,
      humans: sum('humans'),
      total: sum('total'),
      bots: sum('bots'),
      previews: sum('previews'),
    },
  };
}

/** Série zerada; com `n = 1`, um clique só, no último ponto (o mesmo "1" da faixa de números). */
function zeroSerie(t: Timeseries, n = 0): Timeseries {
  const last = t.points.length - 1;
  return {
    ...t,
    points: t.points.map((p, i) => {
      const v = i === last ? n : 0;
      return {
        ...p,
        humans: v,
        total: v,
        bots: 0,
        previews: 0,
        uniques: p.uniques === null ? null : v,
      };
    }),
    totals: { ...t.totals, humans: n, total: n, bots: 0, previews: 0, uniques: n },
  };
}

const piorChave = (k: ApiKey, i: number): ApiKey =>
  i === 0
    ? {
        ...k,
        name: 'Integração 🚀 Zapier → planilha de leads da campanha Black Friday 2026 (time de marketing SP)'.slice(
          0,
          100,
        ),
        scopes: ['links:read', 'links:write', 'stats:read'],
        last_used_at: null,
      }
    : i === 1
      ? { ...k, name: 'CI' }
      : { ...k, name: 'متجر القاهرة — 東京 sync' };

// ------------------------------------------------------------------ troca no fetch

type Json = Record<string, unknown>;

function trocar(modo: Modo, path: string, body: Json): Json {
  if (/^\/v1\/links$/.test(path) && Array.isArray(body.data)) {
    const page = body as unknown as LinkPage;
    if (modo === 'vazio') return { ...page, data: [], has_more: false, next_cursor: null };
    if (modo === 'um')
      return { ...page, data: page.data.slice(0, 1), has_more: false, next_cursor: null };
    return { ...page, data: page.data.map((l, i) => piorLink(l, i)) };
  }
  if (/^\/v1\/links\/\d+$/.test(path) && modo === 'pior')
    return piorLink(body as unknown as Link, 0) as unknown as Json;
  if (/^\/v1\/overview$/.test(path) && 'links_total' in body) {
    return { ...body, links_total: modo === 'vazio' ? 0 : modo === 'um' ? 1 : 1_284 };
  }
  if (/\/stats\/summary$/.test(path)) {
    const s = body as unknown as Summary;
    if (modo === 'pior') {
      return {
        ...s,
        humans: 5_000_000,
        total: 7_186_491,
        uniques: 4_312_908,
        unique_ratio: 0.86,
        bots: 1_284_377,
        previews: 902_114,
        preview_apps: [
          { app: 'whatsapp', n: 801_250 },
          { app: 'telegram', n: 60_002 },
          { app: 'linkedin', n: 40_862 },
        ],
        all_time_humans: 5_000_000,
      } satisfies Summary as unknown as Json;
    }
    const n = modo === 'um' ? 1 : 0;
    return {
      ...s,
      humans: n,
      total: n,
      uniques: n,
      unique_ratio: n ? 1 : null,
      bots: 0,
      previews: 0,
      preview_apps: [],
      all_time_humans: n,
    } satisfies Summary as unknown as Json;
  }
  if (/\/stats\/timeseries$/.test(path)) {
    const t = body as unknown as Timeseries;
    return (modo === 'pior'
      ? piorSerie(t)
      : zeroSerie(t, modo === 'um' ? 1 : 0)) as unknown as Json;
  }
  if (/\/stats\/[a-z]+$/.test(path) && Array.isArray(body.items)) {
    const d = body as unknown as TopDimension;
    if (modo === 'pior') return piorDim(d) as unknown as Json;
    if (modo === 'vazio') return { ...d, total: 0, items: [], others: 0 };
    return {
      ...d,
      total: 1,
      items: d.items.slice(0, 1).map((x) => ({ ...x, n: 1, share: 1 })),
      others: 0,
    };
  }
  if (/^\/v1\/api-keys$/.test(path) && Array.isArray(body.data)) {
    const keys = body.data as ApiKey[];
    if (modo === 'vazio') return { ...body, data: [] };
    if (modo === 'um') return { ...body, data: keys.slice(0, 1) };
    return { ...body, data: keys.map(piorChave) };
  }
  return body;
}

function instalarFetch(modo: Modo) {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.href,
    );
    if (method !== 'GET' || !url.pathname.startsWith('/api/') || res.status !== 200) return res;
    if (!res.headers.get('content-type')?.includes('json')) return res;
    const body = (await res.clone().json()) as Json;
    const novo = trocar(modo, url.pathname.slice(4), body);
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(novo), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}

// ------------------------------------------------------------------ o controle

function montarControle(atual: Modo) {
  const nav = document.createElement('div');
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'Dados de teste (só em dev)');
  nav.dataset.devPiorCaso = '';
  Object.assign(nav.style, {
    position: 'fixed',
    bottom: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '2147483647',
    display: 'flex',
    gap: '2px',
    padding: '3px',
    background: '#e5e5e5',
    borderRadius: '999px',
    font: '12px/1 system-ui, sans-serif',
    boxShadow: '0 1px 3px rgb(0 0 0 / 0.2)',
  });
  for (const { modo, rotulo } of MODOS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = rotulo;
    b.setAttribute('aria-pressed', String(modo === atual));
    Object.assign(b.style, {
      border: '0',
      borderRadius: '999px',
      padding: '6px 10px',
      cursor: 'pointer',
      color: '#111',
      background: modo === atual ? '#fff' : 'transparent',
      fontWeight: modo === atual ? '600' : '400',
    });
    b.addEventListener('click', () => {
      try {
        sessionStorage.setItem(CHAVE, modo);
      } catch {
        /* ignora */
      }
      const u = new URL(window.location.href);
      if (modo === 'demo') u.searchParams.delete('dados');
      else u.searchParams.set('dados', modo);
      window.location.replace(u.href);
    });
    nav.append(b);
  }
  document.body.append(nav);
}

export function instalarPiorCaso() {
  const modo = lerModo();
  if (modo !== 'demo') instalarFetch(modo);
  const montar = () => montarControle(modo);
  if (document.body) montar();
  else window.addEventListener('DOMContentLoaded', montar, { once: true });
}
