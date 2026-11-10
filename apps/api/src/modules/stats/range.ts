import type { Granularity } from '@encurtador/db';
import { z } from 'zod';
import { ApiError } from '../../lib/problem';
import { addDays, daysBetween, isTimeZone, parseBound, utcToday } from '../../lib/time';

const bound = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const timeseriesQuery = z
  .object({
    granularity: z.enum(['hour', 'day', 'month']).default('day'),
    from: bound.optional().meta({
      description: '`AAAA-MM-DD` (início do dia no fuso `tz`) ou instante ISO 8601.',
      example: '2026-10-01',
    }),
    to: bound.optional().meta({
      description:
        '`AAAA-MM-DD` (inclusive, até o fim do dia no fuso) ou instante ISO (exclusivo).',
      example: '2026-10-31',
    }),
    tz: z.string().max(64).default('UTC').meta({ example: 'America/Sao_Paulo' }),
  })
  .strict();

export const dayRangeQuery = z
  .object({
    from: z.iso
      .date()
      .optional()
      .meta({ description: 'Primeiro dia UTC (inclusive).', example: '2026-10-01' }),
    to: z.iso
      .date()
      .optional()
      .meta({ description: 'Último dia UTC (inclusive).', example: '2026-10-31' }),
  })
  .strict();

export const topQuery = dayRangeQuery
  .extend({ limit: z.coerce.number().int().min(1).max(100).default(10) })
  .strict();

const DAY_MS = 86_400_000;
/** Limites do ADR 0004 / do pedido: 14 dias por hora, 5 anos por mês; por dia, 2 anos. */
const MAX_SPAN_MS: Record<Granularity, number> = {
  hour: 14 * DAY_MS,
  day: 732 * DAY_MS,
  month: 1827 * DAY_MS,
};
const DEFAULT_SPAN_MS: Record<Granularity, number> = {
  hour: DAY_MS,
  day: 30 * DAY_MS,
  month: 365 * DAY_MS,
};
const MAX_DAY_RANGE = 1827;

const invalid = (field: string, code: string, message: string) =>
  new ApiError('validation', message, { errors: [{ field: `query.${field}`, code, message }] });

export function resolveSeriesRange(
  q: z.infer<typeof timeseriesQuery>,
  now = new Date(),
): { from: Date; to: Date } {
  if (!isTimeZone(q.tz)) throw invalid('tz', 'invalid_timezone', 'fuso IANA desconhecido');
  const to = q.to ? parseBound(q.to, q.tz, 'to') : now;
  const from = q.from
    ? parseBound(q.from, q.tz, 'from')
    : new Date(to.getTime() - DEFAULT_SPAN_MS[q.granularity]);
  if (from.getTime() >= to.getTime())
    throw invalid('from', 'order', '`from` precisa ser antes de `to`');
  if (to.getTime() - from.getTime() > MAX_SPAN_MS[q.granularity]) {
    const max = { hour: '14 dias', day: '2 anos', month: '5 anos' }[q.granularity];
    throw new ApiError('range_too_large', `com granularity=${q.granularity}, no máximo ${max}`);
  }
  return { from, to };
}

/** Dias UTC [fromDay, toDay) a partir de `from`/`to` inclusivos; padrão: os últimos 30 dias. */
export function resolveDayRange(
  q: z.infer<typeof dayRangeQuery>,
  now = new Date(),
): { fromDay: string; toDay: string; from: string; to: string } {
  const to = q.to ?? utcToday(now);
  const from = q.from ?? addDays(to, -29);
  if (from > to) throw invalid('from', 'order', '`from` precisa ser antes ou igual a `to`');
  if (daysBetween(from, to) >= MAX_DAY_RANGE) {
    throw new ApiError('range_too_large', 'no máximo 5 anos');
  }
  return { fromDay: from, toDay: addDays(to, 1), from, to };
}
