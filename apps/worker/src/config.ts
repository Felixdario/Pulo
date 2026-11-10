import os from 'node:os';

export interface WorkerConfig {
  stream: string;
  group: string;
  consumer: string;
  /** Tamanho máximo do lote (eventos). */
  batchSize: number;
  /** Tempo máximo que um lote espera para encher. */
  flushIntervalMs: number;
  /** BLOCK do XREADGROUP quando o lote está vazio. */
  blockMs: number;
  /** A cada quanto tempo roda o XAUTOCLAIM. */
  reclaimIntervalMs: number;
  /** Idade mínima de uma pendência para ser reivindicada. */
  reclaimIdleMs: number;
  /**
   * Com esta quantidade de falhas reais de processamento (erro de dado do Postgres), a mensagem vai
   * para `<stream>:dead`. Evento inválido vai direto; reentrega por consumidor morto não conta.
   */
  maxDeliveries: number;
  /** Prazo do stop(): depois dele sai sem confirmar o lote em andamento (o PEL cobre). */
  stopTimeoutMs: number;
  /** statement_timeout da conexão do worker. */
  statementTimeoutMs: number;
  metricsPort: number;
  /** Prefixo do canal Pub/Sub do ao vivo (`<prefixo><user_id>`), o mesmo da API. */
  liveChannelPrefix: string;
  /**
   * Retenção da bruta `clicks` em meses completos (`CLICK_RETENTION_MONTHS`). Vazio = nunca apaga
   * (padrão). Com N, a cada 12 h o worker chama `drop_old_click_partitions(N)` (migração 0004).
   */
  clickRetentionMonths: number | null;
}

const int = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new TypeError(`inteiro inválido: "${v}"`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    stream: env.CLICKS_STREAM ?? 'clicks',
    group: env.CLICKS_GROUP ?? 'workers',
    consumer: env.WORKER_CONSUMER ?? `${os.hostname()}-${process.pid}`,
    batchSize: int(env.WORKER_BATCH_SIZE, 1000),
    flushIntervalMs: int(env.WORKER_FLUSH_MS, 500),
    blockMs: int(env.WORKER_BLOCK_MS, 2000),
    reclaimIntervalMs: int(env.WORKER_RECLAIM_INTERVAL_MS, 30_000),
    reclaimIdleMs: int(env.WORKER_RECLAIM_IDLE_MS, 60_000),
    maxDeliveries: int(env.WORKER_MAX_DELIVERIES, 5),
    stopTimeoutMs: int(env.WORKER_STOP_TIMEOUT_MS, 20_000),
    statementTimeoutMs: int(env.WORKER_STATEMENT_TIMEOUT_MS, 30_000),
    metricsPort: int(env.WORKER_METRICS_PORT, 9464),
    liveChannelPrefix: env.LIVE_CHANNEL_PREFIX?.trim() || 'live:',
    clickRetentionMonths:
      env.CLICK_RETENTION_MONTHS === undefined || env.CLICK_RETENTION_MONTHS.trim() === ''
        ? null
        : int(env.CLICK_RETENTION_MONTHS, 0),
  };
}
