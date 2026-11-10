# ADR 0004 — Autenticação e contrato da API `/v1`

- **Status:** aceito (fase 4)
- **Data:** 2026-11-09

## Contexto

A API serve dois tipos de cliente:
- o dashboard, um navegador com usuário e senha;
- integrações, como scripts, Zapier e CI, que usam uma chave de API.

O pedido exige JWT para o dashboard, chaves com hash, prefixo visível e escopos, além de um contrato
HTTP rigoroso: cursor, problem+json, Idempotency-Key, ETag e cabeçalhos de rate limit.

## Decisão 1: dashboard com JWT curto e refresh em cookie

| Opção | Problema |
| - | - |
| JWT longo no `localStorage` | um XSS rouba a sessão inteira; não dá para revogar |
| JWT longo em cookie | revogação só com lista de bloqueio; CSRF em toda rota |
| **Access JWT de 15 min em memória + refresh opaco em cookie httpOnly** | um pouco mais de código |

- **Access token:** JWT HS256 (`jose`), `sub` = id do usuário, expira em 15 min. Vai no corpo do login
  e do refresh, o front guarda só em memória e envia em `Authorization: Bearer`.
- **Refresh token:** 32 bytes aleatórios em cookie `__Host-refresh`.
  - Atributos: `HttpOnly; Secure; SameSite=Strict; Path=/`, com 30 dias. Em dev, sem HTTPS, o cookie
    se chama `refresh` e não leva `Secure`.
  - No banco vai só o SHA-256, em `refresh_tokens(id, user_id, family_id, token_hash, expires_at,
    replaced_by, revoked_at)`.
- **Rotação com detecção de reuso:** cada refresh revoga o token usado e emite outro da mesma família.
  Se um token já revogado for usado de novo, alguém o copiou, e a família inteira é revogada.
- **CSRF:** o refresh e o logout exigem o cabeçalho `X-Requested-With: encurtador`, além do
  `SameSite=Strict`. As outras rotas usam Bearer, que não é enviado automaticamente pelo navegador.
- **Senha:** argon2id, com os parâmetros padrão do `@node-rs/argon2`. O login responde com a mesma
  mensagem e um tempo parecido para e-mail inexistente e para senha errada, com bucket de 10/min por
  IP com HMAC e por e-mail.

## Decisão 2: chaves de API

- **Formato:** `enc_<prefixo de 8>_<segredo de 32>`, tudo em base62. O segredo tem cerca de 190 bits.
- **Armazenamento:** `api_keys(id, user_id, name, prefix UNIQUE, key_hash, scopes text[],
  last_used_at, created_at, revoked_at)`.
  - O hash é **SHA-256**, não argon2: o segredo já tem entropia alta, e um hash lento só atrasaria toda
    requisição sem ganho real de segurança.
  - A busca é pelo prefixo e a comparação usa `timingSafeEqual`.
- **A chave inteira aparece uma única vez**, na criação. Depois a listagem mostra só
  `enc_AbCd1234_…`, com nome, escopos e último uso.
- **Escopos:** `links:read`, `links:write`, `stats:read`. O JWT do dashboard tem todos. A chave só
  pode ter os que foram marcados. Sem o escopo, a resposta é **403** (`insufficient_scope`).
- `last_used_at` é atualizado com no máximo uma escrita por minuto por chave (debounce no Redis).

## Decisão 3: contrato HTTP

- **Erros:** `application/problem+json` (RFC 9457) com `type`, `title`, `status`, `detail` e
  `instance`, além de `errors[]` com campo e mensagem nos 422.

  | Status | Quando |
  | - | - |
  | 201 | criação, com `Location` |
  | 204 | soft delete |
  | 304 | ETag igual |
  | 400 | JSON malformado |
  | 401 | não autenticado |
  | 403 | sem escopo |
  | 404 | inexistente ou de outro usuário (não revelamos que existe) |
  | 409 | alias em uso, ou Idempotency-Key ainda em andamento |
  | 410 | link apagado, para o próprio dono |
  | 412 | `If-Match` divergente |
  | 422 | validação (destino, alias, regras), ou Idempotency-Key reutilizada com outro corpo |
  | 429 | rate limit |
- **Paginação por cursor:** o cursor é base64url opaco de `{ sort, dir, último valor, id }` e está
  amarrado aos filtros. Trocar de filtro com o mesmo cursor dá 422. Ordenações: `created_at`
  (padrão, desc), `clicks` e `title`, sempre com o `id` como desempate. `limit` vai de 1 a 100
  (padrão 20).
- **Filtros de `GET /v1/links`:**
  - `q` busca em título, slug e destino. Usa trigrama (`pg_trgm`) se a fase 5 medir ganho; até lá,
    `ILIKE`.
  - `status` aceita `active`, `disabled` e `expired`.
  - `created_from`, `created_to` e `has_password`.
- **Idempotency-Key** em todo POST que cria algo:
  - Tabela `idempotency_keys(user_id, key, request_hash, status, response, created_at)`, com PK
    `(user_id, key)` e validade de 24 h.
  - Mesma chave e mesmo corpo devolvem a resposta gravada, com `Idempotent-Replayed: true`.
  - Mesma chave com outro corpo dá 422. Chave ainda em processamento dá 409.
  - A reserva é feita com `INSERT … ON CONFLICT DO NOTHING`, sem corrida, na mesma ideia do ADR 0001.
- **ETag:**
  - Nas leituras, é um ETag fraco do hash do corpo. `If-None-Match` igual devolve 304.
  - Nos links, o `PATCH` aceita `If-Match` (ETag forte de `id` + `updated_at`). Divergente dá 412,
    para não sobrescrever a edição de outra aba.
- **Rate limit:** o mesmo token bucket Lua do ADR 0002, por usuário ou por chave, com 120 de
  capacidade e 2/s de reposição. A rota pública de encurtar sem login tem 10/min por visitante.
  Todas as respostas trazem `RateLimit-Limit`, `RateLimit-Remaining` e `RateLimit-Reset`; o 429 traz
  `Retry-After`.
- **Escrita no cache:** a API chama `writeThrough` (ADR 0002) depois de todo commit que muda um link.
- **SSE ao vivo:** o `EventSource` não envia cabeçalhos. Para não pôr o JWT na URL, onde ele iria
  para os logs, `POST /v1/live/ticket` devolve um ticket de uso único válido por 30 s, guardado no
  Redis. Depois o front abre `GET /v1/live?ticket=…`, que assina `live:<user_id>`, filtra o link
  pedido e manda heartbeat a cada 15 s.
- **Prévia do destino:** `GET /v1/preview?url=` busca título, descrição, imagem og e favicon com um
  buscador seguro contra SSRF:
  - resolve o DNS, recusa IP não público e conecta no IP resolvido (fixado);
  - no máximo 3 redirecionamentos, cada um revalidado;
  - 3 s de timeout, só `text/html`, até 512 KB lidos;
  - cache de 1 h no Redis.

  O mesmo buscador faz a verificação assíncrona de loop do ADR 0002.

## Resultado da fase 4

A API ficou com 27 operações em `/v1`, documentadas em `/docs`; o OpenAPI passa no
`@apidevtools/swagger-parser`. Os testes de integração são 68 e cobrem toda rota, inclusive o
isolamento entre usuários, via JWT e via chave.

Ajustes acordados durante a implementação:
- **Lote responde 200, não 207.** O 207 é do WebDAV e exige corpo XML. Cada item volta com o próprio
  `status` (201, 409, 422 ou 503).
- **`POST /v1/api-keys` não aceita Idempotency-Key.** Gravar a resposta para repeti-la guardaria o
  segredo em texto puro. Uma chave criada a mais se revoga.
- **`GET /v1/links/:id` não traz `click_count`.** O ETag forte (`id` + `updated_at`) precisa ser o mesmo
  do `If-Match`. Com o contador no corpo, um 304 esconderia cliques novos ou o worker geraria 412 falsos.
  O contador aparece na listagem (ETag fraco) e em `/stats/summary` (`all_time_humans`).
- **Slug e alias não mudam no `PATCH`** (422). O link curto pode já estar impresso.
- **A rota pública não aceita Idempotency-Key,** porque a tabela é por `user_id`.
- O `type` do problem+json fica em `https://encurta.dev/problems/<code>`.
- Limites de período:
  - `hour` aceita até 14 dias, `day` até 2 anos e `month` até 5 anos.
  - As dimensões e o resumo usam dias UTC.
- **Rotação estrita do refresh:** duas abas renovando ao mesmo tempo revogariam a família. O front
  resolve isso com um refresh único compartilhado entre as abas (fase 7). Não há janela de tolerância.
- O seed demo grava agregados sintéticos. O teste de consistência agregado × bruto da fase 5 usa os
  dados do seed grande, que geram linhas brutas.

## Consequências

- O front precisa renovar o token silenciosamente: um 401 dispara um refresh único e compartilhado
  entre as requisições, e depois a requisição é repetida.
- O isolamento entre usuários é testado em toda rota: o usuário B recebe 404 nos recursos de A.
- O seed demo (`demo@encurta.dev` / `demo1234`) entra na fase 4 com 30 links variados. Os 5 milhões
  de cliques ficam para a fase 5.
