import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/landing.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isApiError } from './lib/api/problem';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Sem rede, a consulta falha na hora com a mensagem "Sem conexão" (ApiError status 0). No modo
      // padrão ('online') ela ficava pausada em silêncio, e uma busca nova sem rede mostrava a lista
      // da busca anterior como se fosse o resultado (break-ui).
      networkMode: 'always',
      // 4xx não melhora com outra tentativa; rede e 5xx tentam mais uma vez (offline, nenhuma).
      retry: (count, err) =>
        count < 1 &&
        navigator.onLine &&
        (!isApiError(err) || err.status === 0 || err.status >= 500),
    },
    mutations: { networkMode: 'always' },
  },
});

// break-ui: painel Demo data / Worst case, só em `vite` (modo development). Não usa `DEV`: ele segue
// o NODE_ENV do processo, e um `vite build` com NODE_ENV=development (o e2e subia assim) levava o
// painel para o dist. `MODE` é `production` em todo build; o import some do bundle.
if (import.meta.env.MODE === 'development') {
  const { instalarPiorCaso } = await import('./dev/pior-caso');
  instalarPiorCaso();
}

const root = document.getElementById('root');
if (!root) throw new Error('#root não encontrado');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
