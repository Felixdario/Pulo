import { describe, expect, it } from 'vitest';
import { dimensionLabel, endSentence, seriesSummary } from './Charts';

describe('Charts (break-ui)', () => {
  it('fecha a frase sem dobrar o ponto da abreviação', () => {
    expect(endSentence('Nenhum clique humano de 12 de out. a 10 de nov.')).toBe(
      'Nenhum clique humano de 12 de out. a 10 de nov.',
    );
    expect(endSentence('Nenhum clique humano em 2026')).toBe('Nenhum clique humano em 2026.');
    expect(seriesSummary([], 'day', 'de 1 a 10 de nov.')).toBe(
      'Nenhum clique humano de 1 a 10 de nov.',
    );
  });

  it('"other" de aparelho e sistema tem nome em pt-BR', () => {
    expect(dimensionLabel('device', 'other')).toBe('TV, console e outros');
    expect(dimensionLabel('os', 'other')).toBe('Outro sistema');
    expect(dimensionLabel('city', 'BR/São Paulo')).toBe('São Paulo, BR');
  });
});
