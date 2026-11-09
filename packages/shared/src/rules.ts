import { z } from 'zod';
import type { DeviceOs, DeviceType } from './device';

/**
 * Regras de destino guardadas em `links.rules` (jsonb). As URLs passam por `validateDestination`
 * na API, como o destino padrão; aqui só a forma.
 */
export const linkRulesSchema = z
  .object({
    geo: z
      .array(
        z
          .object({
            countries: z
              .array(z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alfa-2 em maiúsculas'))
              .min(1),
            url: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .optional(),
    device: z
      .array(
        z
          .object({
            match: z.enum(['ios', 'android', 'mobile', 'tablet', 'desktop']),
            url: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type LinkRules = z.infer<typeof linkRulesSchema>;

export interface ResolveContext {
  /** ISO-2 em maiúsculas, ou null quando desconhecido. */
  country?: string | null;
  device?: DeviceType;
  os?: DeviceOs;
}

export function hasGeoRules(rules: LinkRules | undefined): boolean {
  return (rules?.geo?.length ?? 0) > 0;
}

export function hasDeviceRules(rules: LinkRules | undefined): boolean {
  return (rules?.device?.length ?? 0) > 0;
}

/** Passo 8 do ADR 0002: regra de país → regra de dispositivo → destino padrão. Vence a 1ª que casar. */
export function resolveDestination(
  link: { destination: string; rules?: LinkRules | undefined },
  ctx: ResolveContext,
): string {
  const { rules } = link;
  if (rules?.geo && ctx.country) {
    const country = ctx.country.toUpperCase();
    const hit = rules.geo.find((r) => r.countries.includes(country));
    if (hit) return hit.url;
  }
  if (rules?.device && (ctx.device || ctx.os)) {
    const hit = rules.device.find((r) =>
      r.match === 'ios' || r.match === 'android' ? r.match === ctx.os : r.match === ctx.device,
    );
    if (hit) return hit.url;
  }
  return link.destination;
}
