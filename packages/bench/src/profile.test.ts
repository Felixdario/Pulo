import { describe, expect, it } from 'vitest';
import { parseSeedArgs, DEFAULT_SEED_OPTIONS } from './args';
import { parsePlan } from './explain';
import { generateLinks } from './links';
import { bucket, thresholds, timeAt, timeModel } from './profile';

describe('parseSeedArgs', () => {
  it('padrões e as duas grafias', () => {
    expect(parseSeedArgs([])).toEqual(DEFAULT_SEED_OPTIONS);
    expect(parseSeedArgs(['--clicks=50000', '--months', '3', '--method=copy'])).toMatchObject({
      clicks: 50_000,
      months: 3,
      method: 'copy',
    });
    expect(parseSeedArgs(['--clicks=5.000.000']).clicks).toBe(5_000_000);
  });
  it('recusa opção desconhecida e valor inválido', () => {
    expect(() => parseSeedArgs(['--clics=1'])).toThrow(/desconhecida/);
    expect(() => parseSeedArgs(['--clicks=abc'])).toThrow(/inválido/);
    expect(() => parseSeedArgs(['--jobs=0'])).toThrow();
  });
});

describe('perfil de tráfego', () => {
  it('bucket = width_bucket do Postgres (quantos limites ≤ x)', () => {
    const t = thresholds([1, 1, 2]); // [0,25; 0,5]
    expect(t).toEqual([0.25, 0.5]);
    expect([0, 0.24, 0.25, 0.49, 0.5, 0.99].map((x) => bucket(x, t))).toEqual([0, 0, 1, 1, 2, 2]);
  });
  it('a inversa da CDF é monótona e fica dentro do período', () => {
    const start = Date.UTC(2026, 0, 1);
    const m = timeModel(start, start + 30 * 86_400_000);
    let prev = -Infinity;
    for (let i = 0; i < 1000; i++) {
      const t = timeAt(m, i / 1000);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    expect(timeAt(m, 0)).toBeGreaterThanOrEqual(start);
    expect(timeAt(m, 0.999999)).toBeLessThan(start + 30 * 86_400_000);
  });
  it('madrugada tem bem menos tráfego que a noite (hora local de São Paulo)', () => {
    const start = Date.UTC(2026, 0, 5, 3); // segunda 00:00 em São Paulo
    const m = timeModel(start, start + 7 * 86_400_000);
    const share = (h: number) => (m.cumulative[h] ?? 0) - (m.cumulative[h - 1] ?? 0);
    expect(share(20)).toBeGreaterThan(share(4) * 5);
  });
});

describe('links do bench', () => {
  it('slugs únicos, ~5 % sem divulgação (peso 0) e o link mais popular existe desde antes do início', () => {
    const start = Date.UTC(2025, 10, 1);
    const links = generateLinks({
      links: 2000,
      users: 20,
      seed: 42,
      startMs: start,
      endMs: start + 365 * 86_400_000,
    });
    expect(new Set(links.map((l) => l.slug)).size).toBe(2000);
    const zero = links.filter((l) => l.weight === 0).length;
    expect(zero).toBeGreaterThan(50);
    expect(zero).toBeLessThan(160);
    expect(links.find((l) => l.rank === 1)!.createdAt.getTime()).toBeLessThan(start);
  });
});

describe('parsePlan', () => {
  it('lê tempo, buffers do nó raiz e linhas examinadas (devolvidas + descartadas, × loops)', () => {
    const text = [
      'HashAggregate  (cost=1.00..2.00 rows=10 width=8) (actual time=0.1..5.0 rows=31 loops=1)',
      '  Buffers: shared hit=100 read=20',
      '  ->  Index Scan using x_idx on clicks_p2026_10 c  (cost=0.43..1.00 rows=5 width=8) (actual time=0.01..1.00 rows=40 loops=2)',
      '        Index Cond: (link_id = 1)',
      '        Rows Removed by Filter: 5',
      '        Buffers: shared hit=90 read=20',
      '  ->  Bitmap Heap Scan on clicks_daily d  (cost=1.00..2.00 rows=1 width=8) (actual time=0.01..0.02 rows=3 loops=1)',
      '        Rows Removed by Index Recheck: 7',
      '        ->  Bitmap Index Scan on clicks_daily_pkey  (cost=0.00..1.00 rows=1 width=0) (actual time=0.01..0.01 rows=10 loops=1)',
      'Planning:',
      '  Buffers: shared hit=9',
      'Planning Time: 0.200 ms',
      'Execution Time: 5.123 ms',
    ].join('\n');
    const p = parsePlan(text);
    expect(p).toMatchObject({ executionMs: 5.123, planningMs: 0.2, hit: 100, read: 20 });
    expect(p.rowsRead).toBe(40 * 2 + 5 * 2 + 3 + 7);
  });
});
