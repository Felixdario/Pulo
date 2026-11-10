/**
 * Datas e fusos sem biblioteca: `Intl` dá o deslocamento de um fuso num instante, e isso basta para
 * achar a meia-noite local de um dia (com a correção de horário de verão).
 */

const TIME_ZONES = new Set<string>([...Intl.supportedValuesOf('timeZone'), 'UTC', 'Etc/UTC']);

export const isTimeZone = (tz: string) => TIME_ZONES.has(tz);

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Deslocamento do fuso em ms no instante dado (local − UTC). */
export function tzOffsetMs(instant: number, tz: string): number {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Instante da meia-noite local de `AAAA-MM-DD` no fuso `tz`. */
export function zonedMidnight(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(first, tz);
  return new Date(second);
}

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const utcToday = (now = new Date()) => now.toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Limite de um intervalo vindo da query: `AAAA-MM-DD` é um dia no fuso (`from` = início do dia,
 * `to` = fim do dia, inclusive); um instante ISO 8601 vale como está (`to` exclusivo).
 */
export function parseBound(value: string, tz: string, edge: 'from' | 'to'): Date {
  if (DATE_ONLY.test(value)) {
    return zonedMidnight(edge === 'from' ? value : addDays(value, 1), tz);
  }
  return new Date(value);
}
