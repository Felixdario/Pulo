/**
 * `application/problem+json` (RFC 9457, ADR 0004) → mensagens em pt-BR para a interface.
 * A API manda `code` estável e, nos 422, `errors[]` com campo e código; a mensagem que a pessoa lê
 * sai daqui, nunca do `detail` técnico.
 */

export interface FieldProblem {
  field: string;
  code: string;
  message: string;
}

export interface Problem {
  type?: string;
  title?: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  errors?: FieldProblem[];
  [extra: string]: unknown;
}

const CODE_MESSAGES: Record<string, string> = {
  bad_request: 'O pedido saiu malformado. Recarregue a página e tente de novo.',
  unauthorized: 'Sua sessão acabou. Entre de novo para continuar.',
  invalid_credentials: 'E-mail ou senha incorretos.',
  invalid_refresh: 'Sua sessão expirou. Entre de novo para continuar.',
  invalid_ticket: 'A conexão ao vivo expirou. Tentando de novo.',
  insufficient_scope: 'Esta credencial não tem permissão para isso.',
  session_required: 'Isso só pode ser feito pelo painel, não por chave de API.',
  csrf: 'O pedido foi recusado por segurança. Recarregue a página.',
  not_found: 'Não encontramos isso. Pode ter sido apagado ou ser de outra conta.',
  method_not_allowed: 'Essa ação não existe aqui.',
  alias_taken: 'Este alias já está em uso. Escolha outro.',
  email_taken: 'Já existe uma conta com este e-mail. Entre com ele ou use outro.',
  idempotency_in_progress: 'Ainda estamos criando este link. Espere um instante.',
  gone: 'Este link foi apagado.',
  precondition_failed: 'Alguém editou este link em outra aba. Recarregue para ver a versão atual.',
  payload_too_large: 'Isso passou do tamanho que aceitamos.',
  unsupported_media_type: 'O pedido saiu num formato que não aceitamos.',
  validation: 'Alguns campos não passaram na validação.',
  idempotency_mismatch:
    'Este envio repetiu uma tentativa anterior com outros dados. Tente de novo.',
  invalid_cursor: 'A lista mudou enquanto você rolava. Recarregue a lista.',
  cursor_mismatch: 'A lista mudou enquanto você rolava. Recarregue a lista.',
  range_too_large: 'Esse período é grande demais para essa visão. Escolha um menor.',
  preview_blocked: 'Não dá para abrir essa página: o endereço é de uma rede privada ou local.',
  upstream_error: 'Não deu para ver a página agora; o link funciona mesmo assim.',
  slug_exhausted: 'Não achamos um nome livre agora. Tente de novo.',
  internal: 'Algo deu errado do nosso lado. Tente de novo em instantes.',
};

/** Códigos de campo (validação semântica da API e do Zod) → frase. */
const FIELD_MESSAGES: Record<string, string> = {
  invalid_url: 'Isso não parece um endereço da web. Ele precisa ter um domínio, como loja.com.br.',
  too_long: 'Esse endereço passa de 4.096 caracteres.',
  unsupported_protocol: 'Só endereços que começam com http:// ou https://.',
  credentials: 'Tire o usuário e a senha de dentro do endereço.',
  private_host:
    'Esse endereço é de uma rede privada ou local (como 192.168… ou localhost): quem receber o link não conseguiria abrir.',
  loop: 'Esse endereço já é um link curto nosso. Apontar para ele criaria um loop.',
  alias_format: 'Use de 3 a 64 letras, números, _ ou -, começando por letra ou número.',
  alias_reserved: 'Esse nome é reservado pelo sistema. Escolha outro.',
  slug_taken: 'Este alias já está em uso. Escolha outro.',
  past: 'A expiração precisa ser no futuro.',
};

const FIELD_FALLBACK: Record<string, string> = {
  email: 'Digite um e-mail válido, como voce@exemplo.com.',
  password: 'A senha precisa ter pelo menos 8 caracteres.',
  name: 'Dê um nome à chave, com até 100 caracteres.',
  scopes: 'Marque pelo menos um escopo.',
  max_clicks: 'Use um número inteiro a partir de 1.',
  expires_at: 'Escolha uma data e hora válidas.',
  destination: 'Confira o endereço de destino.',
  alias: 'Confira o alias.',
};

export function fieldMessage(e: FieldProblem): string {
  const known = FIELD_MESSAGES[e.code];
  if (known) return known;
  if (e.field.startsWith('password') && e.field !== 'password') return 'Confira a senha.';
  const root = e.field.split('.')[0] ?? e.field;
  if (root === 'rules') return 'Confira o endereço desta regra.';
  return FIELD_FALLBACK[root] ?? 'Confira este campo.';
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const min = Math.ceil(seconds / 60);
  return min === 1 ? '1 min' : `${min} min`;
}

/** Erro de qualquer chamada à API, já com a mensagem para a pessoa. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem | null;
  /** Segundos de espera do `Retry-After` (429). */
  readonly retryAfter: number | null;
  /** Mensagem por campo (`destination`, `alias`, `rules.geo.0.url`…). */
  readonly fields: Record<string, string>;

  constructor(status: number, problem: Problem | null, retryAfter: number | null = null) {
    const code = problem?.code ?? (status === 0 ? 'network' : `http_${status}`);
    super(messageFor(status, code, retryAfter));
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.problem = problem;
    this.retryAfter = retryAfter;
    this.fields = {};
    for (const e of problem?.errors ?? []) {
      if (!(e.field in this.fields)) this.fields[e.field] = fieldMessage(e);
    }
  }

  /** A primeira mensagem de campo, ou a geral. */
  get firstMessage(): string {
    return Object.values(this.fields)[0] ?? this.message;
  }
}

export function messageFor(status: number, code: string, retryAfter: number | null): string {
  if (status === 0) return 'Sem conexão com o servidor. Confira a internet e tente de novo.';
  if (code === 'rate_limited' || status === 429) {
    return retryAfter
      ? `Muitas tentativas seguidas. Tente de novo em ${formatWait(retryAfter)}.`
      : 'Muitas tentativas seguidas. Espere um pouco e tente de novo.';
  }
  const known = CODE_MESSAGES[code];
  if (known) return known;
  if (status >= 500) return CODE_MESSAGES.internal!;
  return 'Não deu certo. Tente de novo.';
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
