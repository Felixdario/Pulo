# Direção visual — fase 6

O sistema (tokens, componentes, estados e acessibilidade) está em [`DESIGN.md`](../../DESIGN.md); o
produto, em [`PRODUCT.md`](../../PRODUCT.md). Este documento explica **de onde vem o visual**, como a
landing e o app se compõem, o momento assinatura, o nome e o que evitar.

## Como a direção foi decidida

Esta fase rodou sem o usuário. Onde as skills pediam uma escolha dele, eu escolhi e deixo a razão aqui.

1. **`impeccable` (init e new-work).** Escreveu o `PRODUCT.md` a partir dos ADRs e do dossiê, com o que
   foi inferido marcado. Depois listei sete mundos que o público conhece de cor, do mais ao menos
   ressonante:
   1. a catraca e o bilhete de transporte, porque cada passagem é contada uma vez;
   2. as placas azuis de direção da estrada, onde cada regra manda para um destino;
   3. a etiqueta e o carimbo de encomenda, com rota e rastreio;
   4. **o cartaz lambe-lambe de gráfica popular**;
   5. o placar do estádio;
   6. a amarelinha riscada a giz (a leitura literal de "pulo");
   7. o letreiro luminoso de fachada.

   Os mundos 1, 3 e 4 são de papel, o 2 é chapa esmaltada, o 5 e o 7 são de luz e o 6 é giz, então a
   lista cobre mais de três famílias de material.

   O sorteio do `concept-seed` (`seed:e7c39a73701ad28a`) mandou construir o **4**. Ele não era o meu
   primeiro (era a catraca). Mantive o sorteio, porque ele existe justamente para tirar o projeto da
   minha escolha previsível e porque o lambe-lambe carrega o produto: é o meio em que o comércio
   brasileiro anuncia promoção, show e inauguração, exatamente o que o nosso público faz com um link.

   Os desafiantes sorteados e o veredito de cada um, nos dois eixos da skill (identificação com o público
   e clareza do produto):

   | Desafiante | Veredito | O que a direção pegou dele |
   | - | - | - |
   | Mostruário de fonte variável | recusado | a hierarquia só por contraste de tamanho, e o eixo de largura como mecanismo (o link encolhe de verdade) |
   | Display de sete segmentos | competitivo (clareza) | **a ausência desenhada**: zero, desconhecido e período vazio têm forma própria, e o contador troca o dígito em vez de rolar |
   | Raku e fumaça | recusado | cada estado animado tem um registro estático final (o `reduced-motion` mostra o resultado, não o processo) |
   | Bazar de sombras | recusado | **a etiqueta de origem**: todo número diz de onde vem ("únicos por dia, soma", "só humanos") |
   | Cartaz de luta | recusado | o top de dimensões em lista ordenada, com o primeiro lugar maior |
   | Kraftwerk | competitivo (clareza) | as regras de destino desenhadas como rota ortogonal (slug → país → dispositivo → padrão) no editor de regras |

   A página de decisão do impeccable não foi aberta: como subagente, eu não teria quem respondesse, e a
   skill manda seguir com a direção sorteada quando não há resposta. Os contratos de direção estão em
   `apps/web/.impeccable/surfaces/landing.md` e `apps/web/.impeccable/surfaces/app.md`.

2. **`design-taste-frontend`.** Distribuiu a composição.
   - **Landing:** entre `split-stage`, `sentence-as-layout` e `one-motif`, escolhi **`sentence-as-layout`**
     (seed 1070838690), porque o produto cabe numa frase e o campo de URL pode morar dentro dela.
   - **Tipo e paleta:** a skill sorteou Bodoni Moda com Jost sobre cinza-rosado, um par de revista de moda.
     Troquei pelo tipo e pela paleta do mundo do impeccable (`--keep palette,type`), porque um didone de
     luxo briga com cartaz de gráfica e com um público de criador e PME.
   - **App:** entre `accent-ladder`, `framed-sheet` e `achromatic-ledger`, escolhi **`achromatic-ledger`**
     (seed 1207692857). Cromo sem cor e um único tom no dado principal é a tradução visual de "números
     honestos", e a casca "Open plane" é diferente das folhas com borda do Pontual.

## A landing: o cartaz

**Ideia:** neste site, **o cartaz lambe-lambe colado em série no tapume** vira **a frase-layout com o
campo de URL dentro dela**, e o link curto nasce como uma tira nova colada por cima.

### Primeiro viewport (1440 × 900)

- **Campo rosa-gráfica** de ponta a ponta, sem imagem e sem gradiente. O rosa é o papel, não um
  enfeite.
- **Barra de 64 px:** a marca "pulo." à esquerda; Como funciona, Números, API e o botão Entrar à
  direita, todos em tinta.
- **A frase**, em `cartaz` (Archivo 62/850, caixa-alta, cerca de 130 px), duas linhas, alinhada à
  margem esquerda:

  > ENCURTE LINKS.
  > CONTE SÓ GENTE.

- **A tira colada:** uma faixa de papel branco de 640 × 72 px, inclinada -1,5°, atravessa o começo da
  segunda linha, como um lambe colado por cima de outro. Dentro dela, o rótulo "Link para encurtar", o
  campo e o botão preto "Encurtar". É o formulário de verdade, no primeiro viewport, e não um link para
  outra página.
- **Frase de apoio**, a 20 px, logo abaixo da tira e a 40 px dela: "O Pulo encurta na hora e conta cada
  clique de gente uma vez. Robôs e prévias do WhatsApp ficam à parte."
- Embaixo, à esquerda, um link de texto: "Ou entre no demo: demo@encurta.dev".

**No celular (390 px):** a frase fica em duas linhas a cerca de 13vw, e a tira vem depois, reta, na
largura toda, com o botão embaixo do campo (56 px). A frase de apoio segue a 16 px.

### O momento assinatura: o link curto nascendo

1. O visitante cola o link e envia.
2. A tira com a URL longa desliza 8 px e esmaece. Uma tira nova é **colada** no mesmo lugar: entra com
   escala de 1,02 e inclinação de -3°, e assenta em -1,5° em cerca de 420 ms.
3. Na tira nova, o link curto (`pulo.to/aB3xK9q`) aparece em `cartaz` reduzido e sai da largura 100
   para a 62 enquanto entra. Encurtar vira, literalmente, condensar a letra.
4. O botão vira "Copiar", com o QR ao lado e a linha honesta "Vale até 9 de dezembro…".

Com `reduced-motion`, a tira nova já aparece reta e o link já condensado, sem deslocamento.

Esse é o único momento que se apresenta. O resto da landing tem só o retorno dos controles e uma
entrada discreta por seção.

### As seções, em ordem de argumento

| Seção | Afirmação | Prova | Composição |
| - | - | - | - |
| Números honestos | Contamos gente, não robô. | Um fragmento real da página do link (dados de demonstração rotulados): a régua honesta com "Prévia do WhatsApp: 390, não conta" e o contador ao vivo. | Papel claro. Afirmação em `declaracao` nas seis colunas da esquerda; o fragmento em tamanho real à direita. |
| Regras que se explicam | Cada link decide para onde vai. | Um controle deslizante com quatro paradas: "Do Brasil, vai para /br", "No iPhone, vai para a App Store", "Para em 500 cliques" e "Expira em 12/12". | Campo dividido 50/50 com um único deslizante na costura; à direita, o editor de regras desenhado como rota ortogonal. |
| Medido, não prometido | O redirect é rápido e os números batem. | Uma frase corrida com os números reais de `docs/performance.md`: "6,4 ms de p95 no redirect, 0,21 ms para a série de 30 dias, 5 milhões de cliques no teste e nenhuma diferença no teste de consistência." | A frase em `declaracao` nas 12 colunas, com um número aceso por vez. |
| Para quem integra | A API faz tudo que a tela faz. | Um `curl` real de `POST /v1/links` e a resposta, mais "chaves com escopo, erros em problem+json". | Linhas penduradas num eixo na coluna 5, com o código em bloco `pre`. |
| Perguntas | — | "Por que os únicos são por dia?", "O que conta como robô?", "A prévia do WhatsApp gasta clique?", "301 ou 302?", "Vocês guardam meu IP?", "Quanto dura um link sem conta?" | Pergunta grande à esquerda e resposta aberta à direita, sem acordeão. |
| Fechamento | — | — | Campo tinta, frase em `cartaz` rosa-gráfica: "SEU PRÓXIMO LINK, / CONTADO DIREITO." e o botão "Criar conta". |
| Rodapé | — | — | Campo rosa com "pulo.to" a 8vw de margem a margem; links, o crédito "DB-IP Lite (CC BY 4.0)" e "Projeto de portfólio". |

O rosa abre e fecha a página, e o miolo alterna papel e folha, como uma parede de cartazes colados em
série.

## O app: o livro-caixa

**Pergunta de cada tela:**
- **Lista de links:** "Qual link eu quero, e qual está rendendo?". O maior bloco é a tabela, e o campo
  "Novo link" fica no topo.
- **Página do link:** "Quantas pessoas clicaram, e de onde?". O maior número é o de humanos no
  período.
- **Chaves de API:** "Quais chaves existem, o que podem fazer e quando foram usadas?".

### Composição

- **Casca Open plane:** a barra lateral de 232 px no chão de papel tem a marca "pulo." e o seletor de
  conta no topo; Links, Visão geral e Chaves de API no meio; o usuário e o tema no pé. O item ativo é um
  fundo `elevado`, sem barra colorida. Não há barra superior.
- **Lista:** o título "Links" a 24 px com a contagem ("37 links"); o campo de URL e o botão "Encurtar"
  numa linha; a busca e os filtros como frase ("Todos · Ativos · Com regras · Expirados"); e a tabela de
  linhas de 56 px.
- **Página do link, de cima para baixo:**
  1. o link curto em mono a 24 px com Copiar, QR e Editar, e o destino com favicon embaixo;
  2. à direita do título, o contador ao vivo;
  3. a linha de chips de regra;
  4. o seletor de período (24 h, 7 d, 30 d, 90 d e personalizado), sempre com as datas escritas;
  5. uma caixa só, dividida em quatro: Humanos, Únicos por dia (soma), Bots e Prévias;
  6. a régua honesta;
  7. a série em dois terços da largura e, ao lado, os países (mapa pequeno e lista de 10);
  8. na dobra, as folhas de cidades, referrers, navegadores, sistemas e dispositivos, em listas
     ordenadas.
- **Chaves de API:** a configuração em duas colunas (rótulo e descrição à esquerda, folha à direita).
  A chave nova aparece **uma vez**, em mono, com Copiar e a frase "Guarde agora: depois ela não aparece
  mais." Revogar pede confirmação com o nome da chave.

### O momento assinatura no app: o contador ao vivo

O ponto rosa e o número de hoje no título. Quando chega um clique, o dígito **troca** (não rola), e
"+1 agora" acende em `rosa-texto` por 600 ms. Para o avaliador do portfólio, é o momento de abrir o
link de teste numa aba, voltar e ver o número mudar em menos de um segundo. Para o criador, é a
resposta a "está funcionando?" logo depois de postar o story.

## Referências, em palavras

- **Lambe-lambe de gráfica popular:** papel fino de cor chapada (rosa, amarelo, verde-limão), tipo de
  madeira condensado, a mesma folha repetida em grade no tapume e as bordas levemente tortas de quem
  colou com pressa. Pegamos a cor em campo inteiro, a caixa-alta condensada e a inclinação da tira.
  Deixamos de lado o rasgado, a textura de papel e a tinta falhada, que virariam fantasia.
- **Livro-caixa de balcão:** colunas de números alinhadas pela vírgula, tinta preta e nenhuma cor
  além de um sinal. É a disciplina do app.
- **Placar de estádio:** o número que troca de uma vez, e o zero desenhado com o mesmo cuidado do
  resto.
- **Placa de direção de estrada:** a regra lida como seta e destino ("iPhone → App Store").

Não copiamos nenhum site, e nenhuma marca, logo ou página de concorrente serve de molde.

## O que evitar (cara de template)

- O hero de encurtador: o campo centralizado sobre um gradiente roxo ou azul, "Encurte, compartilhe e
  acompanhe" e uma fileira de logos de clientes.
- Três cards de recurso com ícone em círculo ("Rápido", "Seguro", "Analytics").
- O dashboard de kit: quatro cards de KPI com ícone, "+12,5 %" verde em tudo, sparkline, gráfico de área
  com gradiente e curva suavizada, tabela zebrada com cabeçalho em caixa-alta.
- Mapa-múndi como peça de decoração sem lista ao lado, ou um globo 3D girando.
- "Visitantes únicos" sem dizer que é por dia, e bots misturados no total.
- Rótulo pequeno em caixa-alta espaçada acima dos títulos, numeração 01/02/03 e mono como fantasia.
- Sombra dura deslocada e caixas pretas grossas. O lambe-lambe leva a isso fácil, e não é o nosso
  cartaz: a separação vem da cor do papel, não de sombra.
- Creme com terracota, preto com neon, violeta.
- Prova inventada: "+10 mil empresas", depoimento ou preço.

## Diferença em relação ao Pontual

| | Pontual (projeto 2) | Pulo (projeto 3) |
| - | - | - |
| Ponto de partida | o padrão da categoria executado com capricho (régua Booksy) | um mundo próprio sorteado: o cartaz lambe-lambe |
| Landing | página pública do estabelecimento, contida | cartaz rosa de ponta a ponta, frase em caixa-alta a cerca de 130 px |
| Tipo | Hanken Grotesk, uma largura | Archivo em três larguras (62, 75 e 100) e mono para slugs |
| Cor | neutros frios e um acento cobalto | papel e tinta, e rosa-gráfica em campo inteiro (landing) ou só no dado (app) |
| Forma | pílulas, cartões de 16 px, folhas de 20 px | cantos retos ou de 2 a 6 px, tiras inclinadas, nenhuma pílula |
| App | cartões brancos com borda sobre fundo frio | livro-caixa: cromo sem cor, um tom só no dado |
| Assinatura | o bloco ocupado com preparo e limpeza | o link nascendo como tira colada, a régua honesta e o contador ao vivo |

Os dois compartilham só o que é princípio do portfólio: AA, estados honestos e nada de prova inventada.

## O nome

Três candidatos. A disponibilidade de domínio é **hipótese**: nada foi pesquisado nem registrado.

### Pulo

- **Significado:** salto, o que o redirect faz. Em pt-BR, "dar um pulo" é ir rapidinho a um lugar, e
  "o pulo do gato" é o truque de quem sabe.
- **Como soa:** em pt-BR, curto, informal e com cara de verbo ("me manda o pulo"). Em inglês, "POO-loh",
  fácil de dizer e sem significado ruim que eu conheça.
- **Riscos:** é palavra comum, então a marca é fraca para registro sozinha e pode haver apps pequenos com
  o mesmo nome. Não conheço marca grande com ele. Em tagalo, "pulo" quer dizer ilha, o que é neutro.
- **Domínio (hipótese):** `pulo.to` (o melhor para links curtos: `pulo.to/aB3xK9q` tem 15 caracteres),
  `pulo.link`, `pulo.app` ou `pulo.com.br`.

### Rastro

- **Significado:** a marca que alguém deixa ao passar, o que o analytics lê.
- **Como soa:** em pt-BR é forte e sério. Em inglês, "RAHS-troh", pronunciável, mas sem significado.
- **Riscos:** "rastrear" e "rastreamento" puxam para vigilância e para entrega de encomenda, justo o
  contrário da promessa de não guardar IP. "El Rastro" é a feira de Madri. Com seis letras, deixa cada
  link curto mais comprido.
- **Domínio (hipótese):** `rastro.link`, `rastro.to`.

### Curto

- **Significado:** o que o produto entrega.
- **Como soa:** em pt-BR é claro, mas descritivo demais, e lembra "curto-circuito" e "curti". Em inglês,
  "KOOR-toh", sem significado.
- **Riscos:** é o nome mais genérico possível para a categoria, quase impossível de registrar, e se
  confunde com qualquer outro encurtador em português.
- **Domínio (hipótese):** `curto.link`, `curto.to`.

### Escolha: Pulo

- O nome descreve o **mecanismo** (o salto do redirect), não a categoria, e combina com o momento
  assinatura (o link "pula" para a parede).
- Tem quatro letras, o que importa num produto cujo domínio aparece em cada link.
- Funciona em pt-BR e em inglês e não carrega a conotação de vigilância de "Rastro".
- É diferente em som e em forma de "Pontual": não começa com a mesma sílaba nem parece da mesma série.

**Para a fase 7:** o domínio dos links curtos passa de `encurta.dev` para o que for confirmado (hipótese:
`pulo.to`), e o e-mail demo pode virar `demo@pulo.to`. Até lá, o seed continua com `demo@encurta.dev`.

### Aplicação do nome

- **Wordmark em texto:** "pulo." em minúsculas, Archivo largura 62 e peso 850, com tracking de -0,02em.
  O ponto final fica em `rosa-dado` sobre papel ou folha, e em tinta sobre o campo rosa. O ponto
  lembra o ponto do domínio (`pulo.to`) e fecha a palavra como fim de frase de cartaz. Não há símbolo
  à parte: na barra lateral do app, a marca é o próprio wordmark a 20 px.
- **Favicon:** [`favicon.svg`](favicon.svg), um quadrado rosa-gráfica de cantos retos com um "p"
  condensado em tinta, desenhado em caminhos (sem depender de fonte) e legível a 16 px.
- **Microcopy de exemplo:**
  - **CTA da landing:** no formulário, o botão "Encurtar"; no fechamento, "Criar conta"; abaixo do
    hero, "Ou entre no demo".
  - **Estado vazio da lista:** "Você ainda não criou nenhum link. Cole um endereço aqui em cima: o link
    curto sai na hora, e os cliques de gente aparecem nesta lista."
  - **Mensagem de 410 (expirou):** título "Este link expirou" e o texto "Quem criou este link definiu
    que ele valia até 31 de outubro. Se alguém te mandou, peça um link novo." Para o limite: "Este link
    já foi aberto todas as vezes que podia" e "Ele foi criado para 500 cliques, e todos já foram usados."
    No pé das duas, discreto: "Encurtado com pulo." Mostrar a data e o limite exige que a página do
    redirect receba esses dados (fase 7; hoje ela tem textos fixos em `apps/redirect/src/pages.ts`).

## Arquivos desta fase

- `PRODUCT.md`, `DESIGN.md` e este documento.
- `apps/web/src/styles/tokens.css`, com os tokens de `DESIGN.md`, ainda sem nenhum import.
- `docs/design/amostra.html`: conferência de paleta, contraste, tipo e componentes nos dois temas.
- `docs/design/favicon.svg`.
- Artefatos das skills: `apps/web/.impeccable/surfaces/landing.md`, `apps/web/.impeccable/surfaces/app.md`
  e `apps/web/.impeccable/questions/` (o sorteio), do impeccable; e `.taste-skill/direction.json` e
  `.taste-skill/app/direction.json` (as fichas de direção), do design-taste-frontend.
