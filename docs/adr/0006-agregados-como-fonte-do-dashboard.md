# ADR 0006 — Agregados como única fonte do dashboard

- **Status:** aceito (fase 5). Números em [`docs/performance.md`](../performance.md#fase-5-analytics-com-5-milhões-de-cliques-2026-11-10).
- **Data:** 2026-11-10

## Contexto

O dashboard precisa responder, para um link ou para a conta inteira, por período:
- a série por hora, dia ou mês;
- o top de países, cidades, referrers, navegadores, sistemas e dispositivos;
- únicos contra totais.

Contar na bruta (`COUNT(*) … GROUP BY`) custa entre 28 e 448 ms quente e entre 0,34 e 2,5 s frio
com 5 M de cliques, e cresce junto com a tabela. O link quente, com 612 mil cliques, é o pior caso.

## Opções

1. `COUNT` na bruta com o melhor índice possível (ADR 0005): no máximo 21,6 ms quente e 56,8 ms frio
   no Q1, pagando 327 MB e +55 % de WAL. Na visão da conta, o índice **piora** (1,09 s).
2. Materialized views com `REFRESH` periódico: atrasam em minutos, o refresh relê a bruta inteira e
   não dá para atualizar só um link.
3. **Agregados mantidos pelo worker** na mesma instrução que grava a bruta (ADR 0003):
   - `clicks_hourly`;
   - `clicks_daily`, com os únicos;
   - `clicks_daily_dim (link_id, dim, day, value, n)`;
   - `clicks_daily_preview`;
   - `links.click_count`.

## Decisão

**Opção 3.** O dashboard e a API leem só dos agregados (`packages/db/src/stats.ts`), e nenhuma
consulta de produção faz `FROM clicks`.

| Consulta | `COUNT` na bruta, ingênua (quente / frio) | Agregados (quente / frio) | Ganho quente / frio |
| - | -: | -: | -: |
| Série 30 d, link quente | 61,9 / 359 ms | **0,21 / 6,0 ms** | 295× / 60× |
| Série 30 d, link frio | 28,4 / 343 ms | **0,19 / 3,6 ms** | 150× / 95× |
| Top 10 países, 90 d | 122 / 823 ms | **0,59 / 18,0 ms** | 207× / 46× |
| Únicos × totais, 30 d | 83,2 / 388 ms | **0,19 / 4,6 ms** | 440× / 84× |
| Conta, série de 12 meses | 448 / 2.540 ms | **4,22 / 319 ms** | 106× / 8× |

O custo dos agregados está no tempo e no espaço:
- **Tempo:** cada lote do worker atualiza tudo numa transação, a cerca de 6.500 eventos/s com um
  worker.
- **Espaço:** `clicks_daily_dim` ocupa 650 MB, cerca de 60 % da bruta, por causa da cauda longa de
  cidades e referrers. `clicks_hourly` ocupa 120 MB, `clicks_daily` 30 MB e `clicks_daily_preview`
  11 MB.

**A exatidão é provada, não suposta.** O `test:consistency` compara cada agregado com `COUNT` e
`COUNT DISTINCT` na bruta por `EXCEPT ALL` nos dois sentidos, cobrindo:
- links quentes, frios e sem cliques;
- todos os links em 5 dias;
- o `clicks_daily` inteiro.

Ele passa com 5 M, com 7,4 M depois dos benches de escrita e com 50 mil (no CI), inclusive com o
worker real gravando por cima do rebuild. Alterar uma única linha de `clicks_daily_dim` faz 3 casos
falharem.

Para backfill e reconstrução existe `rebuild_aggregates(from, to)`, que reproduz a semântica do worker
em SQL. Por enquanto ela vive em `packages/bench`, porque faz `COUNT` na bruta, e exige o worker parado
no período.

## Consequências

- O dashboard tem latência de submilissegundo por link mesmo com links de centenas de milhares de
  cliques, e o custo não cresce com o histórico, só com o período pedido.
- Uma métrica nova exige alterar a instrução do worker, o `rebuild_aggregates` e o teste de
  consistência.
- `clicks_daily_dim` é o candidato a compactação: dias com mais de 90 dias podem virar mensais
  (`clicks_monthly_dim`) ou cortar a cauda de referrers e cidades com menos de N cliques em "outros".
- A visão da conta fria (319 ms) é a consulta mais lenta, porque soma linha a linha os links do
  usuário. Se ela importar, o próximo passo é um agregado `clicks_daily_user(user_id, day)`, mantido
  pelo worker.
