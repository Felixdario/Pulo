/**
 * Distribuições do seed grande (fase 5). Ficam aqui, em TypeScript, para o gerador no servidor
 * (`generate_series`) e o gerador por `COPY` usarem exatamente os mesmos pesos.
 *
 * Os valores imitam o que o worker grava (ADR 0003): país ISO-2, cidade sem o prefixo do país (o
 * agregado `city` é que leva `BR/São Paulo`), domínio do referrer sem `www.`, nomes do ua-parser-js
 * 1.x e `device` em desktop/mobile/tablet/other.
 */

/** Peso por hora local (America/Sao_Paulo, UTC−3 sem horário de verão desde 2019). */
export const HOUR_OF_DAY = [
  0.35, 0.22, 0.15, 0.1, 0.09, 0.12, 0.25, 0.5, 0.8, 1.0, 1.1, 1.15, 1.2, 1.15, 1.1, 1.05, 1.0, 1.0,
  1.1, 1.25, 1.35, 1.3, 1.0, 0.65,
];

/** Peso por dia da semana local (0 = domingo). */
export const DAY_OF_WEEK = [0.75, 1.1, 1.1, 1.05, 1.05, 1.0, 0.8];

/** Fração de robôs e de prévias no total (o resto é humano). */
export const BOT_SHARE = 0.08;
export const PREVIEW_SHARE = 0.05;

/** Chance de um clique humano ser de alguém que já clicou no mesmo link no mesmo dia. */
export const REPEAT_SHARE = 0.25;

/** [país, cidade, região, peso]; null = o geo não resolveu. */
export const PLACES: [string | null, string | null, string | null, number][] = [
  ['BR', 'São Paulo', 'São Paulo', 16],
  ['BR', 'Rio de Janeiro', 'Rio de Janeiro', 8],
  ['BR', 'Belo Horizonte', 'Minas Gerais', 4],
  ['BR', 'Curitiba', 'Paraná', 3],
  ['BR', 'Porto Alegre', 'Rio Grande do Sul', 3],
  ['BR', 'Salvador', 'Bahia', 2.5],
  ['BR', 'Recife', 'Pernambuco', 2.5],
  ['BR', 'Fortaleza', 'Ceará', 2],
  ['BR', 'Brasília', 'Distrito Federal', 2.5],
  ['BR', 'Campinas', 'São Paulo', 1.5],
  ['BR', 'Goiânia', 'Goiás', 1.5],
  ['BR', 'Manaus', 'Amazonas', 1],
  ['BR', 'Florianópolis', 'Santa Catarina', 1],
  ['BR', null, null, 3],
  ['US', 'New York', 'New York', 3],
  ['US', 'Miami', 'Florida', 2],
  ['US', 'San Francisco', 'California', 1.5],
  ['US', 'Ashburn', 'Virginia', 1],
  ['US', null, null, 1.5],
  ['PT', 'Lisboa', 'Lisboa', 3],
  ['PT', 'Porto', 'Porto', 2],
  ['AR', 'Buenos Aires', 'Buenos Aires', 2.5],
  ['MX', 'Ciudad de México', 'Ciudad de México', 2],
  ['ES', 'Madrid', 'Madrid', 1],
  ['ES', 'Barcelona', 'Catalunya', 0.8],
  ['DE', 'Berlin', 'Berlin', 0.8],
  ['DE', 'Frankfurt am Main', 'Hessen', 0.5],
  ['GB', 'London', 'England', 1],
  ['FR', 'Paris', 'Île-de-France', 0.8],
  ['CO', 'Bogotá', 'Bogotá D.C.', 0.8],
  ['CL', 'Santiago', 'Santiago Metropolitan', 0.7],
  ['UY', 'Montevideo', 'Montevideo', 0.4],
  ['IT', 'Milano', 'Lombardia', 0.4],
  ['JP', 'Tokyo', 'Tokyo', 0.4],
  ['IN', 'Bengaluru', 'Karnataka', 0.4],
  ['CA', 'Toronto', 'Ontario', 0.5],
  ['AO', 'Luanda', 'Luanda', 0.4],
  ['MZ', 'Maputo', 'Maputo', 0.2],
  [null, null, null, 2],
];

/** Origem dos robôs (data centers). */
export const BOT_COUNTRIES: [string | null, number][] = [
  ['US', 50],
  ['DE', 10],
  ['NL', 8],
  ['IE', 6],
  ['SG', 5],
  ['BR', 8],
  ['FR', 4],
  ['GB', 4],
  [null, 5],
];

/** Domínio do referrer. `*cauda*` vira um de ~400 blogs (cauda longa de cardinalidade). */
export const REFERRERS: [string, number][] = [
  ['(direto)', 30],
  ['google.com', 14],
  ['instagram.com', 12],
  ['facebook.com', 7],
  ['t.co', 5],
  ['app:gmail', 4],
  ['linkedin.com', 4],
  ['youtube.com', 3],
  ['bing.com', 1.5],
  ['reddit.com', 1.5],
  ['tiktok.com', 3],
  ['duckduckgo.com', 0.8],
  ['news.ycombinator.com', 0.5],
  ['app:outlook', 1.2],
  ['(desconhecido)', 0.5],
  ['*cauda*', 11.5],
];

export const TAIL_REFERRERS = 400;

/** [device, os, browser, peso] como o ua-parser-js 1.x devolve para humanos. */
export const PLATFORMS: [string, string | null, string | null, number][] = [
  ['mobile', 'Android', 'Mobile Chrome', 30],
  ['mobile', 'iOS', 'Mobile Safari', 18],
  ['mobile', 'iOS', 'Instagram', 5],
  ['mobile', 'Android', 'Samsung Internet', 4],
  ['mobile', 'Android', 'Facebook', 3],
  ['desktop', 'Windows', 'Chrome', 18],
  ['desktop', 'Windows', 'Edge', 6],
  ['desktop', 'Windows', 'Firefox', 2],
  ['desktop', 'Mac OS', 'Safari', 4],
  ['desktop', 'Mac OS', 'Chrome', 4],
  ['desktop', 'Linux', 'Firefox', 1.5],
  ['desktop', 'Chromium OS', 'Chrome', 0.5],
  ['tablet', 'iOS', 'Mobile Safari', 2],
  ['tablet', 'Android', 'Chrome', 1],
  ['other', null, null, 1],
];

/** Robôs: Googlebot/curl não têm navegador; HeadlessChrome tem. */
export const BOT_PLATFORMS: [string, string | null, string | null, number][] = [
  ['desktop', null, null, 70],
  ['desktop', 'Linux', 'Chrome Headless', 20],
  ['mobile', 'Android', 'Mobile Chrome', 10],
];

/** App da prévia (`previewApp` do shared). */
export const PREVIEW_APPS: [string, number][] = [
  ['whatsapp', 55],
  ['facebook', 12],
  ['slack', 8],
  ['telegram', 7],
  ['twitter', 6],
  ['linkedin', 5],
  ['discord', 4],
  ['imessage', 3],
];

/** Limites inferiores acumulados (sem o 0 inicial), para `width_bucket(random(), limites) + 1`. */
export function thresholds(weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    acc += weights[i]!;
    out.push(acc / total);
  }
  return out;
}

/** Índice 0-based em `thresholds`: quantos limites são ≤ x (o mesmo que `width_bucket`). */
export function bucket(x: number, bounds: readonly number[]): number {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bounds[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** PRNG determinístico (mulberry32), para os links e para o gerador por COPY. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR_MS = 3_600_000;
const BRT_OFFSET_MS = -3 * HOUR_MS;

export interface TimeModel {
  startMs: number;
  endMs: number;
  /** Acumulado normalizado por hora desde `startMs` (último = 1). */
  cumulative: number[];
}

/**
 * Perfil de tráfego hora a hora em [start, end): hora do dia × dia da semana (no fuso de São Paulo),
 * uma tendência de crescimento de 0,7× a 1,3× no ano e três dias de campanha com 3× o tráfego.
 */
export function timeModel(startMs: number, endMs: number): TimeModel {
  const hours = Math.round((endMs - startMs) / HOUR_MS);
  const days = Math.ceil(hours / 24);
  const spikes = new Set([0.37, 0.62, 0.88].map((f) => Math.floor(days * f)));
  const w: number[] = [];
  for (let k = 0; k < hours; k++) {
    const local = new Date(startMs + k * HOUR_MS + BRT_OFFSET_MS);
    const trend = 0.7 + (0.6 * k) / hours;
    const spike = spikes.has(Math.floor(k / 24)) ? 3 : 1;
    w.push(HOUR_OF_DAY[local.getUTCHours()]! * DAY_OF_WEEK[local.getUTCDay()]! * trend * spike);
  }
  const total = w.reduce((a, b) => a + b, 0);
  const cumulative: number[] = [];
  let acc = 0;
  for (const x of w) {
    acc += x;
    cumulative.push(acc / total);
  }
  cumulative[cumulative.length - 1] = 1;
  return { startMs, endMs, cumulative };
}

/** Instante (ms) do quantil q ∈ [0, 1) do perfil de tráfego: inversa da CDF, linear dentro da hora. */
export function timeAt(model: TimeModel, q: number): number {
  const c = model.cumulative;
  const k = bucket(q, c);
  const lo = k === 0 ? 0 : c[k - 1]!;
  const hi = c[k]!;
  return Math.floor(model.startMs + (k + (q - lo) / (hi - lo)) * HOUR_MS);
}
