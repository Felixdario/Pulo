# Product

<!-- impeccable:product-schema 1 -->

> Escrito na fase 6 com `impeccable init`. Esta fase rodou sem entrevista com o usuário (o Planejador
> decidiu não interrompê-lo), então tudo que não vem do código, dos ADRs ou do dossiê está marcado
> como **[inferido]** e pode ser corrigido sem cerimônia.

## Platform

web

## Users

- **Criador de conteúdo**: posta no Instagram, no TikTok, no YouTube e em grupos de WhatsApp, quase
  sempre pelo celular. Cola um link longo, quer de volta um curto e legível (`/live-sabado`, não
  `/aB3xK9q`) e quer saber, horas depois, quantas pessoas clicaram e de onde vieram. O trabalho dele:
  encurtar em segundos, colar na bio ou no story e voltar para ver o resultado.
- **Marketing de PME**: no notebook do escritório, cuidando de campanha (Black Friday, cupom do mês,
  QR no cardápio ou no folheto). Cria links com prazo, limite de cliques e destino por país ou
  dispositivo (App Store para iPhone, Play Store para Android), compara canais por referrer e precisa
  de um número que aguente uma reunião sem ser inflado por robôs.
- **Dev que integra pela API**: cria links por script ou backend com uma chave de escopo restrito
  (`links:read`, `links:write`), lê estatísticas pela `/v1` e quer erros em `application/problem+json`
  previsíveis. Usa o dashboard para gerar e revogar chaves e conferir o que a integração fez.
- **Visitante sem conta** **[inferido]**: chega pela landing, encurta um link anônimo (30 dias, slug
  aleatório, sem regras) e decide se vale criar conta.
- **Avaliador do portfólio** (recrutador ou pessoa técnica): abre o demo com `demo@encurta.dev` /
  `demo1234` e quer ver em minutos que o redirect é rápido, que as regras funcionam e que os números
  batem. Ele também é quem clica no link de teste e volta para ver o contador mexer.

## Product Purpose

Encurtador de URLs com analytics. O produto troca um link longo por um curto, decide para onde cada
clique vai (prazo, senha, limite, país, dispositivo, tipo de redirect, repasse de query) e conta esses
cliques com exatidão. O sucesso é a pessoa confiar no número que vê: cada clique humano contado uma vez,
robôs e prévias separados, e o gráfico disponível em milissegundos mesmo com milhões de cliques.

É o 3º de 4 projetos de um portfólio. O destaque é engenharia de caminho quente e de dados, e a
interface tem que deixar essa engenharia visível sem virar um painel de métricas de infraestrutura.

## Positioning

O encurtador que não infla os números. O redirect responde com p95 de 6,4 ms com cache, e o clique é
registrado depois da resposta, sem atrasá-la. O pipeline grava cada clique exatamente uma vez (Redis
Streams, idempotência por id do evento), e o `test:consistency` prova que os agregados batem com a
tabela bruta. A prévia do WhatsApp, o robô do Slack e o crawler aparecem à parte e não gastam o limite
de cliques de um link. Os únicos são contados por dia, com sal diário e sem guardar IP, e a interface diz
isso em vez de vender "visitantes únicos" como se fossem pessoas.

## Operating Context

- **Redirect** (`apps/redirect`): `GET /:slug` → 30x. Páginas próprias e pequenas para 404, 410
  (expirou ou atingiu o limite), 429 e o formulário de senha. Desativado e inexistente dão a mesma
  resposta.
- **API** (`apps/api`, `/v1`): autenticação (JWT curto em memória com refresh em cookie
  httpOnly no web, mais chaves de API com escopos; ADR 0004), links (CRUD, busca `q` com `ILIKE`, já
  que o pg_trgm foi adiado pela medição do ADR 0005, e regras), prévia do destino (título, descrição, imagem, favicon, nº de
  redirects), estatísticas por período, visão geral da conta, chaves de API e SSE ao vivo
  (`live:<user_id>`, atraso de até ~500 ms depois do commit).
- **Link anônimo**: `POST` público, slug aleatório, expira em 30 dias, sem alias, regras ou senha,
  10 por minuto por visitante.
- **Estatísticas**: série por hora, dia ou mês; top de países, cidades, referrers, navegadores,
  sistemas e dispositivos; únicos × totais; contadores de bots e de prévias por app. Tudo lido dos
  agregados (ADR 0006).
- **Demo**: `demo@encurta.dev` / `demo1234`, com links como `demo-promo`, `demo-blog`, `demo-docs`,
  `demo-senha`, `demo-expirado` e `demo-desativado`. O seed grande tem 5 M de cliques para benchmark.

## Capabilities and Constraints

- **Stack do front:** React 19, Vite 8 e TanStack Query 5 em `apps/web` (hoje um placeholder). A escolha
  de bibliotecas de UI, gráfico e mapa é da fase 7.
- **Regras de destino:** país (ISO 3166-1 alfa-2) → dispositivo (`ios`, `android`, `mobile`, `tablet`,
  `desktop`) → destino padrão; vence a primeira que casar. Até 50 regras de país e 10 de dispositivo.
- **Tipo de redirect:** 302 por padrão; 301, 307 e 308 opcionais. Com 301 ou 308, cliques repetidos do
  mesmo navegador não são contados dentro do `cache_ttl` (padrão 1 h), e a interface precisa avisar.
- **Únicos:** `HMAC(sal_do_dia, ip ‖ user_agent)`. O mesmo visitante em dias diferentes é
  irreconhecível, então "únicos no período" é a soma de visitantes-dia.
- **Geo:** DB-IP Lite (CC BY 4.0). O crédito é obrigatório no rodapé do dashboard. Sem a base, país e
  cidade ficam `null` e a interface mostra "desconhecido", não zero.
- **Idioma:** pt-BR. **[inferido]** Inglês não está no escopo desta fase; se entrar, toda string já
  deve passar por uma camada de i18n.
- **Nome e domínio:** o domínio dos links e o e-mail demo usam `encurta.dev` como provisório. O nome
  escolhido nesta fase (abaixo) só será aplicado ao seed e ao domínio na fase 7.

## Brand Commitments

- **Nome do produto: Pulo** (escolha da fase 6, entre Pulo, Rastro e Curto; análise em
  `docs/design/direcao.md`). Domínio dos links curtos como hipótese, sem verificação.
- **Precisa parecer de outra mão que o Pontual** (projeto 2 do mesmo portfólio). Nenhum token, fonte ou
  padrão de componente deve ser herdado dele.
- **Voz:** direta, numérica e sem exagero. Fala "você", usa verbo no imperativo nos botões ("Encurtar",
  "Copiar", "Revogar"), escreve número com separador brasileiro (`12.480`, `6,4 ms`) e nunca promete
  mais do que o dado sustenta. Quando um número tem ressalva, a ressalva vem junto, em uma frase.

## Evidence on Hand

- Medições reais em `docs/performance.md` (p95 de 6,4 ms com cache; consultas de analytics de 0,19 a
  4,22 ms quentes sobre 5 M de cliques) e o `test:consistency`.
- Seed demo em `apps/api/src/seed/demo.ts`.
- Não há clientes, depoimentos, logos de parceiros, preços nem métricas de uso reais. Nada disso deve
  ser inventado na landing. Dados de demonstração aparecem rotulados como demo.

## Product Principles

1. **Números honestos.** Humanos, bots e prévias são contados à parte, e só humanos entram no total e
   no limite de cliques. Os únicos são por dia, e a interface diz isso ao lado do número. "Desconhecido"
   é uma categoria visível, não um buraco no gráfico.
2. **A regra se explica.** Cada regra de um link aparece como uma frase legível ("iPhone vai para a App
   Store", "expira em 12/12 às 23:59", "para depois de 500 cliques") antes de aparecer como campo.
3. **O link curto é o produto.** O slug, o domínio e o botão de copiar têm o lugar mais nobre de cada
   tela. Tudo que o usuário faz termina com um link na área de transferência.
4. **Rápido de verdade, mostrado de verdade.** O que é medido pode ser mostrado (o tempo do redirect, o
   atraso do ao vivo); o que não é medido não vira slogan.
5. **Nada de mentira no demo.** Dados plausíveis, marcados como demo, sem prova social inventada.

## Accessibility & Inclusion

WCAG 2.2 AA. Gráficos têm resumo em texto e tabela equivalente; o mapa tem a lista de países ao lado.
Nenhuma série, status ou regra é indicada só por cor. O contador ao vivo anuncia mudanças com
moderação (`aria-live="polite"`, agregado, nunca a cada clique). Respeita `prefers-reduced-motion`.
