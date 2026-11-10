import { validateAlias } from '@encurtador/shared';

/**
 * Validação ao vivo do alias. Usa o mesmo `validateAlias` de `packages/shared` que a API usa
 * (formato `ALIAS_REGEX` e lista de reservados), então a tela e o servidor nunca discordam.
 */
export type AliasCheck =
  | { state: 'empty' }
  | { state: 'ok' }
  | { state: 'error'; code: 'alias_format' | 'alias_reserved' | 'alias_short'; message: string };

export function checkAlias(raw: string): AliasCheck {
  const alias = raw.trim();
  if (alias === '') return { state: 'empty' };
  const v = validateAlias(alias);
  if (v.ok) return { state: 'ok' };
  if (v.code === 'alias_reserved') {
    return {
      state: 'error',
      code: 'alias_reserved',
      message: `"${alias}" é um nome reservado pelo sistema. Escolha outro.`,
    };
  }
  if (alias.length < 3) {
    return { state: 'error', code: 'alias_short', message: 'Use pelo menos 3 caracteres.' };
  }
  if (alias.length > 64) {
    return {
      state: 'error',
      code: 'alias_format',
      message: `Use no máximo 64 caracteres (agora são ${alias.length}).`,
    };
  }
  if (!/^[A-Za-z0-9]/.test(alias)) {
    return {
      state: 'error',
      code: 'alias_format',
      message: 'Comece com uma letra ou um número.',
    };
  }
  const bad = [...new Set(alias.replace(/[A-Za-z0-9_-]/g, ''))];
  const shown = bad.map((c) => (c === ' ' ? 'espaço' : `"${c}"`)).join(', ');
  return {
    state: 'error',
    code: 'alias_format',
    message: `Só letras sem acento, números, _ e -. Tire ${shown}.`,
  };
}

/**
 * Aceita colar sem `https://` e completa (DESIGN.md > Input de URL). Não decide se o endereço é
 * válido: quem decide é a API, que conhece rede privada e loop.
 */
export function completeUrl(raw: string): string {
  const v = raw.trim();
  if (v === '') return v;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (/^(mailto|tel|javascript|data|ftp):/i.test(v)) return v;
  return `https://${v.replace(/^\/\//, '')}`;
}

/** Checagem leve no cliente, só para o erro óbvio antes de ir à rede. */
export function looksLikeUrl(raw: string): boolean {
  try {
    const u = new URL(completeUrl(raw));
    const h = u.hostname;
    // localhost e IPv6 passam: a API responde com a frase certa (rede privada).
    const hostOk = h.includes('.') || h === 'localhost' || h.startsWith('[');
    return (u.protocol === 'http:' || u.protocol === 'https:') && hostOk;
  } catch {
    return false;
  }
}
