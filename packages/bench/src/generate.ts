import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { uuidv7 } from '@encurtador/shared';
import type { ISql } from 'postgres';
import {
  BOT_COUNTRIES,
  BOT_PLATFORMS,
  BOT_SHARE,
  bucket,
  mulberry32,
  PLACES,
  PLATFORMS,
  PREVIEW_APPS,
  PREVIEW_SHARE,
  REFERRERS,
  REPEAT_SHARE,
  TAIL_REFERRERS,
  thresholds,
  timeAt,
  type TimeModel,
} from './profile';

/**
 * Gerador dos cliques brutos. O clique i (1..N) acontece no quantil (i − U)/N do perfil de tráfego,
 * com U uniforme em [0, 1): os instantes saem **em ordem de tempo**, como o worker grava na vida
 * real (é isso que dá correlação ~1 entre `occurred_at` e a posição física, o caso do BRIN).
 *
 * O link do clique é sorteado entre os que já existiam naquele instante, com probabilidade
 * proporcional ao peso (Zipf com ruído lognormal, `links.ts`): os links ordenados por `created_at`
 * formam um prefixo dos "vivos", e um `width_bucket` sobre o peso acumulado escolhe o link em
 * O(log L). Robôs e prévias seguem as frações de `profile.ts`; visitantes humanos repetem no mesmo
 * link e dia com chance `REPEAT_SHARE`, e o resto vem de um conjunto diário de pessoas (a mesma
 * pessoa pode clicar em links diferentes).
 */
export interface ClickModel {
  clicks: number;
  seed: number;
  time: TimeModel;
  /** Links ordenados por created_at. */
  linkIds: number[];
  linkCreatedMs: number[];
  /** Peso acumulado na mesma ordem. */
  linkCumWeight: number[];
  /** Pessoas distintas por dia no conjunto global de visitantes. */
  visitorPool: number;
}

const col = <T>(rows: readonly T[], i: number) => rows.map((r) => (r as unknown[])[i]);

const PLACE_T = thresholds(PLACES.map((p) => p[3]));
const BOTC_T = thresholds(BOT_COUNTRIES.map((p) => p[1]));
const REF_T = thresholds(REFERRERS.map((p) => p[1]));
const PLAT_T = thresholds(PLATFORMS.map((p) => p[3]));
const BOTP_T = thresholds(BOT_PLATFORMS.map((p) => p[3]));
const APP_T = thresholds(PREVIEW_APPS.map((p) => p[1]));

/** Literal de array do Postgres; vai como parâmetro de texto e o `::tipo[]` converte. */
function arr(values: readonly unknown[]): string {
  return `{${values
    .map((v) =>
      v === null || v === undefined
        ? 'NULL'
        : typeof v === 'number'
          ? String(v)
          : `"${String(v).replace(/[\\"]/g, (c) => `\\${c}`)}"`,
    )
    .join(',')}}`;
}

const COLUMNS =
  'event_id, link_id, occurred_at, kind, visitor, country, city, region, referrer_domain, browser, os, device, preview_app';

/**
 * INSERT … SELECT generate_series(lo, hi) de um pedaço. Cada nível do SELECT tem `OFFSET 0` para
 * que os `random()` sejam avaliados uma vez por linha (sem isso o planejador poderia achatar as
 * subconsultas e sortear de novo a cada referência).
 */
export function seriesInsert(
  m: ClickModel,
  lo: number,
  hi: number,
): { text: string; params: string[] } {
  const params = [
    arr(m.time.cumulative), // $1
    arr(m.linkCreatedMs), // $2
    arr(m.linkCumWeight), // $3
    arr(m.linkIds), // $4
    arr(PLACE_T), // $5
    arr(col(PLACES, 0)), // $6
    arr(col(PLACES, 1)), // $7
    arr(col(PLACES, 2)), // $8
    arr(BOTC_T), // $9
    arr(col(BOT_COUNTRIES, 0)), // $10
    arr(REF_T), // $11
    arr(col(REFERRERS, 0)), // $12
    arr(PLAT_T), // $13
    arr(col(PLATFORMS, 0)), // $14
    arr(col(PLATFORMS, 1)), // $15
    arr(col(PLATFORMS, 2)), // $16
    arr(BOTP_T), // $17
    arr(col(BOT_PLATFORMS, 0)), // $18
    arr(col(BOT_PLATFORMS, 1)), // $19
    arr(col(BOT_PLATFORMS, 2)), // $20
    arr(APP_T), // $21
    arr(col(PREVIEW_APPS, 0)), // $22
  ];
  const text = `
INSERT INTO clicks (${COLUMNS})
SELECT
  overlay(overlay(overlay(gen_random_uuid()::text PLACING substr(x.hex, 1, 8) FROM 1 FOR 8)
    PLACING substr(x.hex, 9, 4) FROM 10 FOR 4) PLACING '7' FROM 15 FOR 1)::uuid,
  x.link_id,
  timestamptz '1970-01-01 00:00:00+00' + x.t_ms * interval '1 millisecond',
  x.kind,
  translate(left(encode(sha256(convert_to(
    '${m.seed}:' || (x.t_ms / 86400000) || ':' ||
    CASE x.kind
      WHEN 'human' THEN CASE WHEN x.r_rep < ${REPEAT_SHARE}
                             THEN 'r' || x.link_id || ':' || floor(x.r_vis * 3)::int
                             ELSE 'g' || floor(x.r_vis * ${m.visitorPool})::int END
      ELSE 'b' || floor(x.r_vis * 300)::int
    END, 'UTF8')), 'base64'), 22), '+/', '-_'),
  CASE WHEN x.kind = 'bot' THEN ($10::text[])[x.bc] ELSE ($6::text[])[x.pl] END,
  CASE WHEN x.kind = 'human' THEN ($7::text[])[x.pl] END,
  CASE WHEN x.kind = 'human' THEN ($8::text[])[x.pl] END,
  CASE WHEN x.kind <> 'human' THEN '(direto)'
       WHEN ($12::text[])[x.rf] = '*cauda*' THEN 'blog' || floor(x.r_tail ^ 3 * ${TAIL_REFERRERS})::int || '.com.br'
       ELSE ($12::text[])[x.rf] END,
  CASE x.kind WHEN 'human' THEN ($16::text[])[x.pf] WHEN 'bot' THEN ($20::text[])[x.bp] END,
  CASE x.kind WHEN 'human' THEN ($15::text[])[x.pf] WHEN 'bot' THEN ($19::text[])[x.bp] END,
  CASE x.kind WHEN 'human' THEN ($14::text[])[x.pf] WHEN 'bot' THEN ($18::text[])[x.bp] ELSE 'desktop' END,
  CASE WHEN x.kind = 'preview' THEN ($22::text[])[x.ap] END
FROM (
  SELECT s3.t_ms, s3.r_tail, s3.r_rep, s3.r_vis,
         ($4::bigint[])[least(width_bucket(s3.r_link * ($3::float8[])[s3.alive], $3::float8[]) + 1, s3.alive)] AS link_id,
         lpad(to_hex(s3.t_ms), 12, '0') AS hex,
         CASE WHEN s3.r_kind < ${BOT_SHARE} THEN 'bot'
              WHEN s3.r_kind < ${BOT_SHARE + PREVIEW_SHARE} THEN 'preview'
              ELSE 'human' END AS kind,
         width_bucket(s3.r_place, $5::float8[]) + 1 AS pl,
         width_bucket(s3.r_place, $9::float8[]) + 1 AS bc,
         width_bucket(s3.r_ref, $11::float8[]) + 1 AS rf,
         width_bucket(s3.r_plat, $13::float8[]) + 1 AS pf,
         width_bucket(s3.r_plat, $17::float8[]) + 1 AS bp,
         width_bucket(s3.r_app, $21::float8[]) + 1 AS ap
  FROM (
    SELECT s2.*, width_bucket(s2.t_ms, $2::bigint[]) AS alive
    FROM (
      SELECT s1.*,
             (${m.time.startMs}::bigint
               + floor((s1.k + (s1.q - s1.clo) / (s1.chi - s1.clo)) * 3600000))::bigint AS t_ms
      FROM (
        SELECT s0.*,
               CASE WHEN s0.k = 0 THEN 0 ELSE ($1::float8[])[s0.k] END AS clo,
               ($1::float8[])[s0.k + 1] AS chi
        FROM (
          SELECT r.*, width_bucket(r.q, $1::float8[]) AS k
          FROM (
            SELECT (i - random()) / ${m.clicks}::float8 AS q,
                   random() AS r_link, random() AS r_kind, random() AS r_place, random() AS r_ref,
                   random() AS r_tail, random() AS r_plat, random() AS r_app, random() AS r_rep,
                   random() AS r_vis
            FROM generate_series(${lo}::bigint, ${hi}::bigint) AS i
            OFFSET 0
          ) r OFFSET 0
        ) s0 OFFSET 0
      ) s1 OFFSET 0
    ) s2 OFFSET 0
  ) s3 OFFSET 0
) x`;
  return { text, params };
}

/** Visitante no formato do redirect (22 caracteres base64url), igual ao do SQL acima. */
function visitorHash(key: string): string {
  return createHash('sha256')
    .update(key)
    .digest('base64')
    .slice(0, 22)
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const tsv = (v: string | number | null) => (v === null ? '\\N' : String(v));

/** Mesmo modelo, gerado no Node e enviado por `COPY clicks FROM STDIN` em streaming. */
export async function copyChunk(sql: ISql, m: ClickModel, lo: number, hi: number, job: number) {
  const rnd = mulberry32(m.seed * 1_000_003 + job);
  const c = m.linkCumWeight;
  function* rows(): Generator<string> {
    let buf: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const q = (i - rnd()) / m.clicks;
      const rLink = rnd();
      const rKind = rnd();
      const rPlace = rnd();
      const rRef = rnd();
      const rTail = rnd();
      const rPlat = rnd();
      const rApp = rnd();
      const rRep = rnd();
      const rVis = rnd();
      const t = timeAt(m.time, q);
      const alive = bucket(t, m.linkCreatedMs);
      const li = Math.min(bucket(rLink * c[alive - 1]!, c), alive - 1);
      const linkId = m.linkIds[li]!;
      const kind =
        rKind < BOT_SHARE ? 'bot' : rKind < BOT_SHARE + PREVIEW_SHARE ? 'preview' : 'human';
      const day = Math.floor(t / 86_400_000);
      const key =
        kind === 'human'
          ? rRep < REPEAT_SHARE
            ? `r${linkId}:${Math.floor(rVis * 3)}`
            : `g${Math.floor(rVis * m.visitorPool)}`
          : `b${Math.floor(rVis * 300)}`;
      const place = PLACES[bucket(rPlace, PLACE_T)]!;
      const plat =
        kind === 'bot' ? BOT_PLATFORMS[bucket(rPlat, BOTP_T)]! : PLATFORMS[bucket(rPlat, PLAT_T)]!;
      let ref = '(direto)';
      if (kind === 'human') {
        ref = REFERRERS[bucket(rRef, REF_T)]![0];
        if (ref === '*cauda*') ref = `blog${Math.floor(rTail ** 3 * TAIL_REFERRERS)}.com.br`;
      }
      const row = [
        uuidv7(t),
        linkId,
        new Date(t).toISOString(),
        kind,
        visitorHash(`${m.seed}:${day}:${key}`),
        kind === 'bot' ? BOT_COUNTRIES[bucket(rPlace, BOTC_T)]![0] : place[0],
        kind === 'human' ? place[1] : null,
        kind === 'human' ? place[2] : null,
        ref,
        kind === 'preview' ? null : plat[2],
        kind === 'preview' ? null : plat[1],
        kind === 'preview' ? 'desktop' : plat[0],
        kind === 'preview' ? PREVIEW_APPS[bucket(rApp, APP_T)]![0] : null,
      ];
      buf.push(row.map(tsv).join('\t'));
      if (buf.length === 2000) {
        yield `${buf.join('\n')}\n`;
        buf = [];
      }
    }
    if (buf.length > 0) yield `${buf.join('\n')}\n`;
  }
  const writable = await sql.unsafe(`COPY clicks (${COLUMNS}) FROM STDIN`).writable();
  await pipeline(Readable.from(rows()), writable);
}
