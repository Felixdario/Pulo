import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export function createMetrics(streamInfo: () => Promise<{ lag: number; pending: number } | null>) {
  const registry = new Registry();
  return {
    registry,
    processed: new Counter({
      name: 'clicks_processed_total',
      help: 'Cliques gravados (linha bruta nova) por tipo',
      labelNames: ['kind'] as const,
      registers: [registry],
    }),
    duplicates: new Counter({
      name: 'clicks_duplicates_total',
      help: 'Eventos reentregues descartados pelo ON CONFLICT',
      registers: [registry],
    }),
    unknownLink: new Counter({
      name: 'clicks_unknown_link_total',
      help: 'Eventos de link inexistente (descartados)',
      registers: [registry],
    }),
    tsMismatch: new Counter({
      name: 'clicks_ts_mismatch_total',
      help: 'Eventos cujo ts diverge mais de 1 s do tempo do UUIDv7 (vale o do UUID)',
      registers: [registry],
    }),
    reclaimed: new Counter({
      name: 'clicks_reclaimed_total',
      help: 'Mensagens reivindicadas de outro consumidor (ou de uma tentativa anterior)',
      registers: [registry],
    }),
    invalid: new Counter({
      name: 'clicks_invalid_total',
      help: 'Falhas de processamento: evento inválido ou recusado pelo banco',
      registers: [registry],
    }),
    dead: new Counter({
      name: 'clicks_dead_total',
      help: 'Mensagens movidas para a dead letter',
      registers: [registry],
    }),
    retries: new Counter({
      name: 'batch_retries_total',
      help: 'Lotes repetidos por erro transitório do Postgres',
      labelNames: ['reason'] as const,
      registers: [registry],
    }),
    batchSize: new Histogram({
      name: 'batch_size',
      help: 'Eventos por lote',
      buckets: [1, 10, 50, 100, 250, 500, 750, 1000],
      registers: [registry],
    }),
    batchDuration: new Histogram({
      name: 'batch_duration_seconds',
      help: 'Duração do enriquecimento + instrução SQL + XACK',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    lag: new Gauge({
      name: 'stream_lag',
      help: 'Entradas do stream ainda não entregues ao grupo (XINFO GROUPS lag)',
      registers: [registry],
      async collect() {
        const info = await streamInfo().catch(() => null);
        if (info) this.set(info.lag);
      },
    }),
    pending: new Gauge({
      name: 'stream_pending',
      help: 'Entradas entregues e ainda sem XACK (PEL do grupo)',
      registers: [registry],
      async collect() {
        const info = await streamInfo().catch(() => null);
        if (info) this.set(info.pending);
      },
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
