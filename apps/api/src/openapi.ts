import { SHARED_VERSION } from '@encurtador/shared';

/** Rotas autenticadas aceitam qualquer um dos dois esquemas (ADR 0004). */
export const SECURITY = [{ bearerAuth: [] }, { apiKey: [] }];

export const OPENAPI_DOCUMENT = {
  openapi: '3.0.3',
  info: {
    title: 'Encurtador API',
    version: SHARED_VERSION,
    description: [
      'API `/v1` do encurtador (ADR 0004).',
      '',
      '- **Dashboard:** `POST /v1/auth/login` devolve um access token JWT de 15 min (envie em `Authorization: Bearer`) e grava o refresh em cookie httpOnly. `/refresh` e `/logout` exigem `X-Requested-With: encurtador`.',
      '- **Integrações:** chave `enc_<8>_<32>` em `Authorization: Bearer enc_…` ou `X-API-Key`, com escopos `links:read`, `links:write` e `stats:read` (sem o escopo: 403).',
      '- **Erros:** sempre `application/problem+json` (RFC 9457); validação é 422 com `errors[]`.',
      '- **Rate limit:** token bucket por usuário/chave (120, 2/s); toda resposta traz `RateLimit-Limit`, `RateLimit-Remaining` e `RateLimit-Reset`, e o 429 traz `Retry-After`.',
      '- **Idempotência:** POSTs de criação aceitam `Idempotency-Key` (24 h); a repetição devolve a mesma resposta com `Idempotent-Replayed: true`.',
      '- **Cache HTTP:** leituras têm ETag (304 com `If-None-Match`); o PATCH de link aceita `If-Match` (412 se divergir).',
    ].join('\n'),
  },
  tags: [
    { name: 'auth', description: 'Cadastro, login e sessão do dashboard' },
    { name: 'api-keys', description: 'Chaves de API (só pela sessão do dashboard)' },
    { name: 'links', description: 'Links curtos' },
    { name: 'stats', description: 'Estatísticas de um link (só agregados)' },
    { name: 'overview', description: 'Visão geral da conta' },
    { name: 'live', description: 'Cliques ao vivo por SSE' },
    { name: 'preview', description: 'Prévia do destino (título, descrição, imagem)' },
    { name: 'public', description: 'Encurtar sem login' },
    { name: 'infra', description: 'Saúde do serviço' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http' as const,
        scheme: 'bearer',
        bearerFormat: 'JWT (dashboard) ou chave enc_<8>_<32>',
        description: 'Access token do login/refresh, ou uma chave de API.',
      },
      apiKey: {
        type: 'apiKey' as const,
        in: 'header' as const,
        name: 'X-API-Key',
        description: 'Chave de API `enc_<prefixo>_<segredo>`.',
      },
    },
  },
};
