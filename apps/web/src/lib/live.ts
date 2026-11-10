import { useEffect, useRef, useState } from 'react';
import type { LiveClick } from './api/types';
import { api } from './session';

/**
 * SSE ao vivo (ADR 0004): pede um ticket de uso único (`POST /v1/live/ticket`) e abre o
 * `EventSource`. O ticket não serve para reconectar, então a reconexão automática do EventSource é
 * desligada e refeita aqui com um ticket novo e espera crescente. Depois de várias falhas seguidas,
 * ou com o navegador offline, o ao vivo fica "pausado" até a pessoa pedir Retomar.
 */
export type LiveState = 'connecting' | 'open' | 'reconnecting' | 'paused';

const BACKOFF = [1000, 2000, 4000, 8000, 15000];
const MAX_FAILURES = 6;
/**
 * O servidor manda `heartbeat` a cada 15 s. Sem nenhum evento por 40 s, a conexão é dada como morta
 * e refeita: com a API fora do ar atrás de um proxy (o do Vite, um nginx), o socket do navegador
 * pode ficar aberto sem erro, e a tela dizia "Ao vivo" para sempre (break-ui).
 */
const SILENCE_MS = 40_000;

export interface LiveHandlers {
  onClick: (c: LiveClick) => void;
  /** Conectou (ou reconectou): hora de ressincronizar o número com a API. */
  onReady?: () => void;
}

export function useLive(linkId: number, handlers: LiveHandlers) {
  const [state, setState] = useState<LiveState>('connecting');
  const [pausedAt, setPausedAt] = useState<Date | null>(null);
  const [generation, setGeneration] = useState(0);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let stopped = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const alive = (source: EventSource) => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (es === source) retry();
      }, SILENCE_MS);
    };

    const pause = () => {
      es?.close();
      es = null;
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      setState('paused');
      setPausedAt(new Date());
    };

    const retry = () => {
      es?.close();
      es = null;
      if (watchdog) clearTimeout(watchdog);
      if (stopped) return;
      failures += 1;
      if (failures >= MAX_FAILURES || !navigator.onLine) return pause();
      setState('reconnecting');
      timer = setTimeout(connect, BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)]);
    };

    async function connect() {
      if (stopped) return;
      let ticket: string;
      try {
        ({ ticket } = await api.post<{ ticket: string }>('/v1/live/ticket'));
      } catch {
        return retry();
      }
      if (stopped) return;
      const url = `${api.baseUrl}/v1/live?ticket=${encodeURIComponent(ticket)}&link_id=${linkId}`;
      const source = new EventSource(url);
      es = source;
      alive(source);
      source.addEventListener('heartbeat', () => alive(source));
      source.addEventListener('ready', () => {
        alive(source);
        failures = 0;
        setState('open');
        handlersRef.current.onReady?.();
      });
      source.addEventListener('click', (ev) => {
        alive(source);
        try {
          handlersRef.current.onClick(JSON.parse((ev as MessageEvent<string>).data) as LiveClick);
        } catch {
          /* evento malformado: ignora */
        }
      });
      source.onerror = () => {
        if (es !== source) return;
        retry();
      };
    }

    const offline = () => pause();
    window.addEventListener('offline', offline);
    void connect();
    return () => {
      stopped = true;
      window.removeEventListener('offline', offline);
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      es?.close();
    };
  }, [linkId, generation]);

  return {
    state,
    pausedAt,
    resume: () => {
      setState('connecting');
      setGeneration((g) => g + 1);
    },
  };
}
