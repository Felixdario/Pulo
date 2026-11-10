import { Dialog } from '@base-ui/react/dialog';
import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api/problem';
import type { DeviceMatch, Link, LinkPatch, RedirectType } from '../lib/api/types';
import { num } from '../lib/format';
import { DEVICE_LABEL, isPermanent, ruleChips } from '../lib/rules';
import { completeUrl } from '../lib/validation';
import { CountryPicker } from './CountryPicker';
import { IconClose, IconPlus, IconTrash } from './Icons';

/** `datetime-local` ⇄ ISO, no fuso de quem edita. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface FormState {
  destination: string;
  title: string;
  expires: string;
  password: 'keep' | 'set' | 'remove';
  newPassword: string;
  maxClicks: string;
  redirectType: RedirectType;
  forwardQuery: boolean;
  geo: { countries: string[]; url: string }[];
  device: { match: DeviceMatch; url: string }[];
}

function fromLink(link: Link): FormState {
  return {
    destination: link.destination,
    title: link.title ?? '',
    expires: toLocalInput(link.expires_at),
    password: link.has_password ? 'keep' : 'remove',
    newPassword: '',
    maxClicks: link.max_clicks === null ? '' : String(link.max_clicks),
    redirectType: link.redirect_type as RedirectType,
    forwardQuery: link.forward_query,
    geo: (link.rules.geo ?? []).map((g) => ({ countries: [...g.countries], url: g.url })),
    device: (link.rules.device ?? []).map((d) => ({ match: d.match, url: d.url })),
  };
}

function toPatch(f: FormState, link: Link): LinkPatch | { error: string; field: string } {
  const patch: LinkPatch = {
    destination: completeUrl(f.destination),
    title: f.title.trim() === '' ? null : f.title.trim(),
    redirect_type: f.redirectType,
    forward_query: f.forwardQuery,
  };
  // Só manda a expiração se mudou: uma data que já passou seria recusada ao salvar outro campo.
  if (f.expires !== toLocalInput(link.expires_at)) {
    patch.expires_at = f.expires ? new Date(f.expires).toISOString() : null;
  }
  if (f.maxClicks.trim() === '') patch.max_clicks = null;
  else {
    const n = Number(f.maxClicks);
    if (!Number.isInteger(n) || n < 1) {
      return { field: 'max_clicks', error: 'Use um número inteiro a partir de 1, ou deixe vazio.' };
    }
    patch.max_clicks = n;
  }
  if (f.password === 'set') {
    if (f.newPassword.length < 4) {
      return { field: 'password', error: 'A senha precisa ter pelo menos 4 caracteres.' };
    }
    patch.password = f.newPassword;
  } else if (f.password === 'remove' && link.has_password) {
    patch.password = null;
  }
  for (const [i, g] of f.geo.entries()) {
    if (g.countries.length === 0) {
      return { field: `rules.geo.${i}.countries`, error: 'Escolha pelo menos um país.' };
    }
  }
  patch.rules = {
    geo: f.geo
      .filter((g) => g.url.trim())
      .map((g) => ({ countries: g.countries, url: completeUrl(g.url) })),
    device: f.device
      .filter((d) => d.url.trim())
      .map((d) => ({ match: d.match, url: completeUrl(d.url) })),
  };
  return patch;
}

/** As frases das regras como ficarão (o chip de cada uma, lido em ordem). */
function previewSentences(f: FormState, link: Link): string[] {
  const draft: Link = {
    ...link,
    expires_at: f.expires ? new Date(f.expires).toISOString() : null,
    is_expired: false,
    has_password: f.password === 'set' || (f.password === 'keep' && link.has_password),
    max_clicks: f.maxClicks && Number(f.maxClicks) > 0 ? Number(f.maxClicks) : null,
    redirect_type: f.redirectType,
    forward_query: f.forwardQuery,
    rules: {
      geo: f.geo.filter((g) => g.url && g.countries.length),
      device: f.device.filter((d) => d.url),
    },
  };
  return ruleChips(draft).map((c) => c.sentence);
}

export function EditLinkDialog({
  link,
  etag,
  open,
  onOpenChange,
  onSave,
  onReload,
}: {
  link: Link;
  etag: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: LinkPatch, etag: string | null) => Promise<void>;
  onReload: () => Promise<Link | undefined>;
}) {
  const [form, setForm] = useState<FormState>(() => fromLink(link));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [local, setLocal] = useState<{ field: string; error: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const ids = {
    destino: useId(),
    titulo: useId(),
    expira: useId(),
    limite: useId(),
    senha: useId(),
    tipo: useId(),
  };
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const fieldError = (field: string) =>
    local?.field === field ? local.error : (error?.fields[field] ?? null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const patch = toPatch(form, link);
    if ('error' in patch) {
      setLocal(patch);
      return;
    }
    setLocal(null);
    setError(null);
    setBusy(true);
    try {
      await onSave(patch, etag);
      onOpenChange(false);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(0, null);
      if (apiErr.status === 412) setConflict(true);
      else setError(apiErr);
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    const fresh = await onReload();
    if (fresh) setForm(fromLink(fresh));
    setConflict(false);
    setError(null);
  }

  const sentences = previewSentences(form, link);
  const general =
    error && Object.keys(error.fields).length === 0
      ? error.message
      : error
        ? 'Confira os campos marcados.'
        : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fundo-dialogo camada" />
        <Dialog.Popup className="flutuante dialogo dialogo-largo camada">
          <div className="dialogo-topo">
            <Dialog.Title className="dialogo-titulo">Editar regras</Dialog.Title>
            <Dialog.Close className="btn btn-fantasma btn-icone" aria-label="Fechar">
              <IconClose />
            </Dialog.Close>
          </div>
          <Dialog.Description className="dialogo-texto">
            O link curto não muda: ele já pode estar impresso ou compartilhado.
          </Dialog.Description>

          {conflict && (
            <div className="aviso-bloco" role="alert">
              <p>
                <strong>Alguém editou este link em outra aba.</strong> Para não apagar a outra
                edição, recarregue e refaça a sua.
              </p>
              <button
                type="button"
                className="btn btn-primario btn-pequeno"
                onClick={() => void reload()}
              >
                Recarregar
              </button>
            </div>
          )}

          <form className="editar" onSubmit={submit} noValidate>
            <section className="editar-bloco" aria-label="Como o link decide">
              <p className="rotulo suave">Como o link decide, em ordem</p>
              {sentences.length ? (
                <ol className="frases">
                  {sentences.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                  <li className="suave">Senão, vai para o destino padrão.</li>
                </ol>
              ) : (
                <p>Sem regras: todo clique vai para o destino padrão.</p>
              )}
            </section>

            <div className="editar-grade">
              <div className="campo-grupo editar-largo">
                <label className="campo-rotulo" htmlFor={ids.destino}>
                  Destino padrão
                </label>
                <input
                  id={ids.destino}
                  className="campo"
                  type="url"
                  value={form.destination}
                  onChange={(e) => set('destination', e.target.value)}
                  aria-invalid={fieldError('destination') ? true : undefined}
                  aria-describedby={fieldError('destination') ? `${ids.destino}-e` : undefined}
                />
                {fieldError('destination') && (
                  <p id={`${ids.destino}-e`} className="campo-erro" role="alert">
                    {fieldError('destination')}
                  </p>
                )}
              </div>
              <div className="campo-grupo editar-largo">
                <label className="campo-rotulo" htmlFor={ids.titulo}>
                  Título
                </label>
                <input
                  id={ids.titulo}
                  className="campo"
                  maxLength={500}
                  value={form.title}
                  onChange={(e) => set('title', e.target.value)}
                />
              </div>
              <div className="campo-grupo">
                <label className="campo-rotulo" htmlFor={ids.expira}>
                  Expira em (opcional)
                </label>
                <input
                  id={ids.expira}
                  className="campo"
                  type="datetime-local"
                  value={form.expires}
                  onChange={(e) => set('expires', e.target.value)}
                  aria-invalid={fieldError('expires_at') ? true : undefined}
                  aria-describedby={fieldError('expires_at') ? `${ids.expira}-e` : undefined}
                />
                {fieldError('expires_at') && (
                  <p id={`${ids.expira}-e`} className="campo-erro" role="alert">
                    {fieldError('expires_at')}
                  </p>
                )}
              </div>
              <div className="campo-grupo">
                <label className="campo-rotulo" htmlFor={ids.limite}>
                  Limite de cliques humanos (opcional)
                </label>
                <input
                  id={ids.limite}
                  className="campo num"
                  inputMode="numeric"
                  placeholder="Sem limite"
                  value={form.maxClicks}
                  onChange={(e) => set('maxClicks', e.target.value.replace(/\D/g, ''))}
                  aria-invalid={fieldError('max_clicks') ? true : undefined}
                  aria-describedby={`${ids.limite}-a`}
                />
                <p
                  id={`${ids.limite}-a`}
                  className={fieldError('max_clicks') ? 'campo-erro' : 'campo-ajuda'}
                >
                  {fieldError('max_clicks') ??
                    (form.maxClicks
                      ? `Para depois de ${num(Number(form.maxClicks))} cliques. Robôs e prévias não gastam.`
                      : 'Robôs e prévias não gastam o limite.')}
                </p>
              </div>
            </div>

            <fieldset className="editar-bloco">
              <legend className="campo-rotulo">Senha</legend>
              <div className="opcoes">
                {link.has_password && (
                  <label className="marcar">
                    <input
                      type="radio"
                      name="senha"
                      checked={form.password === 'keep'}
                      onChange={() => set('password', 'keep')}
                    />
                    Manter a senha atual
                  </label>
                )}
                <label className="marcar">
                  <input
                    type="radio"
                    name="senha"
                    checked={form.password === 'set'}
                    onChange={() => set('password', 'set')}
                  />
                  {link.has_password ? 'Trocar a senha' : 'Pedir senha'}
                </label>
                <label className="marcar">
                  <input
                    type="radio"
                    name="senha"
                    checked={form.password === 'remove'}
                    onChange={() => set('password', 'remove')}
                  />
                  {link.has_password ? 'Tirar a senha' : 'Sem senha'}
                </label>
              </div>
              {form.password === 'set' && (
                <div className="campo-grupo">
                  <label className="campo-rotulo" htmlFor={ids.senha}>
                    Nova senha
                  </label>
                  <input
                    id={ids.senha}
                    className="campo"
                    type="password"
                    autoComplete="new-password"
                    value={form.newPassword}
                    onChange={(e) => set('newPassword', e.target.value)}
                    aria-invalid={fieldError('password') ? true : undefined}
                    aria-describedby={`${ids.senha}-a`}
                  />
                  <p
                    id={`${ids.senha}-a`}
                    className={fieldError('password') ? 'campo-erro' : 'campo-ajuda'}
                  >
                    {fieldError('password') ??
                      'Pelo menos 4 caracteres. Quem abrir o link digita antes de ir.'}
                  </p>
                </div>
              )}
            </fieldset>

            <fieldset className="editar-bloco">
              <legend className="campo-rotulo">Tipo de redirect</legend>
              <div className="opcoes">
                {([302, 307, 301, 308] as const).map((t) => (
                  <label key={t} className="marcar">
                    <input
                      type="radio"
                      name="tipo"
                      checked={form.redirectType === t}
                      onChange={() => set('redirectType', t)}
                    />
                    <span>
                      <strong>{t}</strong>{' '}
                      <span className="suave">
                        {t === 302
                          ? 'temporário (padrão)'
                          : t === 307
                            ? 'temporário, mantém o método'
                            : t === 301
                              ? 'permanente'
                              : 'permanente, mantém o método'}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {isPermanent(form.redirectType) && (
                <p className="aviso-bloco" role="note">
                  Com {form.redirectType}, o navegador guarda o destino: os cliques repetidos da
                  mesma pessoa podem não passar por aqui e não ser contados (por até{' '}
                  {Math.round(link.cache_ttl / 60)} min de cache). Também fica difícil mudar o
                  destino depois para quem já clicou.
                </p>
              )}
              <label className="marcar">
                <input
                  type="checkbox"
                  checked={form.forwardQuery}
                  onChange={(e) => set('forwardQuery', e.target.checked)}
                />
                <span>
                  Repassar a query{' '}
                  <span className="suave">
                    (<span className="mono">?utm_source=story</span> no link curto chega ao destino)
                  </span>
                </span>
              </label>
            </fieldset>

            <fieldset className="editar-bloco">
              <legend className="campo-rotulo">Destino por país</legend>
              <p className="campo-ajuda">
                Vale antes do aparelho. A primeira regra que casar decide.
              </p>
              {form.geo.map((g, i) => (
                <div key={i} className="regra-linha">
                  <CountryPicker
                    label={`Regra ${i + 1}: países`}
                    value={g.countries}
                    invalid={Boolean(fieldError(`rules.geo.${i}.countries`))}
                    onChange={(countries) =>
                      set(
                        'geo',
                        form.geo.map((x, k) => (k === i ? { ...x, countries } : x)),
                      )
                    }
                  />
                  <div className="campo-grupo">
                    <label className="campo-rotulo" htmlFor={`${ids.destino}-g${i}`}>
                      vai para
                    </label>
                    <input
                      id={`${ids.destino}-g${i}`}
                      className="campo"
                      type="url"
                      value={g.url}
                      placeholder="https://sualoja.com.br/pt"
                      onChange={(e) =>
                        set(
                          'geo',
                          form.geo.map((x, k) => (k === i ? { ...x, url: e.target.value } : x)),
                        )
                      }
                      aria-invalid={fieldError(`rules.geo.${i}.url`) ? true : undefined}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-fantasma btn-icone regra-tirar"
                    aria-label={`Tirar a regra ${i + 1} de país`}
                    onClick={() =>
                      set(
                        'geo',
                        form.geo.filter((_, k) => k !== i),
                      )
                    }
                  >
                    <IconTrash />
                  </button>
                  {(fieldError(`rules.geo.${i}.url`) || fieldError(`rules.geo.${i}.countries`)) && (
                    <p className="campo-erro regra-erro">
                      {fieldError(`rules.geo.${i}.countries`) ?? fieldError(`rules.geo.${i}.url`)}
                    </p>
                  )}
                </div>
              ))}
              {form.geo.length < 50 && (
                <button
                  type="button"
                  className="btn btn-secundario btn-pequeno"
                  onClick={() => set('geo', [...form.geo, { countries: [], url: '' }])}
                >
                  <IconPlus /> Regra de país
                </button>
              )}
            </fieldset>

            <fieldset className="editar-bloco">
              <legend className="campo-rotulo">Destino por aparelho</legend>
              {form.device.map((d, i) => (
                <div key={i} className="regra-linha">
                  <div className="campo-grupo">
                    <label className="campo-rotulo" htmlFor={`${ids.tipo}-d${i}`}>
                      Regra {i + 1}: no
                    </label>
                    <select
                      id={`${ids.tipo}-d${i}`}
                      className="campo"
                      value={d.match}
                      onChange={(e) =>
                        set(
                          'device',
                          form.device.map((x, k) =>
                            k === i ? { ...x, match: e.target.value as DeviceMatch } : x,
                          ),
                        )
                      }
                    >
                      {(Object.keys(DEVICE_LABEL) as DeviceMatch[]).map((m) => (
                        <option key={m} value={m}>
                          {DEVICE_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="campo-grupo">
                    <label className="campo-rotulo" htmlFor={`${ids.tipo}-u${i}`}>
                      vai para
                    </label>
                    <input
                      id={`${ids.tipo}-u${i}`}
                      className="campo"
                      type="url"
                      value={d.url}
                      placeholder="https://apps.apple.com/…"
                      onChange={(e) =>
                        set(
                          'device',
                          form.device.map((x, k) => (k === i ? { ...x, url: e.target.value } : x)),
                        )
                      }
                      aria-invalid={fieldError(`rules.device.${i}.url`) ? true : undefined}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-fantasma btn-icone regra-tirar"
                    aria-label={`Tirar a regra ${i + 1} de aparelho`}
                    onClick={() =>
                      set(
                        'device',
                        form.device.filter((_, k) => k !== i),
                      )
                    }
                  >
                    <IconTrash />
                  </button>
                  {fieldError(`rules.device.${i}.url`) && (
                    <p className="campo-erro regra-erro">{fieldError(`rules.device.${i}.url`)}</p>
                  )}
                </div>
              ))}
              {form.device.length < 10 && (
                <button
                  type="button"
                  className="btn btn-secundario btn-pequeno"
                  onClick={() => set('device', [...form.device, { match: 'ios', url: '' }])}
                >
                  <IconPlus /> Regra de aparelho
                </button>
              )}
            </fieldset>

            {general && (
              <p className="campo-erro" role="alert">
                {general}
              </p>
            )}
            <div className="dialogo-acoes">
              <Dialog.Close className="btn btn-secundario">Cancelar</Dialog.Close>
              <button type="submit" className="btn btn-primario" disabled={busy || conflict}>
                {busy ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
