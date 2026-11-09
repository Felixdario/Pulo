# ADR 0002 — Caminho quente do redirect

- **Status:** aceito (fase 2). Números em [`docs/performance.md`](../performance.md): p95 com cache de
  6,4 ms (meta < 20 ms).
- **Data:** 2026-11-09

## Contexto

`apps/redirect` atende uma única rota, `GET /:slug` (mais o `POST /:slug` do formulário de senha). É o
serviço que recebe todo o tráfego, então cada milissegundo e cada ida ao banco contam. A meta é
**p95 < 20 ms com cache**, medida com autocannon (50 conexões, 30 s) com e sem cache.

Há quatro decisões aqui: qual status HTTP usar, em que ordem avaliar as regras, como fazer o cache e
como registrar o clique sem atrasar a resposta.

## 1. Status: 301 × 302 × 307/308

| | Cache do navegador | Método preservado | Clique contado na volta | Mudar o destino surte efeito |
| - | - | - | - | - |
| 301 | sim; sem `Cache-Control` o Chrome guarda **indefinidamente** | não (POST pode virar GET) | não, porque o navegador nem chega a nós | não, para quem já tem em cache |
| 302 | não, por padrão | não, na prática | sim | sim |
| 307 | não | **sim** | sim | sim |
| 308 | como o 301 | **sim** | não | não |

Para SEO, o Google trata um 302 de longa duração como permanente, então o 301 não é necessário para
passar relevância.

**Decisão:** o padrão é **302**, configurável por link (`redirect_type ∈ {301, 302, 307, 308}`).
- 302 e 307 saem com `Cache-Control: private, max-age=0`.
- 301 e 308 saem com `Cache-Control: public, max-age=<link.cache_ttl>` (padrão 3.600 s), em vez do cache
  sem prazo. O link continua "permanente" para robôs, e o estrago de editar o destino dura no máximo
  uma hora. O dashboard avisa: "com 301, cliques repetidos do mesmo navegador não são contados".
- 307/308 existem para quem encurta endpoints que recebem POST, como webhooks.

## 2. Ordem das regras

```
GET /:slug
 1. slug reservado ou com formato inválido   → 404 (sem tocar no Redis)
 2. token bucket por visitante                → 429 + Retry-After
 3. busca no cache (cache-aside)               → ausente/negativo → 404 amigável
 4. desativado ou apagado                      → 404 (mesma página; não revela que existiu)
 5. expires_at ≤ agora                         → 410 "este link expirou"
 6. senha e sem cookie de desbloqueio          → 200 com formulário (no-store)
 7. limite de cliques atingido                 → 410 "este link atingiu o limite"
 8. destino: regra de país → de dispositivo → padrão
 9. repasse de query string e UTMs
10. responde 30x  ──depois──▶  XADD do evento (sem await)
```

- **404 e 410** saem em HTML pequeno, com CSS inline, ou em `application/problem+json` se
  `Accept: application/json`. Desativado e inexistente dão a mesma resposta, para não confirmar a
  existência de links.
- **Senha:** o `POST /:slug` confere com argon2id (lento de propósito, só neste caminho e com bucket
  mais apertado: 5 tentativas por minuto) e grava um cookie HMAC `__unlock_<slug>` por 1 h,
  `HttpOnly; Secure; SameSite=Lax; Path=/<slug>`. Depois responde 303 para o próprio `GET`.
- **Limite de cliques:** `INCR cap:<link_id>` no Redis, atômico. Se o valor passar de `max_clicks`,
  responde 410. O contador é inicializado com `SET NX` a partir do total do banco. **Bots e prévias não
  consomem o limite**: o redirect roda o mesmo `classifyAgent()` de `packages/shared` que o worker usa,
  uma regex de microssegundos, para que o WhatsApp abrir a prévia não gaste o único clique de um link
  de uso único. O limite vale para cliques humanos e é aproximado em ±1 sob concorrência no momento da
  virada, o que fica documentado.
- **País:** usa `CF-IPCountry` ou `X-Country` quando vem de proxy confiável. Senão, consulta o DB-IP
  **Country** Lite (mmdb de ~8 MB) em memória. A consulta só acontece se o link tiver regra de país.
- **Dispositivo:** `mobile | tablet | desktop` e `ios | android | outros`, por regex no user agent, sem
  biblioteca no caminho quente.
- **Query string:** com `forward_query` (padrão: ligado), os parâmetros de entrada são anexados ao
  destino. **Se a chave já existe no destino, vale a do destino**: as UTMs que o dono configurou não
  podem ser sobrescritas por quem compartilha o link.

## 3. Segurança do destino (validada na API, na criação e na edição)

- Só `http:` e `https:`. Com isso `javascript:`, `data:`, `vbscript:`, `file:` e `blob:` caem por
  construção (lista de permissão, não de bloqueio).
- Sem credenciais na URL: `https://banco.com@evil.example` → 422.
- Host que é IP literal privado, loopback, link-local, CGNAT, ULA, multicast ou `0.0.0.0` (v4 e v6,
  incluindo IPv4 mapeado em v6) → 422. O parser WHATWG já normaliza `http://2130706433` e
  `http://0177.0.0.1` para `127.0.0.1`, e o teste cobre essas formas. Hosts `localhost`, `*.localhost`,
  `*.local` e `*.internal` também caem.
- Hostname com DNS que resolve para IP privado: verificação na criação, de melhor esforço (DNS
  rebinding existe). A defesa real contra SSRF fica no buscador da prévia de título, que resolve o
  nome, fixa o IP e só então conecta.
- **Loop:** destino em um dos nossos domínios curtos → 422. Cadeias através de outros encurtadores
  (A → bit.ly → A) são verificadas de forma assíncrona pelo worker, com HEAD até 5 saltos e timeout de
  2 s no buscador seguro. Se a cadeia volta para nós, o link fica `blocked_loop` e o redirect responde
  404.
- Tamanho máximo de 4.096 caracteres. O caso de 2.000 do break-ui precisa funcionar de ponta a ponta.

## 4. Rate limit: token bucket no Redis

Script Lua atômico, com chave por visitante (`HMAC(ip)`, nunca o IP) no redirect e por chave de API ou
usuário na API. Lê `tokens` e `ts`, repõe `(agora − ts) × taxa` até a capacidade, consome 1 e define
`PEXPIRE`. Os padrões do redirect são capacidade 60 e 10/s. As respostas trazem `RateLimit-Limit`,
`RateLimit-Remaining` e `RateLimit-Reset`, além de `Retry-After` no 429.

Escolhido em vez de janela fixa, que permite rajada dupla na virada da janela, e de janela deslizante
com ZSET, que custa O(n) de memória por visitante.

**Uma ida ao Redis só:** o script do bucket também faz o `GET` do link e devolve os dois. O caminho
quente com cache fica em **1 round-trip ao Redis e 0 ao Postgres**. A fase 2 mede as duas versões (duas
idas e uma ida) e registra a diferença.

## 5. Cache-aside

- Chave `l:<slug>` com o JSON mínimo que o redirect precisa: id, destino, status, tipo, expiração,
  limite, regras, se tem senha e versão. O TTL é de 1 h ± 10 % de jitter.
- **Cache negativo:** `l:<slug> = "∅"` com TTL de 30 s. Um robô varrendo slugs aleatórios bate no Redis,
  não no Postgres.
- **Invalidação sem corrida:** quem lê preenche com `SET NX`. A API, depois do commit, faz
  **write-through** com `SET` incondicional: valor novo, ou `∅` quando o link é apagado ou desativado.
  - Se a leitura busca a linha antiga, a API grava a nova e a leitura tenta `SET NX` da antiga: o `NX`
    falha e o cache fica com a nova.
  - Se a leitura grava a antiga antes, o `SET` da API sobrescreve.
  - Nos dois casos o estado final é o novo. Um simples `DEL` deixaria a leitura atrasada regravar o
    valor velho por até 1 h. Criar um link também faz `SET`, o que apaga um `∅` que estivesse em cache.
- **Stampede:** single-flight em memória por slug. 1.000 requisições simultâneas a um slug frio fazem
  1 consulta ao Postgres.
- Sem cache em memória no processo, por enquanto. Ele tiraria o round-trip ao Redis, mas exigiria
  pub/sub para invalidar. Fica como opção se a fase 2 não bater a meta.

## 6. Registrar o clique sem esperar

A resposta é enviada primeiro. Depois, `XADD clicks MAXLEN ~ 1000000 * <evento>` com o ioredis em
autopipelining, sem `await` e com `.catch()` que incrementa `clicks_publish_failed_total`. Se o Redis
cair, um buffer em memória de 10.000 eventos segura e reenvia, e o que passar disso é descartado com
métrica (`clicks_dropped_total`). **Perder um clique é aceitável; atrasar ou derrubar um redirect,
não.**

O evento não leva o IP: veja o ADR 0003.

## Resultado da fase 2

Média de 2 rodadas de 30 s com 50 conexões, autocannon na mesma máquina:

| Cenário | req/s | p50 | p95 | p99 |
| - | -: | -: | -: | -: |
| Cache quente, 1 ida ao Redis (Lua bucket + GET) | 10.129 | 4,64 ms | **6,42 ms** | 7,75 ms |
| Cache quente, 2 idas | 8.921 | 5,22 ms | 7,29 ms | 9,05 ms |
| Sem cache (`CACHE=off`) | 7.891 | 5,98 ms | 8,09 ms | 10,02 ms |
| Cache negativo (404) | 16.090 | 2,95 ms | 4,48 ms | 5,79 ms |

- O script único em Lua (1 ida ao Redis) dá +13,5 % de req/s em relação a 2 idas, e por isso foi mantido.
- A latência é quase toda fila: pela Lei de Little, 50 conexões / 10 mil req/s = 5 ms.

Ajustes acordados durante a implementação:
- `writeThrough(redis, slug, link | null)` recebe o slug, porque com `null` não haveria de onde tirar
  a chave.
- O JSON em cache não leva hash de senha nem dono. Leva só um resumo `passwordVersion`, e trocar a
  senha invalida os cookies de desbloqueio.
- Com o Redis fora, o limite de cliques fica aberto, ou seja, o link continua funcionando, coerente
  com "não derrubar redirects". O redirect serve pelo Postgres e conta `redis_fallback_total`.
- O bucket da senha (5/min) vale mesmo com `RATE_LIMIT=off`, que só existe para o bench.
- O redirect também recusa (404) um destino resolvido que não seja http/https, como defesa em
  profundidade, já que o banco não valida esses campos.
- `HEAD` é atendido como `GET`, e HEAD sem user agent é classificado como bot.
- Limitações conhecidas:
  - o iPadOS 13+ se anuncia como Macintosh e cai em desktop;
  - em Redis Cluster, as chaves `rl:` e `l:` precisariam de uma hash tag comum.

## Consequências

- O redirect depende do Redis para funcionar bem. Se o Redis cair, ele faz fallback para o Postgres
  sem rate limit, com métrica e log de alerta, em vez de derrubar os links.
- `/metrics` (Prometheus) expõe `redirect_duration_seconds` (histograma por status e
  `cache=hit|miss|negative`), `cache_requests_total`, `rate_limited_total` e os contadores de
  publicação.
- O mmdb de país vai junto com o processo (~8 MB de RAM).
- Testes da fase 2: um teste por regra da tabela da seção 2; invalidação (editar → próximo GET já usa o
  destino novo); cache negativo (slug inexistente → 1 consulta ao banco em 100 GETs); bypass de destino
  (`JaVaScRiPt:`, `http://[::ffff:127.0.0.1]`, `http://0x7f.1`, `https://a@b`); bucket (61ª requisição
  em rajada → 429).
