import countries from 'i18n-iso-countries';

/**
 * Países: os códigos (ISO 3166-1) vêm do `i18n-iso-countries` (só a tabela de códigos, sem os
 * nomes de outros idiomas) e o nome em pt-BR vem do `Intl.DisplayNames` do próprio navegador.
 */
const names = new Intl.DisplayNames(['pt-BR'], { type: 'region', fallback: 'code' });

export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return 'Desconhecido';
  try {
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

const collator = new Intl.Collator('pt-BR');

/** Todos os códigos alfa-2, ordenados pelo nome em pt-BR. */
export const ALL_COUNTRIES: string[] = Object.keys(countries.getAlpha2Codes()).sort((a, b) =>
  collator.compare(countryName(a), countryName(b)),
);

/** Id numérico do world-atlas (`"076"`) → alfa-2 (`"BR"`). */
export function numericToAlpha2(id: string | number | undefined): string | null {
  if (id === undefined) return null;
  return countries.numericToAlpha2(String(id).padStart(3, '0')) ?? null;
}
