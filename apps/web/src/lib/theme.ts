import { useSyncExternalStore } from 'react';

/**
 * Tema: acompanha o sistema por padrão; a escolha manual vai para `data-theme` no `<html>` (que o
 * tokens.css lê) e fica no localStorage só como conveniência. O script inline do index.html aplica
 * a escolha antes do primeiro paint, sem piscar.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'pulo-tema';
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let current: ThemeChoice = typeof window === 'undefined' ? 'system' : read();

export function setTheme(choice: ThemeChoice) {
  current = choice;
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* sem storage: vale só nesta aba */
  }
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  for (const fn of listeners) fn();
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => 'system',
  );
}

export const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'Tema do sistema',
  light: 'Tema claro',
  dark: 'Tema escuro',
};

export const nextTheme = (t: ThemeChoice): ThemeChoice =>
  t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system';
