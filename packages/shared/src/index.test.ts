import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isReservedSlug, SHARED_VERSION } from './index';

describe('shared', () => {
  it('expõe a versão', () => {
    expect(SHARED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('nenhum slug é reservado enquanto a lista está vazia', () => {
    fc.assert(fc.property(fc.string(), (slug) => !isReservedSlug(slug)));
  });
});
