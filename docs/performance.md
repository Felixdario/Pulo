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
