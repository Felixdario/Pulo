import { describe, expect, it } from 'vitest';
import { pageTitle } from './title';

describe('pageTitle', () => {
  it('monta o título', () => {
    expect(pageTitle()).toBe('Encurtador');
    expect(pageTitle('Links')).toBe('Links · Encurtador');
  });
});
