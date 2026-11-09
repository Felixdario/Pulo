import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BUCKET_GET,
  clickCount,
  dailySalt,
  decodeLink,
  encodeLink,
  getCachedLink,
  jitteredTtl,
  linkKey,
  NEGATIVE,
  readThroughFill,
  takeTokenAndGet,
  writeThrough,
} from '../../src/cache/index';
import { createLink, type Link } from '../../src/index';
import { flushTestRedis, resolveTestRedisUrl } from '../../src/testing';
import { resetTestDb, testDb } from './helpers';

const redis = new Redis(resolveTestRedisUrl(), { lazyConnect: false });
const { db, close } = testDb();

beforeEach(async () => {
  await flushTestRedis(redis);
  await resetTestDb(db);
});

afterAll(async () => {
  await close();
  redis.disconnect();
});

const make = (alias: string, destination = 'https://example.com/a') =>
  createLink(db, { destination, alias });

describe('codec', () => {
  it('ida e volta com versão; sem hash de senha no cache', async () => {
    const link = await createLink(db, {
      destination: 'https://example.com/x',
      alias: 'codec-1',
      passwordHash: '$argon2id$segredo',
      maxClicks: 3,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
      redirectType: 308,
      rules: { device: [{ match: 'ios', url: 'https://apps.apple.com/' }] },
    });
    const raw = encodeLink(link);
    expect(raw).not.toContain('segredo');
    expect(JSON.parse(raw).v).toBe(1);
    const decoded = decodeLink(raw);
    expect(decoded).toMatchObject({
      kind: 'hit',
      link: {
        id: link.id,
        slug: 'codec-1',
        destination: 'https://example.com/x',
        redirectType: 308,
        maxClicks: 3,
        expiresAt: Date.parse('2030-01-01T00:00:00Z'),
        forwardQuery: true,
      },
    });
    expect(decoded.kind === 'hit' && decoded.link.passwordVersion).toMatch(/^[\w-]{16}$/);
  });

  it('apagado, desativado e bloqueado viram ∅; versão diferente vira stale', () => {
    const base = { status: 'active', deletedAt: null } as unknown as Link;
    expect(encodeLink(null)).toBe(NEGATIVE);
    expect(encodeLink({ ...base, deletedAt: new Date() })).toBe(NEGATIVE);
    expect(encodeLink({ ...base, status: 'disabled' })).toBe(NEGATIVE);
    expect(encodeLink({ ...base, status: 'blocked_loop' })).toBe(NEGATIVE);
    expect(decodeLink(NEGATIVE)).toEqual({ kind: 'negative' });
    expect(decodeLink(null)).toEqual({ kind: 'miss' });
    expect(decodeLink('{"v":0}')).toEqual({ kind: 'stale' });
    expect(decodeLink('{lixo')).toEqual({ kind: 'stale' });
  });

  it('TTL 1 h ± 10 %', () => {
    expect(jitteredTtl(3600, () => 0)).toBe(3240);
    expect(jitteredTtl(3600, () => 0.999999)).toBe(3960);
    for (let i = 0; i < 1000; i++) {
      const t = jitteredTtl();
      expect(t).toBeGreaterThanOrEqual(3240);
      expect(t).toBeLessThanOrEqual(3960);
    }
  });
});

describe('readThroughFill × writeThrough', () => {
  it('leitura atrasada não regrava valor velho por cima do write-through (SET NX falha)', async () => {
    const old = await make('corrida-1', 'https://old.example/');
    const fresh = { ...old, destination: 'https://new.example/' };
    await writeThrough(redis, 'corrida-1', fresh);
    expect(await readThroughFill(redis, 'corrida-1', old)).toBe(false);
    const r = await getCachedLink(redis, 'corrida-1');
    expect(r.kind === 'hit' && r.link.destination).toBe('https://new.example/');
  });

  it('write-through depois da leitura sobrescreve', async () => {
    const old = await make('corrida-2', 'https://old.example/');
    expect(await readThroughFill(redis, 'corrida-2', old)).toBe(true);
    await writeThrough(redis, 'corrida-2', { ...old, destination: 'https://new.example/' });
    const r = await getCachedLink(redis, 'corrida-2');
    expect(r.kind === 'hit' && r.link.destination).toBe('https://new.example/');
  });

  it('TTLs: link ~1 h, negativo 30 s; write-through de criação apaga ∅', async () => {
    const link = await make('ttl-1');
    await readThroughFill(redis, 'ttl-1', link);
    const ttl = await redis.ttl(linkKey('ttl-1'));
    expect(ttl).toBeGreaterThan(3200);
    expect(ttl).toBeLessThanOrEqual(3960);

    await readThroughFill(redis, 'nao-existe', null);
    expect(await redis.get(linkKey('nao-existe'))).toBe(NEGATIVE);
    expect(await redis.ttl(linkKey('nao-existe'))).toBeLessThanOrEqual(30);

    const created = await make('nao-existe');
    await writeThrough(redis, 'nao-existe', created);
    expect((await getCachedLink(redis, 'nao-existe')).kind).toBe('hit');

    await writeThrough(redis, 'nao-existe', null);
    expect(await redis.get(linkKey('nao-existe'))).toBe(NEGATIVE);
    expect(await redis.ttl(linkKey('nao-existe'))).toBeLessThanOrEqual(30);
  });
});

describe('token bucket + GET', () => {
  const bucket = { capacity: 60, refillPerSecond: 10 };

  it('60 em rajada passam, a 61ª é negada com retry; repõe 10/s', async () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < 60; i++) {
      const r = await takeTokenAndGet(redis, 'rl:t1', bucket, undefined, now);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(59 - i);
    }
    const denied = await takeTokenAndGet(redis, 'rl:t1', bucket, undefined, now);
    expect(denied).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 100 });
    expect(denied.resetMs).toBe(6000);
    // 250 ms depois: 2,5 fichas → 2 passam, a 3ª não.
    const later = now + 250;
    expect((await takeTokenAndGet(redis, 'rl:t1', bucket, undefined, later)).allowed).toBe(true);
    expect((await takeTokenAndGet(redis, 'rl:t1', bucket, undefined, later)).allowed).toBe(true);
    expect((await takeTokenAndGet(redis, 'rl:t1', bucket, undefined, later)).allowed).toBe(false);
    // PEXPIRE: some sozinho depois de encher.
    const pttl = await redis.pttl('rl:t1');
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(7000);
  });

  it('devolve o link na mesma chamada só quando permitido', async () => {
    const link = await make('bkt-1');
    await writeThrough(redis, 'bkt-1', link);
    const ok = await takeTokenAndGet(
      redis,
      'rl:t2',
      { capacity: 1, refillPerSecond: 0.001 },
      'bkt-1',
    );
    expect(ok.lookup?.kind).toBe('hit');
    const no = await takeTokenAndGet(
      redis,
      'rl:t2',
      { capacity: 1, refillPerSecond: 0.001 },
      'bkt-1',
    );
    expect(no).toMatchObject({ allowed: false, lookup: null });
    const miss = await takeTokenAndGet(redis, 'rl:t3', bucket, 'nao-tem');
    expect(miss.lookup).toEqual({ kind: 'miss' });
  });

  it('EVALSHA cai para EVAL depois de SCRIPT FLUSH (NOSCRIPT)', async () => {
    await redis.script('FLUSH');
    expect(await redis.script('EXISTS', BUCKET_GET.sha)).toEqual([0]);
    const r = await takeTokenAndGet(redis, 'rl:t4', bucket);
    expect(r.allowed).toBe(true);
    expect(await redis.script('EXISTS', BUCKET_GET.sha)).toEqual([1]);
  });
});

describe('limite de cliques', () => {
  it('inicializa com SET NX a partir do banco e incrementa; peek não consome', async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      return 5;
    };
    expect(await clickCount(redis, 42, 'peek', load)).toBe(5);
    expect(await clickCount(redis, 42, 'incr', load)).toBe(6);
    expect(await clickCount(redis, 42, 'incr', load)).toBe(7);
    expect(await clickCount(redis, 42, 'peek', load)).toBe(7);
    expect(loads).toBe(1);
  });

  it('50 incrementos concorrentes: contagem exata, inicialização única', async () => {
    const counts = await Promise.all(
      Array.from({ length: 50 }, () => clickCount(redis, 7, 'incr', async () => 0)),
    );
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe('sal diário', () => {
  it('quem chega primeiro define; os outros recebem o mesmo; TTL 48 h', async () => {
    const [a, b] = await Promise.all([
      dailySalt(redis, '2026-11-09'),
      dailySalt(redis, '2026-11-09'),
    ]);
    expect(a).toBe(b);
    expect(Buffer.from(a, 'base64')).toHaveLength(32);
    const ttl = await redis.ttl('salt:2026-11-09');
    expect(ttl).toBeGreaterThan(48 * 3600 - 10);
    expect(await dailySalt(redis, '2026-11-10')).not.toBe(a);
    expect(await dailySalt(redis, '2026-11-09', 'candidato')).toBe(a);
  });
});
