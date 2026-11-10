# Desempenho

Medições do caminho quente do redirect (ADR 0002). A meta da fase 2 é **p95 < 20 ms com cache**.

## Fase 2: redirect, 1ª medição (2026-11-09)

### Máquina

| | |
| - | - |
| CPU | AMD Ryzen 5 5500, 6 núcleos / 12 threads, 3,6 GHz |
| RAM | 15,9 GB |
| Sistema | Windows 11 Home 10.0.26200 |
| Node | 22.14.0 |
| Docker | Docker Desktop 4.98.0 (Engine 29.9.2, WSL2, kernel 6.18.54.1), 12 CPUs e 7,7 GB para a VM |
| Postgres / Redis | `postgres:16-alpine` e `redis:7-alpine` do `docker-compose.yml` (portas 5433 e 6380) |

Tudo na mesma máquina: o autocannon, o processo do redirect e a VM do Docker disputam os mesmos
núcleos. A rede até o Postgres e o Redis passa pelo encaminhamento de portas do WSL2.

### Como foi medido

```powershell
corepack pnpm bench:redirect
```

O script (`scripts/bench-redirect.ts`) faz, para cada cenário e cada rodada:

1. sobe `apps/redirect` num processo novo com `NODE_ENV=production` e `LOG_LEVEL=warn`, na porta 8099;
2. garante o link `bench-hot` no banco de dev (destino `https://example.com/bench?utm_source=encurtador`);
3. aquece por 5 s com autocannon (descartado) e mede por **30 s com 50 conexões** (keep-alive);
4. calcula p50/p95/p99 a partir da latência de cada resposta (evento `response` do autocannon,
   ordenado no fim). O autocannon não publica p95 no resumo, por isso a coleta é própria.

O bucket fica ligado com capacidade enorme (`RATE_LIMIT_CAPACITY=RATE_LIMIT_REFILL=10⁹`): o script Lua
roda completo, mas um único IP nunca é barrado. Os eventos de clique vão para o stream `bench:clicks`
(`MAXLEN ~ 10.000`), apagado no fim; o XADD acontece de verdade em toda requisição 302.
A URL leva `?utm_campaign=carga`, então o repasse de query também está no caminho medido.

| Cenário | O que roda por requisição |
| - | - |
| `quente-1ida` | Lua bucket + GET do link (1 ida ao Redis), 0 ao Postgres, XADD depois da resposta |
| `quente-2idas` | EVALSHA do bucket, depois GET separado (2 idas ao Redis), XADD (`REDIS_ROUNDTRIPS=2`) |
| `sem-cache` | EVALSHA do bucket + `SELECT` no Postgres em toda requisição, XADD (`CACHE=off`) |
| `negativo` | Lua bucket + GET de `l:bench-nao-existe` = `∅`, 404 (sem XADD) |

### Resultado

| Cenário | Rodada | req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | erros |
| - | - | -: | -: | -: | -: | -: | -: |
| quente-1ida | 1 | 10.050 | 4,66 | **6,52** | 8,08 | 15,6 | 0 |
| quente-1ida | 2 | 10.208 | 4,62 | **6,32** | 7,42 | 17,7 | 0 |
| quente-2idas | 1 | 8.986 | 5,21 | 7,16 | 8,55 | 20,6 | 0 |
| quente-2idas | 2 | 8.855 | 5,23 | 7,42 | 9,54 | 18,7 | 0 |
| sem-cache | 1 | 8.066 | 5,90 | 7,73 | 9,27 | 17,3 | 0 |
| sem-cache | 2 | 7.715 | 6,06 | 8,44 | 10,77 | 17,0 | 0 |
| negativo | 1 | 15.546 | 3,02 | 4,72 | 6,27 | 18,5 | 0 |
| negativo | 2 | 16.633 | 2,88 | 4,23 | 5,30 | 26,2 | 0 |

Média das duas rodadas:

| Cenário | req/s | p50 (ms) | p95 (ms) | p99 (ms) |
| - | -: | -: | -: | -: |
| quente-1ida | 10.129 | 4,64 | **6,42** | 7,75 |
| quente-2idas | 8.921 | 5,22 | 7,29 | 9,05 |
| sem-cache | 7.891 | 5,98 | 8,09 | 10,02 |
| negativo | 16.090 | 2,95 | 4,48 | 5,79 |

Todas as respostas tiveram o status esperado (302 ou 404), sem erros nem timeouts.

### Leitura

- **A meta foi batida com folga:** p95 de 6,3–6,5 ms com cache, contra 20 ms. O p99 fica abaixo de
  8,1 ms.
- **Quase toda a latência é fila, não trabalho.** Com 50 conexões e ~10 mil req/s, a Lei de
  Little dá 50 / 10.000 = 5 ms de tempo médio no sistema, que é o p50 medido. O processo do redirect
  roda em um núcleo só e satura a CPU: cada requisição custa ~100 µs de CPU no Node (Fastify,
  HMAC da chave do bucket, HMAC do visitante, UUIDv7, montagem do evento e o XADD). Com menos
  conexões a latência cai junto; com mais, sobe sem aumentar o req/s.
- **1 ida × 2 idas ao Redis:** o Lua único dá **+13,5 % de req/s** (10,1 mil × 8,9 mil) e tira
  ~0,6 ms do p50 e ~0,9 ms do p95. A diferença é a segunda ida: mais um comando, mais uma resposta para
  o ioredis decodificar e mais uma volta pelo encaminhamento do WSL2. Fica a versão de 1 ida, como o
  ADR decidiu.
- **Sem cache não é muito pior aqui**, só −22 % de req/s e +1,7 ms no p95. O `SELECT` pelo índice
  único é barato e o Postgres está ocioso; o gargalo continua sendo a CPU do Node. O ganho do cache
  aparece de verdade quando o banco tem carga própria (o worker gravando cliques na fase 3, o
  dashboard lendo agregados) e quando houver várias instâncias do redirect: o Postgres deixa de
  receber uma consulta por clique.
- **O 404 negativo é o mais rápido** (16 mil req/s): não há XADD, nem HMAC de visitante, nem evento.
  É o que se quer: um robô varrendo slugs aleatórios custa pouco e nunca chega ao Postgres.
- **O máximo de 15–26 ms** aparece em todos os cenários e não depende do cache. São pausas de GC e do
  agendador do Windows com o autocannon disputando os mesmos núcleos.

### Limitações

- Cliente e servidor na mesma máquina: o autocannon consome parte da CPU que o redirect usaria. Num
  ambiente separado, o req/s por processo deve ser maior.
- Um único IP e um único slug: o bucket nunca expira entre requisições e o `l:bench-hot` está sempre
  na memória do Redis. Isso é o "cache quente" por definição, não o caso médio com milhões de slugs.
- Sem cache em memória no processo (ADR 0002, seção 5): não foi preciso. Ele tiraria a ida ao Redis,
  mas exigiria pub/sub para invalidar.
- Uma instância só. Escalar é rodar um processo por núcleo (ou `node:cluster`), já que o estado
  compartilhado (cache, bucket, sal, stream) está todo no Redis.

## Fase 5: analytics com 5 milhões de cliques (2026-11-10)

Pergunta da fase: quanto custam as consultas do dashboard quando a tabela bruta tem 5 milhões de
cliques, e o que de fato resolve. Resposta curta: **os agregados resolvem** (0,2–4 ms contra 28–448 ms
quente e 4–320 ms contra 0,34–2,5 s frio). Índice, partição, BRIN e INCLUDE na bruta mudam pouco para
o dashboard, porque o dashboard não lê a bruta. A única mudança aplicada fora do código de bench foi
no `docker-compose.yml` (`random_page_cost=1.1` e `shm_size`), e **nenhuma migração nova**: nenhuma
medição justificou um índice novo na escala do projeto.

### Máquina e configuração do Postgres

A mesma máquina da fase 2 (Ryzen 5 5500, 15,9 GB, Windows 11, Docker Desktop com WSL2, 12 CPUs e
7,7 GB para a VM). O volume do Postgres é um ext4 dentro do VHDX do WSL2, num SSD NVMe.

| parâmetro (`postgres:16-alpine`, PostgreSQL 16.15) | antes da fase | depois | por quê |
| - | - | - | - |
| `shared_buffers` | 128MB | 128MB (sem mudança) | ver "shared_buffers" abaixo: 512MB não mudou nada medível |
| `work_mem` | 4MB | 4MB | os agregados nunca passam de 300 kB; só a consulta ingênua da conta derrama em disco (`external merge`, 6,9 MB) |
| `effective_cache_size` | 4GB | 4GB | — |
| `random_page_cost` | 4 | **1.1** | SSD; muda o plano da visão da conta (29 → 4,2 ms quente) |
| `jit` | on | on | só dispara nas consultas ingênuas (custo > 100 mil), 30 ms de compilação dentro de 448 ms; nos agregados não aparece |
| `max_parallel_workers_per_gather` | 2 | 2 | — |
| `/dev/shm` do container | 64 MB | **256 MB** (`shm_size`) | VACUUM paralelo falhou: `could not resize shared memory segment … No space left on device` |

### Comandos

```powershell
& "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe" compose up -d --wait
corepack pnpm seed:big                 # recria só o encurtador_bench: 5 M cliques, 12 meses, 2.000 links, 20 usuários
corepack pnpm test:consistency         # agregados × bruta + ponta a ponta com o worker real
corepack pnpm bench:analytics          # antes × depois, quente (p50 de 5) e frio (mediana de 3)
corepack pnpm bench:write              # custo de escrita (insertBatch real do worker); --raw-only isola a bruta
corepack pnpm bench:trgm               # ILIKE × pg_trgm com 2.000 e 200.000 links
corepack pnpm bench:retention          # DELETE × DETACH/DROP de um mês
corepack pnpm seed:big --clicks=50000  # o tamanho do CI (15,3 s)
```

Opções do seed: `--clicks`, `--months`, `--links`, `--users`, `--jobs` (conexões, padrão 4), `--seed`
(padrão 42), `--method=series|copy` e `--keep-indexes` (só para a comparação abaixo). O bench grava os
planos completos em `packages/bench/results/` (fora do git); os trechos abaixo vêm de lá.

### O seed grande

Tudo no servidor (`packages/bench/src/generate.ts`): o clique *i* de *N* acontece no quantil
`(i − U)/N` de um perfil de tráfego hora a hora (hora do dia e dia da semana no fuso de São Paulo,
tendência de 0,7× a 1,3× no ano e três dias de campanha com 3×), então **os cliques saem em ordem de
tempo**, como o worker grava. O link é sorteado entre os que já existiam naquele instante, com peso
Zipf (`rank^-1,2`) vezes um ruído lognormal (σ = 1,6) e 5 % de links nunca divulgados. País/cidade,
referrer (com cauda longa de 400 blogs), navegador/sistema/dispositivo e app de prévia seguem pesos;
8 % robôs, 5 % prévias; 25 % dos humanos repetem um visitante do mesmo link e dia. Cada mês é um pedaço
de `generate_series` numa conexão (4 em paralelo), para cada partição ser escrita em ordem por uma
conexão só. Depois os agregados saem **da bruta**, por `rebuild_aggregates(from, to)`
(`packages/bench/src/rebuild.ts`), que reproduz o `INSERT_BATCH` do worker (mesmos `coalesce`,
`<país>/<cidade>`, únicos = visitantes humanos distintos no link-dia, `click_count` só humanos).

| faixa de cliques por link | links | cliques |
| - | -: | -: |
| 0 | 138 | 0 |
| 1–9 | 150 | 710 |
| 10–99 | 636 | 28.267 |
| 100–999 | 750 | 268.844 |
| 1 mil–9.999 | 281 | 824.604 |
| 10 mil–99.999 | 36 | 983.147 |
| ≥ 100 mil | 9 | 2.894.428 |

Link quente: #1467, com 612.097 cliques (12 %). Link frio da medição: #1669 (cerca de 200 humanos no
ano, 18 dias com clique nos últimos 30). Humanos 87,0 %, robôs 8,0 %, prévias 5,0 %.

Tempo de `corepack pnpm seed:big` (do zero, padrão de 5 M), na rodada usada pelo bench (outra rodada idêntica, no fim do dia, levou 362,2 s):

| fase | tempo |
| - | -: |
| recriar e migrar o banco | 13,2 s |
| usuários, links, partições | 0,8 s |
| gerar 5 M cliques (`generate_series`, 4 conexões) | 31,3 s |
| PK e (link_id, occurred_at), uma partição por conexão | 43,3 s |
| `rebuild_aggregates` (13 meses, 4 conexões) | 252,4 s |
| VACUUM (ANALYZE) | 8,9 s |
| **total** | **349,9 s (5,8 min)** |

Escolhas medidas (5 M, mesma máquina):

| alternativa | geração | o que decidiu |
| - | -: | - |
| **INSERT … SELECT generate_series** (padrão) | 31,3–34,6 s | o mais rápido; nada sai do servidor |
| COPY FROM STDIN do Node (`--method=copy`, mesmo modelo em JS) | 52,6 s | o Node gerando e serializando 5 M linhas num processo só é o gargalo |
| carregar com PK e índice no lugar (`--keep-indexes`) | 137,5 s | contra 31 + 43 s de carga sem índice + criação depois |
| tirar também as PKs dos agregados antes do rebuild | 112 + 82 s | contra 188 s com elas: sem ganho, ficou o simples |

O `rebuild_aggregates` é a fase dominante e a mais instável (112 a 252 s em cinco rodadas): ele
escreve ~1,2 GB de agregados (o `clicks_daily_dim` sozinho tem 4,4 M linhas e 650 MB) e fica preso ao
I/O do WSL2.

Tamanhos depois do seed (linhas exatas, `pg_total_relation_size` com índices):

| tabela | linhas | tamanho |
| - | -: | -: |
| `clicks` (13 partições mensais de 35–115 MB + default vazia) | 5.000.000 | 1,07 GB |
| `click_visitors` (13 partições) | 3.403.371 | 418 MB |
| `clicks_hourly` | 1.102.969 | 120 MB |
| `clicks_daily` | 241.778 | 31 MB |
| `clicks_daily_dim` | 4.375.029 | 650 MB |
| `clicks_daily_preview` | 95.653 | 11 MB |
| `links` | 2.000 | 5,7 MB |
| banco inteiro | | 2,28 GB |

A saída do seed lista também cada partição (p2025_11: 199.409 linhas, 43,7 MB … p2026_10:
524.787 linhas, 114,8 MB).

### Como foi medido

- `EXPLAIN (ANALYZE, BUFFERS, TIMING)` em texto. **Quente:** 1 execução de aquecimento e 5 medidas; a
  tabela mostra a execução mediana (tempo, buffers e linhas da mesma execução, que é o plano
  reproduzido abaixo). **Frio:** antes de **cada** execução, `docker stop` do Postgres, `echo 3 >
  /proc/sys/vm/drop_caches` num container privilegiado da própria imagem `postgres:16-alpine` (sem
  isso o Linux da VM ainda teria as páginas) e `docker start`; 3 execuções, vale a mediana, com
  `track_io_timing`.
- "hit / read": buffers do nó raiz. `read` quente quer dizer que a página não estava no
  shared_buffers (128 MB) e veio do cache do sistema operacional.
- "linhas lidas": soma, nos nós de varredura, das linhas devolvidas e das descartadas por filtro ou
  recheck, vezes os loops.
- Todas as estruturas existem ao mesmo tempo; cada variante roda numa transação que faz `DROP` dos
  índices que ela não deve ver e termina em `ROLLBACK`.
- **ingênua** é a `clicks_flat`, cópia não particionada da bruta só com a PK `(occurred_at, event_id)`
  e `COUNT(*) … GROUP BY`. Note que essa PK já é um btree com `occurred_at` na frente: a ingênua
  "de verdade" (sem índice nenhum) está na linha "flat sem índice".
- Janelas: 30 dias = dias UTC [2026-10-11, 2026-11-11), 90 dias desde 2026-08-12, 12 meses desde
  2025-11-10; Q6 = 2026-09-26 inteiro. A API pede "últimos 30 dias" até agora e cobre 31 dias UTC; as
  consultas ingênuas usam exatamente o mesmo intervalo.
- Antes do bench rodaram o `test:consistency` (o ponta a ponta somou 3.000 cliques recentes) e o
  `ANALYZE`. Tudo com a configuração final (`random_page_cost=1.1`).

### Tabela comparativa

Q1–Q5 são as consultas do dashboard; Q5b é a segunda consulta da visão da conta; Q1tz é a série em
America/Sao_Paulo (soma o `clicks_hourly`); Q6 é a varredura de um dia inteiro (backfill, teste de
consistência), o caso do BRIN.

| consulta | estrutura | p50 quente (ms) | hit / read | linhas lidas | frio (ms) | frio read |
| - | - | -: | -: | -: | -: | -: |
| Q1 série 30 d, quente | ingênua (flat, só PK) | 61,9 | 18.921 / 0 | 521.970 | 359 | 12.646 |
| | flat sem índice | 135 | 15.139 / 80.886 | 5.003.001 | 2.380 | 95.951 |
| | (a) flat + (link_id, occurred_at) | 29,0 | 10.046 / 0 | 42.434 | 3.760 | 10.046 |
| | (b) particionada + (link_id, occurred_at) | 30,3 | 10.046 / 0 | 42.434 | 1.060 | 10.045 |
| | (c) flat, só BRIN(occurred_at) | 58,9 | 11.235 / 0 | 584.916 | 666 | 11.220 |
| | (c) flat, só btree(occurred_at) | 62,5 | 17.776 / 0 | 521.970 | 315 | 11.501 |
| | (d) particionada + INCLUDE | 21,6 | 782 / 0 | 42.434 | 56,8 | 432 |
| | **agregados (`dailySeriesQuery`)** | **0,21** | 10 / 0 | 31 | **6,0** | 9 |
| Q2 série 30 d, frio | ingênua | 28,4 | 21.169 / 0 | 521.970 | 343 | 12.646 |
| | (a) | 0,15 | 113 / 0 | 139 | 14,0 | 73 |
| | (b) | 0,24 | 76 / 0 | 139 | 12,9 | 75 |
| | (c) BRIN | 56,2 | 11.235 / 0 | 584.916 | 762 | 11.220 |
| | (c) btree(occurred_at) | 34,9 | 18.672 / 0 | 521.970 | 284 | 11.501 |
| | (d) | 0,23 | 96 / 0 | 139 | 10,9 | 53 |
| | **agregados** | **0,19** | 8 / 0 | 18 | **3,6** | 7 |
| Q3 top 10 países 90 d | ingênua | 122 | 16.705 / 36.593 | 1.520.184 | 823 | 36.722 |
| | (a) | 136 | 16.320 / 36.593 | 1.520.184 | 823 | 36.722 |
| | (b) | 90,1 | 36 / 29.324 | 127.942 | 678 | 29.337 |
| | (c) BRIN | 120 | 15 / 30.290 | 1.579.215 | 1.640 | 30.292 |
| | (c) btree(occurred_at) | 120 | 13.267 / 33.255 | 1.520.184 | 721 | 33.386 |
| | (d) | 30,4 | 1.522 / 0 | 127.943 | 102 | 1.149 |
| | **agregados (`topDimensionQuery`)** | **0,59** | 56 / 0 | 1.721 | **18,0** | 39 |
| Q4 únicos × totais 30 d | ingênua | 83,2 | 18.921 / 0 | 521.970 | 388 | 12.646 |
| | (a) | 52,0 | 10.046 / 0 | 42.434 | 2.790 | 10.046 |
| | (b) | 50,0 | 10.046 / 0 | 42.434 | 945 | 10.045 |
| | (c) BRIN | 69,9 | 11.251 / 0 | 584.916 | 744 | 11.220 |
| | (c) btree(occurred_at) | 82,4 | 17.776 / 0 | 521.970 | 342 | 11.501 |
| | (d) | 39,4 | 782 / 0 | 42.434 | 78,8 | 432 |
| | **agregados (`dailySeriesQuery`, a mesma de Q1)** | **0,19** | 10 / 0 | 31 | **4,6** | 9 |
| Q5 conta, série 12 meses | ingênua | 448 | 13.542 / 82.616 | 5.003.214 | 2.540 | 95.979 |
| | (a) | 1.090 | 12.914 / 207.922 | 1.010.046 | 12.120 | 209.193 |
| | (b) | 1.190 | 13.821 / 209.064 | 1.010.117 | 11.860 | 210.415 |
| | (c) BRIN | 534 | 16.314 / 79.844 | 5.003.214 | 2.520 | 95.979 |
| | (c) btree(occurred_at) | 471 | 14.795 / 81.363 | 5.003.214 | 2.550 | 95.979 |
| | (d) | 612 | 11.700 / 0 | 1.010.117 | 3.230 | 9.471 |
| | **agregados (`accountSeriesQuery`)** | **4,22** | 1.001 / 0 | 9.372 | **319** | 732 |
| Q5b conta, top 10 links | **agregados (`accountTopLinksQuery`)** | **3,18** | 1.019 / 0 | 9.372 | 306 | 748 |
| Q1tz série 30 d em São Paulo | **agregados (`hourlySeriesQuery`)** | **0,67** | 35 / 0 | 731 | 12,0 | 18 |
| Q6 um dia, todos os links | ingênua (PK) | 3,43 | 374 / 0 | 14.022 | 35,9 | 370 |
| | flat sem índice | 132 | 15.715 / 80.310 | 5.003.001 | 3.490 | 95.951 |
| | (c) flat, só BRIN | 6,35 | 900 / 0 | 46.683 | 92,6 | 901 |
| | (c) flat, só btree(occurred_at) | 3,41 | 343 / 0 | 14.022 | 32,5 | 339 |
| | (b) particionada (PK da partição) | 3,70 | 370 / 0 | 14.022 | 39,0 | 369 |
| | (c) particionada, BRIN no lugar da PK | 5,23 | 642 / 0 | 33.333 | 252 | 643 |

Os mín–máx das 5 execuções quentes e as 3 execuções frias de cada linha estão em
`results/analytics.json`; a dispersão quente ficou abaixo de ±10 % em quase tudo, e a fria chega a 10×
(uma leitura aleatória fria no VHDX custa de 0,1 a 0,5 ms).

Tamanho de cada estrutura (5 M linhas, `pg_relation_size`; as particionadas somam as partições):

| estrutura | tamanho |
| - | -: |
| heap da bruta (flat ou particionada) | 749 MB |
| PK (occurred_at, event_id) | 193 MB |
| btree (link_id, occurred_at) | 151 MB |
| btree (occurred_at) | 107 MB |
| **BRIN (occurred_at)**, flat / particionada | **40 kB / 360 kB** |
| (link_id, occurred_at) INCLUDE (kind, visitor, country) | 327 MB |
| `clicks_hourly` heap + PK | 81 + 40 MB |
| `clicks_daily` heap + PK | 19 + 11 MB |
| `clicks_daily_dim` heap + PK | 293 + 357 MB |
| `clicks_daily_preview` heap + PK | 5,5 + 5,6 MB |

`pg_stats.correlation` de `occurred_at`: **1,0000** na flat e de 0,9998 a 1,0000 nas partições
(0,9964 na do mês corrente, que recebeu os eventos do teste ponta a ponta). `link_id`: 0,05.

### EXPLAIN antes × depois

Trechos dos planos da execução mediana (os números batem com a tabela). Os planos completos estão em
`packages/bench/results/analytics-plans.txt`.

**Q1, antes (ingênua):** a PK serve o intervalo de tempo, mas o filtro por link descarta 92 % do que
é lido.

```
GroupAggregate (actual time=56.315..61.665 rows=31 loops=1)
  Buffers: shared hit=18921
  ->  Sort (actual time=56.166..57.443 rows=42434 loops=1)
        ->  Index Scan using clicks_flat_pkey on clicks_flat (actual time=0.021..51.597 rows=42434 loops=1)
              Index Cond: ((occurred_at >= '2026-10-11 00:00:00+00') AND (occurred_at < '2026-11-11 00:00:00+00'))
              Filter: (link_id = 1467)
              Rows Removed by Filter: 479536
Execution Time: 61.948 ms
```

**Q1, depois (agregados):** 31 linhas do `clicks_daily` pela PK.

```
Sort (actual time=0.127..0.129 rows=31 loops=1)
  Buffers: shared hit=10
  ->  Hash Left Join (actual time=0.092..0.115 rows=31 loops=1)
        ->  Function Scan on generate_series g (actual time=0.011..0.012 rows=31 loops=1)
        ->  HashAggregate (actual time=0.042..0.050 rows=31 loops=1)
              ->  Index Scan using clicks_daily_pkey on clicks_daily (actual time=0.017..0.026 rows=31 loops=1)
                    Index Cond: ((link_id = '1467') AND (day >= '2026-10-11') AND (day < '2026-11-11'))
Execution Time: 0.211 ms
```

**Q1 nos degraus:** (a) e (b) trocam a varredura do mês inteiro por 42.434 linhas do link
(`Bitmap Index Scan on clicks_flat_link_time_idx` → `Bitmap Heap Scan … Heap Blocks: exact=9881`,
29,0 ms); a partição só divide o mesmo trabalho em `clicks_p2026_10` (29.237 linhas) e
`clicks_p2026_11` (13.197), 30,3 ms. O (d) não visita o heap:
`Index Only Scan using clicks_p2026_10_link_id_occurred_at_kind_visitor_country_idx … Buffers:
shared hit=782`, 21,6 ms. Frio, o (a) é o pior caso: 10.046 páginas aleatórias, 3,76 s.

**Q2, antes:** o link frio custa quase o mesmo que o quente, porque o trabalho é varrer o período.

```
Gather Merge (actual time=24.486..28.273 rows=32 loops=1)
  Buffers: shared hit=21169
  ->  Parallel Index Scan using clicks_flat_pkey on clicks_flat (actual time=4.742..21.323 rows=46 loops=3)
        Index Cond: ((occurred_at >= '2026-10-11 00:00:00+00') AND (occurred_at < '2026-11-11 00:00:00+00'))
        Rows Removed by Filter: 173944
Execution Time: 28.365 ms
```

**Q2, depois:** `Index Scan using clicks_daily_pkey on clicks_daily (rows=18)`, `Buffers: shared
hit=8`, `Execution Time: 0.194 ms`.

**Q3, antes:** 90 dias de bruta, 1,5 M linhas examinadas para 19 países; 36.593 páginas não estavam
no shared_buffers.

```
Limit
  Buffers: shared hit=16705 read=36593
  ->  Finalize GroupAggregate (actual time=116.879..121.828 rows=19 loops=1)
        ->  Gather Merge
              ->  Partial HashAggregate (actual time=112.945..112.948 rows=19 loops=3)
                    ->  Parallel Index Scan using clicks_flat_pkey on clicks_flat (actual time=0.042..107.652 rows=37043 loops=3)
                          Rows Removed by Filter: 469685
Execution Time: 121.955 ms
```

**Q3, depois:** um intervalo contíguo da PK `(link_id, dim, day, value)`.

```
Limit (actual time=0.514..0.515 rows=10 loops=1)
  Buffers: shared hit=56
  ->  Sort  ->  WindowAgg  ->  HashAggregate (rows=19)
        ->  Index Scan using clicks_daily_dim_pkey on clicks_daily_dim (actual time=0.019..0.244 rows=1721 loops=1)
              Index Cond: ((link_id = '1467') AND (dim = 'country') AND (day >= '2026-08-12') AND (day < '2026-11-11'))
Execution Time: 0.594 ms
```

**Q4, antes:** o mesmo plano de Q1 mais um `count(DISTINCT visitor)` sobre 42.434 linhas ordenadas
(`Sort Method: quicksort Memory: 3751kB`), `Rows Removed by Filter: 479536`, `Execution Time: 83.157
ms`. **Depois:** a mesma consulta de Q1 (o `clicks_daily` já traz `uniques`), `Buffers: shared hit=10`,
`Execution Time: 0.194 ms`.

**Q5, antes:** 12 meses × todos os links do usuário: a bruta inteira, com sort em disco.

```
Finalize GroupAggregate (actual time=397.768..445.911 rows=366 loops=1)
  Buffers: shared hit=13542 read=82616, temp read=2468 written=2483
  ->  Gather Merge (Workers Launched: 2)
        ->  Sort  Sort Method: external merge  Disk: 6936kB
              ->  Hash Join (actual time=9.194..291.167 rows=336656 loops=3)
                    ->  Parallel Seq Scan on clicks_flat c (actual time=8.956..162.208 rows=1667667 loops=3)
                    ->  Index Only Scan using links_user_title_idx on links l (rows=71)
JIT: Functions: 54 … Total 30.040 ms
Execution Time: 448.072 ms
```

Com o índice (a), o planejador troca por 71 varreduras de índice que leem 1 M linhas em 207.922
páginas: 1,09 s quente e 12,1 s frio, **pior** que a varredura sequencial.

**Q5, depois:** 71 links × ~131 dias pelo índice do `clicks_daily`.

```
Sort (actual time=3.980..3.993 rows=366 loops=1)
  Buffers: shared hit=1001
  ->  Hash Left Join
        ->  HashAggregate (actual time=3.469..3.548 rows=366 loops=1)
              ->  Nested Loop (actual time=0.040..2.210 rows=9333 loops=1)
                    ->  Index Only Scan using links_user_title_idx on links l (rows=71)
                    ->  Index Scan using clicks_daily_pkey on clicks_daily d (actual time=0.004..0.019 rows=131 loops=71)
                          Index Cond: ((link_id = l.id) AND (day >= '2025-11-10') AND (day < '2026-11-11'))
Execution Time: 4.217 ms
```

Com `random_page_cost=4` (o padrão), o mesmo SQL virava `Parallel Seq Scan on clicks_daily d (rows=120932
loops=2)` + `Hash Join`, `Buffers: shared hit=2627`, **29,2 ms**, lendo o `clicks_daily` inteiro (de
todos os usuários) para somar 9 mil linhas.

**Q6 (BRIN):**

```
-- flat, só BRIN: 896 blocos "lossy", 32.661 linhas descartadas no recheck
Bitmap Heap Scan on clicks_flat (actual time=1.610..4.268 rows=14022 loops=1)
  Rows Removed by Index Recheck: 32661
  Heap Blocks: lossy=896
  ->  Bitmap Index Scan on clicks_flat_time_brin (actual time=0.090..0.090 rows=8960 loops=1)
Execution Time: 6.351 ms
-- flat, só btree(occurred_at)
Index Scan using clicks_flat_time_idx on clicks_flat (actual time=0.021..1.369 rows=14022 loops=1)
Execution Time: 3.411 ms
```

### Os degraus, um a um

- **(a) índice (link_id, occurred_at):** resolve o link frio (28,4 → 0,15 ms) e corta Q1 pela metade,
  mas não muda a ordem de grandeza do link quente, que tem 42 mil linhas em 30 dias espalhadas por 10 mil
  páginas. Frio é **pior** que a ingênua (3,8 s contra 0,36 s): 10 mil leituras aleatórias contra
  12,6 mil sequenciais. Na conta (Q5) também piora.
- **(b) partição por mês:** com o pruning, Q3 lê 127.942 linhas em vez de 1,5 M (o filtro de 90 dias
  descarta partições inteiras), mas para o resto quente fica igual a (a). O ganho real da partição não é
  leitura: é a **retenção** (abaixo) e índices menores onde o worker escreve (a partição do mês
  corrente inteira, com os dois índices, tem 35 MB; a PK da tabela toda tem 194 MB).
- **(c) BRIN × btree em `occurred_at`:** com correlação 1,0 o BRIN tem **40 kB contra 107 MB** do
  btree (2.700× menor) e acha o dia certo lendo 3,3× mais linhas do que precisa (blocos de 128 páginas);
  quente fica em 6,4 ms contra 3,4 ms; frio, 93 ms contra 33 ms. **Não se justifica aqui:** a PK
  `(occurred_at, event_id)` é obrigatória (deduplicação) e já é um btree com `occurred_at` na frente,
  e dentro da partição o pruning já faz o papel grosso do BRIN. Ele também não ajuda consulta por link
  (Q1 a Q5 com BRIN ficam iguais ou piores que a ingênua). O BRIN faria sentido se a bruta não tivesse
  PK por tempo, ou se fosse uma tabela de log sem deduplicação.
- **(d) INCLUDE (kind, visitor, country):** o melhor da bruta: index-only scan, Q1 21,6 ms quente e
  57 ms frio, Q3 30 ms. Custa 327 MB (2,2× o índice simples, 44 % do heap) e +55 % de WAL por
  inserção na bruta (abaixo). **Não se justifica:** o dashboard não lê a bruta, e os agregados são 100×
  mais rápidos com 1/30 dos buffers.
- **Agregados:** 150–440× mais rápidos quente e 45–95× frio nas consultas por link; 106× na visão da
  conta. Frio, o pior é a conta: 319 ms, 732 páginas aleatórias (mais detalhes em "random_page_cost").

### Custo de escrita

`corepack pnpm bench:write` roda o `insertBatch` real do worker (bruta + todos os agregados numa
instrução) em lotes de 1.000 eventos no `encurtador_bench` já cheio, com 1 e 4 conexões, variantes em
ida e volta. Com `--raw-only` roda só o `INSERT … ON CONFLICT` da bruta, numa transação desfeita, para
isolar o custo dos índices (100 lotes × 2 rodadas):

| índices na bruta | 1 conexão (eventos/s) | 4 conexões | WAL por evento |
| - | -: | -: | -: |
| só a PK | 15.488 | 47.798 | 337 B |
| **PK + (link_id, occurred_at)** (hoje) | 13.756 | 45.482 | 500 B |
| + BRIN (occurred_at) | 13.534 | 37.712 | 492 B |
| + btree (occurred_at) | 14.342 | 42.768 | 558 B |
| + INCLUDE (kind, visitor, country) | 12.976 | 27.235 | 775 B |

Na instrução inteira do worker (60 lotes, 1 rodada), a diferença some no ruído:

| índices na bruta | 1 conexão (eventos/s) | lote p50 / p95 (ms) | 4 conexões | WAL por evento |
| - | -: | -: | -: | -: |
| só a PK | 4.520 | 207 / 296 | 6.166 | 1.302 B |
| PK + (link_id, occurred_at) | 5.797 | 173 / 192 | 9.109 | 1.445 B |
| + BRIN | 4.579 | 181 / 538 | 6.223 | 1.505 B |
| + btree (occurred_at) | 5.671 | 175 / 193 | 8.312 | 1.478 B |
| + INCLUDE | 5.413 | 181 / 237 | 5.465 | 1.765 B |

Leitura: o BRIN é de graça na escrita (0 B a mais de WAL); o índice da migração 0002 custa ~11 % na
inserção da bruta isolada (+163 B de WAL por evento), mas é ~2 % do lote do worker, que é dominado
pelos upserts nos agregados (o `clicks_daily_dim` sozinho recebe 6 linhas por clique humano). O
INCLUDE é o único que pesa: +55 % de WAL na bruta e −40 % de vazão com 4 conexões. A variação entre
rodadas iguais chegou a 2× (uma rodada logo depois do bench frio, com o cache do sistema vazio, deu
2.000–3.000 eventos/s nas mesmas variantes), por isso a decisão se apoia no WAL e no `--raw-only`,
que são estáveis. Os números são menores que os ~6.500 eventos/s da fase 3 porque aqui os agregados
têm 1,2 GB, não alguns MB.

**Decisão:** o `clicks_link_time_idx` fica. Ele não serve o dashboard, mas serve o teste de
consistência, o suporte (cliques de um link) e o `rebuild_aggregates` de um link, e custa ~2 % do
lote.

### shared_buffers

Com `shared_buffers=512MB` (override só para medir, depois desfeito): as consultas dos agregados não
mudaram (Q1 0,21 ms, Q5 4,40 ms; com 128 MB já eram 100 % hit, `read=0`). A escrita deu 3.856
eventos/s com 1 conexão contra 5.797 com 128 MB rodando logo em seguida no mesmo estado: dentro do
ruído. **Sem mudança.** Quem ganharia com mais memória são as consultas ingênuas (Q3 e Q5 leem 36–82
mil páginas do cache do sistema), que o produto não roda.

### random_page_cost

O volume é SSD, e o padrão 4 supõe disco giratório. Com 1.1, a visão da conta (Q5 e Q5b) passa de
`Parallel Seq Scan` no `clicks_daily` inteiro para nested loop pelo índice: **29,2 → 4,2 ms** e
**30,5 → 3,2 ms** quente. O custo honesto: frio, o nested loop faz 732 leituras aleatórias (319 ms)
contra 2.524 sequenciais (68 ms, uma execução, com 4). Ficou 1.1 porque (1) o `clicks_daily` inteiro
tem 31 MB e mora no cache em regime; (2) a varredura sequencial cresce com o **total** de links do
sistema, não com os do usuário: com 10× mais contas, os 29 ms viram ~300 ms para todo mundo, enquanto
o nested loop continua proporcional aos links da conta. As consultas ingênuas na bruta ficam piores
com 1.1 (Q5 em (a)/(b) vira nested loop de 1 M linhas), mas o produto não as roda. O CI usa o service
do GitHub com o padrão 4; os testes de plano do `stats.test.ts` continuam passando com os dois.

### Busca `q` da listagem: ILIKE × pg_trgm

`corepack pnpm bench:trgm` roda o SQL que o `listLinks` real gera (capturado pelo `debug` do
postgres.js) com o usuário de mais links, `ORDER BY created_at DESC LIMIT 21`, com e sem três GIN
`gin_trgm_ops` (título, slug, destino: o `OR` vira `BitmapOr` sem mudar a consulta). p50 de 5, quente:

| links | termo | casam | ILIKE (ms) | trigrama (ms) |
| - | - | -: | -: | -: |
| 2.000 (usuário com 430) | raro (`xpto-48213`) | 0 | 0,79 | 0,12 |
| | médio (`bicicleta`) | 25 | 0,66 | 0,67 |
| | comum (`exemplo`) | 241 | 0,13 | 0,13 |
| | curto (`4k`) | 24 | 0,51 | 0,49 |
| 200.000 (usuário com 44.655) | raro | 1 | **76,2** | **0,72** |
| | médio | 1.861 | 1,34 | 1,32 |
| | comum | 23.524 | 0,16 | 0,17 |
| | curto | 1.933 | 1,66 | 1,35 |

Com termo que casa bastante, os dois planos são o mesmo: o `links_user_created_idx` em ordem para
nos 21 primeiros. Só o termo raro (ou um erro de digitação, que não casa nada) varre todos os links do
usuário: `Bitmap Heap Scan on links … Rows Removed by Filter: 44654`, 76 ms, contra `BitmapOr` de três
`Bitmap Index Scan on links_*_trgm`, 0,72 ms. Os três GIN custam 1,3 MB com 2.000 links e **50,6 MB
com 200.000 (mais que o heap, 47 MB)**, mais 5,5 s para criar e a escrita em toda criação/edição de
link.

**Decisão: sem migração.** Na escala do projeto (2.000 links, 430 no maior usuário) o pior caso é
0,8 ms. O trigrama passa a valer quando uma conta tiver dezenas de milhares de links (a busca sem
resultado passa de ~30 ms por volta de 18 mil links na conta, extrapolando linearmente os 76 ms de 44 mil). O
bench fica pronto para refazer a medida.

### Retenção: DELETE × DETACH/DROP

`corepack pnpm bench:retention`, mês mais antigo (novembro de 2025, 199.409 linhas). A flat é uma cópia
da bruta inteira, que nesse momento tinha 7,4 M linhas por causa dos benches de escrita, com os mesmos
índices da particionada (PK + (link_id, occurred_at)):

| operação | tempo | WAL | efeito no disco |
| - | -: | -: | - |
| `DELETE FROM clicks_flat WHERE occurred_at < '2025-12-01'` | 383 ms | 40,5 MB | 1,59 GB → 1,59 GB; 2,5 % de tuplas mortas (`pgstattuple`) |
| `VACUUM` depois | 6,6 s | 17,7 MB | continua 1,59 GB; 3,4 % de espaço livre dentro da tabela, nada volta ao sistema |
| `VACUUM FULL` para devolver o espaço | 59,4 s com ACCESS EXCLUSIVE (tabela parada) | 1,50 GB | 1,55 GB |
| `ALTER TABLE … DETACH PARTITION … CONCURRENTLY` | 86 ms | 125 kB | — |
| `DROP TABLE` da partição solta | 54 ms | 80 kB | −47,9 MB na hora |
| `drop_old_visitor_partitions(90)` (a função da migração 0002) | 60 ms | 186 kB | `click_visitors` 564 → 288 MB, 6 partições restantes |

O DELETE em si é rápido, mas o custo vem depois: o espaço fica preso (o mês apagado está no começo do
arquivo, então o VACUUM não consegue truncar), o índice incha junto, e devolver o espaço exige 1 minuto
de tabela parada e 1,5 GB de WAL. A partição sai em 140 ms com 0,2 MB de WAL, e o disco volta na hora.
É o argumento a favor da partição por mês, mais do que a velocidade de leitura. Os agregados ficam:
apagar a bruta antiga não muda o dashboard.

### Teste de consistência

`corepack pnpm test:consistency` (`packages/bench/test/consistency`), contra o `encurtador_bench`:

- links quentes (os 3 maiores), frios (o do seed + 4 com 1–20 humanos) e com 0 cliques: cada linha
  de `clicks_hourly`, `clicks_daily` (com `uniques` = `COUNT(DISTINCT visitor)` dos humanos),
  `clicks_daily_dim`, `clicks_daily_preview` e `links.click_count` comparada com `COUNT` na bruta, por
  diferença simétrica (`EXCEPT ALL` nos dois sentidos);
- todos os links em 5 dias (o primeiro, o de mais tráfego, o último completo, o do fim do seed e hoje);
- o `clicks_daily` inteiro (todos os links × todos os dias) e os totais globais por tipo;
- **ponta a ponta:** 3.000 eventos + 300 repetidos publicados num stream do Redis de teste (db 1) e
  processados pelo `ClickWorker` real contra o bench, por cima dos agregados do `rebuild_aggregates`.
  Inclui visitantes que já estavam na bruta naquele link e dia (não podem virar únicos novos), robôs,
  prévias, links quentes/frios/sem clique e dias passados. Depois: a bruta cresce exatamente 3.000, a
  dead letter fica vazia e todas as comparações acima continuam exatas.

| base | resultado | duração |
| - | - | -: |
| 5 M (seed novo) | 8 de 8 | 57 s |
| 7,4 M (depois dos benches de escrita, com os eventos do worker por cima) | 8 de 8 | 94 s |
| 50 mil (tamanho do CI) | 8 de 8 | 4,1 s |

O teste quebra como deve: somar 1 a uma linha de `clicks_daily_dim` do link quente fez 3 casos
falharem, com a linha divergente no erro. No CI: `pnpm seed:big --clicks=50000` e
`pnpm test:consistency`, depois da integração da API.

### Leitura honesta

- **O que resolve é não ler a bruta.** Nenhum índice na bruta chega perto dos agregados: o melhor
  degrau (d) ainda é 50–100× mais lento quente e precisa de 327 MB. Isso confirma a decisão do ADR 0003
  ("o dashboard nunca faz COUNT na bruta"), agora com números.
- **Índice errado piora.** O (a) é o mais "óbvio" e deixa a consulta fria do link quente 10× mais
  lenta que a varredura, e a visão da conta 2,4× mais lenta quente.
- **A partição se paga na retenção, não na leitura.** 140 ms contra 383 ms + 6,6 s + 59 s de VACUUM
  FULL, e o disco de volta.
- **BRIN é lindo no papel e inútil aqui.** 40 kB contra 107 MB, mas a PK por tempo já existe.
- **O ponto fraco que sobrou é a visão da conta fria** (319 ms): ela soma `clicks_daily` link a link.
  Se isso importar, o próximo passo é um agregado por usuário e dia (proposta no ADR 0006), não um
  índice.
- **O agregado de dimensões é grande:** 650 MB, 60 % do tamanho da bruta, por causa da cidade e da
  cauda longa de referrers (uma linha por link × dia × valor). Ainda cabe, mas é o primeiro candidato
  a retenção (por exemplo, rolar dias antigos para mês).
- **O seed é lento no rebuild** (2 a 4 minutos de 5,8) e varia 2× entre rodadas; o gargalo é I/O do
  WSL2, não CPU.

### Limitações

- Tudo numa máquina, com o Postgres numa VM do WSL2: a leitura aleatória fria (0,1–0,5 ms por
  página) é bem pior que a de um SSD nativo, e isso amplia as diferenças frias.
- O "frio" é frio de verdade (shared_buffers e page cache da VM vazios), mas o Windows ainda pode ter
  parte do VHDX no cache dele.
- Os dados são sintéticos: a sazonalidade é a mesma para todos os links (não há o pico logo depois da
  criação que links reais têm), e os links desativados também recebem cliques.
- Um único usuário quente (71 links) para a visão da conta.
