import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BASE62, createSlugGenerator, generateSlug, isReservedSlug } from '../src/index';
import { chiSquarePValue, chiSquareUniform } from './stats';

const N = 1_000_000;
const LENGTH = 7;
const DF = BASE62.length - 1;

/**
 * Limiar por posição com correção de Bonferroni: 7 testes, cada um com p > 0,001/7. Para um gerador
 * correto, a chance de algum dos 7 cair abaixo é ≤ 7 × (0,001/7) = 0,1% por execução (falso
 * alarme). Sem a correção (p > 0,001 em cada um) seria 1 − 0,999⁷ ≈ 0,7%. Somando o critério de
 * pares (P(Poisson(0,14) > 3) ≈ 2,5 × 10⁻⁵), o falso alarme total fica em ~0,1%.
 */
const P_THRESHOLD = 0.001 / LENGTH;
const MAX_PAIRS = 3;

interface Report {
  elapsedMs: number;
  badLength: number;
  badChar: number;
  reserved: number;
  pairs: number;
  perPosition: { statistic: number; p: number }[];
  minP: number;
}

/** Gera N slugs e mede tudo que o critério do ADR 0001 olha. */
function evaluate(generate: () => string): Report {
  const index = new Map([...BASE62].map((c, i) => [c, i]));
  const counts = Array.from({ length: LENGTH }, () => new Float64Array(BASE62.length));
  const seen = new Set<string>();
  const repeats = new Map<string, number>();
  let badLength = 0;
  let badChar = 0;
  let reserved = 0;

  const start = performance.now();
  for (let n = 0; n < N; n++) {
    const slug = generate();
    if (slug.length !== LENGTH) badLength++;
    if (isReservedSlug(slug)) reserved++;
    for (let p = 0; p < slug.length && p < LENGTH; p++) {
      const i = index.get(slug[p]!);
      if (i === undefined) badChar++;
      else counts[p]![i]!++;
    }
    if (seen.has(slug)) repeats.set(slug, (repeats.get(slug) ?? 1) + 1);
    else seen.add(slug);
  }
  const elapsedMs = performance.now() - start;

  let pairs = 0;
  for (const c of repeats.values()) pairs += (c * (c - 1)) / 2;
  const perPosition = counts.map((c) => {
    const statistic = chiSquareUniform(c);
    return { statistic, p: chiSquarePValue(statistic, DF) };
  });
  const minP = Math.min(...perPosition.map((x) => x.p));
  return { elapsedMs, badLength, badChar, reserved, pairs, perPosition, minP };
}

/** O critério de aprovação, idêntico para o gerador real e para os mutantes. */
function passes(r: Report): boolean {
  return (
    r.badLength === 0 &&
    r.badChar === 0 &&
    r.reserved === 0 &&
    r.perPosition.every((x) => x.p > P_THRESHOLD) &&
    r.pairs <= MAX_PAIRS
  );
}

function log(label: string, r: Report): void {
  console.log(
    JSON.stringify({
      label,
      n: N,
      elapsedMs: Math.round(r.elapsedMs),
      pairs: r.pairs,
      df: DF,
      pThreshold: Number(P_THRESHOLD.toExponential(3)),
      minP: Number(r.minP.toExponential(3)),
      chiSquare: r.perPosition.map((x) => Number(x.statistic.toFixed(2))),
    }),
  );
}

describe('gerador padrão, 1.000.000 de slugs (ADR 0001, teste 1)', () => {
  it('comprimento 7, só BASE62, nenhum reservado, uniforme por posição (Bonferroni), ≤ 3 pares', () => {
    const r = evaluate(() => generateSlug());
    log('real', r);
    expect(r.badLength).toBe(0);
    expect(r.badChar).toBe(0);
    expect(r.reserved).toBe(0);
    for (const { p } of r.perPosition) expect(p).toBeGreaterThan(P_THRESHOLD);
    expect(r.pairs).toBeLessThanOrEqual(MAX_PAIRS);
    expect(passes(r)).toBe(true);
  }, 180_000);
});

describe('poder do teste: o mesmo critério reprova geradores com defeito', () => {
  it('mutante 1, viés de módulo: fonte de bytes que já entrega `byte % 62`', () => {
    // Todos os bytes ficam < 248 e passam pela rejeição; os símbolos 0–7 saem 25% mais.
    const generate = createSlugGenerator({
      randomBytes: (size) => nodeRandomBytes(size).map((b) => b % 62),
    });
    const r = evaluate(() => generate());
    log('mutante-modulo', r);
    expect(r.minP).toBeLessThan(P_THRESHOLD);
    expect(passes(r)).toBe(false);
  }, 180_000);

  it('mutante 2, viés leve: um símbolo ~12% mais provável', () => {
    // Cada caractere vira "0" com probabilidade 0,002: P("0") = 1/62 + 0,002 × 61/62.
    const real = createSlugGenerator();
    const generate = () => [...real()].map((c) => (Math.random() < 0.002 ? '0' : c)).join('');
    const r = evaluate(generate);
    log('mutante-leve', r);
    expect(r.minP).toBeLessThan(P_THRESHOLD);
    expect(passes(r)).toBe(false);
  }, 180_000);

  it('mutante 3, repetição: uniforme por posição, mas repete um slug a cada 100.000', () => {
    const real = createSlugGenerator();
    let n = 0;
    let last = '';
    const generate = () => {
      n++;
      if (n % 100_000 === 0) return last;
      last = real();
      return last;
    };
    const r = evaluate(generate);
    log('mutante-repeticao', r);
    expect(r.pairs).toBeGreaterThan(MAX_PAIRS);
    expect(passes(r)).toBe(false);
  }, 180_000);
});
