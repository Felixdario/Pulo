import { describe, expect, it } from 'vitest';
import { chiSquarePValue, erfc } from './stats';

describe('aproximação de Wilson–Hilferty', () => {
  // Valores críticos tabelados da qui-quadrado (cauda superior).
  it.each([
    [18.307, 10, 0.05],
    [23.209, 10, 0.01],
    [79.082, 60, 0.05],
    [88.379, 60, 0.01],
    [99.607, 60, 0.001],
    [124.342, 100, 0.05],
    [149.449, 100, 0.001],
  ])('χ² = %d com %d g.l. → p ≈ %d', (stat, df, p) => {
    expect(Math.abs(chiSquarePValue(stat, df) - p) / p).toBeLessThan(0.08);
  });

  it('erfc nos pontos conhecidos', () => {
    expect(erfc(0)).toBeCloseTo(1, 6);
    expect(erfc(1)).toBeCloseTo(0.157299207, 6);
    expect(erfc(-1)).toBeCloseTo(1.842700793, 6);
    expect(erfc(3)).toBeCloseTo(2.2090497e-5, 9);
  });
});
