import { z } from 'zod';

const datetime = z.iso.datetime({ offset: true });

const rulesSchema = z
  .object({
    geo: z
      .array(
        z
          .object({
            countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
            url: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .max(50)
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
      .max(10)
      .optional(),
  })
  .strict()
  .meta({
    description:
      'Regras de destino: país (ISO 3166-1 alfa-2) → dispositivo → destino padrão; vence a primeira que casar.',
    example: {
      geo: [{ countries: ['PT', 'BR'], url: 'https://exemplo.com/pt' }],
      device: [{ match: 'ios', url: 'https://apps.apple.com/app/id1' }],
    },
  });

const redirectType = z
  .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
  .meta({ description: '301, 302 (padrão), 307 ou 308', example: 302 });

const linkFields = {
  destination: z
    .string()
    .min(1)
    .max(4096)
    .meta({ example: 'https://exemplo.com/promo?utm_source=x' }),
  title: z.string().max(500).nullable(),
  redirect_type: redirectType,
  cache_ttl: z.number().int().min(0).max(31_536_000),
  expires_at: datetime.nullable(),
  max_clicks: z.number().int().min(1).max(1_000_000_000).nullable(),
  password: z.string().min(4).max(1024).nullable(),
  forward_query: z.boolean(),
  rules: rulesSchema,
  status: z.enum(['active', 'disabled']),
};

export const createLinkBody = z
  .object({
    destination: linkFields.destination,
    alias: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .meta({ description: 'Slug escolhido (só na criação).', example: 'promo-natal' }),
    title: linkFields.title.optional(),
    redirect_type: linkFields.redirect_type.optional(),
    cache_ttl: linkFields.cache_ttl.optional(),
    expires_at: linkFields.expires_at.optional(),
    max_clicks: linkFields.max_clicks.optional(),
    password: linkFields.password.optional(),
    forward_query: linkFields.forward_query.optional(),
    rules: linkFields.rules.optional(),
    status: linkFields.status.optional(),
  })
  .strict()
  .meta({
    id: 'LinkCreate',
    example: {
      destination: 'https://exemplo.com/promo',
      alias: 'promo-natal',
      title: 'Promoção de Natal',
      redirect_type: 302,
    },
  });

export type CreateLinkBody = z.infer<typeof createLinkBody>;

/** Slug e alias ficam de fora: o link curto é imutável depois de publicado. */
export const patchLinkBody = z
  .object({
    destination: linkFields.destination.optional(),
    title: linkFields.title.optional(),
    redirect_type: linkFields.redirect_type.optional(),
    cache_ttl: linkFields.cache_ttl.optional(),
    expires_at: linkFields.expires_at.optional(),
    max_clicks: linkFields.max_clicks.optional(),
    password: linkFields.password.optional(),
    forward_query: linkFields.forward_query.optional(),
    rules: linkFields.rules.optional(),
    status: linkFields.status.optional(),
  })
  .strict()
  .meta({
    id: 'LinkPatch',
    description: 'Campos a mudar. `password: null` remove a senha. Slug e alias não mudam.',
    example: { title: 'Novo título', status: 'disabled' },
  });

export type PatchLinkBody = z.infer<typeof patchLinkBody>;

export const linkSchema = z
  .object({
    id: z.number().int(),
    slug: z.string(),
    short_url: z.string(),
    is_custom: z.boolean(),
    destination: z.string(),
    title: z.string().nullable(),
    redirect_type: z.number().int(),
    cache_ttl: z.number().int(),
    status: z.enum(['active', 'disabled', 'blocked_loop']),
    is_expired: z.boolean(),
    expires_at: z.string().nullable(),
    max_clicks: z.number().int().nullable(),
    has_password: z.boolean(),
    forward_query: z.boolean(),
    rules: z.record(z.string(), z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .meta({
    id: 'Link',
    description:
      'Link curto. Contadores ficam fora (veja /stats/summary e a listagem): o ETag forte do link muda só quando ele é editado.',
    example: {
      id: 42,
      slug: 'promo-natal',
      short_url: 'https://encurta.dev/promo-natal',
      is_custom: true,
      destination: 'https://exemplo.com/promo',
      title: 'Promoção de Natal',
      redirect_type: 302,
      cache_ttl: 3600,
      status: 'active',
      is_expired: false,
      expires_at: null,
      max_clicks: null,
      has_password: false,
      forward_query: true,
      rules: {},
      created_at: '2026-11-09T12:00:00.000Z',
      updated_at: '2026-11-09T12:00:00.000Z',
    },
  });

export const linkListItemSchema = linkSchema
  .extend({ click_count: z.number().int() })
  .meta({ id: 'LinkListItem' });

export const listQuery = z
  .object({
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().min(1).max(200).optional(),
    status: z.enum(['active', 'disabled', 'expired']).optional(),
    created_from: z.union([z.iso.date(), datetime]).optional(),
    created_to: z.union([z.iso.date(), datetime]).optional(),
    has_password: z.enum(['true', 'false']).optional(),
    sort: z.enum(['created_at', 'clicks', 'title']).default('created_at'),
    order: z.enum(['asc', 'desc']).optional(),
  })
  .strict();

export const idParams = z.object({
  id: z.coerce
    .number()
    .int()
    .positive()
    .max(2 ** 53 - 1),
});

export const batchBody = z
  .object({
    links: z.array(z.record(z.string(), z.unknown())).min(1).max(1000).meta({
      description: 'Até 1.000 itens no formato de LinkCreate; cada um é validado à parte.',
    }),
  })
  .strict()
  .meta({
    example: {
      links: [
        { destination: 'https://exemplo.com/a' },
        { destination: 'https://exemplo.com/b', alias: 'bb' },
      ],
    },
  });

export const batchResultSchema = z.object({
  created: z.number().int(),
  failed: z.number().int(),
  results: z.array(
    z.object({
      index: z.number().int(),
      status: z.number().int(),
      link: linkSchema.optional(),
      error: z
        .object({
          code: z.string(),
          title: z.string(),
          detail: z.string().optional(),
          errors: z
            .array(z.object({ field: z.string(), code: z.string(), message: z.string() }))
            .optional(),
        })
        .optional(),
    }),
  ),
});
