# ADR 0003 — Pipeline de cliques

- **Status:** aceito (fase 3, validado em modo trio). As mudanças em relação ao rascunho estão em
  "Resultado da fase 3".
- **Data:** 2026-11-09

## Contexto

O redirect publica um evento por clique e não espera nada (ADR 0002). Alguém precisa transformar
esses eventos em linhas brutas e em agregados prontos para o dashboard, com quatro garantias:

1. **Cada clique conta uma vez**, mesmo com reentrega, crash ou dois workers.
2. **O IP bruto nunca é gravado** (LGPD), nem no Postgres, nem no Redis, nem nos logs.
3. **Bots e prévias** (WhatsApp, Slack, facebookexternalhit…) não inflam os números humanos.
4. **O dashboard nunca faz `COUNT(*)` na tabela bruta**: lê agregados (fase 5).

## Opções de transporte

| | Redis Streams | Redis LIST (`LPUSH`/`BRPOP`) | Pub/Sub | Fila no Postgres (`SKIP LOCKED`) | Kafka/NATS |
| - | - | - | - | - | - |
| Já está no Compose | ✅ | ✅ | ✅ | ✅ | ❌ (mais um serviço) |
| Sobrevive a crash do consumidor | ✅ PEL + `XAUTOCLAIM` | ❌ perde o que estava em mãos (ou exige `LMOVE` + varredura manual) | ❌ perde tudo | ✅ | ✅ |
| Vários consumidores dividindo o trabalho | ✅ grupo de consumidores | ✅ | ❌ todos recebem tudo | ✅ | ✅ |
| Custo no caminho quente | 1 `XADD` (~µs, autopipeline) | 1 `LPUSH` | 1 `PUBLISH` | 1 `INSERT` no Postgres por clique | rede extra |
| Medir atraso | ✅ `XINFO GROUPS` → `lag` | só tamanho | ❌ | consulta | ✅ |

**Decisão:** **Redis Streams** com grupo de consumidores. É o único que dá ACK, reentrega e
balanceamento sem acrescentar infraestrutura. A fila no Postgres poria um `INSERT` síncrono por clique
no banco que também serve o analytics, que é justamente o que queremos evitar.

## Formato do evento (`XADD clicks`)

```
event_id     UUIDv7 gerado no redirect (chave de deduplicação)
link_id      bigint
ts           epoch ms do redirect
visitor      HMAC-SHA256(sal_do_dia, ip ‖ user_agent), em base64url de 22 caracteres
ip_net       IP truncado: /24 em IPv4, /48 em IPv6 (só para geolocalização)
ua           user agent (até 512 caracteres)
ref          cabeçalho Referer (até 1.024 caracteres)
country      se o redirect já resolveu (proxy confiável ou regra de país)
kind_hint    human | bot | preview, da classificação rápida do redirect
```

## Privacidade (LGPD)

- **O IP completo só existe na memória do processo do redirect**, durante a requisição. Ele vira duas
  coisas antes de sair:
  - `visitor`: um hash com o sal do dia, usado para os únicos.
  - `ip_net`: o IP truncado, que localiza a cidade com quase a mesma precisão.
- O worker usa o `ip_net` para a geolocalização e o descarta. **Nenhuma coluna guarda IP**, e um teste
  da fase 3 verifica isso no schema e com grep.
- **Sal diário:** 32 bytes aleatórios em `salt:<AAAA-MM-DD>` (UTC), criados com `SET NX` por quem chegar
  primeiro e com TTL de 48 h. Enquanto o sal existe, quem tiver acesso ao Redis conseguiria testar os
  4 × 10⁹ IPv4 e reverter o hash. Depois que ele expira, o `visitor` gravado não pode mais ser ligado a
  um IP. A janela de risco é de no máximo 48 h e fica documentada.
- Consequência aceita: **o mesmo visitante em dois dias diferentes é irreconhecível**. Os únicos são
  por dia. O "únicos no período" do dashboard é a soma de visitantes-dia, e a interface diz isso.
- `X-Forwarded-For` só é lido com `TRUST_PROXY=<CIDRs>` (o `trustProxy` do Fastify com a lista) ou
  com `DEV_TRUST_XFF=1`. Sem isso, um cliente forjaria o IP para burlar o rate limit e o único.
- Logs do pino: `req.ip` e o cabeçalho `x-forwarded-for` passam pelo `redact`.

## Únicos: HyperLogLog × hash com sal diário

| | HLL no Redis (`PFADD`/`PFCOUNT`) | Tabela `(link, dia, visitor)` com sal diário |
| - | - | - |
| Precisão | ±0,81 % | exata |
| Memória | até 12 KB por link-dia | 1 linha por visitante-dia |
| Consistência com o Postgres | separado do agregado; dois sistemas para reconciliar | na **mesma transação** do agregado |
| Teste de consistência (fase 5) | aproximado | igualdade exata |

**Decisão:** **hash com sal diário numa tabela** `click_visitors(link_id, day, visitor) PRIMARY KEY`.
O `INSERT … ON CONFLICT DO NOTHING RETURNING` diz exatamente quem é novo no dia, e esse número soma em
`uniques` no agregado diário, na mesma instrução. Como o sal muda todo dia, a tabela é particionada por
mês e descartada depois de 90 dias: ela só serve para deduplicar o dia corrente e permitir o teste de
consistência. O HLL fica para o contador ao vivo, se a fase 7 precisar de únicos "agora".

## Processamento

```
XREADGROUP GROUP workers <consumer> COUNT 1000 BLOCK 2000 STREAMS clicks >
  → acumula até 1.000 eventos ou 500 ms
  → enriquece em memória: geo (DB-IP City Lite mmdb), UA, domínio do referrer, classificação
  → 1 transação:
      WITH ins AS (
        INSERT INTO clicks (...) SELECT * FROM unnest($1::uuid[], $2::bigint[], ...)
        ON CONFLICT (occurred_at, event_id) DO NOTHING
        RETURNING *
      ), new_visitors AS (
        INSERT INTO click_visitors ... SELECT ... FROM ins WHERE kind = 'human'
        ON CONFLICT DO NOTHING RETURNING link_id, day
      ), agg_hour AS (
        INSERT INTO clicks_hourly ... SELECT ... FROM ins GROUP BY ... ORDER BY ...
        ON CONFLICT (...) DO UPDATE SET total = clicks_hourly.total + EXCLUDED.total, ...
      ), agg_country AS (...), agg_device AS (...), ...
      SELECT count(*) FROM ins;
  → COMMIT
  → XACK clicks workers <ids…>
  → PUBLISH live:<user_id> {link_id, +n}   (para o SSE da API)
```

- **Idempotência:** a deduplicação é o `ON CONFLICT DO NOTHING` em `clicks` pela chave
  `(occurred_at, event_id)`. Em tabela particionada, a chave única precisa incluir a coluna de
  partição; o `occurred_at` vem do evento e é determinístico, então funciona. **Os agregados só somam o
  que o `RETURNING` devolveu.** Um evento reentregue não insere linha bruta e por isso não soma em
  agregado nenhum. Se o worker morrer entre o `COMMIT` e o `XACK`, a reentrega é descartada pelo
  conflito. O efeito é exatamente uma vez, sem tabela de "eventos processados" à parte.
- **Uma instrução só** (CTEs que modificam dados enxergam o mesmo snapshot): ou entram a linha bruta e
  todos os agregados, ou nada. Isso garante a consistência agregado × bruto da fase 5 por construção, e
  o teste confirma.
- **Deadlocks:** dois workers fazendo upsert nas mesmas linhas de agregado em ordens diferentes podem
  travar um ao outro. Cada `INSERT … SELECT` de agregado leva `ORDER BY` pela chave, para todos tomarem
  os locks na mesma ordem. O teste roda 4 workers no mesmo stream.
- **Crash:** a cada 30 s, `XAUTOCLAIM clicks workers <eu> 60000 0-0` pega mensagens pendentes há mais de
  60 s de consumidores mortos.
- **Mensagem venenosa:** com mais de 5 entregas (contador do `XPENDING`), vai para `clicks:dead` e leva
  `XACK`, além da métrica `clicks_dead_total`.
- **Retenção do stream:** `MAXLEN ~ 1.000.000` no `XADD`. O worker parado por ~1 dia com tráfego de
  demonstração não perde nada, e o painel de métricas mostra o `lag`.

## Enriquecimento

- **Geo:** DB-IP IP to City Lite (mmdb, **CC BY 4.0**, com crédito obrigatório no README e no rodapé
  do dashboard), lido com o pacote `maxmind` (MIT). O arquivo é baixado por `pnpm geo:download`
  (pedirei permissão antes do primeiro download) e fica fora do git. Sem o arquivo, país e cidade viram
  `null` e o worker segue.
- **User agent:** `ua-parser-js` **1.x** (MIT). A 2.x mudou para AGPL-3.0, o que não serve. Extrai
  navegador, sistema e tipo de dispositivo.
- **Referrer:** só o domínio, minúsculo, sem `www.`. Não guardamos caminho, por privacidade e para
  limitar a cardinalidade. Ausente vira `(direto)`, e `android-app://com.google.android.gm` vira
  `app:gmail`.
- **Classificação** (`packages/shared/classifyAgent`, compartilhada com o redirect):
  - `preview`: WhatsApp, Slackbot-LinkExpanding, facebookexternalhit, Twitterbot, TelegramBot,
    Discordbot, LinkedInBot, SkypeUriPreview, Applebot (prévia do iMessage), redditbot, Embedly,
    Iframely;
  - `bot`: o pacote `isbot` (Unlicense) mais `HEAD` sem user agent;
  - `human`: o resto.

  `preview` e `bot` entram só nos contadores por tipo (`clicks_hourly.previews` e `.bots`) e em
  `clicks_daily_preview(app)`. As dimensões (país, cidade, referrer, navegador, sistema, dispositivo) e
  os únicos são **só de humanos**.

## Resultado da fase 3

O Validador independente achou duas falhas graves no primeiro desenho e quatro menores. Todas foram
corrigidas e os testes dele viraram regressões (`apps/worker/test/integration/regressions.test.ts`).

| Problema encontrado | Antes | Correção | Depois |
| - | - | - | - |
| O reclaim pegava mensagens do **próprio lote em andamento** quando o Postgres ficava lento. Cada claim somava entrega e, com 5 entregas, um evento **válido** ia para `:dead` | 3.000 eventos geraram 5.477 entradas em `:dead` | O worker guarda os ids `inFlight` e mantém o idle deles baixo com um batimento (`XCLAIM … JUSTID`, que não soma entrega). Trocamos `XAUTOCLAIM` por `XPENDING IDLE` + `XCLAIM` com min-idle, porque o `XAUTOCLAIM` não permite excluir os próprios ids. `:dead` conta **falhas reais**: parse inválido vai direto; erro de dado do Postgres (classes 22 e 23) soma em `HINCRBY <stream>:fails` e mata com 5. A ida para `:dead` é um Lua atômico (XADD só se o XACK devolveu 1) | `:dead` = 0, contagens exatas |
| O mesmo `event_id` com `ts` diferente caía em outra chave `(occurred_at, event_id)` | 3 linhas | `occurred_at` passa a vir dos 48 bits de tempo do **UUIDv7**, e o `ts` só é conferido (`clicks_ts_mismatch_total`). Um id que não seja UUIDv7 vai para `:dead` | 1 linha |
| Stream ou grupo apagado no Redis (FLUSH, restart sem AOF) | `NOGROUP` em loop eterno | Todo comando de stream recria o grupo (`XGROUP CREATE … 0 MKSTREAM`) e segue | eventos processados |
| Clique de link apagado contado como duplicata | `duplicates:2` | A instrução devolve quantos eventos eram de link existente: `unknown_link = válidos − conhecidos` e `duplicates = conhecidos − inseridos` | `duplicates:0` |
| `android-app://joao:senha@…` e país `XX` gravados | gravados | O pacote precisa casar `^[a-z0-9_]+(\.[a-z0-9_]+)+$` (senão vira `(desconhecido)`); referrer com IP literal vira `(ip)`; `normalizeCountry` descarta pseudocódigos | limpos |
| `stop()` pendurado com o Postgres preso num lock | não voltava | `statement_timeout` de 30 s e prazo no `stop()`; o PEL cobre o lote | < 1,5 s |

Decisões da implementação:
- **Uma tabela para as dimensões:** `clicks_daily_dim(link_id, dim, day, value, n)`, com PK nessa
  ordem. O "top N países no período" vira um intervalo contíguo da PK. Cidade é gravada como
  `BR/São Paulo`, para não juntar cidades homônimas de países diferentes.
- `links.click_count` (humanos) é atualizado na mesma instrução. Antes, um `SELECT … ORDER BY id FOR
  UPDATE` trava as linhas de `links`; sem ele, o `UPDATE … FROM` causou 8 deadlocks em 100 mil eventos.
- Erro transitório do Postgres repete o lote no próprio processo e não conta como falha. Assim uma queda
  do banco não manda tudo para `:dead`.
- A geolocalização ficou num pacote próprio, `packages/geo`, para o `shared` continuar sem I/O. Sem o
  arquivo mmdb, país e cidade ficam `null` e o pipeline segue.

Números (Ryzen 5 5500, Postgres e Redis no Docker Desktop):

| Cenário | Resultado |
| - | - |
| 1 worker, lotes de 1.000 | ~6.300–6.700 eventos/s (lote médio de 135–148 ms) |
| 4 workers, 100.000 eventos | 12,7–14,6 s, ou seja, ~6.900–7.900 eventos/s, sem nenhum deadlock em 7 rodadas |
| Consistência em 100 mil eventos | bruta = hourly = daily por tipo; únicos = DISTINCT na bruta; soma de cada dimensão = humanos |

## Consequências

- O fuso das séries é UTC na gravação. O agregado horário é a base e o dashboard converte para o fuso
  da conta somando horas. Os únicos são por dia UTC, o que fica dito na interface.
- O contador ao vivo atrasa no máximo ~500 ms mais a latência do SSE, porque vem depois do commit.
  Em troca, ele nunca mostra um clique que depois "some" por ser duplicado ou bot.
- `/metrics` do worker expõe `clicks_processed_total{kind}`, `clicks_duplicates_total`,
  `batch_size`, `batch_duration_seconds`, `stream_lag` e `clicks_dead_total`.
- Testes da fase 3 (modo trio):
  - mesmo evento entregue 2× resulta em 1 linha e agregados +1;
  - kill do worker entre o commit e o ACK seguido de reclaim não duplica;
  - 4 workers com 100.000 eventos resultam em soma dos agregados = 100.000 e nenhum deadlock;
  - nenhuma coluna `ip` existe;
  - user agents do WhatsApp e do Slack caem em `preview`;
  - `X-Forwarded-For` é ignorado sem a flag.
