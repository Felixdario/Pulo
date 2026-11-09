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
