import { describe, expect, it } from 'vitest';
import { dateShort, displayHost, hostOf, middleTruncate, num, prettyUrl } from './format';

describe('format (break-ui)', () => {
  it('punycode vira Unicode na leitura', () => {
    expect(displayHost('xn--ao-siap.example.com.br')).toBe('ação.example.com.br');
    expect(displayHost('xn--1lqs71d.jp')).toBe('東京.jp');
    expect(displayHost('xn--mnchen-3ya.de')).toBe('münchen.de');
    expect(displayHost('xn--e1afmkfd.xn--p1ai')).toBe('пример.рф');
    // Rótulo inválido fica como veio.
    expect(displayHost('xn--!!.com')).toBe('xn--!!.com');
    expect(hostOf('https://www.xn--ao-siap.example.com.br/x')).toBe('ação.example.com.br');
  });

  it('prettyUrl decodifica o caminho e tolera % inválido', () => {
    expect(prettyUrl('https://xn--ao-siap.example.com.br/promo%C3%A7%C3%A3o/')).toBe(
      'ação.example.com.br/promoção',
    );
    expect(prettyUrl('https://loja.example.com/verao_100%')).toBe('loja.example.com/verao_100%');
  });

  it('middleTruncate não parte emoji nem bandeira', () => {
    const s = '🎉🔥 Liquidação 🇧🇷👩🏽‍💻 '.repeat(6);
    const out = middleTruncate(s, 20);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out).toContain('…');
    expect(middleTruncate('curto', 20)).toBe('curto');
  });

  it('números grandes com separador brasileiro', () => {
    expect(num(5_000_000)).toBe('5.000.000');
    expect(num(0)).toBe('0');
  });
});

describe('datas (break-ui)', () => {
  it('dateShort põe o ano só fora do ano corrente', () => {
    const agora = new Date('2026-11-10T12:00:00Z');
    expect(dateShort('2026-11-03T12:00:00Z', agora)).toBe('3 de nov.');
    expect(dateShort('2025-12-01T12:00:00Z', agora)).toBe('1 de dez. de 2025');
  });
});
