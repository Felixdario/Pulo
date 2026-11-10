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

    const pause = () => {
      es?.close();
      es = null;
      if (timer) clearTimeout(timer);
      setState('paused');
      setPausedAt(new Date());
    };

    const retry = () => {
      es?.close();
      es = null;
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
      source.addEventListener('ready', () => {
        failures = 0;
        setState('open');
        handlersRef.current.onReady?.();
      });
      source.addEventListener('click', (ev) => {
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
