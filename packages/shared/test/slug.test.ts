import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BASE62,
  createSlugGenerator,
  DEFAULT_LENGTH_FOR_ATTEMPT,
  generateSlug,
  type RandomBytes,
} from '../src/index';
import { chiSquarePValue } from './stats';

/** Fonte determinística que percorre 0..255 em ciclo, cobrindo todos os bytes igualmente. */
function cyclingBytes(): { randomBytes: RandomBytes; consumed: () => number } {
  let next = 0;
  let total = 0;
  return {
    randomBytes: (size) => {
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i++) out[i] = next++ & 0xff;
      total += size;
      return out;
    },
    consumed: () => total,
  };
}

function countSymbols(slugs: string[], alphabet: string): number[] {
  const counts = new Array<number>(alphabet.length).fill(0);
  for (const s of slugs) for (const ch of s) counts[alphabet.indexOf(ch)]!++;
  return counts;
}

describe('createSlugGenerator', () => {
  it('sem viés de módulo: bytes 0..255 igualmente → cada símbolo BASE62 sai o mesmo número de vezes', () => {
    const { randomBytes } = cyclingBytes();
    // 248 bytes aceitos por ciclo de 256 e 8 símbolos por slug: 31 slugs por ciclo.
    const cycles = 40;
    const gen = createSlugGenerator({ randomBytes, lengthForAttempt: () => 8 });
    const slugs = Array.from({ length: 31 * cycles }, () => gen());
    const counts = countSymbols(slugs, BASE62);
    expect(new Set(counts)).toEqual(new Set([4 * cycles]));
  });

  it('o mesmo vale para alfabetos que não dividem 256 (3, 7, 100) e que dividem (2, 256)', () => {
    for (const size of [2, 3, 7, 100, 256]) {
      const alphabet = Array.from({ length: size }, (_, i) =>
        String.fromCodePoint(0x4e00 + i),
      ).join('');
      const { randomBytes } = cyclingBytes();
      const limit = Math.floor(256 / size) * size;
      const gen = createSlugGenerator({ alphabet, randomBytes, lengthForAttempt: () => 1 });
      // 10 ciclos completos de bytes aceitos.
      const slugs = Array.from({ length: limit * 10 }, () => gen());
      const counts = countSymbols(slugs, alphabet);
      expect(new Set(counts)).toEqual(new Set([(limit / size) * 10]));
    }
  });

  it('descarta bytes ≥ 248 com BASE62', () => {
    const bytes = [248, 249, 250, 251, 252, 253, 254, 255, 5, 61, 62, 247];
    let i = 0;
    const gen = createSlugGenerator({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => bytes[i++ % bytes.length]!),
      lengthForAttempt: () => 4,
    });
    // 5 → '5'; 61 → 'z'; 62 → 62 % 62 = 0 → '0'; 247 → 247 % 62 = 61 → 'z'.
    expect(gen()).toBe('5z0z');
  });

  it('a modulação ingênua teria viés detectável pelo mesmo teste estatístico', () => {
    // Controle negativo: garante que o qui-quadrado tem poder para pegar `byte % 62`.
    const counts = new Array<number>(62).fill(0);
    const buf = randomBytes(1_000_000);
    for (const b of buf) counts[b % 62]!++;
    const expected = buf.length / 62;
    const stat = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);
    expect(chiSquarePValue(stat, 61)).toBeLessThan(1e-6);
  });

  it('comprimento por tentativa: 7, 7, 7, 8, 8 (tentativa começa em 0)', () => {
    expect([0, 1, 2, 3, 4].map(DEFAULT_LENGTH_FOR_ATTEMPT)).toEqual([7, 7, 7, 8, 8]);
    expect([0, 1, 2, 3, 4].map((a) => generateSlug(a).length)).toEqual([7, 7, 7, 8, 8]);
  });

  it('nunca devolve slug reservado (re-sorteia)', () => {
    // Fonte que produz "api" (BASE62: a=36, p=51, i=44) e depois "xyz".
    const seq = [36, 51, 44, 59, 60, 61];
    let i = 0;
    const gen = createSlugGenerator({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => seq[i++ % seq.length]!),
      lengthForAttempt: () => 3,
    });
    expect(gen()).toBe('xyz');
  });

  it('rejeita alfabetos inválidos', () => {
    expect(() => createSlugGenerator({ alphabet: 'a' })).toThrow(RangeError);
    expect(() => createSlugGenerator({ alphabet: 'aab' })).toThrow(RangeError);
    expect(() => createSlugGenerator({ alphabet: 'x'.repeat(0) })).toThrow(RangeError);
    expect(() => createSlugGenerator({ lengthForAttempt: () => 0 })()).toThrow(RangeError);
  });

  it('propriedade: qualquer alfabeto e qualquer fonte de bytes geram só símbolos do alfabeto', () => {
    fc.assert(
      fc.property(
        // Sem letras: nenhuma palavra reservada pode se formar e o laço de re-sorteio sempre termina.
        fc.uniqueArray(fc.constantFrom(...'0123456789!#$%&*+,/:;<=>?@^_`|~'), {
          minLength: 2,
          maxLength: 31,
        }),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: 1, max: 16 }),
        (symbols, seed, length) => {
          const alphabet = symbols.join('');
          const limit = Math.floor(256 / symbols.length) * symbols.length;
          // Garante ao menos um byte aceito na fonte para o gerador sempre terminar.
          const bytes = [...seed, limit - 1];
          let i = 0;
          const gen = createSlugGenerator({
            alphabet,
            lengthForAttempt: () => length,
            randomBytes: (size) =>
              Uint8Array.from({ length: size }, () => bytes[i++ % bytes.length]!),
          });
          const slug = gen();
          return Array.from(slug).length === length && [...slug].every((c) => symbols.includes(c));
        },
      ),
    );
  });
});
