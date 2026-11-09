import { createSlugGenerator } from '@encurtador/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createLink,
  createLinks,
  InvalidAliasError,
  links,
  SlugExhaustedError,
  SlugTakenError,
  users,
  type CreateLinkInput,
} from '../../src/index';
import { resetTestDb, scripted, testDb } from './helpers';

const queries: string[] = [];
const { db, close } = testDb({ onQuery: (q) => queries.push(q) });
const dest = 'https://example.com/';

const countLinks = async () => {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(links);
  return row!.n;
};
/** Queries emitidas por `fn`, normalizadas. */
const captured = async (fn: () => Promise<unknown>) => {
  queries.length = 0;
  await fn().catch(() => {});
  return queries.map((q) => q.trim().split(/\s+/)[0]!.toLowerCase());
};

beforeEach(async () => {
  await resetTestDb(db);
});

afterAll(async () => {
  await close();
});

describe('createLink', () => {
  it('cria com slug aleatório de 7 caracteres e defaults do banco', async () => {
    const link = await createLink(db, { destination: dest });
    expect(link.slug).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(link).toMatchObject({
      isCustom: false,
      redirectType: 302,
      cacheTtl: 3600,
      status: 'active',
      forwardQuery: true,
      rules: {},
      userId: null,
      deletedAt: null,
    });
  });

  it('colisão forçada: alfabeto "ab", k = 3 (8 slugs), 50 concorrentes → 8 sucessos e 42 SlugExhaustedError', async () => {
    const generate = createSlugGenerator({ alphabet: 'ab', lengthForAttempt: () => 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => createLink(db, { destination: dest }, { generate })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(8);
    expect(failed).toHaveLength(42);
    for (const f of failed) expect(f.reason).toBeInstanceOf(SlugExhaustedError);

    const rows = await db.select({ slug: links.slug }).from(links);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.slug))).toEqual(
      new Set(['aaa', 'aab', 'aba', 'abb', 'baa', 'bab', 'bba', 'bbb']),
    );
  });

  it('20 concorrentes com o mesmo alias → 1 sucesso e 19 SlugTakenError', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        createLink(db, { destination: dest, alias: 'black-friday' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed).toHaveLength(19);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(SlugTakenError);
      expect((f.reason as SlugTakenError).slug).toBe('black-friday');
    }
    expect(await countLinks()).toBe(1);
  });

  it('alias em uso não gera nova tentativa (um único INSERT)', async () => {
    await createLink(db, { destination: dest, alias: 'meu-alias' });
    const generate = scripted('nunca00');
    const q = await captured(() =>
      createLink(db, { destination: dest, alias: 'meu-alias' }, { generate }),
    );
    expect(q).toEqual(['insert']);
    expect(generate.calls).toEqual([]);
  });

  it('nenhum SELECT antes do INSERT; colisão re-sorteia com tentativa 0, 1, 2…', async () => {
    await createLink(db, { destination: dest, alias: 'taken01' });
    await createLink(db, { destination: dest, alias: 'taken02' });
    const generate = scripted('taken01', 'taken02', 'free003');
    let link: Awaited<ReturnType<typeof createLink>> | undefined;
    const q = await captured(async () => {
      link = await createLink(db, { destination: dest }, { generate });
    });
    expect(q).toEqual(['insert', 'insert', 'insert']);
    expect(generate.calls).toEqual([0, 1, 2]);
    expect(link?.slug).toBe('free003');
    expect(link?.isCustom).toBe(false);
  });

  it('esgota em 5 tentativas com comprimentos 7, 7, 7, 8, 8', async () => {
    await createLink(db, { destination: dest, alias: 'xxxxxxx' });
    const lengths: number[] = [];
    const generate = (attempt = 0) => {
      lengths.push(attempt >= 3 ? 8 : 7);
      return 'xxxxxxx';
    };
    await expect(createLink(db, { destination: dest }, { generate })).rejects.toBeInstanceOf(
      SlugExhaustedError,
    );
    expect(lengths).toEqual([7, 7, 7, 8, 8]);
  });

  it('slug de link apagado (deleted_at) continua ocupado', async () => {
    const link = await createLink(db, { destination: dest, alias: 'apagado' });
    await db.update(links).set({ deletedAt: new Date() }).where(eq(links.id, link.id));

    await expect(createLink(db, { destination: dest, alias: 'apagado' })).rejects.toBeInstanceOf(
      SlugTakenError,
    );
    const generate = scripted('apagado', 'novo123');
    const fresh = await createLink(db, { destination: dest }, { generate });
    expect(fresh.slug).toBe('novo123');
  });

  it('diferencia maiúsculas: "aBc12x9" e "AbC12x9" coexistem', async () => {
    const a = await createLink(db, { destination: dest, alias: 'aBc12x9' });
    const b = await createLink(db, { destination: dest, alias: 'AbC12x9' });
    expect(a.slug).toBe('aBc12x9');
    expect(b.slug).toBe('AbC12x9');
    const generate = scripted('abc12x9');
    expect((await createLink(db, { destination: dest }, { generate })).slug).toBe('abc12x9');
    expect(await countLinks()).toBe(3);
    // A busca exata também diferencia.
    const found = await db.select().from(links).where(eq(links.slug, 'ABC12X9'));
    expect(found).toHaveLength(0);
  });

  it('alias inválido ou reservado é recusado antes de ir ao banco', async () => {
    for (const [alias, code] of [
      ['ab', 'alias_format'],
      ['-abc', 'alias_format'],
      ['Admin', 'alias_reserved'],
      ['HEALTHZ', 'alias_reserved'],
    ] as const) {
      const q = await captured(async () => {
        const err = await createLink(db, { destination: dest, alias }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidAliasError);
        expect((err as InvalidAliasError).code).toBe(code);
      });
      expect(q).toEqual([]);
    }
  });

  it('grava todos os campos opcionais', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'a@example.com', passwordHash: 'x' })
      .returning();
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    const link = await createLink(db, {
      destination: dest,
      alias: 'completo',
      userId: user!.id,
      title: 'Título',
      redirectType: 307,
      cacheTtl: 60,
      expiresAt,
      maxClicks: 10,
      passwordHash: 'hash',
      forwardQuery: false,
      rules: { geo: [{ countries: ['BR'], url: 'https://example.com/br' }] },
    });
    expect(link).toMatchObject({
      isCustom: true,
      userId: user!.id,
      title: 'Título',
      redirectType: 307,
      cacheTtl: 60,
      expiresAt,
      maxClicks: 10,
      passwordHash: 'hash',
      forwardQuery: false,
      rules: { geo: [{ countries: ['BR'], url: 'https://example.com/br' }] },
    });
  });
});

describe('CHECKs do banco', () => {
  const pgCode = async (p: Promise<unknown>) => {
    const err = (await p.then(
      () => null,
      (e: unknown) => e,
    )) as { cause?: { code?: string; constraint_name?: string } } | null;
    return { code: err?.cause?.code, constraint: err?.cause?.constraint_name };
  };

  it('recusa redirect_type 303', async () => {
    const r = await pgCode(
      createLink(db, { destination: dest, redirectType: 303 as unknown as 302 }),
    );
    expect(r).toEqual({ code: '23514', constraint: 'links_redirect_type_check' });
  });

  it('recusa max_clicks 0 (e negativo)', async () => {
    for (const maxClicks of [0, -1]) {
      const r = await pgCode(createLink(db, { destination: dest, maxClicks }));
      expect(r).toEqual({ code: '23514', constraint: 'links_max_clicks_check' });
    }
  });

  it('recusa status fora da lista', async () => {
    const r = await pgCode(
      db.insert(links).values({ slug: 'st4tus1', destination: dest, status: 'x' as 'active' }),
    );
    expect(r).toEqual({ code: '23514', constraint: 'links_status_check' });
  });

  it('aceita os 4 redirect_type válidos', async () => {
    for (const redirectType of [301, 302, 307, 308] as const) {
      await expect(createLink(db, { destination: dest, redirectType })).resolves.toMatchObject({
        redirectType,
      });
    }
  });

  it('e-mail único sem diferenciar maiúsculas', async () => {
    await db.insert(users).values({ email: 'Ana@Example.com', passwordHash: 'x' });
    const r = await pgCode(
      db.insert(users).values({ email: 'ana@example.COM', passwordHash: 'y' }),
    );
    expect(r).toEqual({ code: '23505', constraint: 'users_email_key' });
  });
});

describe('createLinks (lote)', () => {
  it('1.000 itens com um alias repetido 4× e 1 alias já existente → 996 linhas novas', async () => {
    await createLink(db, { destination: dest, alias: 'ja-existe' });

    const inputs: CreateLinkInput[] = Array.from({ length: 1000 }, (_, i) => ({
      destination: `${dest}${i}`,
    }));
    const dupAt = [10, 200, 500, 999];
    for (const i of dupAt) inputs[i] = { destination: `${dest}dup${i}`, alias: 'promo' };
    inputs[42] = { destination: `${dest}existe`, alias: 'ja-existe' };

    const q = await captured(async () => {
      const results = await createLinks(db, inputs);
      expect(results).toHaveLength(1000);

      expect(results[10]).toMatchObject({ ok: true, link: { slug: 'promo', isCustom: true } });
      for (const i of [200, 500, 999]) {
        expect(results[i]).toEqual({ ok: false, code: 'slug_taken', slug: 'promo' });
      }
      expect(results[42]).toEqual({ ok: false, code: 'slug_taken', slug: 'ja-existe' });

      const okCount = results.filter((r) => r.ok).length;
      expect(okCount).toBe(996);
      // A ordem é preservada: cada resultado é do seu item.
      results.forEach((r, i) => {
        if (r.ok) expect(r.link.destination).toBe(inputs[i]!.destination);
      });
    });
    expect(await countLinks()).toBe(1 + 996);
    // Uma transação com um único INSERT multi-linha; nenhum SELECT.
    expect(q).toEqual(['begin', 'insert', 'commit']);
  });

  it('re-sorteia só os itens que colidiram, na mesma transação', async () => {
    await createLink(db, { destination: dest, alias: 'ocupado1' });
    await createLink(db, { destination: dest, alias: 'ocupado2' });
    const generate = scripted('livre01', 'ocupado1', 'livre02', 'ocupado2', 'livre03', 'livre04');
    let results: Awaited<ReturnType<typeof createLinks>> = [];
    const q = await captured(async () => {
      results = await createLinks(
        db,
        Array.from({ length: 4 }, () => ({ destination: dest })),
        { generate },
      );
    });
    expect(results.map((r) => (r.ok ? r.link.slug : r.code))).toEqual([
      'livre01',
      'livre03',
      'livre02',
      'livre04',
    ]);
    // 1ª rodada com 4 linhas, 2ª só com as 2 que colidiram (tentativa 1).
    expect(generate.calls).toEqual([0, 0, 0, 0, 1, 1]);
    expect(q).toEqual(['begin', 'insert', 'insert', 'commit']);
  });

  it('esgotamento por item: 10 itens com 8 slugs possíveis → 8 ok, 2 slug_exhausted', async () => {
    const generate = createSlugGenerator({ alphabet: 'ab', lengthForAttempt: () => 3 });
    const results = await createLinks(
      db,
      Array.from({ length: 10 }, () => ({ destination: dest })),
      { generate },
    );
    expect(results.filter((r) => r.ok)).toHaveLength(8);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, code: 'slug_exhausted' },
      { ok: false, code: 'slug_exhausted' },
    ]);
    expect(await countLinks()).toBe(8);
  });

  it('alias inválido vira erro do item sem derrubar os outros', async () => {
    const results = await createLinks(db, [
      { destination: dest, alias: 'ok-alias' },
      { destination: dest, alias: 'x' },
      { destination: dest, alias: 'docs' },
      { destination: dest },
    ]);
    expect(results.map((r) => (r.ok ? 'ok' : r.code))).toEqual([
      'ok',
      'alias_format',
      'alias_reserved',
      'ok',
    ]);
  });

  it('slug aleatório nunca repete alias do próprio lote; alias tem prioridade', async () => {
    const generate = scripted('meualias', 'outro99');
    const results = await createLinks(
      db,
      [{ destination: dest }, { destination: dest, alias: 'meualias' }],
      { generate },
    );
    expect(results.map((r) => (r.ok ? r.link.slug : r.code))).toEqual(['outro99', 'meualias']);
  });

  it('lote vazio não abre transação', async () => {
    const q = await captured(() => createLinks(db, []));
    expect(q).toEqual([]);
  });

  it('dois lotes concorrentes com o mesmo alias: só um fica com ele', async () => {
    const [a, b] = await Promise.all([
      createLinks(db, [{ destination: dest, alias: 'disputa' }, { destination: dest }]),
      createLinks(db, [{ destination: dest, alias: 'disputa' }, { destination: dest }]),
    ]);
    const winners = [a![0]!, b![0]!].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    expect([a![1]!.ok, b![1]!.ok]).toEqual([true, true]);
    expect(await countLinks()).toBe(3);
  });
});
