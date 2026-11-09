import { inject } from 'vitest';
import { createDb, type CreateDbOptions } from '../../src/index';

export { resetTestDb } from '../../src/testing';

export function testDb(options: CreateDbOptions = {}) {
  return createDb(inject('testDatabaseUrl'), { max: 20, ...options });
}

/** Gerador roteirizado: devolve os slugs na ordem e falha se acabar. */
export function scripted(...slugs: string[]) {
  let i = 0;
  const calls: number[] = [];
  const gen = (attempt = 0) => {
    calls.push(attempt);
    const s = slugs[i++];
    if (s === undefined) throw new Error('gerador roteirizado esgotado');
    return s;
  };
  return Object.assign(gen, { calls });
}
