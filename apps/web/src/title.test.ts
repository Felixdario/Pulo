import { describe, expect, it } from 'vitest';
import { pageTitle } from './title';

describe('pageTitle', () => {
  it('monta o título', () => {
    expect(pageTitle()).toBe('Pulo: encurte links, conte só gente');
    expect(pageTitle('Links')).toBe('Links · Pulo');
  });
});
