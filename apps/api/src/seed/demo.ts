/**
 * Seed demo (ADR 0004): `corepack pnpm seed:demo`. Idempotente: rodar de novo atualiza os mesmos 30
 * links (pelo slug, só se forem do usuário demo) e regenera os agregados só desses links. Nada de
 * outros usuários é lido para escrita nem apagado; a tabela bruta de cliques não é tocada.
 *
 * Cria `demo@encurta.dev` / `demo1234`, 30 links variados e uma chave de API (impressa uma vez, na
 * criação). Cliques sintéticos dos últimos 90 dias são gerados no SQL, coerentes entre si:
 * `clicks_daily` = soma do `clicks_hourly` por dia UTC, cada dimensão do `clicks_daily_dim` soma os
 * humanos do dia, `clicks_daily_preview` soma as prévias do dia e `links.click_count` = soma dos humanos.
 */
import { createHash } from 'node:crypto';
import {
  API_SCOPES,
  createDb,
  insertApiKey,
  listApiKeys,
  normalizeEmail,
  sql,
  type Database,
  type LinkRules,
} from '@encurtador/db';
import { BASE62, linkRulesSchema, validateDestination } from '@encurtador/shared';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { generateApiKey } from '../lib/crypto';

export const DEMO_EMAIL = 'demo@encurta.dev';
export const DEMO_PASSWORD = 'demo1234';
const KEY_NAME = 'Demo (seed)';
const SHORT_DOMAINS = ['encurta.dev'];

interface Spec {
  /** Alias, ou omitido para um slug "aleatório" estável (derivado do índice). */
  alias?: string;
  destination: string;
  title?: string | null;
  redirectType?: 301 | 302 | 307 | 308;
  status?: 'active' | 'disabled';
  /** Dias desde a criação. */
  age: number;
  /** Expiração em dias a partir de agora (negativo = já expirou). */
  expiresIn?: number;
  maxClicks?: number | 'exhausted';
  password?: string;
  forwardQuery?: boolean;
  rules?: LinkRules;
  /** Humanos por hora, em média, no pico. 0 = sem cliques. */
  rate: number;
}

const LONG_TITLE =
  'Guia completo e definitivo, revisado e ampliado, sobre como escolher, configurar, medir e otimizar ' +
  'links curtos em campanhas de marketing multicanal com UTMs, QR codes impressos, regras por país e ' +
  'por dispositivo, senhas, limites de cliques e expiração, sem perder nenhum clique pelo caminho — edição 2026';

const LONG_URL = (() => {
  const base =
    'https://www.example.com/campanhas/2026/black-friday/landing?utm_source=newsletter&utm_medium=email&ref=';
  return base + 'x'.repeat(2000 - base.length);
})();

export const SPECS: Spec[] = [
  {
    alias: 'demo-promo',
    destination: 'https://www.example.com/black-friday',
    title: 'Black Friday 2026',
    age: 95,
    rate: 6,
  },
  {
    alias: 'demo-blog',
    destination: 'https://blog.example.com/como-encurtar-links',
    title: 'Como encurtar links',
    redirectType: 301,
    age: 92,
    rate: 3,
  },
  {
    alias: 'demo-docs',
    destination: 'https://developer.mozilla.org/pt-BR/docs/Web/HTTP/Status/308',
    title: 'MDN: 308 Permanent Redirect',
    redirectType: 308,
    age: 88,
    rate: 1.5,
  },
  {
    alias: 'demo-senha',
    destination: 'https://www.example.com/area-restrita',
    title: 'Material exclusivo (senha: segredo)',
    password: 'segredo',
    age: 80,
    rate: 0.8,
  },
  {
    alias: 'demo-expirado',
    destination: 'https://www.example.com/cupom-outubro',
    title: 'Cupom de outubro (expirado)',
    age: 60,
    expiresIn: -10,
    rate: 2,
  },
  {
    alias: 'demo-desativado',
    destination: 'https://www.example.com/pausado',
    title: 'Campanha pausada',
    status: 'disabled',
    age: 70,
    rate: 1,
  },
  {
    alias: 'demo-esgotado',
    destination: 'https://www.example.com/ingresso-unico',
    title: 'Ingresso de uso limitado (esgotado)',
    maxClicks: 'exhausted',
    age: 30,
    rate: 0.8,
  },
  {
    alias: 'demo-limite',
    destination: 'https://www.example.com/beta',
    title: 'Beta com limite de 100 mil cliques',
    maxClicks: 100_000,
    age: 45,
    rate: 1,
  },
  {
    alias: 'demo-pais',
    destination: 'https://www.example.com/en',
    title: 'Loja internacional (regra por país)',
    rules: {
      geo: [
        { countries: ['BR', 'PT', 'AO', 'MZ'], url: 'https://www.example.com/pt' },
        { countries: ['ES', 'MX', 'AR'], url: 'https://www.example.com/es' },
      ],
    },
    age: 75,
    rate: 2,
  },
  {
    alias: 'demo-app',
    destination: 'https://www.example.com/app',
    title: 'Baixe o app (regra por dispositivo)',
    rules: {
      device: [
        { match: 'ios', url: 'https://apps.apple.com/br/app/id1234567890' },
        { match: 'android', url: 'https://play.google.com/store/apps/details?id=com.example.app' },
      ],
    },
    age: 66,
    rate: 2.5,
  },
  {
    alias: 'demo-titulo-longo',
    destination: 'https://www.example.com/guia',
    title: LONG_TITLE,
    age: 50,
    rate: 0.8,
  },
  {
    alias: 'demo-emoji',
    destination: 'https://www.example.com/lancamento',
    title: '🎉 Lançamento 🚀 — coleção de verão ☀️🏖️ com até 50% off 🔥',
    age: 20,
    rate: 1.2,
  },
  {
    alias: 'demo-url-2000',
    destination: LONG_URL,
    title: 'Destino com 2.000 caracteres',
    age: 40,
    rate: 0.8,
  },
  {
    alias: 'demo-zero',
    destination: 'https://www.example.com/ninguem-clicou',
    title: 'Ainda sem cliques',
    age: 15,
    rate: 0,
  },
  {
    alias: 'demo-utm',
    destination: 'https://www.example.com/?utm_source=demo&utm_campaign=fixa',
    title: 'UTMs fixas, sem repassar a query',
    forwardQuery: false,
    age: 35,
    rate: 1,
  },
  {
    alias: 'demo-webhook',
    destination: 'https://hooks.example.com/entrada',
    title: 'Webhook (307 preserva o POST)',
    redirectType: 307,
    age: 25,
    rate: 0.8,
  },
  {
    alias: 'demo-expira-breve',
    destination: 'https://www.example.com/flash-sale',
    title: 'Oferta relâmpago (expira em 3 dias)',
    expiresIn: 3,
    age: 10,
    rate: 1.5,
  },
  {
    alias: 'demo-novo',
    destination: 'https://www.example.com/novidade',
    title: 'Link novo',
    age: 2,
    rate: 4,
  },
  { destination: 'https://github.com/', title: 'GitHub', age: 90, rate: 1 },
  {
    destination: 'https://pt.wikipedia.org/wiki/Encurtador_de_URL',
    title: 'Encurtador de URL — Wikipédia',
    age: 85,
    rate: 0.7,
  },
  { destination: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: null, age: 82, rate: 2.2 },
  {
    destination: 'https://www.example.com/podcast/episodio-42',
    title: 'Podcast #42',
    redirectType: 308,
    age: 77,
    rate: 0.9,
  },
  {
    destination: 'https://www.example.com/webinar',
    title: 'Webinar (senha)',
    password: 'webinar',
    age: 63,
    rate: 0.6,
  },
  {
    destination: 'https://www.example.com/natal-2025',
    title: 'Natal 2025 (expirado)',
    expiresIn: -40,
    age: 91,
    rate: 1.8,
  },
  {
    destination: 'https://www.example.com/rascunho',
    title: 'Rascunho desativado',
    status: 'disabled',
    age: 12,
    rate: 0,
  },
  {
    destination: 'https://www.example.com/cardapio',
    title: 'Cardápio (QR code na mesa)',
    age: 58,
    rate: 3.5,
  },
  {
    destination: 'https://www.example.com/vagas',
    title: 'Vagas abertas',
    redirectType: 301,
    age: 47,
    rate: 0.8,
  },
  {
    destination: 'https://www.example.com/pesquisa',
    title: 'Pesquisa de satisfação',
    maxClicks: 500,
    age: 28,
    rate: 0.8,
  },
  {
    destination: 'https://www.example.com/evento?cidade=sp',
    title: 'Evento em São Paulo',
    age: 18,
    rate: 1.1,
  },
  { destination: 'https://www.example.com/ebook', title: 'E-book grátis', age: 5, rate: 2 },
];

/** Slug base62 de 7 caracteres, estável por índice: o mesmo em toda execução. */
export function stableSlug(index: number): string {
  const digest = createHash('sha256').update(`encurtador-demo:${index}`).digest();
  let s = '';
  for (let i = 0; s.length < 7; i++) s += BASE62[digest[i]! % 62];
  return s;
}

/** Distribuições das dimensões (pesos inteiros); cidades somam o mesmo que o país de cada uma. */
const DIST: [string, string, number][] = [
  ['country', 'BR', 50],
  ['country', 'PT', 12],
  ['country', 'US', 10],
  ['country', 'DE', 5],
  ['country', 'AO', 3],
  ['country', '(desconhecido)', 3],
  ['city', 'BR/São Paulo', 25],
  ['city', 'BR/Rio de Janeiro', 15],
  ['city', 'BR/Belo Horizonte', 10],
  ['city', 'PT/Lisboa', 8],
  ['city', 'PT/Porto', 4],
  ['city', 'US/New York', 6],
  ['city', 'US/San Francisco', 4],
  ['city', 'DE/Berlin', 5],
  ['city', 'AO/Luanda', 3],
  ['city', '(desconhecido)', 3],
  ['referrer', '(direto)', 35],
  ['referrer', 'instagram.com', 18],
  ['referrer', 'google.com', 15],
  ['referrer', 'news.ycombinator.com', 8],
  ['referrer', 'linkedin.com', 7],
  ['referrer', 'x.com', 6],
  ['referrer', 't.co', 4],
  ['referrer', 'android-app://com.google.android.gm', 3],
  ['browser', 'Chrome', 52],
  ['browser', 'Mobile Safari', 22],
  ['browser', 'Safari', 8],
  ['browser', 'Firefox', 7],
  ['browser', 'Edge', 6],
  ['browser', 'Samsung Internet', 5],
  ['os', 'Android', 38],
  ['os', 'iOS', 27],
  ['os', 'Windows', 20],
  ['os', 'Mac OS', 10],
  ['os', 'Linux', 5],
  ['device', 'mobile', 62],
  ['device', 'desktop', 34],
  ['device', 'tablet', 4],
];
const PREVIEW_DIST: [string, number][] = [
  ['whatsapp', 60],
  ['telegram', 15],
  ['slack', 15],
  ['other', 10],
];

const pgText = (values: readonly string[]) =>
  `{${values.map((v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(',')}}`;

async function ensureUser(db: Database): Promise<number> {
  const email = normalizeEmail(DEMO_EMAIL);
  const rows = (await db.execute(
    sql`SELECT id, password_hash FROM users WHERE lower(email) = ${email}`,
  )) as unknown as { id: string; password_hash: string }[];
  if (rows[0]) {
    const ok = await argon2Verify(rows[0].password_hash, DEMO_PASSWORD).catch(() => false);
    if (!ok) {
      await db.execute(
        sql`UPDATE users SET password_hash = ${await argon2Hash(DEMO_PASSWORD)} WHERE id = ${rows[0].id}`,
      );
    }
    return Number(rows[0].id);
  }
  const [created] = (await db.execute(sql`
    INSERT INTO users (email, password_hash) VALUES (${email}, ${await argon2Hash(DEMO_PASSWORD)})
    ON CONFLICT DO NOTHING RETURNING id`)) as unknown as { id: string }[];
  if (created) return Number(created.id);
  return ensureUser(db); // corrida com outra execução: agora existe
}

async function upsertLinks(db: Database, userId: number): Promise<{ id: number; spec: Spec }[]> {
  const out: { id: number; spec: Spec }[] = [];
  for (const [i, spec] of SPECS.entries()) {
    const v = validateDestination(spec.destination, { shortDomains: SHORT_DOMAINS });
    if (!v.ok) throw new Error(`destino inválido no seed (${i}): ${v.code}`);
    if (spec.rules) linkRulesSchema.parse(spec.rules);
    const slug = spec.alias ?? stableSlug(i);
    const passwordHash = spec.password ? await argon2Hash(spec.password) : null;
    const maxClicks = typeof spec.maxClicks === 'number' ? spec.maxClicks : null;
    const expiresAt =
      spec.expiresIn === undefined
        ? null
        : new Date(Date.now() + spec.expiresIn * 86_400_000).toISOString();
    const createdAt = new Date(Date.now() - spec.age * 86_400_000).toISOString();
    // ON CONFLICT só atualiza se o slug já é do demo; slug de outro usuário não volta no RETURNING.
    // A senha só é regravada se mudou de "com" para "sem" (o hash é aleatório a cada execução).
    const [row] = (await db.execute(sql`
      INSERT INTO links (user_id, slug, is_custom, destination, title, redirect_type, status,
                         expires_at, max_clicks, password_hash, forward_query, rules, created_at)
      VALUES (${userId}, ${slug}, ${spec.alias !== undefined}, ${v.url}, ${spec.title ?? null},
              ${spec.redirectType ?? 302}, ${spec.status ?? 'active'}, ${expiresAt}::timestamptz,
              ${maxClicks}::int, ${passwordHash}, ${spec.forwardQuery ?? true},
              ${JSON.stringify(spec.rules ?? {})}::jsonb, ${createdAt}::timestamptz)
      ON CONFLICT (slug) DO UPDATE SET
        destination = EXCLUDED.destination, title = EXCLUDED.title,
        redirect_type = EXCLUDED.redirect_type, status = EXCLUDED.status,
        expires_at = CASE WHEN links.expires_at IS NULL OR EXCLUDED.expires_at IS NULL
                          THEN EXCLUDED.expires_at ELSE links.expires_at END,
        max_clicks = EXCLUDED.max_clicks,
        password_hash = CASE WHEN EXCLUDED.password_hash IS NULL THEN NULL
                             ELSE coalesce(links.password_hash, EXCLUDED.password_hash) END,
        forward_query = EXCLUDED.forward_query, rules = EXCLUDED.rules, deleted_at = NULL,
        updated_at = CASE WHEN (links.destination, links.title, links.redirect_type, links.status,
                                links.max_clicks, links.forward_query, links.rules)
                               IS DISTINCT FROM
                               (EXCLUDED.destination, EXCLUDED.title, EXCLUDED.redirect_type,
                                EXCLUDED.status, EXCLUDED.max_clicks, EXCLUDED.forward_query,
                                EXCLUDED.rules)
                          THEN now() ELSE links.updated_at END
      WHERE links.user_id = EXCLUDED.user_id
      RETURNING id`)) as unknown as { id: string }[];
    if (!row) throw new Error(`o slug "${slug}" já pertence a outro usuário; o seed não mexe nele`);
    out.push({ id: Number(row.id), spec });
  }
  return out;
}

/** Regenera os agregados dos links demo (e só deles), numa transação. */
async function seedClicks(db: Database, linksSeeded: { id: number; spec: Spec }[]) {
  const ids = `{${linksSeeded.map((l) => l.id).join(',')}}`;
  const rates = `{${linksSeeded.map((l) => l.spec.rate).join(',')}}`;
  await db.transaction(async (tx) => {
    for (const table of [
      'clicks_hourly',
      'clicks_daily',
      'clicks_daily_dim',
      'clicks_daily_preview',
    ]) {
      await tx.execute(
        sql`DELETE FROM ${sql.identifier(table)} WHERE link_id = ANY(${ids}::bigint[])`,
      );
    }
    // Horas: curva diurna (pico ~21h UTC = 18h em Brasília), fim de semana mais fraco, ruído
    // determinístico por hashtext. Cliques só entre a criação (ou 90 dias atrás) e agora/expiração.
    await tx.execute(sql`
      WITH p AS (SELECT * FROM unnest(${ids}::bigint[], ${rates}::float8[]) AS p(link_id, rate)),
      l AS (
        SELECT p.link_id, p.rate,
               greatest(date_trunc('hour', k.created_at), date_trunc('hour', now()) - interval '90 days') AS lo,
               least(date_trunc('hour', now()), coalesce(date_trunc('hour', k.expires_at), date_trunc('hour', now()))) AS hi
        FROM p JOIN links k ON k.id = p.link_id
        WHERE p.rate > 0
      ),
      h AS (
        SELECT l.link_id, g AS hour,
               floor(l.rate
                     * (0.15 + 0.85 * (0.5 + 0.5 * cos((extract(hour FROM g) - 21) * pi() / 12)))
                     * CASE WHEN extract(isodow FROM g) >= 6 THEN 0.6 ELSE 1 END
                     * ((abs(hashtext(l.link_id || ':' || g::text)) % 100) / 50.0))::bigint AS humans,
               CASE WHEN abs(hashtext('b' || l.link_id || g::text)) % 100 < 12
                    THEN 1 + abs(hashtext('c' || l.link_id || g::text)) % 3 ELSE 0 END AS bots,
               CASE WHEN abs(hashtext('p' || l.link_id || g::text)) % 100 < 6 THEN 1 ELSE 0 END AS previews
        FROM l CROSS JOIN LATERAL generate_series(l.lo, l.hi - interval '1 hour', interval '1 hour') AS g
      )
      INSERT INTO clicks_hourly (link_id, hour, total, humans, bots, previews)
      SELECT link_id, hour, humans + bots + previews, humans, bots, previews
      FROM h WHERE humans + bots + previews > 0`);
    // Dias UTC = soma das horas; únicos entre 55 % e 85 % dos humanos (≥ 1 se houve humano).
    await tx.execute(sql`
      INSERT INTO clicks_daily (link_id, day, total, humans, uniques, bots, previews)
      SELECT link_id, day, total, humans,
             CASE WHEN humans = 0 THEN 0
                  ELSE greatest(1, floor(humans * (0.55 + (abs(hashtext('u' || link_id || day::text)) % 30) / 100.0)))::bigint END,
             bots, previews
      FROM (
        SELECT link_id, (hour AT TIME ZONE 'UTC')::date AS day, sum(total) AS total,
               sum(humans) AS humans, sum(bots) AS bots, sum(previews) AS previews
        FROM clicks_hourly WHERE link_id = ANY(${ids}::bigint[]) GROUP BY 1, 2
      ) d`);
    // Cada dimensão divide os humanos do dia pelos pesos; o resto do arredondamento vai para o 1º.
    await tx.execute(sql`
      WITH dist AS (
        SELECT * FROM unnest(${pgText(DIST.map((d) => d[0]))}::text[], ${pgText(DIST.map((d) => d[1]))}::text[],
                             ${`{${DIST.map((d) => d[2]).join(',')}}`}::int[]) WITH ORDINALITY AS t(dim, value, w, ord)
      ),
      tot AS (SELECT dim, sum(w) AS sw, min(ord) AS first FROM dist GROUP BY dim),
      raw AS (
        SELECT d.link_id, d.day, dist.dim, dist.value, dist.ord = tot.first AS is_first, d.humans,
               floor(d.humans * dist.w::numeric / tot.sw)::bigint AS n
        FROM clicks_daily d CROSS JOIN dist JOIN tot ON tot.dim = dist.dim
        WHERE d.link_id = ANY(${ids}::bigint[]) AND d.humans > 0
      ),
      fixed AS (
        SELECT link_id, day, dim, value,
               n + CASE WHEN is_first THEN humans - sum(n) OVER (PARTITION BY link_id, day, dim) ELSE 0 END AS n
        FROM raw
      )
      INSERT INTO clicks_daily_dim (link_id, dim, day, value, n)
      SELECT link_id, dim, day, value, n FROM fixed WHERE n > 0`);
    await tx.execute(sql`
      WITH dist AS (
        SELECT * FROM unnest(${pgText(PREVIEW_DIST.map((d) => d[0]))}::text[],
                             ${`{${PREVIEW_DIST.map((d) => d[1]).join(',')}}`}::int[]) WITH ORDINALITY AS t(app, w, ord)
      ),
      raw AS (
        SELECT d.link_id, d.day, dist.app, dist.ord = 1 AS is_first, d.previews,
               floor(d.previews * dist.w::numeric / (SELECT sum(w) FROM dist))::bigint AS n
        FROM clicks_daily d CROSS JOIN dist
        WHERE d.link_id = ANY(${ids}::bigint[]) AND d.previews > 0
      )
      INSERT INTO clicks_daily_preview (link_id, day, app, n)
      SELECT link_id, day, app, n FROM (
        SELECT link_id, day, app,
               n + CASE WHEN is_first THEN previews - sum(n) OVER (PARTITION BY link_id, day) ELSE 0 END AS n
        FROM raw
      ) x WHERE n > 0`);
    await tx.execute(sql`
      UPDATE links k SET click_count = coalesce(
        (SELECT sum(humans) FROM clicks_daily d WHERE d.link_id = k.id), 0)
      WHERE k.id = ANY(${ids}::bigint[])`);
  });
  // "Esgotado": o limite é exatamente o total de humanos já contados.
  const exhausted = linksSeeded.filter((l) => l.spec.maxClicks === 'exhausted').map((l) => l.id);
  if (exhausted.length > 0) {
    await db.execute(sql`
      UPDATE links SET max_clicks = greatest(click_count, 1)
      WHERE id = ANY(${`{${exhausted.join(',')}}`}::bigint[])`);
  }
}

async function ensureKey(db: Database, userId: number): Promise<string | null> {
  const existing = (await listApiKeys(db, userId)).find((k) => k.name === KEY_NAME);
  if (existing) return null;
  const g = generateApiKey();
  await insertApiKey(db, {
    userId,
    name: KEY_NAME,
    prefix: g.prefix,
    keyHash: g.hash,
    scopes: [...API_SCOPES],
  });
  return g.key;
}

export async function seedDemo(db: Database) {
  const userId = await ensureUser(db);
  const seeded = await upsertLinks(db, userId);
  await seedClicks(db, seeded);
  const key = await ensureKey(db, userId);
  const [totals] = (await db.execute(sql`
    SELECT count(*) AS links, coalesce(sum(click_count), 0) AS humans
    FROM links WHERE user_id = ${userId}`)) as unknown as { links: string; humans: string }[];
  return { userId, links: Number(totals!.links), humans: Number(totals!.humans), key };
}

export async function main() {
  const { db, close } = createDb(process.env.DATABASE_URL);
  try {
    const r = await seedDemo(db);
    console.log(
      `seed demo: usuário ${DEMO_EMAIL} (id ${r.userId}), ${r.links} links, ${r.humans} cliques humanos`,
    );
    console.log(
      r.key
        ? `chave de API criada (aparece só agora): ${r.key}`
        : `chave de API "${KEY_NAME}" já existia (o segredo não é reexibido)`,
    );
  } finally {
    await close();
  }
}
