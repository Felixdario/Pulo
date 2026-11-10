import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  classifyAgent,
  normalizeCountry,
  previewApp,
  referrerDomain,
  uuidv7,
  uuidv7Timestamp,
} from '../src/index';

describe('uuidv7Timestamp', () => {
  it('devolve os 48 bits de tempo; recusa o que não é UUIDv7', () => {
    for (const ms of [0, 1, Date.UTC(2026, 10, 9), 2 ** 48 - 1]) {
      expect(uuidv7Timestamp(uuidv7(ms))).toBe(ms);
    }
    expect(uuidv7Timestamp(uuidv7(1).toUpperCase())).toBe(1);
    for (const bad of [
      '',
      'x',
      '0190c6e1-7a2b-4c3d-8e4f-0123456789ab', // versão 4
      '0190c6e1-7a2b-7c3d-ce4f-0123456789ab', // variante errada
      '0190c6e17a2b7c3d8e4f0123456789ab', // sem hífens
      '0190c6e1-7a2b-7c3d-8e4f-0123456789ab ',
    ]) {
      expect(uuidv7Timestamp(bad), bad).toBeNull();
    }
  });
});

describe('normalizeCountry', () => {
  it.each([
    ['BR', 'BR'],
    ['br', 'BR'],
    [' us ', 'US'],
    ['XX', null],
    ['ZZ', null],
    ['T1', null],
    ['A1', null],
    ['A2', null],
    ['O1', null],
    ['EU', null],
    ['AP', null],
    ['BRA', null],
    ['1A', null],
    ['', null],
    [null, null],
    [undefined, null],
  ])('%j → %j', (code, expected) => {
    expect(normalizeCountry(code)).toBe(expected);
  });
});

describe('referrerDomain', () => {
  it.each([
    [undefined, '(direto)'],
    ['', '(direto)'],
    ['   ', '(direto)'],
    ['https://www.google.com/search?q=segredo', 'google.com'],
    ['https://WWW.Example.COM./caminho/privado?token=x#frag', 'example.com'],
    ['http://news.ycombinator.com/item?id=1', 'news.ycombinator.com'],
    ['https://user:pass@www.site.com/', 'site.com'],
    ['https://www.www.site.com/', 'www.site.com'],
    ['https://t.co/abc', 't.co'],
    ['https://ñandú.com/', 'xn--and-6ma2c.com'],
    ['android-app://com.google.android.gm', 'app:gmail'],
    ['android-app://com.google.android.gm/', 'app:gmail'],
    ['ANDROID-APP://COM.WHATSAPP', 'app:whatsapp'],
    ['android-app://com.desconhecido.app/https/x', 'app:com.desconhecido.app'],
    ['ios-app://123456/com.foo', '(desconhecido)'],
    ['nao e url', '(desconhecido)'],
    ['javascript:alert(1)', '(desconhecido)'],
    ['file:///etc/passwd', '(desconhecido)'],
    // Pacote Android estrito: nada de userinfo, porta ou caracteres estranhos.
    ['android-app://joao:senha@com.x"y\\z,{q}', '(desconhecido)'],
    ['android-app://user@com.whatsapp', '(desconhecido)'],
    ['android-app://com.whatsapp:443', '(desconhecido)'],
    ['android-app://a\u0000b', '(desconhecido)'],
    ['android-app://', '(desconhecido)'],
    ['android-app://semponto', '(desconhecido)'],
    ['android-app://com..x', '(desconhecido)'],
    ['android-app://com.exemplo_1.app2', 'app:com.exemplo_1.app2'],
    // Host IP literal não vira valor de dimensão.
    ['http://192.168.0.10/x', '(ip)'],
    ['http://203.0.113.77:8080/', '(ip)'],
    ['http://[2001:db8::1]:81/', '(ip)'],
    ['http://2130706433/', '(ip)'],
    ['http://user:senha@Evil.COM.:8080/p?q=1', 'evil.com'],
  ])('%j → %s', (ref, expected) => {
    expect(referrerDomain(ref)).toBe(expected);
  });

  it('propriedade: app: só com pacote válido', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (s) => {
        const d = referrerDomain(`android-app://${s}`);
        expect(d === '(desconhecido)' || /^app:[a-z0-9_.]+$/.test(d)).toBe(true);
      }),
    );
  });

  it('propriedade: nunca devolve caminho, query ou fragmento', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        const d = referrerDomain(url);
        expect(d).not.toMatch(/[/?#@]/);
        expect(d.startsWith('www.')).toBe(false);
      }),
    );
  });
});

describe('previewApp', () => {
  it.each([
    ['WhatsApp/2.23.20.0 A', 'whatsapp'],
    ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'slack'],
    ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'facebook'],
    ['Twitterbot/1.0', 'twitter'],
    ['TelegramBot (like TwitterBot)', 'telegram'],
    ['Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'discord'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
      'imessage',
    ],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36', null],
    ['Mozilla/5.0 (compatible; Googlebot/2.1)', null],
  ])('%s → %s', (ua, app) => {
    expect(previewApp(ua)).toBe(app);
  });

  it('previewApp não nulo ⇔ classifyAgent = preview', () => {
    for (const ua of ['WhatsApp/2', 'Twitterbot/1.0', 'curl/8', 'Mozilla/5.0 Chrome/1']) {
      expect(previewApp(ua) !== null).toBe(classifyAgent(ua) === 'preview');
    }
  });
});
