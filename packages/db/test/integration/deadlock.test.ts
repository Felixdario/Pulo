import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLinks, type CreateLinkInput, type CreateLinkResult } from '../../src/index';
import { resetTestDb, testDb } from './helpers';

const { db, close } = testDb({ max: 4 });
const dest = 'https://example.com/';

beforeAll(async () => {
  await resetTestDb(db);
});

afterAll(async () => {
  await close();
});

describe('createLinks concorrente', () => {
  it('20 rodadas de 2 lotes com os mesmos 200 aliases (direto × reverso) + aleatórios: sem deadlock, 1 dono por alias', async () => {
    for (let round = 0; round < 20; round++) {
      const aliases = Array.from(
        { length: 200 },
        (_, k) => `r${String(round).padStart(2, '0')}-alias-${String(k).padStart(3, '0')}`,
      );
      const batch = (list: string[]): CreateLinkInput[] => [
        ...list.map((alias) => ({ destination: `${dest}${alias}`, alias })),
        ...Array.from({ length: 5 }, () => ({ destination: dest })),
      ];

      const settled = await Promise.allSettled([
        createLinks(db, batch(aliases)),
        createLinks(db, batch([...aliases].reverse())),
      ]);
      const errors = settled.filter((s) => s.status === 'rejected');
      expect(errors, `rodada ${round}: ${errors.map((e) => String(e.reason)).join('; ')}`).toEqual(
        [],
      );

      const [a, b] = settled.map((s) => (s as PromiseFulfilledResult<CreateLinkResult[]>).value);
      const owners = new Map<string, number>();
      for (const r of [...a!, ...b!]) {
        if (r.ok && r.link.isCustom) owners.set(r.link.slug, (owners.get(r.link.slug) ?? 0) + 1);
        if (!r.ok) expect(r.code).toBe('slug_taken');
      }
      expect(owners.size).toBe(200);
      for (const alias of aliases) expect(owners.get(alias), alias).toBe(1);
      // Os 5 aleatórios de cada lote sempre entram.
      expect([...a!.slice(200), ...b!.slice(200)].every((r) => r.ok)).toBe(true);
    }
  });
});
