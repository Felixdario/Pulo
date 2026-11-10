import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Confirm, CopyButton, ErrorBlock, Skeleton } from '../components/ui';
import { ApiError } from '../lib/api/problem';
import type { ApiKey, ApiScope, CreatedApiKey } from '../lib/api/types';
import { dateShort, relative } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { api } from '../lib/session';
import { pageTitle } from '../title';

const SCOPES: { value: ApiScope; label: string; help: string }[] = [
  { value: 'links:read', label: 'links:read', help: 'Listar e ler links.' },
  { value: 'links:write', label: 'links:write', help: 'Criar, editar e apagar links.' },
  { value: 'stats:read', label: 'stats:read', help: 'Ler estatísticas e o ao vivo.' },
];

function CreateKey({ onCreated }: { onCreated: (k: CreatedApiKey) => void }) {
  const ids = { nome: useId(), escopos: useId() };
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['links:read']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [local, setLocal] = useState<{ name?: string; scopes?: string }>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    const issues: { name?: string; scopes?: string } = {};
    if (!name.trim()) issues.name = 'Dê um nome à chave, como "CI" ou "Zapier".';
    if (scopes.length === 0) issues.scopes = 'Marque pelo menos um escopo.';
    setLocal(issues);
    if (issues.name || issues.scopes) return;
    setBusy(true);
    setError(null);
    try {
      const key = await api.post<CreatedApiKey>('/v1/api-keys', { name: name.trim(), scopes });
      setName('');
      onCreated(key);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, null));
    } finally {
      setBusy(false);
    }
  }

  const nameError = local.name ?? error?.fields.name;
  const scopesError = local.scopes ?? error?.fields.scopes;
  return (
    <form className="chave-form" onSubmit={submit} noValidate>
      <div className="campo-grupo">
        <label className="campo-rotulo" htmlFor={ids.nome}>
          Nome
        </label>
        <input
          id={ids.nome}
          className="campo"
          maxLength={100}
          placeholder="CI do site"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${ids.nome}-e` : undefined}
        />
        {nameError && (
          <p id={`${ids.nome}-e`} className="campo-erro" role="alert">
            {nameError}
          </p>
        )}
      </div>
      <fieldset className="escopos" aria-describedby={scopesError ? `${ids.escopos}-e` : undefined}>
        <legend className="campo-rotulo">Escopos</legend>
        {SCOPES.map((s) => (
          <label key={s.value} className="marcar">
            <input
              type="checkbox"
              checked={scopes.includes(s.value)}
              onChange={(e) =>
                setScopes((prev) =>
                  e.target.checked ? [...prev, s.value] : prev.filter((x) => x !== s.value),
                )
              }
            />
            <span>
              <span className="mono">{s.label}</span> <span className="suave">{s.help}</span>
            </span>
          </label>
        ))}
        {scopesError && (
          <p id={`${ids.escopos}-e`} className="campo-erro" role="alert">
            {scopesError}
          </p>
        )}
      </fieldset>
      {error && !error.fields.name && !error.fields.scopes && (
        <p className="campo-erro" role="alert">
          {error.message}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primario" disabled={busy}>
          {busy ? 'Criando…' : 'Criar chave'}
        </button>
      </div>
    </form>
  );
}

function NewKey({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
  return (
    <div className="chave-nova" role="status">
      <p className="chave-nova-aviso">
        <strong>Guarde agora: depois ela não aparece mais.</strong> Guardamos só o hash; se perder,
        revogue e crie outra.
      </p>
      <p className="rotulo suave">
        {created.name} · {created.scopes.join(', ')}
      </p>
      <code className="chave-segredo mono" data-testid="chave-nova">
        {created.key}
      </code>
      <div className="chave-nova-acoes">
        <CopyButton text={created.key} announce="Chave copiada" />
        <button type="button" className="btn btn-secundario" onClick={onDone}>
          Já guardei
        </button>
      </div>
    </div>
  );
}

function KeyRow({ k, onRevoke }: { k: ApiKey; onRevoke: (k: ApiKey) => void }) {
  return (
    <tr className="linha">
      <td>
        <span className="linha-nome">{k.name}</span>
        <span className="mono suave linha-titulo">{k.display}</span>
      </td>
      <td>
        <ul className="chips">
          {k.scopes.map((s) => (
            <li key={s} className="chip mono">
              {s}
            </li>
          ))}
        </ul>
      </td>
      <td className="suave">
        {k.last_used_at ? (
          <time dateTime={k.last_used_at} title={k.last_used_at}>
            {relative(k.last_used_at)}
          </time>
        ) : (
          'Nunca usada'
        )}
      </td>
      <td className="suave col-data">{dateShort(k.created_at)}</td>
      <td className="col-acoes">
        <button
          type="button"
          className="btn btn-secundario btn-pequeno"
          onClick={() => onRevoke(k)}
          aria-label={`Revogar ${k.name}`}
        >
          Revogar
        </button>
      </td>
    </tr>
  );
}

export function KeysPage() {
  useDocumentTitle(pageTitle('Chaves de API'));
  const qc = useQueryClient();
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: ({ signal }) => api.get<{ data: ApiKey[] }>('/v1/api-keys', { signal }),
  });

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.del(`/v1/api-keys/${revoking.id}`);
      toast.success(`Chave ${revoking.name} revogada. Ela parou de funcionar agora.`);
      setRevoking(null);
      api.forget('/v1/api-keys');
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não deu certo.');
    } finally {
      setBusy(false);
    }
  }

  const list = keys.data?.data ?? [];

  return (
    <div className="tela-conteudo">
      <header className="tela-cabeca">
        <h1 className="titulo-tela">Chaves de API</h1>
      </header>

      <section className="config" aria-labelledby="t-nova-chave">
        <div className="config-texto">
          <h2 id="t-nova-chave" className="folha-titulo">
            Nova chave
          </h2>
          <p className="suave">
            Para scripts e integrações. Envie em <span className="mono">Authorization: Bearer</span>
            . Dê só os escopos que a integração precisa.
          </p>
        </div>
        <div className="folha">
          {created ? (
            <NewKey created={created} onDone={() => setCreated(null)} />
          ) : (
            <CreateKey
              onCreated={(k) => {
                setCreated(k);
                api.forget('/v1/api-keys');
                void qc.invalidateQueries({ queryKey: ['api-keys'] });
              }}
            />
          )}
        </div>
      </section>

      <section className="config" aria-labelledby="t-chaves">
        <div className="config-texto">
          <h2 id="t-chaves" className="folha-titulo">
            Chaves ativas
          </h2>
          <p className="suave">
            Revogar corta o acesso na hora. O último uso é atualizado no máximo uma vez por minuto.
          </p>
        </div>
        <div className="folha folha-tabela">
          {keys.isError ? (
            <ErrorBlock
              message={`Não deu para carregar as chaves. ${(keys.error as ApiError).message}`}
              onRetry={() => void keys.refetch()}
            />
          ) : keys.isPending ? (
            <div className="lista-vazia" aria-hidden="true">
              <Skeleton width="60%" />
              <Skeleton width="40%" />
            </div>
          ) : list.length === 0 ? (
            <p className="lista-vazia suave">
              Nenhuma chave ativa. Crie uma acima quando precisar.
            </p>
          ) : (
            <div className="tabela-quadro" tabIndex={0} role="region" aria-label="Chaves ativas">
              <table className="tabela">
                <thead>
                  <tr>
                    <th scope="col">Chave</th>
                    <th scope="col">Escopos</th>
                    <th scope="col">Último uso</th>
                    <th scope="col" className="col-data">
                      Criada
                    </th>
                    <th scope="col" className="col-acoes">
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((k) => (
                    <KeyRow key={k.id} k={k} onRevoke={setRevoking} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <Confirm
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revogar ${revoking?.name ?? 'a chave'}?`}
        description={
          <p>
            A chave <span className="mono">{revoking?.display}</span> para de funcionar agora. Toda
            integração que usa essa chave passa a receber 401. Não dá para desfazer.
          </p>
        }
        confirmLabel={busy ? 'Revogando…' : 'Revogar chave'}
        busy={busy}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}
