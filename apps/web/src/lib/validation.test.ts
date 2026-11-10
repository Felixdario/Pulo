import { ALIAS_REGEX, isReservedSlug } from '@encurtador/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkAlias, completeUrl, looksLikeUrl } from './validation';

describe('checkAlias (espelha validateAlias de packages/shared)', () => {
  it('vazio não é erro: sai um slug aleatório', () => {
    expect(checkAlias('')).toEqual({ state: 'empty' });
    expect(checkAlias('   ')).toEqual({ state: 'empty' });
  });

  it('aceita o formato do ADR 0001', () => {
    for (const a of ['promo-natal', 'live_sabado', 'abc', 'A1b', 'x'.repeat(64)]) {
      expect(checkAlias(a)).toEqual({ state: 'ok' });
    }
  });

  it('recusa reservados sem diferenciar maiúsculas', () => {
    for (const a of ['admin', 'API', 'Login', 'healthz', 'password']) {
      const r = checkAlias(a);
      expect(r.state).toBe('error');
      if (r.state === 'error') {
        expect(r.code).toBe('alias_reserved');
        expect(r.message).toContain('reservado');
      }
    }
  });

  it('explica cada problema de formato em frase', () => {
    expect(checkAlias('ab')).toMatchObject({
      code: 'alias_short',
      message: 'Use pelo menos 3 caracteres.',
    });
    expect(checkAlias('-promo')).toMatchObject({ message: 'Comece com uma letra ou um número.' });
    expect(checkAlias('x'.repeat(65))).toMatchObject({
      message: 'Use no máximo 64 caracteres (agora são 65).',
    });
    expect(checkAlias('promo natal')).toMatchObject({
      message: 'Só letras sem acento, números, _ e -. Tire espaço.',
    });
    expect(checkAlias('ação!')).toMatchObject({
      message: 'Só letras sem acento, números, _ e -. Tire "ç", "ã", "!".',
    });
  });

  it('nunca discorda do servidor (propriedade)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 70 }), (raw) => {
        const alias = raw.trim();
        fc.pre(alias !== '');
        const serverOk = ALIAS_REGEX.test(alias) && !isReservedSlug(alias);
        expect(checkAlias(raw).state === 'ok').toBe(serverOk);
      }),
      { numRuns: 500 },
    );
  });
});

describe('completeUrl e looksLikeUrl', () => {
  it('completa https:// quando falta', () => {
    expect(completeUrl('loja.com.br/natal')).toBe('https://loja.com.br/natal');
    expect(completeUrl('  http://a.com ')).toBe('http://a.com');
    expect(completeUrl('//a.com')).toBe('https://a.com');
  });

  it('deixa a decisão de rede privada para a API', () => {
    expect(looksLikeUrl('loja.com.br')).toBe(true);
    expect(looksLikeUrl('localhost:3000')).toBe(true);
    expect(looksLikeUrl('192.168.0.1')).toBe(true);
    expect(looksLikeUrl('isso não é url')).toBe(false);
    expect(looksLikeUrl('ftp://a.com')).toBe(false);
  });
});
