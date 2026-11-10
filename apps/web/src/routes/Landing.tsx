import { Link, useNavigate } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState, type FormEvent, type Ref } from 'react';
import { HonestRuler } from '../components/HonestRuler';
import { IconArrow } from '../components/Icons';
import { QrCode, QrDownloads } from '../components/Qr';
import { CopyButton, DbipCredit, Wordmark } from '../components/ui';
import { ApiError, formatWait } from '../lib/api/problem';
import type { PublicLink } from '../lib/api/types';
import { dateLong, splitShortUrl, spellSlug } from '../lib/format';
import { useCountdown, useDocumentTitle, usePrefersReducedMotion } from '../lib/hooks';
import { api, DEMO, login, useSession } from '../lib/session';
import { completeUrl, looksLikeUrl } from '../lib/validation';
import { pageTitle } from '../title';

const PLACEHOLDER = 'https://sualoja.com.br/black-friday?utm_source=instagram';

type Phase = 'form' | 'colando' | 'resultado';

/** Mensagem da landing para cada erro do encurtar público. */
function shortenError(err: unknown): { text: string; retryAt: number | null } {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const wait = err.retryAfter ?? 60;
      return {
        text: `Você encurtou 10 links no último minuto. Tente de novo em ${formatWait(wait)}.`,
        retryAt: Date.now() + wait * 1000,
      };
    }
    return { text: err.fields.destination ?? err.firstMessage, retryAt: null };
  }
  return { text: 'Não deu certo. Tente de novo.', retryAt: null };
}

function Shortener() {
  const ids = { campo: useId(), erro: useId() };
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; retryAt: number | null } | null>(null);
  const [result, setResult] = useState<PublicLink | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const reduce = usePrefersReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const left = useCountdown(error?.retryAt ?? null);

  useEffect(() => {
    if (phase !== 'colando') return;
    // A tira nova assenta em 420 ms (--dur-assinatura); a antiga sai antes disso.
    const t = setTimeout(() => setPhase('resultado'), reduce ? 0 : 420);
    return () => clearTimeout(t);
  }, [phase, reduce]);

  useEffect(() => {
    if (phase !== 'form') resultRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [phase]);

  const blocked = error?.retryAt != null && left > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const raw = value.trim();
    if (raw === '') {
      setError({ text: 'Cole um link para encurtar.', retryAt: null });
      inputRef.current?.focus();
      return;
    }
    if (!looksLikeUrl(raw)) {
      setError({
        text: 'Isso não parece um endereço da web. Ele precisa ter um domínio, como loja.com.br.',
        retryAt: null,
      });
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const link = await api.post<PublicLink>(
        '/v1/public/links',
        { destination: completeUrl(raw) },
        { auth: false },
      );
      setResult(link);
      setPhase('colando');
    } catch (err) {
      setError(shortenError(err));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  function again() {
    setResult(null);
    setValue('');
    setPhase('form');
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const errorText =
    error && error.retryAt !== null
      ? left > 0
        ? `Você encurtou 10 links no último minuto. Tente de novo em ${formatWait(left)}.`
        : 'Pode tentar de novo.'
      : error?.text;

  return (
    <div className="tiras">
      {phase !== 'resultado' && (
        <form
          className={clsx('tira tira-form', phase === 'colando' && 'tira-saindo')}
          onSubmit={submit}
          noValidate
          aria-hidden={phase === 'colando' || undefined}
        >
          <div className="tira-campo">
            <label htmlFor={ids.campo} className="tira-rotulo">
              Link para encurtar
            </label>
            <input
              ref={inputRef}
              id={ids.campo}
              className="tira-input"
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder={PLACEHOLDER}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error && error.retryAt === null) setError(null);
              }}
              aria-invalid={error && error.retryAt === null ? true : undefined}
              aria-describedby={error ? ids.erro : undefined}
              disabled={phase === 'colando'}
            />
          </div>
          <button
            type="submit"
            className="btn btn-cartaz tira-botao"
            disabled={busy || blocked || phase === 'colando'}
          >
            <span className="btn-troca">
              <span aria-hidden={busy}>Encurtar</span>
              <span aria-hidden={!busy}>Encurtando…</span>
            </span>
          </button>
        </form>
      )}

      {result && phase !== 'form' && (
        <ResultStrip
          ref={resultRef}
          link={result}
          onAgain={again}
          settled={phase === 'resultado'}
        />
      )}

      <p id={ids.erro} className="tira-erro" role="alert">
        {phase === 'form' ? errorText : ''}
      </p>
    </div>
  );
}

function ResultStrip({
  link,
  onAgain,
  settled,
  ref,
}: {
  link: PublicLink;
  onAgain: () => void;
  settled: boolean;
  ref: Ref<HTMLDivElement>;
}) {
  const { host, slug } = splitShortUrl(link.short_url);
  return (
    <div ref={ref} className={clsx('tira tira-resultado', !settled && 'tira-colando')}>
      <div className="tira-resultado-topo">
        <div className="tira-resultado-link">
          <p className="tira-rotulo">Seu link curto</p>
          <p className="tira-curto">
            <span className="sr-only">{spellSlug(host, slug)}</span>
            <span aria-hidden="true">
              <span className="tira-curto-host">{host}</span>
              {slug}
            </span>
          </p>
        </div>
        <CopyButton text={link.short_url} variant="cartaz" className="tira-botao" />
      </div>
      <div className="tira-resultado-pe">
        <QrCode url={link.short_url} size={96} />
        <div className="tira-resultado-texto">
          <p>
            Vale até {dateLong(link.expires_at)}. Para escolher o nome, a validade e as regras,{' '}
            <Link to="/criar-conta" className="sublinhado">
              crie uma conta
            </Link>
            .
          </p>
          <div className="tira-resultado-acoes">
            <QrDownloads url={link.short_url} slug={link.slug} />
            <button type="button" className="btn btn-fantasma btn-pequeno" onClick={onAgain}>
              Encurtar outro
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DemoLink({ className, label }: { className?: string; label?: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useSession((s) => s.status);
  return (
    <span className={className}>
      <button
        type="button"
        className="botao-texto"
        disabled={busy}
        onClick={async () => {
          if (status === 'authenticated') return navigate({ to: '/app' });
          setBusy(true);
          setError(null);
          try {
            await login(DEMO.email, DEMO.password);
            await navigate({ to: '/app' });
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Não deu para entrar no demo.');
            setBusy(false);
          }
        }}
      >
        {busy ? 'Entrando no demo…' : (label ?? 'Ou entre no demo')}
      </button>
      {error && (
        <span className="campo-erro" role="alert">
          {' '}
          {error}
        </span>
      )}
    </span>
  );
}

const FAQ = [
  {
    q: 'Por que os únicos são por dia?',
    a: 'Para reconhecer um visitante sem guardar o IP, usamos um código que muda todo dia. O mesmo visitante em dois dias diferentes conta duas vezes, e a tela diz isso: "únicos por dia (soma)", nunca "visitantes únicos".',
  },
  {
    q: 'O que conta como robô?',
    a: 'Crawlers, monitores e clientes de linha de comando, reconhecidos pelo navegador que dizem ser. Eles aparecem à parte, com nome, e não entram no total nem no limite de cliques.',
  },
  {
    q: 'A prévia do WhatsApp gasta clique?',
    a: 'Não. Quando você cola o link numa conversa, o WhatsApp abre o endereço para montar a prévia. Essa visita é contada como prévia, separada por app, e não gasta o limite do link.',
  },
  {
    q: '301 ou 302?',
    a: 'O padrão é 302, e com ele cada clique passa por nós. Com 301 ou 308, o navegador guarda o destino e os cliques repetidos da mesma pessoa podem não ser contados. O painel avisa antes de você trocar.',
  },
  {
    q: 'Vocês guardam meu IP?',
    a: 'Não. O IP serve na hora para descobrir país e cidade e para o código diário dos únicos, e não é gravado. A geolocalização usa a base DB-IP Lite.',
  },
  {
    q: 'Quanto dura um link sem conta?',
    a: '30 dias, com nome aleatório e sem regras. Com uma conta, você escolhe o nome, a validade, a senha, o limite e para onde cada país ou aparelho vai.',
  },
];

const CURL = `curl -X POST "$PULO_API/v1/links" \\
  -H "Authorization: Bearer enc_AbCd1234_…" \\
  -H "Idempotency-Key: 6f1c…" \\
  -H "Content-Type: application/json" \\
  -d '{"destination":"https://sualoja.com.br/natal","alias":"natal"}'`;

const RESPOSTA = `HTTP/1.1 201 Created
Location: /v1/links/42
ETag: "l42-1731"

{"id":42,"slug":"natal","short_url":"https://encurta.dev/natal",
 "destination":"https://sualoja.com.br/natal","redirect_type":302, …}`;

export function Landing() {
  useDocumentTitle(pageTitle());
  const status = useSession((s) => s.status);
  return (
    <div className="landing">
      <section className="cartaz sobre-rosa" aria-labelledby="frase">
        <header className="cartaz-barra">
          <Link to="/" className="marca-link" aria-label="pulo., início">
            <Wordmark size={28} />
          </Link>
          <nav aria-label="Seções" className="cartaz-nav">
            <a href="#como-funciona">Como funciona</a>
            <a href="#numeros">Números</a>
            <a href="#api">API</a>
            {status === 'authenticated' ? (
              <Link to="/app" className="btn btn-primario cartaz-entrar">
                Abrir o painel
              </Link>
            ) : (
              <Link to="/entrar" className="btn btn-primario cartaz-entrar">
                Entrar
              </Link>
            )}
          </nav>
        </header>

        <div className="cartaz-corpo">
          <h1 id="frase" className="cartaz-frase">
            <span>Encurte links.</span> <span>Conte só gente.</span>
          </h1>
          <Shortener />
          <p className="cartaz-apoio">
            O Pulo encurta na hora e conta cada clique de gente uma vez. Robôs e prévias do WhatsApp
            ficam à parte.
          </p>
          <p className="cartaz-demo">
            <DemoLink />
            <span className="cartaz-demo-email">: {DEMO.email}</span>
          </p>
        </div>
      </section>

      <section id="numeros" className="secao secao-papel" aria-labelledby="t-numeros">
        <div className="secao-grade">
          <div className="secao-afirmacao">
            <h2 id="t-numeros" className="declaracao">
              Contamos gente, não robô.
            </h2>
            <p className="texto-landing">
              Quando o link cai num grupo, o WhatsApp, o Slack e os crawlers abrem o endereço antes
              de qualquer pessoa. O Pulo mostra essas visitas numa régua à parte e conta no total só
              quem clicou de verdade, uma vez cada.
            </p>
          </div>
          <figure className="fragmento folha" aria-label="Exemplo com dados de demonstração">
            <div className="fragmento-topo">
              <span className="chip">Dados de demonstração</span>
              <span className="ao-vivo-mini">
                <i className="ponto-vivo" aria-hidden="true" /> Ao vivo{' '}
                <strong className="num">1.284</strong> hoje
              </span>
            </div>
            <HonestRuler
              humans={12480}
              bots={802}
              previews={431}
              previewApps={[
                { app: 'whatsapp', n: 390 },
                { app: 'slack', n: 41 },
              ]}
            />
            <p className="rotulo suave">Prévia do WhatsApp: 390, não conta.</p>
          </figure>
        </div>
      </section>

      <section id="como-funciona" className="secao secao-folha" aria-labelledby="t-regras">
        <div className="secao-grade">
          <div className="secao-afirmacao">
            <h2 id="t-regras" className="declaracao">
              Cada link decide para onde vai.
            </h2>
            <p className="texto-landing">
              País, aparelho, prazo, senha e limite de cliques. Cada regra aparece escrita como
              frase, na ordem em que o redirect lê: a primeira que casar decide.
            </p>
          </div>
          <ol className="rota" aria-label="Exemplo de regras de um link">
            <li className="rota-origem mono">/live-sabado</li>
            <li>
              <strong>Do Brasil</strong>, vai para <span className="mono">/br</span>
            </li>
            <li>
              <strong>No iPhone</strong>, vai para a App Store
            </li>
            <li>
              <strong>Para em 500</strong> cliques de gente
            </li>
            <li>
              <strong>Expira</strong> em 12/12 às 23:59
            </li>
            <li className="rota-padrao">Senão, vai para o destino padrão</li>
          </ol>
        </div>
      </section>

      <section id="medido" className="secao secao-papel" aria-labelledby="t-medido">
        <h2 id="t-medido" className="sr-only">
          Medido, não prometido
        </h2>
        <p className="declaracao frase-medida">
          <strong>6,4 ms</strong> de p95 no redirect, <strong>0,21 ms</strong> para a série de 30
          dias, <strong>5 milhões</strong> de cliques no teste e <strong>nenhuma diferença</strong>{' '}
          no teste de consistência.
        </p>
        <p className="rotulo suave frase-medida-fonte">
          Medições do próprio projeto, numa máquina de desenvolvimento (docs/performance.md).
        </p>
      </section>

      <section id="api" className="secao secao-folha" aria-labelledby="t-api">
        <div className="secao-grade">
          <div className="secao-afirmacao">
            <h2 id="t-api" className="declaracao">
              A API faz tudo que a tela faz.
            </h2>
            <p className="texto-landing">
              Chaves com escopo (<span className="mono">links:read</span>,{' '}
              <span className="mono">links:write</span>, <span className="mono">stats:read</span>),
              erros em problem+json, paginação por cursor, ETag e Idempotency-Key.
            </p>
          </div>
          <div className="codigo-grupo">
            <pre className="codigo" tabIndex={0} aria-label="Exemplo de requisição">
              <code>{CURL}</code>
            </pre>
            <pre className="codigo codigo-resposta" tabIndex={0} aria-label="Exemplo de resposta">
              <code>{RESPOSTA}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className="secao secao-papel" aria-labelledby="t-faq">
        <h2 id="t-faq" className="sr-only">
          Perguntas
        </h2>
        <dl className="faq">
          {FAQ.map((f) => (
            <div key={f.q} className="faq-item">
              <dt className="declaracao faq-pergunta">{f.q}</dt>
              <dd className="texto-landing">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="fechamento" aria-labelledby="t-fechamento">
        <h2 id="t-fechamento" className="fechamento-frase">
          <span>Seu próximo link,</span> <span>contado direito.</span>
        </h2>
        <div className="fechamento-acoes">
          <Link to="/criar-conta" className="btn btn-cartaz fechamento-botao">
            Criar conta <IconArrow />
          </Link>
          <DemoLink className="fechamento-demo" label="Ou entre no demo" />
        </div>
      </section>

      <footer className="rodape sobre-rosa">
        <p className="rodape-marca" aria-hidden="true">
          pulo.
        </p>
        <div className="rodape-linhas">
          <nav aria-label="Rodapé" className="rodape-nav">
            <Link to="/entrar">Entrar</Link>
            <Link to="/criar-conta">Criar conta</Link>
            <a href="/api/docs">Documentação da API</a>
          </nav>
          <DbipCredit className="rodape-credito" />
          <p className="rotulo">Projeto de portfólio. Sem clientes, sem preço, sem depoimento.</p>
        </div>
      </footer>
    </div>
  );
}
