import { describe, expect, it } from 'vitest';
import {
  createMemoryGeoLookup,
  createMmdbCountryLookup,
  createMmdbGeoLookup,
  nullGeoLookup,
} from '../src/index';

describe('geo', () => {
  it('arquivo ausente: avisa e devolve nulls, sem lançar', async () => {
    const warnings: string[] = [];
    const log = { warn: (_o: object, msg: string) => warnings.push(msg) };
    const city = await createMmdbGeoLookup('nao/existe.mmdb', log);
    expect(city.available).toBe(false);
    expect(city.lookup('203.0.113.0')).toEqual({ country: null, city: null, region: null });
    const country = await createMmdbCountryLookup('nao/existe.mmdb', log);
    expect(country.available).toBe(false);
    expect(country.lookup('203.0.113.77')).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('geo:download');
  });

  it('arquivo inválido: avisa e desliga', async () => {
    const warnings: string[] = [];
    const city = await createMmdbGeoLookup('package.json', {
      warn: (_o: object, msg: string) => warnings.push(msg),
    });
    expect(city.available).toBe(false);
    expect(warnings[0]).toContain('falha ao abrir');
  });

  it('fake em memória', () => {
    const geo = createMemoryGeoLookup({ '203.0.113.0': { country: 'BR', city: 'São Paulo' } });
    expect(geo.lookup('203.0.113.0')).toEqual({ country: 'BR', city: 'São Paulo', region: null });
    expect(geo.lookup('198.51.100.0')).toEqual({ country: null, city: null, region: null });
    expect(nullGeoLookup.lookup('x')).toEqual({ country: null, city: null, region: null });
  });
});
