import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './routes/AppShell';
import { Landing } from './routes/Landing';
import { LoginPage, SignupPage } from './routes/Auth';
import { NotFound, Root } from './routes/Root';
import { parseLinksSearch } from './routes/links-search';
import { PERIODS, type Period } from './lib/period';
import { ensureSession, useSession } from './lib/session';

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFound });

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Landing,
});

const authSearch = (s: Record<string, unknown>): { redirect?: string } =>
  typeof s.redirect === 'string' && s.redirect.startsWith('/app') ? { redirect: s.redirect } : {};

/** Quem já tem sessão não vê o login: vai direto para o app. */
const skipIfAuthenticated = async ({ search }: { search: { redirect?: string } }) => {
  if (await ensureSession()) throw redirect({ to: search.redirect ?? '/app' });
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/entrar',
  validateSearch: authSearch,
  beforeLoad: skipIfAuthenticated,
  component: LoginPage,
});

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/criar-conta',
  validateSearch: authSearch,
  beforeLoad: skipIfAuthenticated,
  component: SignupPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  beforeLoad: async ({ location }) => {
    if (await ensureSession()) return;
    // Sessão expirada no meio do uso: o AppShell mostra o aviso no lugar; sem sessão, login.
    if (useSession.getState().status === 'expired') return;
    throw redirect({ to: '/entrar', search: { redirect: location.href } });
  },
  component: AppShell,
});

const linksRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  validateSearch: parseLinksSearch,
  component: lazyRouteComponent(() => import('./routes/LinksPage'), 'LinksPage'),
});

export interface LinkSearch {
  period?: Period | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

const day = /^\d{4}-\d{2}-\d{2}$/;

const linkRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'links/$id',
  validateSearch: (s: Record<string, unknown>): LinkSearch => {
    const out: LinkSearch = {};
    if (typeof s.period === 'string' && (PERIODS as readonly string[]).includes(s.period)) {
      out.period = s.period as Period;
    }
    if (typeof s.from === 'string' && day.test(s.from)) out.from = s.from;
    if (typeof s.to === 'string' && day.test(s.to)) out.to = s.to;
    return out;
  },
  component: lazyRouteComponent(() => import('./routes/LinkPage'), 'LinkPage'),
});

const keysRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'keys',
  component: lazyRouteComponent(() => import('./routes/KeysPage'), 'KeysPage'),
});

const routeTree = rootRoute.addChildren([
  landingRoute,
  loginRoute,
  signupRoute,
  appRoute.addChildren([linksRoute, linkRoute, keysRoute]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
