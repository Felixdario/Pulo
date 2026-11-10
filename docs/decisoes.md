# Decisões

Decisões curtas e não bloqueantes. As grandes viram ADR em `docs/adr/`.

## D-01 — Portas do Compose (2026-11-09)
O Postgres 17 do projeto 2 usa a 5432. Aqui ficam Postgres 16 na **5433** e Redis 7 na **6380**.

## D-02 — Skills (2026-11-09)
Estão todas presentes: impeccable, design-taste-frontend, emil-design-eng, animate, break-ui,
review-animations, pick-ui-library e dupla-agentes. `review-animations` e `pick-ui-library` têm
`disable-model-invocation: true`, então o agente lê o `SKILL.md` delas e segue as instruções à mão,
como no projeto 2.

## D-03 — Carga com autocannon (2026-11-09)
O autocannon entra como devDependency e roda via `pnpm bench:*`, sem instalação global. O k6 exigiria
um binário fora do npm.

## D-04 — Licenças do enriquecimento (2026-11-09)
`ua-parser-js` fica fixado em 1.x (MIT), porque a 2.x é AGPL-3.0. `maxmind` (MIT) lê o mmdb. `isbot` é
Unlicense. O DB-IP Lite é CC BY 4.0, com crédito no README e no dashboard.

## D-05 — DB-IP Lite baixado (2026-11-10)
O usuário autorizou o download. `corepack pnpm geo:download` baixou a edição 2026-11 de
`download.db-ip.com`:

| Base | Compactado | Em disco |
| - | - | - |
| City | 60 MB | 121 MB |
| Country | 4 MB | 8 MB |

Os arquivos ficam em `data/geo/`, fora do git. Consultando com o IP truncado, como o worker faz
(`/24` e `/48`), a resposta segue útil. Exemplos:
- `200.160.2.0` → BR / São Paulo / Pinheiros;
- `8.8.8.0` → US / California / Mountain View;
- `81.2.69.0` → GB / England / London.

A precisão de cidade da base Lite vem por bairro ou município, que é suficiente para o mapa e a tabela
de cidades. Sem os arquivos, país e cidade continuam `null`.

## D-06 — Nome e direção de design (2026-11-10)
- **Nome:** o produto se chama **Pulo**, escolhido entre Pulo, Rastro e Curto. Ele nomeia o mecanismo
  (o salto do redirect), tem 4 letras e funciona em pt-BR e em inglês.
- **Domínio:** é só hipótese (`pulo.to`). Nada foi pesquisado nem registrado.
- **Direção:**
  - a landing é um cartaz lambe-lambe de gráfica popular, rosa e preto em Archivo condensada;
  - o app segue um estilo acromático de livro-razão, e o rosa aparece só nos cliques humanos.
- **Sem entrevista com o usuário:** a fase rodou sem ela. O que foi inferido está marcado em
  `PRODUCT.md`. A mudança de nome ou de direção é barata até a fase 7.
- **Rascunhos do impeccable:** ficam fora do git (`mocks/`, `questions/`, `review/`), como no Pontual.

## D-07 — Bibliotecas do front (pick-ui-library, 2026-11-10)
Pela lista curada da skill:
- **@base-ui/react:** diálogos, menus, tooltips e o combobox de países, com foco e Esc acessíveis.
- **sonner:** avisos curtos (toasts).
- **recharts:** a série temporal.
  - Sem animação de entrada, porque o DESIGN.md não desenha gráfico na entrada.
  - O gráfico é `aria-hidden`, com resumo em texto e "Ver tabela".
- **zustand:** o estado da sessão.
- **clsx:** classes condicionais.

Fora da lista:
- **TanStack Router:** search params tipados para os filtros e o período; combina com o TanStack Query.
- **world-atlas + topojson-client + d3-geo:** o mapa coroplético em Equal Earth, via npm.
- **qrcode:** gera SVG e PNG localmente.
- **i18n-iso-countries:** só a tabela de códigos numéricos para ISO-2. Os nomes dos países vêm do
  `Intl.DisplayNames`.
- **@fontsource-variable:** Archivo, com eixo de largura, e JetBrains Mono, auto-hospedadas.

Recusadas: NumberFlow, motion, next-themes, Liveline e Virtuoso.
- O contador troca de uma vez, como placar, sem rolar dígitos.
- As animações são CSS, que é a ferramenta mais barata.
- A SPA não tem SSR, então um script inline resolve o tema sem piscar.
- A lista é paginada por cursor, sem virtualização.

## D-08 — Slug em mono também na tira da landing (2026-11-10)
A direção põe o link curto da tira em Archivo largura 62. Um slug aleatório como `sEXddOm` fica
ambíguo entre O e 0, que é justamente o motivo de o DESIGN.md usar JetBrains Mono para slugs.
Decisão: o slug vai em mono também na tira, e o domínio continua em Archivo. Fica para o polimento
(fase 8).
