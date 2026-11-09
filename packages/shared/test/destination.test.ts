import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  normalizeShortDomains,
  validateDestination,
  type DestinationErrorCode,
} from '../src/index';

const opts = { shortDomains: ['enc.ta', 'go.encurta.dev'] };
const check = (raw: string) => validateDestination(raw, opts);
const codeOf = (raw: string): DestinationErrorCode | 'ok' => {
  const r = check(raw);
  return r.ok ? 'ok' : r.code;
};

/** Faixas IPv4 não públicas, escritas aqui de forma independente da implementação. */
const NON_PUBLIC_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const toInt = (ip: string) => ip.split('.').reduce((a, p) => a * 256 + Number(p), 0);
const toDotted = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const inRange = (n: number, [base, prefix]: [string, number]) =>
  Math.floor(n / 2 ** (32 - prefix)) === Math.floor(toInt(base) / 2 ** (32 - prefix));
const isNonPublic = (n: number) => NON_PUBLIC_V4.some((r) => inRange(n, r));

const privateV4 = fc
  .tuple(fc.constantFrom(...NON_PUBLIC_V4), fc.integer({ min: 0, max: 2 ** 32 - 1 }))
  .map(([[base, prefix], r]) => toInt(base) + (r % 2 ** (32 - prefix)));
const publicV4 = fc.integer({ min: 0, max: 2 ** 32 - 1 }).filter((n) => !isNonPublic(n));

/** As várias grafias que o parser WHATWG aceita para o mesmo IPv4. */
const spellings = (n: number): string[] => {
  const [a, b, c, d] = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const hex = (x: number) => `0x${x.toString(16)}`;
  const oct = (x: number) => `0${x.toString(8)}`;
  return [
    toDotted(n),
    `${toDotted(n)}.`,
    String(n),
    hex(n),
    oct(n),
    [a, b, c, d].map(hex).join('.'),
    [a, b, c, d].map(oct).join('.'),
    `${a}.${(b << 16) + (c << 8) + d}`,
    `${a}.${b}.${(c << 8) + d}`,
    `[::ffff:${toDotted(n)}]`,
    `[0:0:0:0:0:ffff:${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}]`,
    `[::FFFF:${toDotted(n)}]`,
  ];
};

describe('validateDestination — aceitos', () => {
  it('fc.webUrl() http/https com domínio público é aceita e normalizada pelo WHATWG', () => {
    fc.assert(
      fc.property(
        fc.webUrl({
          validSchemes: ['http', 'https'],
          withQueryParameters: true,
          withFragments: true,
        }),
        (raw) => {
          const host = new URL(raw).hostname.replace(/\.+$/, '');
          fc.pre(!/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host));
          fc.pre(!/(^|\.)(enc\.ta|go\.encurta\.dev)$/.test(host));
          expect(check(raw)).toEqual({ ok: true, url: new URL(raw).href });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('IPv4 público em qualquer grafia é aceito', () => {
    fc.assert(
      fc.property(publicV4, (n) => {
        for (const host of spellings(n)) {
          const r = check(`http://${host}/x`);
          expect(r.ok, host).toBe(true);
        }
      }),
    );
  });

  it.each([
    ['https://example.com', 'https://example.com/'],
    ['HTTPS://EXAMPLE.COM/Path?Q=1#F', 'https://example.com/Path?Q=1#F'],
    ['http://example.com:8080/a', 'http://example.com:8080/a'],
    ['https://example.com:443/', 'https://example.com/'],
    ['https://example.com.', 'https://example.com./'],
    ['https://ñandú.com/ç', 'https://xn--and-6ma2c.com/%C3%A7'],
    ['https://xn--nxasmq6b.com/', 'https://xn--nxasmq6b.com/'],
    ['https://例え.テスト/', 'https://xn--r8jz45g.xn--zckzah/'],
    ['  https://example.com/  ', 'https://example.com/'],
    ['https://8.8.8.8/', 'https://8.8.8.8/'],
    ['https://[2606:4700:4700::1111]/', 'https://[2606:4700:4700::1111]/'],
    ['http://localhost.example.com/', 'http://localhost.example.com/'],
    ['http://local.com/', 'http://local.com/'],
    ['http://notenc.ta/', 'http://notenc.ta/'],
    ['http://enc.ta.evil.com/', 'http://enc.ta.evil.com/'],
  ])('%s → %s', (raw, url) => {
    expect(check(raw)).toEqual({ ok: true, url });
  });

  it('URL de 2.000 caracteres passa; 4.096 passa; 4.097 não', () => {
    const base = 'https://example.com/?q=';
    const of = (len: number) => base + 'a'.repeat(len - base.length);
    expect(check(of(2000))).toEqual({ ok: true, url: of(2000) });
    expect(check(of(4096)).ok).toBe(true);
    expect(codeOf(of(4097))).toBe('too_long');
  });

  it('normalização que estoura 4.096 vira too_long', () => {
    // Cada espaço vira %20: 1.400 espaços → +2.800 caracteres.
    const raw = `https://example.com/${'a'.repeat(1300)}${' '.repeat(1400)}x`;
    expect(raw.length).toBeLessThanOrEqual(4096);
    expect(codeOf(raw)).toBe('too_long');
  });
});

describe('validateDestination — esquemas', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '\tjavascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    'javascript\n:alert(1)',
    '\u0000javascript:alert(1)',
    '\u001fjavascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'DATA:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'FILE://c:/windows/win.ini',
    'blob:https://example.com/uuid',
    'ftp://example.com/',
    'ws://example.com/',
    'wss://example.com/',
    'mailto:a@example.com',
    'about:blank',
    'chrome://settings',
    'intent://x#Intent;end',
  ])('%j → unsupported_protocol', (raw) => {
    expect(codeOf(raw)).toBe('unsupported_protocol');
  });

  it.each([
    'java script:alert(1)',
    '//example.com',
    '/a',
    'example.com',
    '',
    ' ',
    'http://',
    'https://',
  ])('%j → invalid_url', (raw) => {
    expect(codeOf(raw)).toBe('invalid_url');
  });

  it('propriedade: qualquer esquema que não seja http/https é recusado', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9+.-]{0,15}$/),
        fc.constantFrom('//example.com/x', 'example.com', 'alert(1)', '///x'),
        (scheme, rest) => {
          fc.pre(!['http', 'https'].includes(scheme.toLowerCase()));
          const r = check(`${scheme}:${rest}`);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(['unsupported_protocol', 'invalid_url']).toContain(r.code);
        },
      ),
    );
  });
});

describe('validateDestination — credenciais', () => {
  it.each([
    'https://banco.com@evil.example/',
    'https://user:pass@example.com/',
    'https://:pass@example.com/',
    'https://user:@example.com/',
    'http://a%40b@example.com/',
    'https://banco.com%2F@evil.example/',
  ])('%s → credentials', (raw) => {
    expect(codeOf(raw)).toBe('credentials');
  });

  it('"@" sozinho antes do host conta como userinfo vazio e é aceito pelo WHATWG sem credencial', () => {
    // O WHATWG descarta o "@" de userinfo vazio; não há credencial a esconder.
    expect(check('https://@example.com/')).toEqual({ ok: true, url: 'https://example.com/' });
  });
});

describe('validateDestination — hosts privados', () => {
  it('IPv4 gerado em faixa não pública é recusado em todas as grafias', () => {
    fc.assert(
      fc.property(privateV4, (n) => {
        for (const host of spellings(n)) {
          expect(codeOf(`http://${host}/`), host).toBe('private_host');
        }
      }),
    );
  });

  it.each([
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://0177.0000.0000.0001/',
    'http://127.1/',
    'http://127.0.1/',
    'http://127.0.0.1./',
    'http://%31%32%37.0.0.1/',
    'http://１２７.０.０.１/',
    'http://0/',
    'http://0.0.0.0/',
    'http://255.255.255.255/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://198.18.0.1/',
    'http://192.0.2.1/',
    'http://224.0.0.1/',
    'http://[::1]/',
    'http://[::]/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[0:0:0:0:0:ffff:127.0.0.1]/',
    'http://[::FFFF:127.0.0.1]/',
    'http://[0000::ffff:7f00:0001]/',
    'http://[::ffff:0:127.0.0.1]/',
    'http://[::127.0.0.1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[64:ff9b::127.0.0.1]/',
    'http://[2002:7f00:1::]/',
    'http://[fc00::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://[2001:db8::1]/',
    'http://localhost/',
    'http://LOCALHOST/',
    'http://localhost./',
    'http://localhost../',
    'http://a.localhost/',
    'http://a.b.localhost./',
    'http://printer.local/',
    'http://PRINTER.LOCAL./',
    'http://metadata.google.internal/',
    'http://db.internal./',
    'http://localhost:3000/',
    'http://router.home.arpa/',
    'http://localhost.localdomain/',
    'http://localhost%2e/',
    'http://LOCALHOST%2E%2E/',
    'http://loc­alhost/',
    'http://0x7f.0x0.0x0.0x1/',
    'http://[::ffff:127.0.0.1]:80/',
    'http://[::ffff:0.0.0.0]/',
    'http://0.0.0.0./',
    'http:/\\127.0.0.1',
    'http:\\\\127.0.0.1\\',
  ])('%j → private_host', (raw) => {
    expect(codeOf(raw)).toBe('private_host');
  });
});

describe('validateDestination — loop', () => {
  it.each([
    'https://enc.ta/abc',
    'https://ENC.TA/abc',
    'https://enc.ta./abc',
    'https://www.enc.ta/abc',
    'https://WWW.Enc.Ta./abc',
    'https://a.b.enc.ta/abc',
    'http://enc.ta:8080/abc',
    'https://go.encurta.dev/x',
    'https://www.go.encurta.dev/x',
    'https://x.go.encurta.dev./x',
    'http://enc%2Eta/',
    'https://e​nc.ta/',
    'https://ENC。TA/',
    'https://enc．ta/',
    'https:enc.ta',
  ])('%j → loop', (raw) => {
    expect(codeOf(raw)).toBe('loop');
  });

  it('domínios curtos são normalizados (caixa, ponto final, www., IDN)', () => {
    const o = { shortDomains: ['WWW.Enc.Ta.', 'ñandú.com'] };
    expect(validateDestination('https://enc.ta/', o)).toEqual({ ok: false, code: 'loop' });
    expect(validateDestination('https://xn--and-6ma2c.com/', o)).toEqual({
      ok: false,
      code: 'loop',
    });
    expect(validateDestination('https://ñandú.com/', o)).toEqual({ ok: false, code: 'loop' });
  });

  it('sem domínios curtos não há loop', () => {
    expect(validateDestination('https://enc.ta/', { shortDomains: [] }).ok).toBe(true);
  });
});

describe('validateDestination — entrada inválida', () => {
  it.each(['http://exa mple.com/', 'http://[::1/', 'http://999.1.1.1/', 'http://1.2.3.4.5/'])(
    '%j → não aceita',
    (raw) => {
      expect(check(raw).ok).toBe(false);
    },
  );

  it('não aceita não-string', () => {
    expect(validateDestination(42 as unknown as string, opts)).toEqual({
      ok: false,
      code: 'invalid_url',
    });
  });
});

describe('validateDestination — hosts de um rótulo e nomes de /etc/hosts', () => {
  it.each([
    'http://ip6-localhost/',
    'http://ip6-loopback/',
    'http://ip6-localnet/',
    'http://ip6-allnodes/',
    'http://ip6-allrouters/',
    'http://ip6-mcastprefix/',
    'http://IP6-LOCALHOST./',
    'http://ip6-localhost.:8080/x',
    'http://router/',
    'http://metadata/',
    'http://metadata/computeMetadata/v1/',
    'http://intranet',
    'https://intranet./',
    'http://wpad/',
    'http://com/',
    'http://xn--and-6ma2c/',
    'http://ñandú/',
  ])('%j → private_host', (raw) => {
    expect(codeOf(raw)).toBe('private_host');
  });

  it.each([
    'https://ip6-localhost.example.com/',
    'https://router.example.com/',
    'https://metadata.example.org/',
    'https://intranet.empresa.com.br/',
    'https://t.co/',
    'https://x.ai/',
    'https://com.br/',
  ])('domínio público com ponto continua aceito: %s', (raw) => {
    expect(check(raw).ok).toBe(true);
  });

  it('propriedade: qualquer domínio gerado (sempre com ponto) não é afetado pela regra', () => {
    fc.assert(
      fc.property(fc.domain(), (domain) => {
        const host = domain.toLowerCase();
        fc.pre(!/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host));
        fc.pre(!/(^|\.)(enc\.ta|go\.encurta\.dev)$/.test(host));
        let parsed: string;
        try {
          parsed = new URL(`https://${domain}/`).href;
        } catch {
          return; // rótulos que o WHATWG recusa (ex.: xn-- inválido) não são o alvo aqui
        }
        expect(check(`https://${domain}/`)).toEqual({ ok: true, url: parsed });
      }),
      { numRuns: 1000 },
    );
  });

  it('propriedade: rótulo único gerado é sempre private_host', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/), (label) => {
        expect(codeOf(`http://${label}/`)).toBe('private_host');
      }),
    );
  });
});

describe('shortDomains inválidos são erro de configuração', () => {
  it.each([
    ['com esquema', 'https://enc.ta'],
    ['com esquema sem barras', 'http:enc.ta'],
    ['vazio', ''],
    ['só espaços', '   '],
    ['com caminho', 'enc.ta/x'],
    ['com barra final', 'enc.ta/'],
    ['com porta', 'enc.ta:443'],
    ['com query', 'enc.ta?x'],
    ['com fragmento', 'enc.ta#x'],
    ['com credencial', 'u@enc.ta'],
    ['com espaço no meio', 'enc .ta'],
    ['com barra invertida', 'enc.ta\\x'],
    ['IPv4', '127.0.0.1'],
    ['IPv6', '[::1]'],
    ['um rótulo só', 'localhost'],
    ['só www', 'www.ta'],
    ['rótulo vazio', 'enc..ta'],
    ['ponto inicial', '.enc.ta'],
    ['caractere proibido', 'enc<.ta'],
    ['punycode inválido', 'xn--a.com'],
  ])('%s (%j) → TypeError', (_label, domain) => {
    expect(() => validateDestination('https://example.com/', { shortDomains: [domain] })).toThrow(
      TypeError,
    );
    expect(() => normalizeShortDomains([domain])).toThrow(TypeError);
  });

  it('não-string e não-lista → TypeError', () => {
    expect(() => normalizeShortDomains([42 as unknown as string])).toThrow(TypeError);
    expect(() => normalizeShortDomains('enc.ta' as unknown as string[])).toThrow(TypeError);
  });

  it('o erro de configuração aparece mesmo com destino inválido', () => {
    expect(() => validateDestination('javascript:x', { shortDomains: ['https://enc.ta'] })).toThrow(
      TypeError,
    );
  });

  it('normaliza os válidos: caixa, ponto final, www., IDN, espaços nas pontas', () => {
    expect(
      normalizeShortDomains(['ENC.TA', 'enc.ta.', 'www.Enc.Ta', ' go.encurta.dev ', 'ñandú.com']),
    ).toEqual(['enc.ta', 'enc.ta', 'enc.ta', 'go.encurta.dev', 'xn--and-6ma2c.com']);
  });

  it('lista vazia é válida (sem proteção de loop, por escolha explícita)', () => {
    expect(normalizeShortDomains([])).toEqual([]);
  });
});
