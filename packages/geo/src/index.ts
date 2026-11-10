import { existsSync } from 'node:fs';
import { normalizeCountry } from '@encurtador/shared';
import maxmind, { type CityResponse, type CountryResponse, type Reader } from 'maxmind';

/**
 * Geolocalização por IP (ADR 0003). Recebe só o IP **truncado** (`ip_net`: /24 ou /48), nunca o
 * completo. A base é o DB-IP Lite (CC BY 4.0), baixada por `pnpm geo:download` para `data/geo/`.
 * Sem o arquivo, tudo vira `null` e o pipeline segue.
 */
export interface GeoResult {
  /** ISO 3166-1 alfa-2 em maiúsculas. */
  country: string | null;
  city: string | null;
  region: string | null;
}

export interface GeoLookup {
  lookup(ipNet: string): GeoResult;
  /** false quando não há base carregada (tudo vira null). */
  readonly available: boolean;
}

export interface CountryLookup {
  lookup(ip: string): string | null;
}

const EMPTY: GeoResult = Object.freeze({ country: null, city: null, region: null });

export const nullGeoLookup: GeoLookup = { lookup: () => EMPTY, available: false };

export const DEFAULT_CITY_MMDB = 'data/geo/dbip-city-lite.mmdb';
export const DEFAULT_COUNTRY_MMDB = 'data/geo/dbip-country-lite.mmdb';

interface Warn {
  warn(obj: object, msg: string): void;
}

/** ISO-2 válido ou null; pseudocódigos (EU, AP, XX…) também viram null. */
const iso2 = (code: string | undefined): string | null => normalizeCountry(code);

/** Lê um mmdb se ele existir; senão devolve null e avisa (sem derrubar o processo). */
async function openIfExists<T extends CityResponse | CountryResponse>(
  path: string,
  log: Warn,
  what: string,
): Promise<Reader<T> | null> {
  if (!existsSync(path)) {
    log.warn(
      { path },
      `base de ${what} ausente; geolocalização desligada (rode "corepack pnpm geo:download")`,
    );
    return null;
  }
  try {
    return await maxmind.open<T>(path, { cache: { max: 10_000 } });
  } catch (err) {
    log.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      `falha ao abrir a base de ${what}; geolocalização desligada`,
    );
    return null;
  }
}

/** DB-IP City Lite: país, cidade (nome em inglês) e região (1ª subdivisão). */
export async function createMmdbGeoLookup(
  path: string = process.env.GEO_CITY_MMDB || DEFAULT_CITY_MMDB,
  log: Warn = console,
): Promise<GeoLookup> {
  const reader = await openIfExists<CityResponse>(path, log, 'cidades');
  if (!reader) return nullGeoLookup;
  return {
    available: true,
    lookup(ipNet) {
      let r: CityResponse | null;
      try {
        r = reader.get(ipNet);
      } catch {
        return EMPTY;
      }
      if (!r) return EMPTY;
      return {
        country: iso2(r.country?.iso_code),
        city: r.city?.names?.en ?? null,
        region: r.subdivisions?.[0]?.names?.en ?? null,
      };
    },
  };
}

/** DB-IP Country Lite, para as regras de país do redirect. */
export async function createMmdbCountryLookup(
  path: string = process.env.GEO_COUNTRY_MMDB || DEFAULT_COUNTRY_MMDB,
  log: Warn = console,
): Promise<CountryLookup & { available: boolean }> {
  const reader = await openIfExists<CountryResponse>(path, log, 'países');
  if (!reader) return { available: false, lookup: () => null };
  return {
    available: true,
    lookup(ip) {
      try {
        return iso2(reader.get(ip)?.country?.iso_code);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Fake em memória para testes: chave = `ip_net` exato (ex.: `203.0.113.0`). O que não estiver no
 * mapa devolve nulls, como um IP fora da base.
 */
export function createMemoryGeoLookup(entries: Record<string, Partial<GeoResult>>): GeoLookup {
  const map = new Map(
    Object.entries(entries).map(([k, v]) => [
      k,
      { country: v.country ?? null, city: v.city ?? null, region: v.region ?? null },
    ]),
  );
  return { available: true, lookup: (ipNet) => map.get(ipNet) ?? EMPTY };
}
