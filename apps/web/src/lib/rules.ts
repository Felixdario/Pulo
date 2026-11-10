import type { DeviceMatch, Link, LinkListItem } from './api/types';
import { dateTimeShort, hostOf, num } from './format';

/** "A regra se explica" (PRODUCT.md): cada regra vira uma frase, na ordem do redirect (ADR 0002). */

export const DEVICE_LABEL: Record<DeviceMatch, string> = {
  ios: 'iPhone e iPad',
  android: 'Android',
  mobile: 'Celular',
  tablet: 'Tablet',
  desktop: 'Computador',
};

/** O aparelho dentro da frase ("No iPhone e iPad", "No celular"): nomes próprios ficam como são. */
const DEVICE_IN_SENTENCE: Record<DeviceMatch, string> = {
  ios: 'iPhone e iPad',
  android: 'Android',
  mobile: 'celular',
  tablet: 'tablet',
  desktop: 'computador',
};

export type ChipTone = 'neutro' | 'aviso' | 'negativo';

export interface RuleChip {
  key: string;
  text: string;
  tone: ChipTone;
  /** Frase longa (tooltip e página do link). */
  sentence: string;
}

function pathOrHost(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, '');
    const path = u.pathname === '/' ? '' : u.pathname;
    return host.length + path.length > 24 && path ? path : `${host}${path}`;
  } catch {
    return url;
  }
}

export function ruleChips(link: Link | LinkListItem, now = Date.now()): RuleChip[] {
  const chips: RuleChip[] = [];
  if (link.status === 'disabled') {
    chips.push({
      key: 'status',
      text: 'Desativado',
      tone: 'neutro',
      sentence: 'Desativado: quem abrir o link vê "não encontrado".',
    });
  }
  if (link.status === 'blocked_loop') {
    chips.push({
      key: 'status',
      text: 'Bloqueado (loop)',
      tone: 'negativo',
      sentence: 'Bloqueado: o destino voltava para um link curto nosso.',
    });
  }
  if (link.expires_at) {
    const at = new Date(link.expires_at).getTime();
    const past = link.is_expired || at <= now;
    const soon = !past && at - now < 3 * 86_400_000;
    chips.push({
      key: 'expires',
      text: past
        ? `Expirou ${dateTimeShort(link.expires_at).split(' ')[0]}`
        : `Expira ${dateTimeShort(link.expires_at)}`,
      tone: past ? 'negativo' : soon ? 'aviso' : 'neutro',
      sentence: past
        ? `Expirou em ${dateTimeShort(link.expires_at)}.`
        : `Expira em ${dateTimeShort(link.expires_at)}.`,
    });
  }
  if (link.has_password) {
    chips.push({
      key: 'password',
      text: 'Com senha',
      tone: 'neutro',
      sentence: 'Pede senha antes de abrir.',
    });
  }
  if (link.max_clicks !== null) {
    const used = 'click_count' in link ? link.click_count : null;
    const left = used === null ? null : Math.max(0, link.max_clicks - used);
    const done = left === 0;
    const near = left !== null && !done && used! >= link.max_clicks * 0.9;
    chips.push({
      key: 'limit',
      text: done
        ? 'Limite atingido'
        : near
          ? `Faltam ${num(left)} de ${num(link.max_clicks)}`
          : `Para em ${num(link.max_clicks)}`,
      tone: done ? 'negativo' : near ? 'aviso' : 'neutro',
      sentence: done
        ? `Atingiu o limite de ${num(link.max_clicks)} cliques humanos.`
        : `Para depois de ${num(link.max_clicks)} cliques humanos.`,
    });
  }
  for (const [i, g] of (link.rules.geo ?? []).entries()) {
    chips.push({
      key: `geo-${i}`,
      text: `${g.countries.slice(0, 3).join(', ')}${g.countries.length > 3 ? '…' : ''} → ${pathOrHost(g.url)}`,
      tone: 'neutro',
      sentence: `De ${g.countries.join(', ')}, vai para ${hostOf(g.url)}.`,
    });
  }
  for (const [i, d] of (link.rules.device ?? []).entries()) {
    chips.push({
      key: `device-${i}`,
      text: `${DEVICE_LABEL[d.match]} → ${pathOrHost(d.url)}`,
      tone: 'neutro',
      sentence: `No ${DEVICE_IN_SENTENCE[d.match]}, vai para ${hostOf(d.url)}.`,
    });
  }
  if (link.redirect_type !== 302) {
    chips.push({
      key: 'type',
      text: String(link.redirect_type),
      tone: 'neutro',
      sentence:
        link.redirect_type === 301 || link.redirect_type === 308
          ? `Redirect ${link.redirect_type} (permanente): o navegador guarda e pode não contar cliques repetidos.`
          : `Redirect ${link.redirect_type} (temporário, preserva o método).`,
    });
  }
  // Repassar a query é o padrão; o chip só aparece quando o link foge dele.
  if (!link.forward_query) {
    chips.push({
      key: 'query',
      text: 'Não repassa ?utm',
      tone: 'neutro',
      sentence: 'Não repassa a query do link curto: o destino recebe só a própria.',
    });
  }
  return chips;
}

export const isPermanent = (t: number) => t === 301 || t === 308;
