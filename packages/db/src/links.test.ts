import { describe, expect, it } from 'vitest';
import { compareBytes } from './links';

describe('compareBytes', () => {
  it('ordena igual à comparação de bytes UTF-8 (COLLATE "C")', () => {
    const words = ['b', 'a', 'B', 'aa', 'a-', 'a_', 'Z', '0', '', 'ä', '￿', '😀', 'a😀', 'a￿'];
    const byBytes = [...words].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    expect([...words].sort(compareBytes)).toEqual(byBytes);
  });

  it('difere de < em UTF-16 e de localeCompare onde precisa', () => {
    // U+FFFF < U+1F600 em ponto de código, mas o par substituto 0xD83D < 0xFFFF em UTF-16.
    expect(compareBytes('￿', '😀')).toBeLessThan(0);
    expect(compareBytes('B', 'a')).toBeLessThan(0);
    expect(compareBytes('abc', 'abc')).toBe(0);
  });
});
