# ADR 0005 — Partição e índices da tabela bruta de cliques

- **Status:** aceito (fase 5). Números em [`docs/performance.md`](../performance.md#fase-5-analytics-com-5-milhões-de-cliques-2026-11-10).
- **Data:** 2026-11-10

## Contexto

A tabela `clicks` recebe um evento por clique: 5 M de linhas em 12 meses no seed padrão (1,07 GB com
índices). O dashboard nunca lê dela (ADR 0006). Ela serve para três coisas: a deduplicação do worker,
o backfill com `rebuild_aggregates` e o teste de consistência. As perguntas eram se particionar
compensa, quais índices manter, se o BRIN se justifica e se a busca `q` da listagem precisa de
trigrama.

## Opções medidas

Cada opção foi medida com p50 de 5 execuções quentes e mediana de 3 frias. O cache frio foi obtido
reiniciando o container e esvaziando o page cache do WSL2.

| Estrutura | Tamanho | Q1 série 30 d de um link quente (quente / frio) | Q6 um dia inteiro (quente / frio) | Custo no INSERT da bruta |
| - | -: | -: | -: | -: |
| flat, só PK `(occurred_at, event_id)` | 193 MB | 61,9 / 359 ms | 3,43 / 35,9 ms | 15.488 ev/s, 337 B de WAL por evento |
| + `(link_id, occurred_at)` | +151 MB | 29,0 / 3.760 ms | — | 13.756 ev/s, 500 B (−11 %) |
| particionada por mês + `(link_id, occurred_at)` | igual | 30,3 / 1.060 ms | 3,70 / 39,0 ms | igual |
| só BRIN `(occurred_at)` | **40 kB** | 58,9 / 666 ms | 6,35 / 92,6 ms | 13.534 ev/s, 492 B |
| `INCLUDE (kind, visitor, country)` | 327 MB | 21,6 / 56,8 ms | — | 12.976 ev/s, 775 B (−40 % com 4 conexões) |

A correlação de `occurred_at` é 1,0000, porque a bruta é inserida em ordem de tempo. Esse é o cenário
ideal para o BRIN.

**Retenção** (apagar um mês inteiro da bruta):

| | Tempo | WAL | Disco |
| - | -: | -: | - |
| `DELETE … WHERE` | 383 ms + VACUUM de 6,6 s | 40,5 MB | não volta; precisa de `VACUUM FULL` (59,4 s com a tabela travada, 1,5 GB de WAL) |
| `DETACH PARTITION CONCURRENTLY` + `DROP` | 86 + 54 ms | 0,2 MB | volta na hora |

**Busca `q` (ILIKE × pg_trgm):**
- Com 2.000 links, as duas ficam abaixo de 0,8 ms.
- Com 200.000 links, só o termo raro melhora (76 → 0,7 ms); termos comuns usam o mesmo plano com ou
  sem índice.
- Os 3 índices GIN ocupam 50,6 MB, mais que o heap (47 MB).

## Decisão

1. **Particionar por mês**, por causa da retenção e não da leitura. Nas consultas por link, a partição
   empata com o índice composto. A vantagem é apagar um mês em 140 ms e 0,2 MB de WAL, contra um
   `VACUUM FULL` de 59 s com a tabela travada. Os índices do mês quente também ficam pequenos.
2. **Manter a PK `(occurred_at, event_id)`**, que já é o btree de tempo e a chave de deduplicação, e o
   índice `(link_id, occurred_at)`. Este custa cerca de 11 % do INSERT isolado e cerca de 2 % da
   instrução inteira do worker, e serve o teste de consistência, o backfill por link e o suporte.
3. **Sem BRIN.**
   - Ele é 2.600 vezes menor, mas seria redundante: a PK já cobre o tempo e o pruning já corta por mês.
   - No lugar da PK, ele é mais lento (5,2 contra 3,7 ms quente e 252 contra 39 ms frio) e não serve
     para deduplicar.
   - Fica registrado como a escolha certa para uma bruta só de append, sem chave única de tempo.
4. **Sem índice cobrindo (INCLUDE).** Ele custa 327 MB e +55 % de WAL para acelerar leituras que o
   produto não faz.
5. **Sem pg_trgm por enquanto.** Só ajuda com dezenas de milhares de links por conta, e o índice fica
   maior que a tabela.
6. **Postgres no Compose:**
   - `random_page_cost=1.1`, porque o volume é SSD. A visão da conta quente cai de 29,2 para 4,2 ms.
   - `shm_size: 256mb`, porque o VACUUM paralelo falhava sem `/dev/shm`.
   - `shared_buffers` continua em 128 MB, já que 512 MB não mudou nada mensurável.

## Consequências

- **Retenção da bruta:** passa a ser feita com `DETACH` + `DROP` por mês, pela função
  `drop_old_click_partitions(meses)` (migração 0004, fase 8).
  - O `DETACH` é o comum, com `lock_timeout` de 3 s. O `CONCURRENTLY` não serve aqui por três motivos:
    o Postgres o recusa quando existe partição DEFAULT, e ele também não roda dentro de transação nem
    de função.
  - O worker chama a função a cada 12 h só quando `CLICK_RETENTION_MONTHS` está definido; por padrão,
    nunca apaga.
  - Os agregados do dashboard são mantidos.
- **Índice errado piora as coisas.** O índice composto deixa a visão da conta 2,4 vezes mais lenta
  quente e 4,8 vezes mais lenta fria, porque o planejador troca a varredura sequencial por milhares de
  leituras aleatórias. É mais um motivo para o dashboard não ler da bruta.
- **Efeito colateral do `random_page_cost=1.1`:** a visão da conta fria sobe de 68 para 319 ms. Se o
  caso frio importar, a solução é um agregado `clicks_daily_user` (ADR 0006), não outro índice.
- **Reavaliar o trigrama** quando houver contas com cerca de 18 mil links ou mais.
