import type { FastifyReply, FastifyRequest } from 'fastify';

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/*
 * Identidade Pulo (DESIGN.md) em CSS inline e pequeno: faixa rosa-gráfica com o wordmark, papel,
 * tinta e cantos quase retos. Sem fonte baixada: Archivo se estiver instalada, senão a condensada do
 * sistema no título. Claro e escuro pelos mesmos tokens do app.
 */
const CSS =
  ':root{--rosa:#ff3d8b;--dado:#e0136f;--tinta:#141414;--papel:#f4f4f1;--folha:#fff;--suave:#55554f;--controle:#8c8c85;--neg:#b3261e;--on:#fff;color-scheme:light dark}' +
  '@media (prefers-color-scheme:dark){:root{--rosa:#ff4f98;--dado:#ff4f98;--tinta:#f2f2ef;--papel:#0f0f0f;--folha:#181818;--suave:#b5b5ae;--controle:#6e6e6e;--neg:#ff7b72;--on:#141414}}' +
  '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--papel);color:var(--tinta);font:16px/1.5 Archivo,"Arial Narrow",system-ui,sans-serif}' +
  'header{background:var(--rosa);color:#141414;padding:14px clamp(16px,4vw,40px)}' +
  '.marca{font-weight:850;font-size:24px;line-height:1;letter-spacing:-.02em;font-stretch:condensed}' +
  'main{flex:1;width:100%;max-width:34rem;padding:clamp(40px,10vh,96px) clamp(16px,4vw,40px)}' +
  'h1{margin:0 0 12px;font-size:clamp(2rem,1.2rem + 3vw,3rem);line-height:1;font-weight:800;font-stretch:condensed;letter-spacing:-.01em;text-wrap:balance}' +
  'p{margin:0 0 16px;color:var(--suave)}' +
  'form{display:grid;gap:12px;margin-top:24px}label{font-size:12px;font-weight:600;color:var(--suave)}' +
  'input{font:inherit;height:44px;padding:0 12px;border:1px solid var(--controle);border-radius:4px;background:var(--folha);color:var(--tinta)}' +
  'input:focus-visible,button:focus-visible{outline:2px solid var(--tinta);outline-offset:2px}' +
  'button{font:inherit;font-weight:600;height:44px;border:0;border-radius:4px;background:var(--tinta);color:var(--on);cursor:pointer}' +
  'button{transition:transform 160ms cubic-bezier(.2,.8,.2,1)}button:active{transform:scale(.97)}@media (prefers-reduced-motion:reduce){button{transition:none}button:active{transform:none}}.err{color:var(--neg);font-weight:600}' +
  '.pe{margin-top:48px;font-size:13px}.pe b{color:var(--tinta);font-weight:850;font-stretch:condensed}.pe i{color:var(--dado);font-style:normal}';

const MARCA = '<span class="marca">pulo.</span>';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · pulo.</title><style>${CSS}</style></head><body><header>${MARCA}</header><main>${body}<p class="pe">Encurtado com <b>pulo<i>.</i></b></p></main></body></html>`;
}

const wantsJson = (req: FastifyRequest) =>
  /application\/(problem\+)?json/i.test(req.headers.accept ?? '');

export type ProblemKind = 'not_found' | 'expired' | 'limit_reached' | 'rate_limited';

/** O que a página do 410 sabe dizer: a data da expiração ou o tamanho do limite. */
export interface ProblemInfo {
  expiresAt?: number | null;
  maxClicks?: number | null;
}

const dateFmt = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});
const numFmt = new Intl.NumberFormat('pt-BR');

function describe(
  kind: ProblemKind,
  info: ProblemInfo,
): { status: number; title: string; detail: string; extra: Record<string, unknown> } {
  switch (kind) {
    case 'not_found':
      return {
        status: 404,
        title: 'Link não encontrado',
        detail:
          'Este link não existe ou não está mais disponível. Confira se ele foi copiado inteiro.',
        extra: {},
      };
    case 'expired': {
      const at = info.expiresAt ?? null;
      return {
        status: 410,
        title: 'Este link expirou',
        detail:
          at === null
            ? 'O prazo deste link terminou. Se alguém te mandou, peça um link novo.'
            : `Quem criou este link definiu que ele valia até ${dateFmt.format(at)} (horário de Brasília). Se alguém te mandou, peça um link novo.`,
        extra: at === null ? {} : { expired_at: new Date(at).toISOString() },
      };
    }
    case 'limit_reached': {
      const max = info.maxClicks ?? null;
      return {
        status: 410,
        title: 'Este link atingiu o limite de cliques',
        detail:
          max === null
            ? 'Ele já foi aberto todas as vezes que podia.'
            : `Ele foi criado para ${numFmt.format(max)} ${max === 1 ? 'clique' : 'cliques'}, e ${max === 1 ? 'ele já foi usado' : 'todos já foram usados'}. Se alguém te mandou, peça um link novo.`,
        extra: max === null ? {} : { max_clicks: max },
      };
    }
    case 'rate_limited':
      return {
        status: 429,
        title: 'Muitas requisições',
        detail: 'Foram muitos acessos seguidos daqui. Espere alguns segundos e tente de novo.',
        extra: {},
      };
  }
}

/** 404/410/429 em HTML pequeno ou `application/problem+json` (ADR 0002). */
export function sendProblem(
  req: FastifyRequest,
  reply: FastifyReply,
  kind: ProblemKind,
  info: ProblemInfo = {},
) {
  const p = describe(kind, info);
  reply.code(p.status).header('cache-control', 'no-store');
  if (wantsJson(req)) {
    return reply.type('application/problem+json').send(
      JSON.stringify({
        type: `about:blank#${kind}`,
        title: p.title,
        status: p.status,
        detail: p.detail,
        ...p.extra,
      }),
    );
  }
  return reply
    .type('text/html; charset=utf-8')
    .send(page(p.title, `<h1>${escapeHtml(p.title)}</h1><p>${escapeHtml(p.detail)}</p>`));
}

/** Formulário de senha (passo 6). `action` repete o caminho e a query de entrada. */
export function sendPasswordForm(
  req: FastifyRequest,
  reply: FastifyReply,
  action: string,
  status: 200 | 401 = 200,
) {
  reply.code(status).header('cache-control', 'no-store');
  if (wantsJson(req)) {
    return reply.type('application/problem+json').send(
      JSON.stringify({
        type: 'about:blank#password_required',
        title: 'Senha necessária',
        status,
        detail: status === 401 ? 'Senha incorreta.' : 'Este link é protegido por senha.',
      }),
    );
  }
  const error =
    status === 401
      ? '<p class="err" id="erro" role="alert">Senha incorreta. Confira com quem te mandou o link.</p>'
      : '';
  const describedBy = status === 401 ? ' aria-describedby="erro" aria-invalid="true"' : '';
  return reply
    .type('text/html; charset=utf-8')
    .send(
      page(
        'Link protegido',
        `<h1>Este link pede senha</h1><p>Quem criou o link pediu uma senha antes de abrir. Digite a que te passaram.</p>${error}<form method="post" action="${escapeHtml(action)}"><label for="senha">Senha</label><input id="senha" type="password" name="password" autocomplete="current-password" required autofocus${describedBy}><button type="submit">Abrir link</button></form>`,
      ),
    );
}
