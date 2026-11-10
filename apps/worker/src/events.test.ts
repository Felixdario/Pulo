import { createMemoryGeoLookup, nullGeoLookup } from '@encurtador/geo';
import { uuidv7 } from '@encurtador/shared';
import { describe, expect, it } from 'vitest';
import { enrich, parseEvent, UaCache } from './events';
import { loadConfig } from './config';

const T = Date.UTC(2026, 10, 9, 12);
const base = {
  event_id: uuidv7(T),
  link_id: '42',
  ts: String(T),
  visitor: 'abcdefghijklmnopqrstuv',
  ip_net: '203.0.113.0',
  ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ref: 'https://www.news.example/artigo?id=1',
  country: '',
  kind_hint: 'human',
};
const now = Date.UTC(2026, 10, 9, 13);

describe('parseEvent', () => {
  it('aceita o evento do redirect', () => {
    const r = parseEvent(base, now);
    expect(r).toMatchObject({
      ok: true,
      event: { linkId: '42', ipNet: '203.0.113.0', country: null },
    });
  });

  it.each([
    ['event_id', { event_id: 'x' }],
    ['event_id', { event_id: undefined }],
    ['event_id', { event_id: '0190c6e1-7a2b-4c3d-8e4f-0123456789ab' }], // UUIDv4
    ['event_time', { event_id: uuidv7(Date.UTC(2019, 11, 31)) }],
    ['event_time', { event_id: uuidv7(now + 2 * 86_400_000) }],
    ['link_id', { link_id: 'abc' }],
    ['link_id', { link_id: '0' }],
    ['link_id', { link_id: '-1' }],
    ['link_id', { link_id: '9223372036854775808' }],
    ['visitor', { visitor: 'curto' }],
    ['visitor', { visitor: 'a'.repeat(21) + '!' }],
    ['kind_hint', { kind_hint: 'alien' }],
  ])('campo inválido: %s', (reason, patch) => {
    const f = { ...base, ...patch } as Record<string, string>;
    for (const [k, v] of Object.entries(f)) if (v === undefined) delete f[k];
    expect(parseEvent(f, now)).toEqual({ ok: false, reason });
  });

  it('occurred_at vem do UUIDv7; ts divergente é só sinalizado', () => {
    for (const [ts, mismatch] of [
      [String(T), false],
      [String(T + 999), false],
      [String(T + 1001), true],
      [String(T - 40 * 86_400_000), true],
      ['agora', true],
      ['', true],
    ] as const) {
      const r = parseEvent({ ...base, ts }, now);
      expect(r).toMatchObject({ ok: true, tsMismatch: mismatch, event: { ts: T } });
    }
  });

  it('país fora de ISO-2 ou pseudocódigo vira desconhecido (não descarta)', () => {
    for (const country of ['BRA', '1A', 'XX', 'EU', 'T1', 'A1']) {
      expect(parseEvent({ ...base, country }, now)).toMatchObject({
        ok: true,
        event: { country: null },
      });
    }
    expect(parseEvent({ ...base, country: ' br ' }, now)).toMatchObject({
      event: { country: 'BR' },
    });
  });

  it('IP completo por engano é truncado; ua e ref são cortados', () => {
    const r = parseEvent(
      { ...base, ip_net: '203.0.113.77', ua: 'x'.repeat(600), ref: 'y'.repeat(2000) },
      now,
    );
    expect(r.ok && r.event.ipNet).toBe('203.0.113.0');
    expect(r.ok && r.event.ua.length).toBe(512);
    expect(r.ok && r.event.ref.length).toBe(1024);
    expect(parseEvent({ ...base, ip_net: 'lixo' }, now)).toMatchObject({
      ok: true,
      event: { ipNet: '' },
    });
    expect(parseEvent({ ...base, country: 'br' }, now)).toMatchObject({ event: { country: 'BR' } });
  });
});

describe('enrich', () => {
  const geo = createMemoryGeoLookup({
    '203.0.113.0': { country: 'BR', city: 'São Paulo', region: 'São Paulo' },
  });
  const ev = (patch: Record<string, string> = {}) => {
    const r = parseEvent({ ...base, ...patch }, now);
    if (!r.ok) throw new Error(r.reason);
    return r.event;
  };

  it('geo, UA, referrer, sem IP na linha', () => {
    const row = enrich(ev(), geo, new UaCache());
    expect(row).toEqual({
      eventId: base.event_id,
      linkId: '42',
      occurredAt: '2026-11-09T12:00:00.000Z',
      kind: 'human',
      visitor: base.visitor,
      country: 'BR',
      city: 'São Paulo',
      region: 'São Paulo',
      referrerDomain: 'news.example',
      browser: 'Mobile Safari',
      os: 'iOS',
      device: 'mobile',
      previewApp: null,
    });
    expect(JSON.stringify(row)).not.toContain('203.0.113');
  });

  it('país do proxy vence; cidade de outro país é descartada', () => {
    const row = enrich(ev({ country: 'US' }), geo, new UaCache());
    expect(row).toMatchObject({ country: 'US', city: null, region: null });
  });

  it('reclassifica pelo UA; dica do redirect só acrescenta (HEAD sem UA)', () => {
    const uas = new UaCache();
    expect(enrich(ev({ ua: 'WhatsApp/2.23.20.0 A', kind_hint: 'human' }), geo, uas)).toMatchObject({
      kind: 'preview',
      previewApp: 'whatsapp',
    });
    expect(enrich(ev({ ua: 'curl/8.4.0', kind_hint: 'human' }), geo, uas).kind).toBe('bot');
    expect(enrich(ev({ ua: '', kind_hint: 'bot' }), geo, uas).kind).toBe('bot');
    expect(enrich(ev({ ua: '', kind_hint: 'human' }), nullGeoLookup, uas)).toMatchObject({
      kind: 'human',
      country: null,
      device: 'desktop',
      referrerDomain: 'news.example',
    });
  });

  it('UaCache limita o tamanho', () => {
    const c = new UaCache(2);
    c.get('a');
    c.get('b');
    c.get('c');
    expect((c as unknown as { map: Map<string, unknown> }).map.size).toBe(2);
  });

  it('config padrão do ADR', () => {
    expect(loadConfig({})).toMatchObject({
      stream: 'clicks',
      group: 'workers',
      batchSize: 1000,
      flushIntervalMs: 500,
      blockMs: 2000,
      reclaimIntervalMs: 30_000,
      reclaimIdleMs: 60_000,
      maxDeliveries: 5,
    });
  });
});
