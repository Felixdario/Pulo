/**
 * Baixa as bases DB-IP Lite (CC BY 4.0) para `data/geo/`: `corepack pnpm geo:download`.
 *
 *   https://download.db-ip.com/free/dbip-city-lite-AAAA-MM.mmdb.gz    → data/geo/dbip-city-lite.mmdb
 *   https://download.db-ip.com/free/dbip-country-lite-AAAA-MM.mmdb.gz → data/geo/dbip-country-lite.mmdb
 *
 * Tenta o mês corrente (UTC); se ainda não saiu (404), cai para o anterior. Os arquivos ficam fora
 * do git (`*.mmdb` e `data/geo/` no .gitignore). Atribuição obrigatória no README e no dashboard:
 * "IP Geolocation by DB-IP" com link para https://db-ip.com.
 *
 * Opções: GEO_ONLY=city|country, GEO_DIR (padrão data/geo).
 */
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = process.env.GEO_DIR ?? `${root}data/geo`;
const kinds = (process.env.GEO_ONLY ? [process.env.GEO_ONLY] : ['city', 'country']) as (
  'city' | 'country'
)[];

const month = (offset: number) => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

async function download(kind: 'city' | 'country') {
  for (const ym of [month(0), month(-1)]) {
    const url = `https://download.db-ip.com/free/dbip-${kind}-lite-${ym}.mmdb.gz`;
    const res = await fetch(url);
    if (res.status === 404) {
      console.log(`${url}: ainda não publicado, tentando o mês anterior`);
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
    mkdirSync(dir, { recursive: true });
    const target = `${dir}/dbip-${kind}-lite.mmdb`;
    const tmp = `${target}.part`;
    try {
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
        createGunzip(),
        createWriteStream(tmp),
      );
      renameSync(tmp, target);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    console.log(`${kind}: ${ym} → ${target}`);
    return;
  }
  throw new Error(`nenhuma base ${kind} encontrada para ${month(0)} nem ${month(-1)}`);
}

for (const kind of kinds) await download(kind);
console.log('Atribuição obrigatória (CC BY 4.0): "IP Geolocation by DB-IP" — https://db-ip.com');
