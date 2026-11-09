import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ALIAS_REGEX, isReservedSlug, RESERVED_SLUGS, validateAlias } from '../src/index';

const ADR_LIST = [
  'api',
  'v1',
  'docs',
  'metrics',
  'health',
  'healthz',
  'ready',
  'admin',
  'login',
  'logout',
  'signup',
  'app',
  'dashboard',
  'static',
  'assets',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  '.well-known',
  'www',
  'qr',
  's',
  'l',
];

describe('palavras reservadas', () => {
  it('contém toda a lista do ADR 0001, em minúsculas', () => {
    for (const w of ADR_LIST) expect(RESERVED_SLUGS.has(w)).toBe(true);
    for (const w of RESERVED_SLUGS) expect(w).toBe(w.toLowerCase());
  });

  it('reservadas em qualquer caixa são reservadas', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RESERVED_SLUGS).chain((w) => fc.mixedCase(fc.constant(w))),
        (w) => {
          expect(isReservedSlug(w)).toBe(true);
          const r = validateAlias(w);
          expect(r.ok).toBe(false);
          // As com ponto ou curtas demais caem antes, no formato.
          if (ALIAS_REGEX.test(w)) expect(r).toEqual({ ok: false, code: 'alias_reserved' });
          else expect(r).toEqual({ ok: false, code: 'alias_format' });
        },
      ),
    );
  });

  it('"API", "Docs", "HEALTHZ", "Admin" → alias_reserved', () => {
    for (const w of ['API', 'Docs', 'HEALTHZ', 'Admin', 'dAsHbOaRd', 'WWW', 'sitemap']) {
      expect(validateAlias(w)).toEqual({ ok: false, code: 'alias_reserved' });
    }
  });
});

describe('validateAlias', () => {
  it('aceita qualquer string do regex que não seja reservada', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/), (alias) => {
        fc.pre(!isReservedSlug(alias));
        expect(validateAlias(alias)).toEqual({ ok: true });
      }),
    );
  });

  it('rejeita o que não casa com o regex', () => {
    const bad = [
      '',
      'a',
      'ab',
      '-abc',
      '_abc',
      'ab c',
      'abc.def',
      'abc/def',
      'ação',
      'abc\n',
      '\nabc',
      'abc%20',
      'a'.repeat(65),
      'émoji😀',
      'abc​',
      'ａｂｃ',
    ];
    for (const a of bad) expect(validateAlias(a)).toEqual({ ok: false, code: 'alias_format' });
  });

  it('limites: 3 e 64 caracteres passam', () => {
    expect(validateAlias('a1-')).toEqual({ ok: true });
    expect(validateAlias('a'.repeat(64))).toEqual({ ok: true });
    expect(validateAlias('black-friday_2026')).toEqual({ ok: true });
  });

  it('propriedade: strings arbitrárias com caractere fora do conjunto são recusadas', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', minLength: 3, maxLength: 64 }), (s) => {
        fc.pre(/[^A-Za-z0-9_-]/.test(s));
        expect(validateAlias(s)).toEqual({ ok: false, code: 'alias_format' });
      }),
    );
  });
});
