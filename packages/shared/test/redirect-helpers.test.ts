import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  classifyAgent,
  compileCidrs,
  detectDevice,
  linkRulesSchema,
  mergeQuery,
  resolveDestination,
  truncateIp,
  uuidv7,
} from '../src/index';

const UA = {
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windowsPhone:
    'Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Mobile Safari/537.36 Edge/15.15063',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
};

describe('classifyAgent', () => {
  it.each([
    'WhatsApp/2.23.20.0 A',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
    'Mozilla/5.0 (compatible; redditbot/1.0; +http://www.reddit.com/feedback)',
    'Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)',
    'Iframely/1.3.1 (+https://iframely.com/docs/about)',
  ])('prévia: %s', (ua) => {
    expect(classifyAgent(ua, 'GET')).toBe('preview');
  });

  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'curl/8.4.0',
    'python-requests/2.31.0',
    'Go-http-client/1.1',
    'HeadlessChrome/120.0',
  ])('robô: %s', (ua) => {
    expect(classifyAgent(ua, 'GET')).toBe('bot');
  });

  it('HEAD sem user agent é robô; GET sem user agent é humano', () => {
    expect(classifyAgent(undefined, 'HEAD')).toBe('bot');
    expect(classifyAgent('', 'head')).toBe('bot');
    expect(classifyAgent('   ', 'HEAD')).toBe('bot');
    expect(classifyAgent(undefined, 'GET')).toBe('human');
  });

  it.each(Object.values(UA))('humano: %s', (ua) => {
    expect(classifyAgent(ua, 'GET')).toBe('human');
    expect(classifyAgent(ua, 'HEAD')).toBe('human');
  });
});

describe('detectDevice', () => {
  it.each([
    [UA.chromeWin, 'desktop', 'other'],
    [UA.safariMac, 'desktop', 'other'],
    [UA.firefoxLinux, 'desktop', 'other'],
    [UA.iphone, 'mobile', 'ios'],
    [UA.ipad, 'tablet', 'ios'],
    [UA.androidPhone, 'mobile', 'android'],
    [UA.androidTablet, 'tablet', 'android'],
    [UA.windowsPhone, 'mobile', 'other'],
    ['', 'desktop', 'other'],
  ])('%s → %s/%s', (ua, device, os) => {
    expect(detectDevice(ua)).toEqual({ device, os });
  });

  it('nunca lança, qualquer entrada', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 600 }), (ua) => {
        const r = detectDevice(ua);
        expect(['mobile', 'tablet', 'desktop']).toContain(r.device);
        expect(['ios', 'android', 'other']).toContain(r.os);
      }),
    );
  });
});

describe('rules: schema e resolveDestination', () => {
  const link = {
    destination: 'https://example.com/default',
    rules: linkRulesSchema.parse({
      geo: [
        { countries: ['BR', 'PT'], url: 'https://example.com/pt' },
        { countries: ['US'], url: 'https://example.com/us' },
      ],
      device: [
        { match: 'ios', url: 'https://apps.apple.com/x' },
        { match: 'android', url: 'https://play.google.com/x' },
        { match: 'mobile', url: 'https://m.example.com/' },
        { match: 'tablet', url: 'https://t.example.com/' },
      ],
    }),
  };

  it('país vence dispositivo; dispositivo vence padrão', () => {
    expect(resolveDestination(link, { country: 'BR', device: 'mobile', os: 'ios' })).toBe(
      'https://example.com/pt',
    );
    expect(resolveDestination(link, { country: 'us', device: 'desktop', os: 'other' })).toBe(
      'https://example.com/us',
    );
    expect(resolveDestination(link, { country: 'DE', device: 'mobile', os: 'ios' })).toBe(
      'https://apps.apple.com/x',
    );
    expect(resolveDestination(link, { country: null, device: 'mobile', os: 'android' })).toBe(
      'https://play.google.com/x',
    );
    expect(resolveDestination(link, { device: 'mobile', os: 'other' })).toBe(
      'https://m.example.com/',
    );
    expect(resolveDestination(link, { device: 'tablet', os: 'other' })).toBe(
      'https://t.example.com/',
    );
    expect(resolveDestination(link, { device: 'desktop', os: 'other' })).toBe(
      'https://example.com/default',
    );
    expect(resolveDestination({ destination: 'https://a.example/' }, { country: 'BR' })).toBe(
      'https://a.example/',
    );
  });

  it('a ordem dentro da lista decide (primeira que casa)', () => {
    const l = {
      destination: 'https://d.example/',
      rules: linkRulesSchema.parse({
        device: [
          { match: 'mobile', url: 'https://m.example/' },
          { match: 'ios', url: 'https://ios.example/' },
        ],
      }),
    };
    expect(resolveDestination(l, { device: 'mobile', os: 'ios' })).toBe('https://m.example/');
  });

  it('schema recusa formas erradas', () => {
    for (const bad of [
      { geo: [{ countries: ['br'], url: 'https://x' }] },
      { geo: [{ countries: ['BRA'], url: 'https://x' }] },
      { geo: [{ countries: [], url: 'https://x' }] },
      { geo: [{ countries: ['BR'] }] },
      { device: [{ match: 'watch', url: 'https://x' }] },
      { device: [{ match: 'ios', url: '' }] },
      { other: true },
      { geo: [{ countries: ['BR'], url: 'https://x', extra: 1 }] },
    ]) {
      expect(linkRulesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(linkRulesSchema.parse({})).toEqual({});
  });
});

describe('mergeQuery', () => {
  it.each([
    ['https://x.example/p', '', 'https://x.example/p'],
    ['https://x.example/p', '?', 'https://x.example/p'],
    ['https://x.example/p', 'a=1', 'https://x.example/p?a=1'],
    ['https://x.example/p', '?a=1&b=2', 'https://x.example/p?a=1&b=2'],
    ['https://x.example/p?', 'a=1', 'https://x.example/p?a=1'],
    ['https://x.example/p?a=0', 'a=1&b=2', 'https://x.example/p?a=0&b=2'],
    ['https://x.example/p?a=0&', 'b=2', 'https://x.example/p?a=0&b=2'],
    [
      'https://x.example/p?utm_source=dono',
      'utm_source=spam&utm_medium=x',
      'https://x.example/p?utm_source=dono&utm_medium=x',
    ],
    [
      'https://x.example/p?utm_source=dono',
      'utm%5Fsource=spam',
      'https://x.example/p?utm_source=dono',
    ],
    ['https://x.example/p?a+b=1', 'a%20b=2', 'https://x.example/p?a+b=1'],
    ['https://x.example/p?q=1#frag', 'r=2', 'https://x.example/p?q=1&r=2#frag'],
    ['https://x.example/p#frag', 'r=2', 'https://x.example/p?r=2#frag'],
    ['https://x.example/p', 'a=1&a=2&b=&c', 'https://x.example/p?a=1&a=2&b=&c'],
    ['https://x.example/p', 'a=1&&b=2', 'https://x.example/p?a=1&b=2'],
    ['https://x.example/p?a=1', 'a=2&a=3', 'https://x.example/p?a=1'],
    ['https://x.example/p', 'x=%E0%A4%A', 'https://x.example/p?x=%E0%A4%A'],
    ['https://x.example/p', 'x=a#b', 'https://x.example/p?x=a%23b'],
  ])('%s + %j → %s', (dest, incoming, expected) => {
    expect(mergeQuery(dest, incoming)).toBe(expected);
  });

  const key = fc.constantFrom('a', 'b', 'c', 'utm_source', 'utm_medium', 'ç', 'a b', '&x');
  const value = fc.string({ maxLength: 6 });
  const params = fc.array(fc.tuple(key, value), { maxLength: 6 });
  const fragment = fc.option(fc.constantFrom('#top', '#a=b', '#'), { nil: undefined });

  it('propriedade: destino intacto; entrada anexada na ordem, com repetições, exceto chaves do destino', () => {
    fc.assert(
      fc.property(params, params, fragment, (own, incoming, hash) => {
        const ownQs = new URLSearchParams(own).toString();
        const dest = `https://x.example/p${ownQs ? `?${ownQs}` : ''}${hash ?? ''}`;
        const result = mergeQuery(dest, new URLSearchParams(incoming).toString());

        const ownKeys = new Set(own.map(([k]) => k));
        const expected = [...own, ...incoming.filter(([k]) => !ownKeys.has(k))];
        const url = new URL(result);
        expect([...url.searchParams]).toEqual(expected);
        expect(url.hash).toBe(new URL(dest).hash);
        // A query do destino é um prefixo literal da nova.
        const [destBase] = dest.split('#');
        expect(result.startsWith(destBase!)).toBe(true);
      }),
    );
  });

  it('propriedade: idempotente — anexar de novo a mesma entrada não muda nada', () => {
    fc.assert(
      fc.property(params, params, (own, incoming) => {
        const ownQs = new URLSearchParams(own).toString();
        const dest = `https://x.example/p${ownQs ? `?${ownQs}` : ''}`;
        const inc = new URLSearchParams(incoming).toString();
        const once = mergeQuery(dest, inc);
        // Toda chave da entrada já está no resultado, então nada mais entra.
        expect(mergeQuery(once, inc)).toBe(once);
      }),
    );
  });
});

describe('truncateIp', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0'],
    ['8.8.8.8', '8.8.8.0'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.0'],
    ['::ffff:203.0.113.77', '203.0.113.0'],
    ['::FFFF:cb00:714d', '203.0.113.0'],
    ['2001:db8:abcd:12:3456::1', '2001:db8:abcd::'],
    ['2001:0db8:0000:0012::1', '2001:db8::'],
    ['2606:4700:4700::1111', '2606:4700:4700::'],
    ['fe80::1%eth0', 'fe80::'],
    ['::1', '::'],
    ['[2001:db8:1:2::3]', '2001:db8:1::'],
    ['nada', null],
    ['', null],
    ['2130706433', null],
  ])('%s → %s', (ip, expected) => {
    expect(truncateIp(ip)).toBe(expected);
  });

  it('propriedade: IPv4 truncado nunca contém o último octeto original (exceto 0)', () => {
    fc.assert(
      fc.property(fc.ipV4(), (ip) => {
        const t = truncateIp(ip)!;
        expect(t.split('.').slice(0, 3)).toEqual(ip.split('.').slice(0, 3));
        expect(t.endsWith('.0')).toBe(true);
      }),
    );
  });

  it('propriedade: IPv6 truncado zera os 80 bits finais', () => {
    fc.assert(
      fc.property(fc.ipV6(), (ip) => {
        const t = truncateIp(ip);
        expect(t).not.toBeNull();
        expect(truncateIp(t!)).toBe(t);
      }),
    );
  });
});

describe('compileCidrs', () => {
  const trusted = compileCidrs('10.0.0.0/8, 127.0.0.1, 192.168.1.0/24, ::1, fd00::/8');
  it.each([
    ['10.1.2.3', true],
    ['127.0.0.1', true],
    ['127.0.0.2', false],
    ['192.168.1.200', true],
    ['192.168.2.1', false],
    ['::ffff:10.0.0.1', true],
    ['::1', true],
    ['fd12::1', true],
    ['fe80::1', false],
    ['8.8.8.8', false],
    ['lixo', false],
  ])('%s → %s', (ip, ok) => {
    expect(trusted(ip)).toBe(ok);
  });

  it('lista vazia não confia em ninguém; entrada inválida lança', () => {
    expect(compileCidrs('')('127.0.0.1')).toBe(false);
    expect(() => compileCidrs('10.0.0.0/33')).toThrow(TypeError);
    expect(() => compileCidrs('10.0.0/8')).toThrow(TypeError);
    expect(() => compileCidrs('::/129')).toThrow(TypeError);
    expect(() => compileCidrs('1.2.3.4/')).toThrow(TypeError);
    expect(compileCidrs('0.0.0.0/0')('1.2.3.4')).toBe(true);
  });
});

describe('uuidv7', () => {
  it('formato, versão, variante e ordem temporal', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13).replace('-', '')).toBe(
      (1_700_000_000_000).toString(16).padStart(12, '0'),
    );
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000);
  });
});
