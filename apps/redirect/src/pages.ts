import type { FastifyReply, FastifyRequest } from 'fastify';

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const CSS =
  'body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f6f4;color:#1c1c1a}' +
  'main{max-width:28rem;padding:2rem 1.5rem;text-align:center}' +
  'h1{font-size:1.375rem;margin:0 0 .5rem}p{margin:0 0 1rem;color:#55554f}' +
  'form{display:grid;gap:.75rem;margin-top:1rem}' +
  'input{font:inherit;padding:.625rem .75rem;border:1px solid #c9c9c3;border-radius:.5rem}' +
  'button{font:inherit;padding:.625rem;border:0;border-radius:.5rem;background:#1c1c1a;color:#fff;cursor:pointer}' +
  '.err{color:#a3261b}' +
  '@media (prefers-color-scheme:dark){body{background:#151514;color:#ededea}p{color:#a5a59f}input{background:#1f1f1d;color:inherit;border-color:#3a3a36}button{background:#ededea;color:#151514}.err{color:#f08a7e}}';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

const wantsJson = (req: FastifyRequest) =>
  /application\/(problem\+)?json/i.test(req.headers.accept ?? '');

export type ProblemKind = 'not_found' | 'expired' | 'limit_reached' | 'rate_limited';

const PROBLEMS: Record<ProblemKind, { status: number; title: string; detail: string }> = {
  not_found: {
    status: 404,
    title: 'Link não encontrado',
    detail: 'Este link não existe ou não está disponível.',
  },
  expired: { status: 410, title: 'Este link expirou', detail: 'O prazo deste link terminou.' },
  limit_reached: {
    status: 410,
    title: 'Este link atingiu o limite',
    detail: 'O número máximo de acessos deste link já foi alcançado.',
  },
  rate_limited: {
    status: 429,
    title: 'Muitas requisições',
    detail: 'Espere alguns segundos e tente de novo.',
  },
};

/** 404/410/429 em HTML pequeno ou `application/problem+json` (ADR 0002). */
export function sendProblem(req: FastifyRequest, reply: FastifyReply, kind: ProblemKind) {
  const p = PROBLEMS[kind];
  reply.code(p.status).header('cache-control', 'no-store');
  if (wantsJson(req)) {
    return reply.type('application/problem+json').send(
      JSON.stringify({
        type: `about:blank#${kind}`,
        title: p.title,
        status: p.status,
        detail: p.detail,
      }),
    );
  }
  return reply
    .type('text/html; charset=utf-8')
    .send(page(p.title, `<h1>${p.title}</h1><p>${p.detail}</p>`));
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
  const error = status === 401 ? '<p class="err" role="alert">Senha incorreta.</p>' : '';
  return reply
    .type('text/html; charset=utf-8')
    .send(
      page(
        'Link protegido',
        `<h1>Link protegido</h1><p>Digite a senha para continuar.</p>${error}<form method="post" action="${escapeHtml(action)}"><input type="password" name="password" aria-label="Senha" autocomplete="current-password" required autofocus><button type="submit">Abrir link</button></form>`,
      ),
    );
}
