/**
 * `corepack pnpm demo`: do clone limpo ao demo no ar (com `docker compose up -d --wait` já rodado).
 * 1. cria o .env a partir do .env.example, se ele não existir;
 * 2. aplica as migrações (drizzle-kit migrate) e roda o seed demo;
 * 3. sobe redirect, API, worker e web juntos (o `dev` de cada app);
 * 4. imprime as URLs e a conta demo quando os quatro respondem.
 * Sem dependência nova: só Node e o pnpm do corepack. Variáveis já definidas no ambiente têm
 * prioridade sobre o .env (dá para trocar portas ou o banco sem editar o arquivo).
 */
import { execSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const pnpm = 'corepack pnpm';

if (!existsSync(`${raiz}.env`)) {
  copyFileSync(`${raiz}.env.example`, `${raiz}.env`);
  console.log('▸ .env criado a partir do .env.example');
}
// Não sobrescreve o que já está no ambiente.
process.loadEnvFile(`${raiz}.env`);

const porta = (nome, padrao) => process.env[nome] || padrao;
const web = `http://localhost:${porta('WEB_PORT', '5173')}`;
const api = `http://localhost:${porta('API_PORT', '3000')}`;
const redirect = `http://localhost:${porta('REDIRECT_PORT', '8080')}`;
const metricas = `http://localhost:${porta('WORKER_METRICS_PORT', '9464')}`;
const temGeo = existsSync(`${raiz}data/geo/dbip-city-lite.mmdb`);

function passo(titulo, comando) {
  console.log(`\n▸ ${titulo}`);
  execSync(comando, { cwd: raiz, stdio: 'inherit' });
}

try {
  passo('Migrações (drizzle-kit migrate)', `${pnpm} --filter @encurtador/db db:migrate`);
} catch {
  console.error(
    '\nNão consegui aplicar as migrações. O Docker está de pé? Rode `docker compose up -d --wait` e tente de novo.',
  );
  process.exit(1);
}
passo('Seed demo (demo@encurta.dev, 30 links e 90 dias de cliques)', `${pnpm} seed:demo`);

console.log('\n▸ Subindo redirect, API, worker e web…\n');
const servidores = spawn(`${pnpm} -r --parallel --filter "./apps/*" dev`, {
  cwd: raiz,
  stdio: 'inherit',
  shell: true,
});

let encerrando = false;
const encerrar = () => {
  if (encerrando) return;
  encerrando = true;
  // No Windows o kill do shell não leva os filhos junto: derruba a árvore inteira.
  if (process.platform === 'win32' && servidores.pid) {
    try {
      execSync(`taskkill /pid ${servidores.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      // já tinha saído
    }
  } else {
    servidores.kill('SIGINT');
  }
};
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
servidores.on('exit', (codigo) => process.exit(codigo ?? 0));

async function respondendo(url) {
  try {
    const r = await fetch(url);
    return r.status < 500;
  } catch {
    return false;
  }
}

for (let i = 0; i < 180; i++) {
  const todos = await Promise.all(
    [`${redirect}/healthz`, `${api}/healthz`, `${metricas}/metrics`, `${web}/`].map(respondendo),
  );
  if (todos.every(Boolean)) {
    console.log(`
┌──────────────────────────────────────────────────────────────────┐
  Pulo no ar
  Web (landing e painel):  ${web}
  Entrar:                  ${web}/entrar
  API e OpenAPI:           ${api}/docs
  Redirect (teste):        ${redirect}/demo-promo
  Métricas do worker:      ${metricas}/metrics

  Conta demo: demo@encurta.dev  /  demo1234
${
  temGeo
    ? '  Geolocalização: bases do DB-IP encontradas em data/geo/.'
    : '  Opcional: `corepack pnpm geo:download` baixa as bases do DB-IP\n  (sem elas, país e cidade dos cliques novos ficam "desconhecido").'
}

  Ctrl+C encerra tudo.
└──────────────────────────────────────────────────────────────────┘
`);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
