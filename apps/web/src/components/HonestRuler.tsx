import { num, percent } from '../lib/format';

/**
 * Régua honesta (DESIGN.md): humanos, bots e prévias numa barra só, separados por costura de 2 px.
 * Só a parte humana é rosa; bots em hachura, prévias em pontilhado. Cor nunca é a única pista: cada
 * parte tem rótulo, número e porcentagem embaixo.
 */
const APP_NAMES: Record<string, string> = {
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  telegram: 'Telegram',
  discord: 'Discord',
  facebook: 'Facebook',
  twitter: 'X/Twitter',
  linkedin: 'LinkedIn',
  imessage: 'iMessage',
  skype: 'Skype',
  teams: 'Teams',
  other: 'outros',
};

export const appName = (app: string) => APP_NAMES[app] ?? app;

export function HonestRuler({
  humans,
  bots,
  previews,
  previewApps = [],
  loading = false,
}: {
  humans: number;
  bots: number;
  previews: number;
  previewApps?: { app: string; n: number }[];
  loading?: boolean;
}) {
  const total = humans + bots + previews;
  const share = (n: number) => (total > 0 ? n / total : 0);
  const apps = previewApps
    .filter((a) => a.n > 0)
    .slice(0, 3)
    .map((a) => `${appName(a.app)} ${num(a.n)}`)
    .join(', ');
  const summary =
    total === 0
      ? 'Nenhum clique no período.'
      : `Humanos ${num(humans)} (${percent(share(humans))}), bots ${num(bots)}, prévias ${num(previews)}.`;

  return (
    <figure className="regua" aria-label="Régua honesta: humanos, bots e prévias">
      <div className="regua-barra" role="img" aria-label={loading ? 'Carregando' : summary}>
        {total === 0 || loading ? (
          <span className="regua-vazia" />
        ) : (
          <>
            {humans > 0 && <span className="regua-humanos" style={{ flexGrow: humans }} />}
            {bots > 0 && <span className="regua-bots" style={{ flexGrow: bots }} />}
            {previews > 0 && <span className="regua-previas" style={{ flexGrow: previews }} />}
          </>
        )}
      </div>
      <figcaption className="regua-legenda">
        <span>
          <i className="amostra amostra-humanos" aria-hidden="true" />
          Humanos <strong className="num">{loading ? '—' : num(humans)}</strong>
          {!loading && total > 0 && <span className="suave"> ({percent(share(humans))})</span>}
        </span>
        <span>
          <i className="amostra amostra-bots" aria-hidden="true" />
          Bots <strong className="num">{loading ? '—' : num(bots)}</strong>
        </span>
        <span>
          <i className="amostra amostra-previas" aria-hidden="true" />
          Prévias <strong className="num">{loading ? '—' : num(previews)}</strong>
          {apps && <span className="suave"> ({apps})</span>}
        </span>
      </figcaption>
      <p className="regua-nota suave">Só humanos entram no total e no limite de cliques.</p>
    </figure>
  );
}
