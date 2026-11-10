import { create } from 'zustand';
import { ApiClient } from './api/client';
import type { Session, User } from './api/types';

/** Base da API: o Vite faz proxy de `/api` para a API (vite.config.ts). */
export const api = new ApiClient({ baseUrl: '/api' });

export type SessionStatus = 'checking' | 'anonymous' | 'authenticated' | 'expired';

interface SessionState {
  status: SessionStatus;
  user: User | null;
  /** "logout" quando a sessão acabou porque saiu em outra aba. */
  endedBy: 'expired' | 'logout' | null;
}

export const useSession = create<SessionState>(() => ({
  status: 'checking',
  user: null,
  endedBy: null,
}));

api.onSession((e) => {
  if (e.type === 'session') {
    useSession.setState({ status: 'authenticated', user: e.session.user, endedBy: null });
    return;
  }
  const was = useSession.getState().status;
  if (e.reason === 'anonymous') {
    useSession.setState({ status: 'anonymous', user: null, endedBy: null });
  } else if (was === 'authenticated' || was === 'expired') {
    useSession.setState({ status: 'expired', user: null, endedBy: e.reason });
  } else {
    useSession.setState({ status: 'anonymous', user: null, endedBy: null });
  }
});

let bootstrap: Promise<boolean> | null = null;

/** Restaura a sessão pelo cookie de refresh (uma vez por carga de página). */
export function ensureSession(): Promise<boolean> {
  const s = useSession.getState();
  if (s.status === 'authenticated') return Promise.resolve(true);
  if (s.status === 'anonymous' || s.status === 'expired') {
    if (bootstrap) return Promise.resolve(false);
  }
  bootstrap ??= api
    .refresh(null)
    .then((t) => t !== null)
    .catch(() => {
      useSession.setState({ status: 'anonymous', user: null });
      return false;
    });
  return bootstrap.then((ok) => ok || useSession.getState().status === 'authenticated');
}

export async function login(email: string, password: string): Promise<User> {
  const session = await api.post<Session>('/v1/auth/login', { email, password }, { auth: false });
  api.startSession(session);
  return session.user;
}

export async function signup(email: string, password: string): Promise<User> {
  const session = await api.post<Session>('/v1/auth/signup', { email, password }, { auth: false });
  api.startSession(session);
  return session.user;
}

export async function logout(): Promise<void> {
  await api.logout();
  useSession.setState({ status: 'anonymous', user: null, endedBy: null });
}

export const DEMO = { email: 'demo@encurta.dev', password: 'demo1234' } as const;
