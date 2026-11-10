import type { GeoLookup } from '@encurtador/geo';
import {
  classifyAgent,
  normalizeCountry,
  previewApp,
  referrerDomain,
  truncateIp,
  uuidv7Timestamp,
  type AgentKind,
} from '@encurtador/shared';
import { UAParser } from 'ua-parser-js';

/** Evento como chega do redirect (`XADD clicks`, ADR 0003). */
export interface ClickEvent {
  eventId: string;
  linkId: string;
  ts: number;
  visitor: string;
  ipNet: string;
  ua: string;
  ref: string;
  country: string | null;
  kindHint: AgentKind | null;
}

/** Linha pronta para `clicks`, já sem nada que identifique o IP. */
export interface ClickRow {
  eventId: string;
  linkId: string;
  occurredAt: string;
  kind: AgentKind;
  visitor: string;
  country: string | null;
  city: string | null;
  region: string | null;
  referrerDomain: string;
  browser: string | null;
  os: string | null;
  device: string;
  previewApp: string | null;
}

export type ParseResult =
  { ok: true; event: ClickEvent; tsMismatch: boolean } | { ok: false; reason: string };

const BIGINT = /^[1-9][0-9]{0,18}$/;
const VISITOR = /^[A-Za-z0-9_-]{22}$/;
const KINDS = new Set<string>(['human', 'bot', 'preview']);
const MIN_TS = Date.UTC(2020, 0, 1);
const MAX_SKEW_MS = 24 * 3600 * 1000;
/** Diferença tolerada entre `ts` e o tempo do UUIDv7 antes de contar como divergência. */
const TS_TOLERANCE_MS = 1000;

export function fieldsToRecord(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) out[fields[i]!] = fields[i + 1]!;
  return out;
}

/**
 * Valida um evento. Um campo obrigatório inválido torna a mensagem "venenosa", e ela vai direto
 * para a dead letter (o erro é determinístico: reentregar não adianta). Valida aqui tudo que um
 * CHECK do banco recusaria, para que um evento ruim não derrube o lote inteiro.
 *
 * O instante do clique (`occurred_at`, parte da chave de deduplicação) vem dos 48 bits de tempo do
 * UUIDv7 do `event_id`, não do campo `ts`: assim o mesmo `event_id` sempre cai na mesma chave, mesmo
 * que uma reentrega traga outro `ts`. O redirect gera os dois com o mesmo relógio; se divergirem
 * mais de 1 s, vale o do UUID e o worker conta em métrica.
 */
export function parseEvent(f: Record<string, string>, now = Date.now()): ParseResult {
  const eventId = (f.event_id ?? '').toLowerCase();
  const time = uuidv7Timestamp(eventId);
  if (time === null) return { ok: false, reason: 'event_id' };
  if (time < MIN_TS || time > now + MAX_SKEW_MS) return { ok: false, reason: 'event_time' };
  const linkId = f.link_id ?? '';
  if (!BIGINT.test(linkId) || BigInt(linkId) > 9223372036854775807n) {
    return { ok: false, reason: 'link_id' };
  }
  const ts = Number(f.ts);
  const tsMismatch = !Number.isFinite(ts) || Math.abs(ts - time) > TS_TOLERANCE_MS;
  const visitor = f.visitor ?? '';
  if (!VISITOR.test(visitor)) return { ok: false, reason: 'visitor' };
  // País fora de ISO-2, ou pseudocódigo (XX, EU, T1…), vira desconhecido; não é motivo de descarte.
  const country = normalizeCountry(f.country);
  const hint = f.kind_hint ?? '';
  if (hint !== '' && !KINDS.has(hint)) return { ok: false, reason: 'kind_hint' };
  const rawNet = f.ip_net ?? '';
  // Se por acaso chegar um IP completo, ele é truncado aqui e nunca sai do processo.
  const ipNet = rawNet === '' ? '' : (truncateIp(rawNet) ?? '');
  return {
    ok: true,
    tsMismatch,
    event: {
      eventId,
      linkId,
      ts: time,
      visitor,
      ipNet,
      ua: (f.ua ?? '').slice(0, 512),
      ref: (f.ref ?? '').slice(0, 1024),
      country,
      kindHint: hint === '' ? null : (hint as AgentKind),
    },
  };
}

interface UaInfo {
  browser: string | null;
  os: string | null;
  device: string;
}

/** ua-parser-js 1.x (MIT) com cache: poucos UAs diferentes cobrem quase todo o tráfego. */
export class UaCache {
  private readonly map = new Map<string, UaInfo>();
  constructor(private readonly max = 5000) {}

  get(ua: string): UaInfo {
    const hit = this.map.get(ua);
    if (hit) return hit;
    const r = new UAParser(ua).getResult();
    const type = r.device.type;
    const info: UaInfo = {
      browser: r.browser.name ?? null,
      os: r.os.name ?? null,
      device: type === 'mobile' || type === 'tablet' ? type : type ? 'other' : 'desktop',
    };
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(ua, info);
    return info;
  }
}

/**
 * Enriquecimento em memória: geo pelo `ip_net` (descartado em seguida), UA, domínio do referrer e
 * reclassificação. O worker reclassifica com a mesma função do redirect; a dica do redirect só vale
 * quando ele sabia algo a mais (HEAD sem user agent = robô).
 */
export function enrich(e: ClickEvent, geo: GeoLookup, uas: UaCache): ClickRow {
  let kind = classifyAgent(e.ua, 'GET');
  if (kind === 'human' && e.kindHint && e.kindHint !== 'human') kind = e.kindHint;
  const g = e.ipNet ? geo.lookup(e.ipNet) : { country: null, city: null, region: null };
  const country = e.country ?? g.country;
  const ua = uas.get(e.ua);
  return {
    eventId: e.eventId,
    linkId: e.linkId,
    occurredAt: new Date(e.ts).toISOString(),
    kind,
    visitor: e.visitor,
    country,
    // Cidade e região só se forem do mesmo país (o proxy pode ter dito outro).
    city: g.country === country ? g.city : null,
    region: g.country === country ? g.region : null,
    referrerDomain: referrerDomain(e.ref),
    browser: ua.browser,
    os: ua.os,
    device: ua.device,
    previewApp: kind === 'preview' ? (previewApp(e.ua) ?? 'other') : null,
  };
}
