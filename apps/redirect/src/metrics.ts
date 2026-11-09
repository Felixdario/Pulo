import { Counter, Histogram, Registry } from 'prom-client';

export type CacheLabel = 'hit' | 'miss' | 'negative' | 'bypass' | 'none';

/** Um registro por app, para que os testes possam subir várias instâncias. */
export function createMetrics() {
  const registry = new Registry();
  return {
    registry,
    duration: new Histogram({
      name: 'redirect_duration_seconds',
      help: 'Tempo de resposta do GET/POST /:slug',
      labelNames: ['status', 'cache'] as const,
      buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [registry],
    }),
    cacheRequests: new Counter({
      name: 'cache_requests_total',
      help: 'Consultas ao cache de links por resultado',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
    rateLimited: new Counter({
      name: 'rate_limited_total',
      help: 'Respostas 429 do token bucket',
      labelNames: ['bucket'] as const,
      registers: [registry],
    }),
    publishFailed: new Counter({
      name: 'clicks_publish_failed_total',
      help: 'XADD que falhou (o evento vai para o buffer em memória)',
      registers: [registry],
    }),
    dropped: new Counter({
      name: 'clicks_dropped_total',
      help: 'Eventos descartados porque o buffer em memória encheu',
      registers: [registry],
    }),
    redisFallback: new Counter({
      name: 'redis_fallback_total',
      help: 'Requisições servidas direto do Postgres porque o Redis falhou',
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
