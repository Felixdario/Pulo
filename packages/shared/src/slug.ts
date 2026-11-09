import { isReservedSlug } from './reserved';

/** `[0-9A-Za-z]`, a ordem não importa para a distribuição. */
export const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Comprimento padrão por tentativa (0-based): 7 nas 3 primeiras, 8 da 4ª em diante (ADR 0001). */
export const DEFAULT_LENGTH_FOR_ATTEMPT = (attempt: number): number => (attempt >= 3 ? 8 : 7);

export type RandomBytes = (size: number) => Uint8Array;

export interface SlugGeneratorOptions {
  alphabet?: string;
  /** Recebe o número da tentativa, começando em 0. */
  lengthForAttempt?: (attempt: number) => number;
  /** Fonte de bytes uniformes. Padrão: `crypto.getRandomValues` (CSPRNG, mesma fonte do randomBytes). */
  randomBytes?: RandomBytes;
}

export type SlugGenerator = (attempt?: number) => string;

const POOL_SIZE = 512;

const cryptoRandomBytes: RandomBytes = (size) => {
  const out = new Uint8Array(size);
  // getRandomValues aceita no máximo 65.536 bytes por chamada.
  for (let offset = 0; offset < size; offset += 65_536) {
    globalThis.crypto.getRandomValues(out.subarray(offset, Math.min(size, offset + 65_536)));
  }
  return out;
};

/**
 * Gerador de slugs por amostragem por rejeição: um byte `b` vira `alphabet[b % n]` só se
 * `b < floor(256 / n) * n`; os outros são descartados. Assim cada símbolo tem exatamente a mesma
 * probabilidade (sem viés de módulo). Slugs reservados são descartados e sorteados de novo.
 *
 * Os bytes vêm de um buffer interno reabastecido em blocos de 512 e consumidos em ordem, sem sobras
 * descartadas, o que também permite o teste determinístico de viés.
 */
export function createSlugGenerator(options: SlugGeneratorOptions = {}): SlugGenerator {
  const alphabet = options.alphabet ?? BASE62;
  const lengthForAttempt = options.lengthForAttempt ?? DEFAULT_LENGTH_FOR_ATTEMPT;
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;

  const symbols = Array.from(alphabet);
  const n = symbols.length;
  if (n < 2 || n > 256) {
    throw new RangeError('o alfabeto precisa ter entre 2 e 256 símbolos');
  }
  if (new Set(symbols).size !== n) {
    throw new RangeError('o alfabeto tem símbolos repetidos');
  }
  const limit = Math.floor(256 / n) * n;

  let pool: Uint8Array = new Uint8Array(0);
  let pos = 0;

  const nextSymbol = (): string => {
    for (;;) {
      if (pos >= pool.length) {
        pool = randomBytes(POOL_SIZE);
        pos = 0;
        if (pool.length === 0) throw new Error('randomBytes devolveu 0 bytes');
      }
      const byte = pool[pos++]!;
      if (byte < limit) return symbols[byte % n]!;
    }
  };

  return (attempt = 0) => {
    const length = lengthForAttempt(attempt);
    if (!Number.isInteger(length) || length < 1) {
      throw new RangeError(`comprimento inválido para a tentativa ${attempt}: ${length}`);
    }
    for (;;) {
      let slug = '';
      for (let i = 0; i < length; i++) slug += nextSymbol();
      if (!isReservedSlug(slug)) return slug;
    }
  };
}

const defaultGenerator = createSlugGenerator();

/** Slug aleatório com o gerador padrão (BASE62, 7 caracteres na tentativa 0). */
export function generateSlug(attempt = 0): string {
  return defaultGenerator(attempt);
}
