import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { Wordmark } from '../components/ui';
import { ApiError } from '../lib/api/problem';
import { useDocumentTitle } from '../lib/hooks';
import { DEMO, login, signup } from '../lib/session';
import { pageTitle } from '../title';

type Mode = 'login' | 'signup';

function AuthForm({ mode }: { mode: Mode }) {
  const search = useSearch({ strict: false }) as { redirect?: string };
  const navigate = useNavigate();
  const ids = { email: useId(), senha: useId(), erro: useId(), ajuda: useId() };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'form' | 'demo' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [local, setLocal] = useState<{ email?: string; password?: string }>({});
  const isLogin = mode === 'login';

  async function go(e: string, p: string, which: 'form' | 'demo') {
    setBusy(which);
    setError(null);
    try {
      await (isLogin || which === 'demo' ? login(e, p) : signup(e, p));
      await navigate({ to: search.redirect ?? '/app' });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, null));
      setBusy(null);
    }
  }

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const issues: { email?: string; password?: string } = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      issues.email = 'Digite um e-mail válido, como voce@exemplo.com.';
    }
    if (password.length < 8) issues.password = 'A senha precisa ter pelo menos 8 caracteres.';
    setLocal(issues);
    if (issues.email || issues.password) return;
    void go(email.trim(), password, 'form');
  }

  const emailError = local.email ?? error?.fields.email;
  const passwordError = local.password ?? error?.fields.password;
  const general = error && !error.fields.email && !error.fields.password ? error.message : null;

  return (
    <main className="auth">
      <Link to="/" className="marca-link auth-marca" aria-label="pulo., início">
        <Wordmark size={32} />
      </Link>
      <div className="folha auth-folha">
        <h1 className="titulo-tela">{isLogin ? 'Entrar' : 'Criar conta'}</h1>
        <p className="suave auth-sub">
          {isLogin
            ? 'Seus links, seus cliques e suas chaves de API.'
            : 'Com uma conta, você escolhe o nome do link, a validade e as regras.'}
        </p>
        <form className="auth-form" onSubmit={submit} noValidate>
          <div className="campo-grupo">
            <label className="campo-rotulo" htmlFor={ids.email}>
              E-mail
            </label>
            <input
              id={ids.email}
              className="campo"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? `${ids.email}-erro` : undefined}
            />
            {emailError && (
              <p id={`${ids.email}-erro`} className="campo-erro" role="alert">
                {emailError}
              </p>
            )}
          </div>
          <div className="campo-grupo">
            <label className="campo-rotulo" htmlFor={ids.senha}>
              Senha
            </label>
            <input
              id={ids.senha}
              className="campo"
              type="password"
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={passwordError ? true : undefined}
              aria-describedby={
                [passwordError ? `${ids.senha}-erro` : '', !isLogin ? ids.ajuda : '']
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            />
            {!isLogin && (
              <p id={ids.ajuda} className="campo-ajuda">
                Pelo menos 8 caracteres.
              </p>
            )}
            {passwordError && (
              <p id={`${ids.senha}-erro`} className="campo-erro" role="alert">
                {passwordError}
              </p>
            )}
          </div>
          <p id={ids.erro} className="campo-erro" role="alert">
            {general ?? ''}
          </p>
          <button type="submit" className="btn btn-primario auth-botao" disabled={busy !== null}>
            {busy === 'form'
              ? isLogin
                ? 'Entrando…'
                : 'Criando…'
              : isLogin
                ? 'Entrar'
                : 'Criar conta'}
          </button>
        </form>
        <div className="auth-alternativas">
          <button
            type="button"
            className="btn btn-secundario auth-botao"
            disabled={busy !== null}
            onClick={() => void go(DEMO.email, DEMO.password, 'demo')}
          >
            {busy === 'demo' ? 'Entrando no demo…' : 'Entrar no demo'}
          </button>
          <p className="rotulo suave">
            Conta de demonstração: <span className="mono">{DEMO.email}</span>, com dados marcados
            como demo.
          </p>
        </div>
      </div>
      <p className="auth-troca">
        {isLogin ? (
          <>
            Ainda não tem conta?{' '}
            <Link
              to="/criar-conta"
              search={search.redirect ? { redirect: search.redirect } : {}}
              className="link-texto"
            >
              Criar conta
            </Link>
          </>
        ) : (
          <>
            Já tem conta?{' '}
            <Link
              to="/entrar"
              search={search.redirect ? { redirect: search.redirect } : {}}
              className="link-texto"
            >
              Entrar
            </Link>
          </>
        )}
      </p>
    </main>
  );
}

export function LoginPage() {
  useDocumentTitle(pageTitle('Entrar'));
  return <AuthForm mode="login" />;
}

export function SignupPage() {
  useDocumentTitle(pageTitle('Criar conta'));
  return <AuthForm mode="signup" />;
}
