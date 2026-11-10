import type { Database } from '@encurtador/db';
import type { ApiScope } from '@encurtador/db';
import type { Redis } from 'ioredis';
import type { ApiConfig } from './config';

export interface AuthContext {
  userId: number;
  /** `session`: JWT do dashboard (todos os escopos). `key`: chave de API com os escopos marcados. */
  kind: 'session' | 'key';
  keyId: number | null;
  scopes: ReadonlySet<ApiScope>;
}

export interface Ctx {
  db: Database;
  redis: Redis;
  config: ApiConfig;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    /** Por que as credenciais enviadas foram recusadas (detalhe do 401). */
    authFailure: string | null;
    idempotency: { userId: number; key: string; finished: boolean } | null;
  }
  interface FastifyContextConfig {
    /** `none`: rota sem login (auth, público, SSE com ticket). Padrão nas rotas /v1: exigido. */
    auth?: 'required' | 'none';
    /** Escopo exigido de chaves de API (o JWT tem todos). */
    scope?: ApiScope;
    /** Só a sessão do dashboard (criar e revogar chaves). */
    sessionOnly?: boolean;
    /** Aceita `Idempotency-Key`. */
    idempotent?: boolean;
  }
}
