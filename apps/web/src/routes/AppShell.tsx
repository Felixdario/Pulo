import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog } from '@base-ui/react/dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { IconClose, IconMenu, IconPlus, IconTheme } from '../components/Icons';
import { DbipCredit, Wordmark } from '../components/ui';
import { logout, useSession } from '../lib/session';
import { nextTheme, setTheme, THEME_LABEL, useTheme } from '../lib/theme';

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Principal" className="nav">
      <Link
        to="/app"
        className="nav-item"
        activeOptions={{ exact: true, includeSearch: false }}
        activeProps={{ 'aria-current': 'page' }}
        onClick={onNavigate}
      >
        Links
      </Link>
      <Link
        to="/app/keys"
        className="nav-item"
        activeProps={{ 'aria-current': 'page' }}
        onClick={onNavigate}
      >
        Chaves de API
      </Link>
    </nav>
  );
}

function UserFoot() {
  const user = useSession((s) => s.user);
  const theme = useTheme();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <div className="lateral-pe">
      <button
        type="button"
        className="btn btn-fantasma lateral-tema"
        onClick={() => setTheme(nextTheme(theme))}
        aria-label={`${THEME_LABEL[theme]}. Trocar tema`}
      >
        <IconTheme /> {THEME_LABEL[theme]}
      </button>
      {user && (
        <div className="lateral-usuario">
          <span className="lateral-email" title={user.email}>
            {user.email}
          </span>
          <button
            type="button"
            className="btn btn-fantasma btn-pequeno"
            onClick={async () => {
              await logout();
              qc.clear();
              await navigate({ to: '/' });
            }}
          >
            Sair
          </button>
        </div>
      )}
    </div>
  );
}

function ExpiredDialog() {
  const status = useSession((s) => s.status);
  const endedBy = useSession((s) => s.endedBy);
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <AlertDialog.Root open={status === 'expired'}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fundo-dialogo camada" />
        <AlertDialog.Popup className="flutuante dialogo camada">
          <AlertDialog.Title className="dialogo-titulo">
            {endedBy === 'logout' ? 'Você saiu em outra aba' : 'Sua sessão expirou'}
          </AlertDialog.Title>
          <AlertDialog.Description className="dialogo-texto">
            {endedBy === 'logout'
              ? 'A sessão foi encerrada em outra aba. Entre de novo para continuar daqui.'
              : 'Por segurança, a sessão acaba depois de um tempo ou quando é encerrada em outro lugar. Entre de novo para continuar de onde parou.'}
          </AlertDialog.Description>
          <div className="dialogo-acoes">
            <button
              type="button"
              className="btn btn-primario"
              onClick={() => {
                qc.clear();
                useSession.setState({ status: 'anonymous', endedBy: null });
                void navigate({ to: '/entrar', search: { redirect: location.href } });
              }}
            >
              Entrar de novo
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function screenName(path: string): string {
  if (path.startsWith('/app/keys')) return 'Chaves de API';
  if (path.startsWith('/app/links/')) return 'Link';
  return 'Links';
}

export function AppShell() {
  const [menu, setMenu] = useState(false);
  const location = useLocation();
  return (
    <div className="app">
      <a className="pular" href="#conteudo">
        Pular para o conteúdo
      </a>
      <aside className="lateral" aria-label="Navegação">
        <Link to="/app" className="marca-link lateral-marca" aria-label="pulo., seus links">
          <Wordmark size={24} />
        </Link>
        <Nav />
        <UserFoot />
      </aside>

      <header className="topo-movel">
        <Dialog.Root open={menu} onOpenChange={setMenu}>
          <Dialog.Trigger className="btn btn-fantasma btn-icone" aria-label="Abrir menu">
            <IconMenu />
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Backdrop className="fundo-dialogo camada" />
            <Dialog.Popup className="menu-movel camada">
              <div className="menu-movel-topo">
                <Dialog.Title render={<div />}>
                  <Wordmark size={24} />
                </Dialog.Title>
                <Dialog.Close className="btn btn-fantasma btn-icone" aria-label="Fechar menu">
                  <IconClose />
                </Dialog.Close>
              </div>
              <Nav onNavigate={() => setMenu(false)} />
              <UserFoot />
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
        <p className="topo-movel-titulo">{screenName(location.pathname)}</p>
        <Link
          to="/app"
          search={{}}
          hash="novo-link"
          className="btn btn-primario btn-icone"
          aria-label="Novo link"
        >
          <IconPlus />
        </Link>
      </header>

      <main id="conteudo" className="tela" tabIndex={-1}>
        <Outlet />
        <footer className="tela-rodape">
          <DbipCredit />
        </footer>
      </main>
      <ExpiredDialog />
    </div>
  );
}
