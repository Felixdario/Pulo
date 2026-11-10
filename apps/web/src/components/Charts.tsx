import { geoEqualEarth, geoPath } from 'd3-geo';
import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { feature } from 'topojson-client';
import type { FeatureCollection, Geometry } from 'geojson';
import type { Topology } from 'topojson-specification';
import type { SeriesPoint, TopDimension } from '../lib/api/types';
import { countryName, numericToAlpha2 } from '../lib/countries';
import { num, numCompact, percent } from '../lib/format';
import type { Granularity } from '../lib/period';

// ------------------------------------------------------------------ série temporal

const MONTHS = [
  'jan.',
  'fev.',
  'mar.',
  'abr.',
  'maio',
  'jun.',
  'jul.',
  'ago.',
  'set.',
  'out.',
  'nov.',
  'dez.',
];

/** Rótulo do ponto (a API manda `AAAA-MM-DD`, `AAAA-MM` ou `AAAA-MM-DDTHH:MI` no fuso pedido). */
export function pointLabel(label: string, g: Granularity, long = false): string {
  const [date, timePart] = label.split('T');
  const [y, m, d] = (date ?? '').split('-').map(Number);
  const month = MONTHS[(m ?? 1) - 1] ?? '';
  if (g === 'month') return `${month} ${y}`;
  if (g === 'day') return `${d} ${month}`;
  const hour = `${Number((timePart ?? '00').slice(0, 2))}h`;
  return long ? `${d} ${month}, ${hour}` : hour;
}

/** 4 ou 5 marcas redondas a partir do zero. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * pow).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v));
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + Math.round(step));
  return ticks;
}

interface TooltipProps {
  active?: boolean;
  payload?: { payload: SeriesPoint }[];
  granularity: Granularity;
  showUniques: boolean;
}

function SeriesTooltip({ active, payload, granularity, showUniques }: TooltipProps) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="flutuante dica serie-dica">
      <p className="rotulo">{pointLabel(p.label, granularity, true)}</p>
      <p>
        Humanos <strong className="num">{num(p.humans)}</strong>
      </p>
      {showUniques && p.uniques !== null && (
        <p>
          Únicos do dia <strong className="num">{num(p.uniques)}</strong>
        </p>
      )}
      {(p.bots > 0 || p.previews > 0) && (
        <p className="suave">
          Bots {num(p.bots)} · Prévias {num(p.previews)}
        </p>
      )}
    </div>
  );
}

export function SeriesChart({
  points,
  granularity,
  showUniques,
}: {
  points: SeriesPoint[];
  granularity: Granularity;
  showUniques: boolean;
}) {
  const max = Math.max(0, ...points.map((p) => Math.max(p.humans, p.uniques ?? 0)));
  const ticks = niceTicks(max);
  const step = Math.max(1, Math.ceil(points.length / 7));
  // A largura do eixo y acompanha o maior rótulo ("300 mil" não cabe nos 44 px de "20 mil").
  const yWidth = Math.max(32, Math.max(...ticks.map((t) => numCompact(t).length)) * 7 + 10);
  return (
    <div className="serie" aria-hidden="true">
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart
          data={points}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          accessibilityLayer={false}
        >
          <CartesianGrid vertical={false} className="serie-grade" />
          <XAxis
            dataKey="label"
            tickFormatter={(l: string) => pointLabel(l, granularity)}
            interval={step - 1}
            tickLine={false}
            axisLine={false}
            className="serie-eixo"
            minTickGap={8}
          />
          <YAxis
            ticks={ticks}
            domain={[0, ticks[ticks.length - 1] ?? 1]}
            tickFormatter={(v: number) => numCompact(v)}
            tickLine={false}
            axisLine={false}
            width={yWidth}
            className="serie-eixo"
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ className: 'serie-cursor' }}
            isAnimationActive={false}
            content={<SeriesTooltip granularity={granularity} showUniques={showUniques} />}
          />
          <Area
            type="linear"
            dataKey="humans"
            className="serie-humanos"
            strokeWidth={2}
            isAnimationActive={false}
            activeDot={{ r: 3, className: 'serie-ponto' }}
          />
          {showUniques && (
            <Line
              type="linear"
              dataKey="uniques"
              className="serie-unicos"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
              activeDot={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Fecha a frase com ponto, sem dobrar o ponto de uma abreviação ("10 de nov."). */
export function endSentence(s: string): string {
  return s.endsWith('.') ? s : `${s}.`;
}

/** Resumo em texto e tabela equivalente (DESIGN.md > Accessibility). */
export function seriesSummary(points: SeriesPoint[], g: Granularity, range: string): string {
  const total = points.reduce((a, p) => a + p.humans, 0);
  if (total === 0) return endSentence(`Nenhum clique humano ${range}`);
  const peak = points.reduce((a, p) => (p.humans > a.humans ? p : a), points[0]!);
  return `${num(total)} cliques humanos ${range}, pico de ${num(peak.humans)} em ${pointLabel(peak.label, g, true)}.`;
}

export function SeriesTable({
  points,
  granularity,
  showUniques,
}: {
  points: SeriesPoint[];
  granularity: Granularity;
  showUniques: boolean;
}) {
  return (
    <div
      className="tabela-quadro tabela-serie"
      tabIndex={0}
      role="region"
      aria-label="Tabela da série"
    >
      <table className="tabela tabela-compacta">
        <thead>
          <tr>
            <th scope="col">Quando</th>
            <th scope="col" className="col-num">
              Humanos
            </th>
            {showUniques && (
              <th scope="col" className="col-num">
                Únicos do dia
              </th>
            )}
            <th scope="col" className="col-num">
              Bots
            </th>
            <th scope="col" className="col-num">
              Prévias
            </th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.start}>
              <td>{pointLabel(p.label, granularity, true)}</td>
              <td className="col-num num">{num(p.humans)}</td>
              {showUniques && (
                <td className="col-num num">{p.uniques === null ? '—' : num(p.uniques)}</td>
              )}
              <td className="col-num num">{num(p.bots)}</td>
              <td className="col-num num">{num(p.previews)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ mapa

type World = FeatureCollection<Geometry, { name: string }>;
let worldPromise: Promise<World> | null = null;

/** O mapa só é baixado quando a página do link abre (world-atlas, 110 m, ~100 KB). */
function loadWorld(): Promise<World> {
  worldPromise ??= import('world-atlas/countries-110m.json').then((m) => {
    const topo = (m as { default: unknown }).default as Topology;
    return feature(topo, topo.objects.countries!) as unknown as World;
  });
  return worldPromise;
}

/** Cinco classes em escala logarítmica: 1–9, 10–99, 100–999… (um país concentra quase tudo). */
export function mapClasses(max: number): { from: number; to: number }[] {
  if (max <= 0) return [];
  const top = Math.max(1, Math.ceil(Math.log10(max + 1)));
  const n = Math.min(5, top);
  const out: { from: number; to: number }[] = [];
  for (let i = 0; i < n; i++) {
    const from = i === 0 ? 1 : 10 ** Math.round((i * top) / n);
    const to = i === n - 1 ? max : 10 ** Math.round(((i + 1) * top) / n) - 1;
    if (to >= from) out.push({ from, to });
  }
  return out;
}

const W = 640;
const H = 320;

export function CountryMap({ data }: { data: TopDimension | undefined }) {
  const [world, setWorld] = useState<World | null>(null);
  useEffect(() => {
    let alive = true;
    void loadWorld().then((w) => alive && setWorld(w));
    return () => {
      alive = false;
    };
  }, []);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of data?.items ?? []) m.set(i.value, i.n);
    return m;
  }, [data]);
  const max = Math.max(0, ...counts.values());
  const classes = mapClasses(max);
  const classOf = (n: number) => {
    const i = classes.findIndex((c) => n >= c.from && n <= c.to);
    return i === -1 ? 0 : 5 - classes.length + i + 1;
  };

  const paths = useMemo(() => {
    if (!world) return [];
    const projection = geoEqualEarth().fitSize([W, H], world);
    const path = geoPath(projection);
    return world.features
      .filter((f) => f.properties.name !== 'Antarctica')
      .map((f, i) => ({ key: `${f.id ?? i}`, code: numericToAlpha2(f.id), d: path(f) ?? '' }));
  }, [world]);

  return (
    <figure className="mapa">
      <svg viewBox={`0 0 ${W} ${H}`} className="mapa-svg" aria-hidden="true">
        {paths.map((p) => {
          const n = p.code ? (counts.get(p.code) ?? 0) : 0;
          const k = n > 0 ? classOf(n) : 0;
          return (
            <path key={p.key} d={p.d} className={k ? `mapa-pais seq-${k}` : 'mapa-pais seq-vazio'}>
              {p.code && <title>{`${countryName(p.code)}: ${num(n)}`}</title>}
            </path>
          );
        })}
      </svg>
      {classes.length > 0 && (
        <figcaption className="mapa-legenda">
          {classes.map((c, i) => (
            <span key={c.from} className="mapa-legenda-item">
              <i className={`amostra seq-${5 - classes.length + i + 1}`} aria-hidden="true" />
              {c.from === c.to ? num(c.from) : `${num(c.from)}–${num(c.to)}`}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

// ------------------------------------------------------------------ dimensões

/** Valor da dimensão para leitura humana ("Desconhecido", "Direto (sem referrer)"…). */
export function dimensionLabel(dim: string, value: string): string {
  if (value === '(desconhecido)' || value === '') return 'Desconhecido';
  if (value === '(direto)') return 'Direto (sem referrer)';
  if (value === '(ip)') return 'Endereço IP';
  if (dim === 'country') return countryName(value);
  if (dim === 'city') {
    const [country, ...rest] = value.split('/');
    const city = rest.join('/');
    if (!city || city === '(desconhecido)') return `Desconhecida (${country})`;
    return `${city}, ${country}`;
  }
  if (dim === 'device') {
    return (
      {
        mobile: 'Celular',
        tablet: 'Tablet',
        desktop: 'Computador',
        other: 'TV, console e outros',
      }[value] ?? value
    );
  }
  if (dim === 'os') {
    return { ios: 'iOS', android: 'Android', other: 'Outro sistema' }[value] ?? value;
  }
  return value;
}

export function DimensionList({
  data,
  dim,
  limit = 10,
  showCode = false,
}: {
  data: TopDimension;
  dim: string;
  limit?: number;
  showCode?: boolean;
}) {
  const items = data.items.slice(0, limit);
  const rest = data.total - items.reduce((a, i) => a + i.n, 0);
  const max = Math.max(1, ...items.map((i) => i.n));
  if (data.total === 0)
    return <p className="suave lista-dim-vazia">Nenhum clique humano no período.</p>;
  return (
    <ol className="lista-dim">
      {items.map((i, k) => (
        <li key={i.value} className={k === 0 ? 'dim dim-primeiro' : 'dim'}>
          <span className="dim-nome" title={dimensionLabel(dim, i.value)}>
            {showCode && /^[A-Z]{2}$/.test(i.value) && (
              <span className="dim-codigo mono">{i.value}</span>
            )}
            {dimensionLabel(dim, i.value)}
          </span>
          <span className="dim-valor num">
            {num(i.n)} <span className="suave">{percent(i.share)}</span>
          </span>
          <span className="dim-barra" aria-hidden="true">
            <span style={{ transform: `scaleX(${i.n / max})` }} />
          </span>
        </li>
      ))}
      {rest > 0 && (
        <li className="dim dim-outros">
          <span className="dim-nome suave">Outros</span>
          <span className="dim-valor num suave">
            {num(rest)} {percent(rest / data.total)}
          </span>
        </li>
      )}
    </ol>
  );
}
