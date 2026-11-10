/**
 * Seletor de período da página do link. A série escolhe a granularidade sozinha; os totais e as
 * listas de dimensão são lidos por dia UTC (é assim que a API agrega, ADR 0006), e a tela diz isso.
 */

export const PERIODS = ['24h', '7d', '30d', '90d', '12m', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABEL: Record<Period, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
  '90d': '90 d',
  '12m': '12 m',
  custom: 'Personalizado',
};

export const PERIOD_LONG: Record<Period, string> = {
  '24h': 'últimas 24 horas',
  '7d': 'últimos 7 dias',
  '30d': 'últimos 30 dias',
  '90d': 'últimos 90 dias',
  '12m': 'últimos 12 meses',
  custom: 'período personalizado',
};

export type Granularity = 'hour' | 'day' | 'month';

export interface ResolvedPeriod {
  granularity: Granularity;
  /** Query da série (`from`, `to`, `tz`). */
  series: { granularity: Granularity; from: string; to: string; tz: string };
  /** Dias UTC (inclusive) dos totais e das dimensões. */
  days: { from: string; to: string };
}

const DAY = 86_400_000;

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export const addUtcDays = (day: string, n: number) =>
  utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

/** Granularidade automática de um intervalo de dias: até 2 dias por hora, até ~13 meses por dia. */
export function autoGranularity(spanDays: number): Granularity {
  if (spanDays <= 2) return 'hour';
  if (spanDays <= 400) return 'day';
  return 'month';
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function resolvePeriod(
  period: Period,
  custom: { from?: string | undefined; to?: string | undefined } = {},
  now = new Date(),
): ResolvedPeriod {
  const today = utcDay(now);
  if (period === '24h') {
    const from = new Date(now.getTime() - DAY);
    // A hora cheia deixa a chave de cache estável por uma hora (ETag e 304 funcionam).
    from.setUTCMinutes(0, 0, 0);
    const to = new Date(now);
    to.setUTCMinutes(0, 0, 0);
    to.setTime(to.getTime() + 3_600_000);
    return {
      granularity: 'hour',
      series: {
        granularity: 'hour',
        from: from.toISOString(),
        to: to.toISOString(),
        tz: localTimeZone(),
      },
      days: { from: utcDay(from), to: today },
    };
  }
  let from: string;
  let to = today;
  if (period === '7d') from = addUtcDays(today, -6);
  else if (period === '30d') from = addUtcDays(today, -29);
  else if (period === '90d') from = addUtcDays(today, -89);
  else if (period === '12m') {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    from = utcDay(d);
  } else {
    from = custom.from ?? addUtcDays(today, -29);
    to = custom.to ?? today;
    if (from > to) [from, to] = [to, from];
  }
  const granularity = period === '12m' ? 'month' : autoGranularity(daysBetween(from, to) + 1);
  return {
    granularity,
    series:
      granularity === 'hour'
        ? {
            granularity,
            from: new Date(`${from}T00:00:00Z`).toISOString(),
            to: new Date(Date.parse(`${to}T00:00:00Z`) + DAY).toISOString(),
            tz: localTimeZone(),
          }
        : // Dia e mês em UTC: só assim a API devolve os únicos (que existem por dia UTC).
          { granularity, from, to, tz: 'UTC' },
    days: { from, to },
  };
}

export const GRANULARITY_LABEL: Record<Granularity, string> = {
  hour: 'por hora',
  day: 'por dia',
  month: 'por mês',
};
