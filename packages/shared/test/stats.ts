/**
 * Valor-p da cauda superior de uma qui-quadrado, pela aproximação de Wilson–Hilferty (1931):
 * se X ~ χ²(k), então (X/k)^(1/3) é aproximadamente normal com média 1 − 2/(9k) e variância 2/(9k).
 * Para k = 61 o erro absoluto perto de p = 0,001 fica abaixo de 10⁻⁴, mais que suficiente para um
 * limiar de 0,001. A normal usa erfc de Numerical Recipes (erro relativo < 1,2 × 10⁻⁷).
 */
export function chiSquarePValue(statistic: number, df: number): number {
  const v = 2 / (9 * df);
  const z = (Math.cbrt(statistic / df) - (1 - v)) / Math.sqrt(v);
  return 0.5 * erfc(z / Math.SQRT2);
}

export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** Estatística de Pearson para contagens observadas contra a uniforme. */
export function chiSquareUniform(counts: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < counts.length; i++) total += counts[i]!;
  const expected = total / counts.length;
  let stat = 0;
  for (let i = 0; i < counts.length; i++) {
    const d = counts[i]! - expected;
    stat += (d * d) / expected;
  }
  return stat;
}
