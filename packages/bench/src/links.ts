import { BASE62 } from '@encurtador/shared';
import { mulberry32 } from './profile';

/**
 * Links sintéticos do bench, com títulos e destinos variados o bastante para a busca `q` da listagem
 * (ILIKE × trigrama) ter termos raros, médios e comuns.
 */
export interface BenchLink {
  userId: number;
  slug: string;
  destination: string;
  title: string | null;
  status: 'active' | 'disabled';
  createdAt: Date;
  expiresAt: Date | null;
  /** Posição no ranking de popularidade (1 = mais clicado em potencial). */
  rank: number;
  /** Peso relativo de cliques: rank^-1,2 × lognormal(σ = 1,6); 0 = link nunca divulgado. */
  weight: number;
}

const CAMPAIGNS = [
  'Black Friday',
  'Natal',
  'Dia das Mães',
  'Volta às aulas',
  'Lançamento',
  'Webinar',
  'Newsletter',
  'Promoção relâmpago',
  'Cupom',
  'Live',
  'Podcast',
  'Vagas',
  'Evento',
  'Pesquisa',
  'E-book',
  'Liquidação',
  'Aniversário',
  'Clube',
  'Workshop',
  'Meetup',
];
const TOPICS = [
  'tênis de corrida',
  'notebooks',
  'cafeteiras',
  'curso de TypeScript',
  'Postgres na prática',
  'marketing digital',
  'receitas veganas',
  'fone bluetooth',
  'viagem para Lisboa',
  'seguro auto',
  'planilha de gastos',
  'cadeira gamer',
  'investimentos',
  'kit escolar',
  'smartwatch',
  'roupas de inverno',
  'ração para gatos',
  'bicicleta elétrica',
  'monitor 4K',
  'assinatura anual',
  'guia de SEO',
  'ofertas da semana',
  'cupom de frete',
  'masterclass de design',
  'imersão em dados',
];
const DOMAINS = [
  'www.lojaexemplo.com.br',
  'blog.exemplo.com',
  'www.example.com',
  'loja.acme.com.br',
  'cursos.exemplo.dev',
  'eventos.exemplo.org',
  'www.youtube.com',
  'docs.google.com',
  'forms.gle',
  'www.instagram.com',
  'medium.com',
  'github.com',
  'shop.exemplo.pt',
  'news.exemplo.com.br',
  'app.exemplo.io',
];
const SOURCES = ['instagram', 'newsletter', 'whatsapp', 'linkedin', 'tiktok', 'qrcode', 'x'];

const SLUG_SPACE = 62 ** 7;
/** Primo maior que 62: i × P mod 62⁷ é uma bijeção, então os slugs nunca colidem. */
const SLUG_PRIME = 2_147_483_629;

function slugFor(i: number): string {
  let x = Number((BigInt(i + 1) * BigInt(SLUG_PRIME)) % BigInt(SLUG_SPACE));
  let s = '';
  for (let k = 0; k < 7; k++) {
    s = BASE62[x % 62]! + s;
    x = Math.floor(x / 62);
  }
  return s;
}

const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export interface LinkGenOptions {
  links: number;
  users: number;
  seed: number;
  startMs: number;
  endMs: number;
  /** Prefixo do slug (os links do bench de trigrama não colidem com os do seed). */
  slugOffset?: number;
}

export function generateLinks(o: LinkGenOptions): BenchLink[] {
  const rnd = mulberry32(o.seed * 7919 + 17);
  const span = o.endMs - o.startMs;
  const preStart = 60 * 86_400_000;
  // Ranking de popularidade embaralhado (Fisher-Yates): o id não diz quem é quente.
  const ranks = Array.from({ length: o.links }, (_, i) => i + 1);
  for (let i = ranks.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [ranks[i], ranks[j]] = [ranks[j]!, ranks[i]!];
  }
  const out: BenchLink[] = [];
  for (let i = 0; i < o.links; i++) {
    const rank = ranks[i]!;
    const z = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    const neverShared = rnd() < 0.05;
    const weight = neverShared ? 0 : rank ** -1.2 * Math.exp(1.6 * z);
    // Os 5 mais populares existem antes do início (série do ano inteiro); os outros nascem ao longo
    // do período, mais no começo (~27 % antes do início).
    const createdAt =
      rank <= 5
        ? o.startMs - 30 * 86_400_000
        : o.startMs - preStart + rnd() ** 1.5 * (span + preStart - 3_600_000);
    // Usuários com carteiras desiguais: o usuário 1 tem ~22 % dos links.
    const userId = 1 + Math.floor(o.users * rnd() ** 2);
    const campaign = CAMPAIGNS[Math.floor(rnd() * CAMPAIGNS.length)]!;
    const topic = TOPICS[Math.floor(rnd() * TOPICS.length)]!;
    const year = 2024 + Math.floor(rnd() * 3);
    const domain = DOMAINS[Math.floor(rnd() ** 1.5 * DOMAINS.length)]!;
    const source = SOURCES[Math.floor(rnd() * SOURCES.length)]!;
    const path = `${slugify(topic)}-${Math.floor(rnd() * 100_000)}`;
    const hasTitle = rnd() > 0.1;
    const expires = rnd() < 0.05;
    out.push({
      userId,
      slug: slugFor((o.slugOffset ?? 0) + i),
      destination: `https://${domain}/${slugify(campaign)}/${path}?utm_source=${source}&utm_campaign=${slugify(campaign)}-${year}`,
      title: hasTitle ? `${campaign}: ${topic} ${year}` : null,
      status: rnd() < 0.03 ? 'disabled' : 'active',
      createdAt: new Date(Math.floor(createdAt)),
      expiresAt: expires ? new Date(Math.floor(createdAt + 90 * 86_400_000)) : null,
      rank,
      weight,
    });
  }
  return out;
}
