# Fase 8: polimento

Registro do break-ui, do review-animations, do audit e do polish do impeccable, da acessibilidade e do
backlog. Tudo foi conferido no navegador (Chrome do sistema via Playwright), em 1440, 720 (equivale a
200 % de zoom em 1440) e 390 px, no claro e no escuro.

## Como reproduzir

**Pior caso de verdade (5 M de cliques).** O `encurtador_bench` tem o seed grande com um link extra só
para isso:

```sh
corepack pnpm seed:big --hot=5000000   # ~5 M de cliques no link `pior-caso-5m`, além dos 5 M do seed
```

O dono do link mais quente vira `bench@encurta.dev` / `bench1234` (o hash fica em
`packages/bench/src/seed-big.ts`). Para abrir o painel contra o bench, suba a API apontada para ele e o
web normal:

```sh
# terminal 1 (apps/api)
DATABASE_URL=postgres://encurtador:encurtador@localhost:5433/encurtador_bench \
LIVE_CHANNEL_PREFIX=bench-live: npx tsx --env-file-if-exists=../../.env src/main.ts
# terminal 2 (apps/web)
npx vite
```

Na lista, "Ordenar por: mais cliques" põe o `pior-caso-5m` em primeiro (4.568.610 humanos; os outros
~0,4 M do link são bots e prévias).

**Painel Demo data / Worst case.** Só em `vite` (modo development): uma barra fixa no pé da tela com
**Demo data**, **Worst case**, **Vazio** e **Um**. A escolha vai para a URL (`?dados=pior`) e para o
`sessionStorage`. O pior caso entra pela mesma fronteira dos dados reais: um `fetch` embrulhado troca o
JSON das respostas da API (lista, link, estatísticas, chaves), dentro dos limites da API (título 500,
alias 64, destino 4.096, 50 regras de país, nome de chave 100). Fixture e controle em
`apps/web/src/dev/pior-caso.ts`.

O painel não entra no build: `main.tsx` só o importa com `import.meta.env.MODE === 'development'`, o
e2e roda contra o build de produção e confere que `[data-dev-pior-caso]` não existe, e
`grep -rl "Worst case\|pulo-dados\|devPiorCaso" apps/web/dist` não acha nada, inclusive num build com
`NODE_ENV=development`.

**Capturas.** `CAPTURAS=1 npx playwright test capturas` em `apps/web` gera as 16 capturas e
`landing-erro-390-claro.png`. A `link-5m-1440-claro.png` precisa do web apontado para o bench (acima):
`CAPTURAS=1 CAPTURA_5M_URL=http://localhost:5173 npx playwright test capturas`.

## 1. break-ui

Severidade: **Quebrado** (conteúdo ilegível, ação inalcançável ou dado errado), **Feio** (legível mas
visivelmente errado) e **Frágil** (bem agora, a um passo de quebrar).

| #   | Caso                                      | Tela                    | O que quebrou                                                                                                                                                       | Correção                                                                                                                                                         | Arquivo                                                      |
| --- | ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Sem rede, erro no meio do SSE             | Link                    | **Quebrado.** Com a API fora do ar atrás de um proxy (o do Vite, um nginx), o socket do `EventSource` ficava aberto sem erro e a tela dizia "Ao vivo" para sempre.  | O heartbeat virou evento nomeado (`event: heartbeat`, o `EventSource` não expõe comentários) e o cliente refaz a conexão depois de 40 s sem evento. Medido: "reconectando…" 34 s depois de matar a API, e pausado com a hora em seguida. | `lib/live.ts`, `api/src/modules/live/routes.ts`              |
| 2   | Sem rede, busca da lista                  | Lista                   | **Quebrado.** Offline, a consulta do TanStack Query ficava pausada em silêncio: digitar "black" mostrava a lista anterior como se fosse o resultado.                  | `networkMode: 'always'` (a consulta falha na hora com "Sem conexão com o servidor…") e nova tentativa só com `navigator.onLine`.                                     | `main.tsx`                                                   |
| 3   | Sem rede, busca da lista (com dados)       | Lista                   | **Quebrado.** Uma busca nova que falhou mostrava a lista da busca anterior (placeholder) sem erro.                                                                    | O erro aparece quando a falha é da busca nova; a página seguinte que falha mantém a lista e mostra o erro no pé; a atualização em segundo plano avisa a hora dos dados. | `routes/LinksPage.tsx`                                       |
| 4   | 429 (ou 5xx) ao abrir um link             | Link                    | **Quebrado.** Qualquer erro virava o título "Link não encontrado", sem tentar de novo.                                                                                 | 404 e 410 dizem que o link não existe; o resto diz "Não deu para abrir este link", com Tentar de novo para 0, 429 e 5xx.                                             | `routes/LinkPage.tsx`                                        |
| 5   | Alias de 64 caracteres                    | Lista (1440)            | **Quebrado.** O slug em `nowrap` alargava a tabela e empurrava Humanos, Criado, Copiar e o menu para fora do quadro.                                                   | O link curto quebra (`max-width: 40ch`, `overflow-wrap: anywhere`).                                                                                                | `styles/app.css` (`.linha-curto`)                            |
| 6   | Alias e domínio longo                     | Lista (390)             | **Quebrado.** O link era cortado com reticência no fim, que é justamente o slug, a parte que muda de uma linha para outra.                                             | Quebra entre domínio e slug (`<wbr>`), e o slug anda inteiro (`inline-block`): `localhost:8080/` em cima, `9NbzCMK` embaixo. Só um alias maior que a linha quebra por dentro. | `components/ui.tsx`, `styles/base.css`, `styles/app.css`     |
| 7   | URL de 2.000 caracteres                   | Lista (1440)            | **Feio.** O destino cortado no meio com 40 caracteres não cabia em 28ch e o fim sumia seco, sem reticência.                                                             | `middleTruncate(…, 34)`, `max-width: 32ch` e `text-overflow: ellipsis` de reserva; o `title` traz o destino legível inteiro.                                        | `routes/LinksPage.tsx`, `styles/app.css` (`.destino`)        |
| 8   | URL de 2.000 em regra de aparelho         | Link (200 %)            | **Quebrado.** O chip "Tablet → /colecao/black-friday-2026/…" em `nowrap` vazava a página (739 px numa tela de 720).                                                    | O chip quebra dentro da folha (`min-height` de 22 px em vez de altura fixa, `overflow-wrap: anywhere`).                                                              | `styles/base.css` (`.chip`)                                  |
| 9   | 5 M de cliques, período de 12 m           | Link                    | **Quebrado.** O eixo y tinha 44 px fixos: "300 mil" e "600 mil" apareciam como "00 mil".                                                                              | A largura do eixo segue o maior rótulo.                                                                                                                           | `components/Charts.tsx`                                      |
| 10  | 5 M de cliques, período de 12 m           | Link e lista            | **Feio.** "de 1 de dez. a 10 de nov." lia como se andasse para trás; a lista misturava links de dois anos com a mesma data.                                           | `dateShort` põe o ano fora do ano corrente ("1 de dez. de 2025").                                                                                                  | `lib/format.ts`                                              |
| 11  | 5 M de cliques (dados reais)              | Link                    | **Feio.** O aparelho `other` aparecia cru ("other").                                                                                                                 | "TV, console e outros"; o sistema `other` vira "Outro sistema" ("Outros" já é a linha do resto).                                                                   | `components/Charts.tsx`                                      |
| 12  | Link com 0 cliques                        | Link                    | **Feio.** "Nenhum clique humano de 12 de out. a 10 de nov.." com ponto dobrado (também no resumo do leitor de tela).                                                   | `endSentence` não repete o ponto da abreviação.                                                                                                                   | `components/Charts.tsx`, `routes/LinkPage.tsx`               |
| 13  | Link quente (lote do ao vivo a cada 1 s)  | Link                    | **Feio.** O delta acendia a cada lote, um pisca-pisca constante; o anúncio agregado contava eventos, não cliques.                                                       | O delta acende no máximo a cada 2 s; o anúncio soma os cliques humanos recebidos.                                                                                 | `routes/LinkPage.tsx`, `components/LiveCounter.tsx`          |
| 14  | Quatro botões em 390 px                   | Link                    | **Feio.** "Mais ações" caía sozinho na segunda linha.                                                                                                                | Até 640 px, QR e Editar regras perdem o ícone e os quatro cabem numa linha.                                                                                        | `styles/app.css`                                             |
| 15  | 999.999.999 humanos ao lado de 0          | Lista (390)             | **Feio.** Copiar e "Mais ações" mudavam de lugar de uma linha para outra: a célula tinha `width: 1%` e as ações vazavam dela.                                           | `width: auto` na célula de ações do celular.                                                                                                                       | `styles/app.css`                                             |
| 16  | Nome de chave com emoji e três escopos    | Chaves                  | **Feio.** Os escopos em três linhas encostavam no fio da linha.                                                                                                      | `padding-block` nas células da tabela de chaves.                                                                                                                  | `styles/app.css`                                             |
| 17  | Emoji, bandeira e ZWJ no título           | Lista, link             | **Quebrado.** `middleTruncate` cortava por unidade UTF-16 e partia emoji (meia surrogate).                                                                           | Corte por grafema (`Intl.Segmenter`).                                                                                                                             | `lib/format.ts`                                              |
| 18  | Domínio não latino (`ação.example.com.br`) | Lista, link             | **Feio.** O destino aparecia em punycode (`xn--ao-siap…`) e com o caminho percent-encoded.                                                                            | `displayHost` decodifica o punycode e `prettyUrl` decodifica o caminho; um `%` inválido fica como veio.                                                             | `lib/format.ts`                                              |
| 19  | Regra de aparelho                         | Diálogo, dica           | **Feio.** "No iphone e ipad, vai para…" (minúsculas forçadas).                                                                                                       | Nomes próprios na frase: "No iPhone e iPad", "No Android", "No tablet".                                                                                           | `lib/rules.ts`                                               |
| 20  | Título cortado na lista e nas dimensões   | Lista, link             | **Frágil.** Texto com reticência sem jeito de ler inteiro.                                                                                                           | `title` com o texto completo.                                                                                                                                     | `routes/LinksPage.tsx`, `components/Charts.tsx`              |
| 21  | Painel de pior caso                       | Build                   | **Quebrado.** O e2e fazia o `vite build` com `NODE_ENV=development`, `import.meta.env.DEV` virava `true` e o painel ia para o dist.                                   | Gate por `MODE === 'development'`, build do e2e com `NODE_ENV=production` e teste no e2e.                                                                           | `main.tsx`, `playwright.config.ts`, `e2e/landing.spec.ts`    |
| 22  | Cidades do fixture                        | Fixture                 | Defeito do fixture, não do componente: as cidades vinham sem o país (`Santa Rita…` em vez de `BR/Santa Rita…`) e viravam "Desconhecida (…)".                         | Formato da API (`<país>/<cidade>`).                                                                                                                              | `dev/pior-caso.ts`                                           |

### Decisões que ficaram para você

- **Título de 500 caracteres no cabeçalho do link:** quebra em quantas linhas precisar (4 no desktop, 6
  em 200 %). Recomendo manter: o título identifica o link e não é truncado em lugar nenhum desta tela; na
  lista ele já é cortado com `title`.
- **Último mês parcial na série de 12 m:** o mês corrente aparece como uma queda (10 dias contra meses
  inteiros). O número é honesto; dá para marcar o ponto como "parcial" na dica e na tabela. Fica para
  quem mexer na série.
- **Chips de regra na lista:** com três chips e "+4", a linha cresce para 100 px. Recomendo manter os três
  (DESIGN.md), já que o resto vai para a dica.
- **Domínio em Unicode:** mostrar `ação.example.com.br` no lugar do punycode ajuda quem escreveu o
  domínio, mas esconde um homógrafo (`аpple.com` com "а" cirílico). Como é o próprio dono quem vê os
  links, mantive; numa tela pública seria punycode.

### O que aguentou

- 5 M de cliques reais: os números (`4.377.464`, `401.448`) cabem na faixa, a régua honesta, a legenda do
  mapa (`1.000.000–2.778.722`) e as listas de dimensões; a página abre com as consultas em milissegundos.
- Landing com URL de 2.000 caracteres: o campo rola por dentro, o resultado mostra só o link curto e o
  QR; sem rede, a frase "Sem conexão com o servidor. Confira a internet e tente de novo." aparece no
  lugar do erro.
- Vazio e Um: "0 links", "1 link", "1 humano"/"0 humanos", "Você ainda não criou nenhum link" com o
  campo, "Nenhuma chave ativa".
- Offline no ao vivo: "Ao vivo pausado · Atualizado às 19:01" com Retomar, que reconecta.
- Vietnamita (`Đặng Thị Ngọc Hân`), árabe, japonês e cirílico: sem corte de diacrítico, `line-height`
  folgado.

## 2. review-animations

Feito à mão pelo `SKILL.md` (a skill não roda sozinha). Inventário: tira da landing (endireitar, sair,
colar, condensar), botões (pressionar e trocar rótulo), menus e dicas do Base UI, diálogos e fundo, menu
do celular, avisos (Sonner), delta do ao vivo, barras das dimensões, segmentos, skeletons, tema e as
páginas do redirect.

| Antes                                                                     | Depois                                                                              | Por quê                                                                                                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `.segmento { transition: background-color 160ms ease }`                   | sem transição                                                                       | O período e o status trocam pelas setas do teclado: ação de teclado não anima. (`app.css`)                                      |
| `.menu-movel`: só opacidade, 200 ms na entrada e na saída                  | `translateY(-8px)` e opacidade, 200 ms; saída em 120 ms; reduzido sem deslocamento    | Fade puro não diz de onde a folha veio; ela desce da barra do botão. Saída mais rápida que a entrada. (`app.css`)                |
| `.fundo-dialogo` sai em 200 ms, o diálogo em 120 ms                         | o fundo também sai em 120 ms                                                        | O fundo ficava escurecendo a tela depois que o diálogo já tinha saído. (`base.css`)                                             |
| Sonner: `transform 400ms, opacity 400ms, height 400ms` com `ease`           | 200 ms com `--ease-saida`                                                           | Aviso é resposta do sistema: acima de 300 ms e com curva fraca. 200 ms casa com o desmontar do Sonner. (`base.css`)             |
| `.btn-troca > span { transition: opacity 160ms ease }`                     | `--ease-saida`                                                                      | Curva embutida fraca no troca-rótulo do Copiar. (`base.css`)                                                                    |
| `.tira { transition: transform 160ms ease }`                              | `--ease-saida` (já corrigido no começo desta fase)                                  | Mesmo motivo: o "papel endireita" usa a curva do sistema. (`landing.css`)                                                       |
| Delta do ao vivo reacendia a cada lote                                     | no máximo a cada 2 s                                                                | Keyframe disparado em alta frequência num link quente. (`LinkPage.tsx`)                                                         |
| Botão do redirect: `:active` com `scale(.97)` sem transição nem reduzido    | `transition: transform 160ms`, curva do sistema, e nada com movimento reduzido        | Mesmo gesto do app, e respeita `prefers-reduced-motion`. (`apps/redirect/src/pages.ts`)                                          |

**Veredito: aprovado depois das correções.**

- **Aprovado como está:** menus e dicas (`scale(0.96)` a partir de `--transform-origin`, 160 ms, saída
  em 100 ms, dica instantânea quando já há uma aberta); diálogos centrados (`scale(0.97)`, 200/120 ms, no
  celular sobem 24 px); pressionar (`scale(0.97)`, 160 ms, `--ease-saida`, conforme o padrão); barras das
  dimensões (`scaleX`, 200 ms, só quando o período muda); skeletons chapados, sem brilho; tema sem
  transição de cor.
- **Acima de 300 ms, justificado:** a tira colada (420 ms) e o link condensando (`wdth` 100 → 62, 420 ms)
  são o único momento assinatura, uma vez por envio. O `font-variation-settings` reflui o texto, mas é
  uma linha curta. O delta do ao vivo (600 ms) indica estado e agora tem limite de frequência.
- **Movimento reduzido:** some todo deslocamento (tira reta, diálogos e menus só com opacidade, sem
  `scale` no pressionar) e o delta vira sublinhado. Conferido no e2e (`animationName: none`,
  `transform: none` na tira). Hover com movimento fica atrás de `(hover: hover) and (pointer: fine)`.

## 3. impeccable: audit e polish

`impeccable context` carregou PRODUCT.md, DESIGN.md e as briefs; o detector rodou no código
(`apps/web/src`) e na landing em 1280 e 390 px: **0 anti-padrões**. Advisories: tamanhos fora da escala
(15, 13 e 20 px, que são da escala real do app e do cartaz), a hachura dos bots (falso positivo: é a
linguagem da régua honesta no DESIGN.md) e "Lite." sozinha na última linha do FAQ a 390 px (corrigido).
As telas do app pedem login, então o detector não passa por elas; foram revistas por captura.

| #   | Dimensão                 | Antes | Depois | Achado principal                                                                             |
| --- | ------------------------ | ----: | -----: | -------------------------------------------------------------------------------------------- |
| 1   | Acessibilidade           |     2 |      4 | Região de rolagem da tabela fora do Tab; erro de campo não anunciado; queda do ao vivo muda   |
| 2   | Performance              |     3 |      3 | Chunk da página do link com 530 KB (recharts)                                                 |
| 3   | Temas                    |     4 |      4 | —                                                                                            |
| 4   | Responsivo               |     2 |      3 | Overflow a 200 % (chips) e slug cortado no celular; a tabela da lista rola dentro do quadro no tablet |
| 5   | Integridade              |     3 |      4 | Painel de pior caso no build do e2e; "Link não encontrado" para 429                           |
|     | **Total**                | 14/20 |  18/20 |                                                                                              |

**Crítico e alto (corrigidos):**

- **[P0] O ao vivo mente quando a conexão morre sem fechar** (break-ui 1).
- **[P0] Busca sem rede mostra o resultado errado** (break-ui 2 e 3).
- **[P1] Ações da lista fora do quadro com alias longo; slug cortado no celular** (break-ui 5 e 6).
- **[P1] Eixo y cortado** (break-ui 9).
- **[P1] Página vaza a 200 % de zoom** (break-ui 8).
- **[P1] `scrollable-region-focusable` (axe):** a tabela da série, que rola, não entrava no Tab. Os três
  quadros de tabela agora têm `tabIndex=0`, `role="region"` e nome, com o anel por dentro.
- **[P1] Erro de campo não anunciado:** o foco ia para o campo antes de o React ligar o
  `aria-describedby`, e o leitor não lia o erro. Os erros de campo (novo link, editar regras, login,
  chaves) têm `role="alert"`.
- **[P1] Foco perdido depois de criar um link:** o Encurtar fica desabilitado durante o envio e o foco
  caía no `body`. Ele vai para o Copiar do resultado, como na landing.
- **[P1] Queda do ao vivo só desenhada:** "reconectando" e "pausado" agora têm um `role="status"`.
- **[P1] 429 vira "Link não encontrado"** (break-ui 4) e **painel de pior caso no dist** (break-ui 21).

**Polish:** `text-wrap: pretty` no texto da landing; as frases de período sem ponto dobrado; data com ano
fora do ano corrente; nomes de aparelho em pt-BR; DESIGN.md atualizado na tabela de Motion.

**Ficou de fora, com motivo:**

- **[P2] Chunk da página do link com 530 KB** (recharts, d3-geo e o resto): a página já é carregada sob
  demanda e o mapa vem à parte. Quebrar o recharts em outro chunk é trabalho de performance, fora do
  polimento.
- **[P2] Tabela da lista entre 641 e 1100 px:** rola dentro do quadro (o DESIGN.md permite: "a tabela
  rola dentro do próprio quadro"), e agora o quadro entra no Tab. Virar lista de duas linhas também no
  tablet é uma mudança de layout para a próxima fase.
- **[P2] Oito alertas de uma vez:** trocar de período sem rede mostra o erro em cada folha (DESIGN.md:
  "dentro do bloco que falhou"), e cada um é `role="alert"`. Juntar num aviso só muda o padrão de erro
  do sistema; fica registrado.
- **[P3] "Silenciar anúncios" troca o rótulo e o `aria-pressed` juntos.** Funciona nos leitores, mas o
  ideal é rótulo fixo; não mexi para não mudar o texto aprovado.
- **[P3] Advisories de tamanho de fonte (13, 15 e 20 px):** são da escala usada no código desde a fase 7;
  o caminho é documentá-los no DESIGN.md, não trocá-los.

## 4. Acessibilidade

| Item                                                                               | Estado | Como foi conferido                                                                                       |
| ---------------------------------------------------------------------------------- | :----: | -------------------------------------------------------------------------------------------------------- |
| axe sem violações (qualquer impacto, WCAG 2.0/2.1/2.2 A e AA), claro e escuro       |   ✔    | e2e `a11y.spec.ts`: landing, landing com erro, landing com resultado, login, lista, link, link com a tabela da série, diálogo de regras, chaves |
| Teclado: criar link                                                                |   ✔    | e2e: Tab → "Pular para o conteúdo" → Enter → destino → alias → título → Encurtar, foco visível em cada passo, Enter cria, o foco vai para o resultado e "Ver cliques" abre a página |
| Teclado: período                                                                   |   ✔    | e2e: um Tab entra no rádio marcado, setas trocam, marcam e vão para a URL                                  |
| Teclado: mapa e tabela                                                             |   ✔    | e2e: "Ver tabela" com Enter; o mapa é `aria-hidden` e a lista de países ao lado é o dado; o quadro da tabela entra no Tab |
| Teclado: editar regras                                                             |   ✔    | e2e: Enter abre, o foco entra no diálogo, Esc fecha e o foco volta para "Editar regras"                     |
| Teclado: chaves                                                                    |   ✔    | e2e: Criar sem nome mostra o erro como alerta; com nome, cria e mostra a chave uma vez                     |
| Foco visível e ordem lógica                                                        |   ✔    | e2e confere `:focus-visible` com anel de 2 px em cada passo                                               |
| Rótulos                                                                            |   ✔    | axe (`label`, `button-name`, `link-name`) e `getByLabel` nos testes                                        |
| `aria-live` do contador                                                            |   ✔    | Região `polite`, no máximo a cada 30 s, agregada e silenciável; estado da conexão num `role="status"`      |
| Anúncio de erros                                                                   |   ✔    | Erros de bloco e de campo com `role="alert"`; erro da landing também                                      |
| Zoom de 200 % sem perder conteúdo                                                  |   ✔    | e2e com 640 px de largura: nenhuma tela rola na horizontal; pior caso conferido a 720 px                   |
| `prefers-reduced-motion`                                                           |   ✔    | e2e com `reducedMotion: 'reduce'`: a tira nasce reta e sem animação                                        |

## 5. Backlog

- **a) D-08:** na tira da landing, o slug vai em JetBrains Mono (`.tira-curto-slug`, 0,86 em, peso
  700) e o domínio segue em Archivo condensada. Visível em `docs/screenshots/landing-*.png`.
- **b) Testes instáveis da API:**
  - `links.test.ts` "filtros q, status…": duas causas possíveis, as duas eliminadas. (1) Os links tinham
    slug aleatório, e o `q=ver` também busca no slug com `ILIKE`: um slug com "ver" em qualquer caixa
    entrava no resultado. Agora os aliases são fixos. (2) O teste vencia o link com `Date.now() - 1 s`
    do Windows, mas o filtro compara com o `now()` do Postgres, que roda na VM do Docker (WSL2) e pode
    ficar segundos atrás. Agora o vencimento é `now() - interval '1 hour'` e o dia de criação vem do
    banco. Não deu para provar qual das duas causou a falha de antes (hoje os relógios batem).
  - Isolamento do ao vivo: `LIVE_CHANNEL_PREFIX` na API e no worker (padrão `live:`). Os testes da API
    usam um prefixo por processo, o do worker também, o e2e usa `e2e-live:` e o `test:consistency` usa
    o dele. O `PUBSUB NUMSUB` conta só o canal do teste, e o teste confere que o canal do dev não chega.
  - Integrações: uma trava de suíte (`holdTestSuiteLock`, advisory lock no banco `postgres`) impede que
    duas suítes de pacotes diferentes apaguem os dados uma da outra no `encurtador_test`.
  - A integração da API rodou 3 vezes seguidas sem falha (68 testes cada).
- **c) `drop_old_click_partitions(meses)`** (migração 0004):
  - Derruba as partições mensais de `clicks` cujo mês terminou antes de (1º dia do mês corrente − N
    meses) e apaga o mesmo período da `clicks_default`. Os agregados não mudam.
  - **Sem CONCURRENTLY, de propósito.** O Postgres recusa `DETACH PARTITION … CONCURRENTLY` quando a
    tabela tem partição DEFAULT, e a `clicks` tem `clicks_default`; além disso, a forma CONCURRENTLY não
    roda em transação nem em função. A forma comum pega ACCESS EXCLUSIVE só no catálogo, por um
    instante; a função tem `lock_timeout = 3s` para desistir em vez de enfileirar os INSERTs do worker, e
    um advisory lock para dois workers não correrem juntos.
  - Teste no `encurtador_test` (`apps/worker/test/integration/pipeline.test.ts`): cria partições de 12,
    13 e 14 meses atrás, publica cliques nelas e na DEFAULT, confere que só as antigas somem, que os
    agregados ficam iguais, que a função é idempotente e que 0 meses é recusado.
  - Worker: `CLICK_RETENTION_MONTHS` vazio (padrão) não apaga nada; com N, roda na partida e a cada
    12 h, junto da manutenção de partições. Falha só vai para o log.
- **d) Documentação da API:** o link agora é `/api/docs/`, com a barra. Sem ela, o Swagger UI pedia os
  assets em `./static/…` relativos a `/api/`, fora do proxy. A URL pode vir de `VITE_API_DOCS_URL`
  (para quando a API estiver em outro domínio). O e2e abre o link no `vite preview` e confere que a UI
  carrega sem nenhum 4xx em `/api/docs`.

## 6. Outros ajustes da fase

- Heartbeat do SSE: de comentário (`: heartbeat`) para evento (`event: heartbeat`, sem dados). A
  documentação OpenAPI da rota foi atualizada. **O ADR 0004 diz só "heartbeat a cada 15 s"; proposta de
  texto no relatório da fase.**
- O e2e sobe a API com um balde de rate limit maior (o demo faz a suíte inteira, e os testes novos de
  a11y esgotavam o balde do ADR, de 120 com 2/s). O limite continua testado na integração da API.
