import type { Redis } from 'ioredis';

type Listener = (message: string) => void;

/**
 * Uma conexão de SUBSCRIBE por processo, compartilhada por todos os SSE (ADR 0004). O canal
 * `live:<user_id>` é assinado no primeiro ouvinte e desassinado quando o último sai.
 */
export class LiveHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private closed = false;

  constructor(private readonly sub: Redis) {
    sub.on('message', (channel: string, message: string) => {
      for (const fn of this.listeners.get(channel) ?? []) fn(message);
    });
  }

  async subscribe(channel: string, fn: Listener): Promise<() => Promise<void>> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(fn);
    return async () => {
      const s = this.listeners.get(channel);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) {
        this.listeners.delete(channel);
        if (!this.closed) await this.sub.unsubscribe(channel).catch(() => {});
      }
    };
  }

  /** Quantos canais estão assinados (testes). */
  get channels(): number {
    return this.listeners.size;
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
    this.sub.disconnect();
  }
}
