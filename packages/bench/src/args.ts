/** Parâmetros do `seed:big` (`--chave=valor` ou `--chave valor`). */
export interface SeedOptions {
  /** Total de cliques brutos (padrão 5.000.000). */
  clicks: number;
  /** Meses de histórico até agora (padrão 12). */
  months: number;
  /** Links (padrão 2.000). */
  links: number;
  /** Usuários donos dos links (padrão 20). */
  users: number;
  /** Conexões em paralelo na geração, nos índices e nos agregados (padrão 4). */
  jobs: number;
  /** Semente do `setseed` (mesma semente e mesmo `jobs` = mesmos dados). */
  seed: number;
  /** `series` (INSERT … SELECT generate_series no servidor) ou `copy` (COPY FROM STDIN do Node). */
  method: 'series' | 'copy';
  /** Carrega a bruta com a PK e o índice no lugar (só para medir contra o padrão, que os recria depois). */
  keepIndexes: boolean;
}

export const DEFAULT_SEED_OPTIONS: SeedOptions = {
  clicks: 5_000_000,
  months: 12,
  links: 2_000,
  users: 20,
  jobs: 4,
  seed: 42,
  method: 'series',
  keepIndexes: false,
};

const INT_KEYS = ['clicks', 'months', 'links', 'users', 'jobs', 'seed'] as const;
type IntKey = (typeof INT_KEYS)[number];

function parseCount(key: string, raw: string): number {
  // Aceita 5000000, 5_000_000 e 5.000.000.
  const n = Number(raw.replace(/[._]/g, ''));
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`--${key}: inteiro inválido "${raw}"`);
  return n;
}

export function parseSeedArgs(argv: readonly string[]): SeedOptions {
  const out: SeedOptions = { ...DEFAULT_SEED_OPTIONS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if (arg === '--keep-indexes') {
      out.keepIndexes = true;
      continue;
    }
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new TypeError(`argumento inesperado: "${arg}"`);
    const key = m[1]!;
    const value = m[2] ?? argv[++i];
    if (value === undefined) throw new TypeError(`--${key} sem valor`);
    if (key === 'method') {
      if (value !== 'series' && value !== 'copy') throw new TypeError(`--method: "${value}"`);
      out.method = value;
    } else if ((INT_KEYS as readonly string[]).includes(key)) {
      out[key as IntKey] = parseCount(key, value);
    } else {
      throw new TypeError(`opção desconhecida: --${key}`);
    }
  }
  if (out.months < 1 || out.links < 1 || out.users < 1 || out.jobs < 1) {
    throw new TypeError('--months, --links, --users e --jobs precisam ser ≥ 1');
  }
  return out;
}
