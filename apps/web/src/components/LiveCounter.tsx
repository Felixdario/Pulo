import { clsx } from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { num, timeOnly } from '../lib/format';
import type { LiveState } from '../lib/live';
import { Hint } from './ui';

/**
 * Contador ao vivo (DESIGN.md): o ponto rosa e o número de hoje. O dígito troca de uma vez, como um
 * placar (nada de contar rolando); o delta acende por 600 ms, no máximo a cada 2 s (num link quente
 * chega lote a cada segundo, e reacender sem parar vira pisca-pisca). A região `aria-live` fala no máximo a
 * cada 30 s, já agregada, e pode ser silenciada.
 */
export function LiveCounter({
  today,
  lastMinute,
  pulse,
  received,
  state,
  pausedAt,
  onResume,
}: {
  today: number | undefined;
  lastMinute: number;
  /** Muda quando o delta deve acender (já limitado a uma vez a cada 2 s por quem chama). */
  pulse: number;
  /** Cliques humanos recebidos pelo ao vivo desde a abertura (para o anúncio agregado). */
  received: number;
  state: LiveState;
  pausedAt: Date | null;
  onResume: () => void;
}) {
  const [muted, setMuted] = useState(false);
  const [announce, setAnnounce] = useState('');
  const receivedRef = useRef(received);
  const announced = useRef(received);
  const lastAnnounce = useRef(0);
  const todayRef = useRef(today);

  useEffect(() => {
    todayRef.current = today;
  }, [today]);

  useEffect(() => {
    receivedRef.current = received;
  }, [received]);

  useEffect(() => {
    const t = setInterval(() => {
      const n = receivedRef.current - announced.current;
      if (n <= 0 || muted) return;
      if (Date.now() - lastAnnounce.current < 30_000) return;
      announced.current = receivedRef.current;
      lastAnnounce.current = Date.now();
      const total = todayRef.current;
      setAnnounce(
        `${n === 1 ? '1 novo clique' : `${num(n)} novos cliques`}${total !== undefined ? `, ${num(total)} hoje` : ''}.`,
      );
    }, 5_000);
    return () => clearInterval(t);
  }, [muted]);

  return (
    <div className="ao-vivo">
      <div className="ao-vivo-topo">
        <Hint text="Atualiza até 1 s depois do clique. Só cliques humanos, no dia UTC de hoje.">
          <span className="ao-vivo-rotulo">
            {state !== 'paused' && (
              <i
                className={clsx('ponto-vivo', state !== 'open' && 'ponto-vivo-vazado')}
                aria-hidden="true"
              />
            )}
            {state === 'paused' ? 'Ao vivo pausado' : 'Ao vivo'}
          </span>
        </Hint>
        <button
          type="button"
          className="btn btn-fantasma btn-pequeno ao-vivo-som"
          aria-pressed={muted}
          onClick={() => setMuted((m) => !m)}
        >
          {muted ? 'Anúncios silenciados' : 'Silenciar anúncios'}
        </button>
      </div>
      <p className="ao-vivo-linha">
        <strong className="ao-vivo-numero num" data-testid="ao-vivo-numero">
          {today === undefined ? '—' : num(today)}
        </strong>
        <span className="suave"> hoje</span>
      </p>
      {/* A chave muda a cada clique: o elemento renasce e a animação de 600 ms roda de novo. */}
      <p key={pulse} className={clsx('ao-vivo-delta', pulse > 0 && 'ao-vivo-delta-aceso')}>
        {lastMinute > 0 ? `+${num(lastMinute)} no último minuto` : 'Nenhum clique no último minuto'}
      </p>
      {state === 'reconnecting' && <p className="rotulo suave">reconectando…</p>}
      {state === 'paused' && (
        <p className="rotulo suave ao-vivo-pausado">
          {pausedAt ? `Atualizado às ${timeOnly(pausedAt)}. ` : ''}
          <button type="button" className="btn btn-secundario btn-pequeno" onClick={onResume}>
            Retomar
          </button>
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {muted ? '' : announce}
      </span>
      {/* A queda da conexão também é anunciada (uma vez por mudança), não só desenhada no ponto. */}
      <span className="sr-only" role="status">
        {state === 'paused'
          ? 'Ao vivo pausado.'
          : state === 'reconnecting'
            ? 'Ao vivo reconectando.'
            : ''}
      </span>
    </div>
  );
}
