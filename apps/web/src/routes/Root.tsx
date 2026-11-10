import { Tooltip } from '@base-ui/react/tooltip';
import { Link, Outlet } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { Wordmark } from '../components/ui';
import { useDocumentTitle } from '../lib/hooks';
import { useTheme } from '../lib/theme';
import { pageTitle } from '../title';

export function Root() {
  const theme = useTheme();
  return (
    <Tooltip.Provider delay={400} closeDelay={0}>
      <Outlet />
      <Toaster
        position="bottom-center"
        theme={theme}
        closeButton={false}
        toastOptions={{ duration: 4000 }}
      />
    </Tooltip.Provider>
  );
}

export function NotFound() {
  useDocumentTitle(pageTitle('Página não encontrada'));
  return (
    <main className="vazio-pagina">
      <Wordmark size={32} />
      <h1 className="titulo-tela">Esta página não existe</h1>
      <p className="suave">O endereço pode ter mudado. Os links curtos abrem pelo domínio curto.</p>
      <Link to="/" className="btn btn-primario">
        Voltar para o início
      </Link>
    </main>
  );
}
