---
name: Pulo
description: Encurtador de links que conta só gente, com robôs e prévias à parte.
colors:
  rosa-grafica: '#ff3d8b'
  rosa-dado: '#e0136f'
  rosa-texto: '#c2185b'
  tinta: '#141414'
  papel: '#f4f4f1'
  folha: '#ffffff'
  elevado: '#edede9'
  borda: '#e2e2dd'
  fio: '#eeeeea'
  controle: '#8c8c85'
  suave: '#55554f'
  apagada: '#6b6b64'
  on-tinta: '#ffffff'
  positivo: '#1f7a4c'
  positivo-fundo: '#ddf5e6'
  positivo-tinta: '#0b3b22'
  negativo: '#b3261e'
  negativo-fundo: '#fde7e5'
  negativo-tinta: '#7a1610'
  aviso-fundo: '#fff4d6'
  aviso-tinta: '#8a4b00'
  grade: '#e6e6e1'
  cat-1: '#e0136f'
  cat-2: '#141414'
  cat-3: '#12805c'
  cat-4: '#c25e00'
  cat-5: '#2b5fb0'
  seq-1: '#f7dce8'
  seq-2: '#f2a9c8'
  seq-3: '#ea6fa3'
  seq-4: '#d93279'
  seq-5: '#a3104f'
  dark-rosa-grafica: '#ff4f98'
  dark-rosa-texto: '#ff7fb4'
  dark-tinta: '#f2f2ef'
  dark-papel: '#0f0f0f'
  dark-folha: '#181818'
  dark-elevado: '#232323'
  dark-borda: '#2a2a2a'
  dark-fio: '#202020'
  dark-controle: '#6e6e6e'
  dark-suave: '#b5b5ae'
  dark-apagada: '#96968f'
  dark-positivo: '#4cc38a'
  dark-negativo: '#ff7b72'
  dark-aviso: '#f0b45a'
  dark-grade: '#262626'
  dark-cat-3: '#3fa37e'
  dark-cat-4: '#e8893a'
  dark-cat-5: '#6e9be8'
  dark-seq-1: '#3a1a28'
  dark-seq-2: '#6b2445'
  dark-seq-3: '#a8306a'
  dark-seq-4: '#e0468c'
  dark-seq-5: '#ff8cbe'
typography:
  cartaz:
    fontFamily: 'Archivo Variable, Archivo, Arial Narrow, sans-serif'
    fontSize: 'clamp(3.5rem, 1rem + 8vw, 8.5rem)'
    fontWeight: 850
    lineHeight: 0.9
    letterSpacing: '-0.02em'
    fontVariation: "'wdth' 62"
  declaracao:
    fontFamily: 'Archivo Variable, Archivo, sans-serif'
    fontSize: 'clamp(1.75rem, 1.2rem + 2vw, 2.25rem)'
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: '-0.01em'
    fontVariation: "'wdth' 75"
  texto-landing:
    fontFamily: 'Archivo Variable, Archivo, sans-serif'
    fontSize: '1.0625rem'
    fontWeight: 400
    lineHeight: 1.55
    fontVariation: "'wdth' 100"
  numero:
    fontFamily: 'Archivo Variable, Archivo, sans-serif'
    fontSize: '32px'
    fontWeight: 650
    lineHeight: '36px'
    letterSpacing: '-0.01em'
    fontFeature: 'tnum'
    fontVariation: "'wdth' 75"
  titulo:
    fontFamily: 'Archivo Variable, Archivo, sans-serif'
    fontSize: '24px'
    fontWeight: 700
    lineHeight: '30px'
    letterSpacing: '-0.01em'
  secao:
    fontFamily: 'Archivo Variable, Archivo, sans-serif'
    fontSize: '16px'
    fontWeight: 600
    lineHeight: '24px'
  corpo:
    fontFamily: 'Archivo Variable, Archivo, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: '20px'
    fontFeature: 'tnum'
  rotulo:
    fontFamily: 'Archivo Variable, Archivo, sans-serif'
    fontSize: '12px'
    fontWeight: 500
    lineHeight: '16px'
    fontFeature: 'tnum'
  slug:
    fontFamily: 'JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace'
    fontSize: '14px'
    fontWeight: 500
    lineHeight: '20px'
rounded:
  papel: '0px'
  chip: '2px'
  controle: '4px'
  folha: '6px'
spacing:
  '1': '4px'
  '2': '8px'
  '3': '12px'
  '4': '16px'
  '6': '24px'
  '8': '32px'
  '12': '48px'
  '16': '64px'
  '24': '96px'
  '40': '160px'
components:
  botao-primario:
    backgroundColor: '{colors.tinta}'
    textColor: '{colors.on-tinta}'
    rounded: '{rounded.controle}'
    height: '36px'
    padding: '0 16px'
  botao-cartaz:
    backgroundColor: '{colors.tinta}'
    textColor: '{colors.on-tinta}'
    rounded: '{rounded.papel}'
    height: '56px'
    padding: '0 28px'
  botao-secundario:
    backgroundColor: '{colors.elevado}'
    textColor: '{colors.tinta}'
    rounded: '{rounded.controle}'
    height: '36px'
    padding: '0 14px'
  tira-url:
    backgroundColor: '{colors.folha}'
    textColor: '{colors.tinta}'
    rounded: '{rounded.papel}'
    height: '72px'
    padding: '0 8px 0 20px'
  campo:
    backgroundColor: '{colors.folha}'
    textColor: '{colors.tinta}'
    rounded: '{rounded.controle}'
    height: '36px'
    padding: '0 12px'
  folha:
    backgroundColor: '{colors.folha}'
    rounded: '{rounded.folha}'
    padding: '20px'
  chip-regra:
    backgroundColor: '{colors.elevado}'
    textColor: '{colors.tinta}'
    rounded: '{rounded.chip}'
    height: '22px'
    padding: '0 8px'
  chip-regra-vencida:
    backgroundColor: '{colors.negativo-fundo}'
    textColor: '{colors.negativo-tinta}'
    rounded: '{rounded.chip}'
    height: '22px'
  chip-regra-perto:
    backgroundColor: '{colors.aviso-fundo}'
    textColor: '{colors.aviso-tinta}'
    rounded: '{rounded.chip}'
    height: '22px'
  linha-tabela:
    backgroundColor: '{colors.folha}'
    textColor: '{colors.tinta}'
    height: '56px'
  contador-ao-vivo:
    textColor: '{colors.tinta}'
    typography: '{typography.numero}'
---

# Design System: Pulo

> **Versão 1, documentada a partir do código da fase 7** (`impeccable document`, modo scan, em merge
> com a versão 0 da fase 6). Os tokens normativos estão em `apps/web/src/styles/tokens.css` e no
> frontmatter acima; a base, o app e a landing estão em `apps/web/src/styles/{base,app,landing}.css`.
> O sidecar `apps/web/.impeccable/design.json` traz movimento, sombras, pontos de quebra e os
> componentes de referência. A direção, os nomes e as referências estão em `docs/design/direcao.md`.
> Se este arquivo e o código divergirem, vale o código, e este arquivo precisa ser atualizado.

## Overview

**Estrela-guia: "O cartaz e o livro-caixa."**

O Pulo tem duas caras, e as duas vêm do mesmo mundo: o **lambe-lambe de gráfica popular**, aquele
cartaz de papel fino e colorido, impresso em tipo de madeira condensado e colado em série nos tapumes
da cidade. É o meio em que o comércio brasileiro sempre anunciou show, promoção e inauguração, que é o
que o nosso público faz com um link.

- **A landing é o cartaz.** Um campo rosa-choque de ponta a ponta, uma frase curta em caixa-alta
  condensada e a tira de papel branco colada por cima com o campo de URL. Quando o link curto nasce, ele
  é uma tira nova colada no lugar.
- **O app é o livro-caixa da gráfica.** Papel-jornal, tinta preta, colunas de números alinhadas, sem
  cor no cromo. O rosa da gráfica volta só onde o dado importa: os cliques humanos e o ponto do ao vivo.

A distinção mora em três lugares:

1. a **régua honesta**, que mostra humanos, bots e prévias numa barra só, com só a parte humana em
   rosa;
2. o **link curto como objeto**, sempre o maior texto da sua linha e a um clique de ser copiado;
3. os **números no lugar**, com algarismos tabulares, separador brasileiro e ressalva junto.

**Características:**

- Claro por padrão. O escuro acompanha o sistema e é um tema completo, com os mesmos papéis.
- Uma família tipográfica (Archivo) em três larguras, mais uma mono só para slugs, chaves e código.
- Cantos retos no cartaz e quase retos no app (2, 4 e 6 px). Nada de pílula.
- Superfícies chapadas: borda de 1 px no app e nenhuma sombra em repouso.
- Rosa só em dado, no foco do cartaz e no ao vivo. Status sempre com texto e forma.

## Colors

Estratégia: **Committed** na landing (o rosa cobre de 40 a 60 % da página, em campos inteiros) e
**Restrained** no app (o cromo em tinta e papel, rosa abaixo de 1 % dos pixels, sempre em dado).

### Rosa da gráfica

- **Rosa-gráfica** (`rosa-grafica`, `#ff3d8b`): o papel do cartaz. Campo do hero, campo do rodapé da
  landing e fundo do favicon. Sobre ele, **tudo em tinta**: o cinza suave cai para 2,25:1 e é proibido.
- **Rosa-dado** (`rosa-dado`, `#e0136f`): a série dos cliques humanos, a parte humana da régua
  honesta, o ponto do ao vivo e a categoria 1 dos gráficos. Dá 4,67:1 no branco, então serve também para
  marcas finas.
- **Rosa-texto** (`rosa-texto`, `#c2185b`): links de texto e o delta "+12 no último minuto" do ao
  vivo. Dá 5,87:1 no branco e 5,33:1 no papel.

### Neutros

- **Tinta** (`tinta`): todo texto principal, o botão primário e o foco.
- **Papel** (`papel`): o chão do app e as seções claras da landing. Fica um nível abaixo do branco,
  com croma baixo, sem virar creme.
- **Folha** (`folha`): cartões, tabelas, a tira de URL e diálogos.
- **Elevado** (`elevado`): hover de linha, item ativo da navegação, chip de regra e skeleton.
- **Borda**, **fio** e **controle**: borda de folha, divisória de linha e borda de campo. A borda de
  campo passa de 3:1, como pede o critério de contraste de componentes.
- **Suave** e **apagada**: texto secundário e placeholder ou meta. Nada mais claro que `apagada`
  carrega palavras.

### Status

`positivo`, `negativo` e `aviso` aparecem só em pares de pílula (fundo claro e tinta da mesma cor) e
em números de variação. Vermelho é sinal, não textura: uma marca vermelha por objeto, no máximo.

### Contraste conferido (WCAG 2.2 AA)

Calculado com a fórmula de luminância relativa da WCAG. Texto normal pede 4,5:1; texto grande, marcas
de gráfico e bordas de controle pedem 3:1.

**Claro**

| Par                                                     | Uso                    | Contraste | Exige |
| ------------------------------------------------------- | ---------------------- | --------: | ----: |
| `tinta` `#141414` / `folha` `#ffffff`                   | texto principal        |     18,42 |   4,5 |
| `tinta` / `papel` `#f4f4f1`                             | texto no chão          |     16,72 |   4,5 |
| `tinta` / `rosa-grafica` `#ff3d8b`                      | texto no cartaz        |      5,52 |   4,5 |
| `tinta` / `elevado` `#edede9`                           | texto do chip          |     15,70 |   4,5 |
| `suave` `#55554f` / `folha`                             | secundário             |      7,50 |   4,5 |
| `suave` / `papel`                                       | secundário no chão     |      6,81 |   4,5 |
| `apagada` `#6b6b64` / `folha`                           | meta, placeholder      |      5,37 |   4,5 |
| `apagada` / `papel`                                     | meta no chão           |      4,87 |   4,5 |
| `apagada` / `elevado`                                   | meta em hover          |      4,57 |   4,5 |
| `rosa-texto` `#c2185b` / `folha`                        | link de texto          |      5,87 |   4,5 |
| `rosa-texto` / `papel`                                  | link no chão           |      5,33 |   4,5 |
| `rosa-dado` `#e0136f` / `folha`                         | série, ponto ao vivo   |      4,67 |     3 |
| `controle` `#8c8c85` / `folha`                          | borda de campo         |      3,38 |     3 |
| `controle` / `papel`                                    | borda de campo no chão |      3,07 |     3 |
| `positivo` `#1f7a4c` / `folha`                          | número que melhorou    |      5,32 |   4,5 |
| `positivo-tinta` `#0b3b22` / `positivo-fundo` `#ddf5e6` | pílula                 |     10,99 |   4,5 |
| `negativo` `#b3261e` / `folha`                          | número que piorou      |      6,54 |   4,5 |
| `negativo-tinta` `#7a1610` / `negativo-fundo` `#fde7e5` | pílula, chip vencido   |      9,10 |   4,5 |
| `aviso-tinta` `#8a4b00` / `aviso-fundo` `#fff4d6`       | chip perto do limite   |      6,21 |   4,5 |
| `cat-3` `#12805c` / `folha`                             | categoria 3            |      4,92 |     3 |
| `cat-4` `#c25e00` / `folha`                             | categoria 4            |      4,29 |     3 |
| `cat-5` `#2b5fb0` / `folha`                             | categoria 5            |      6,24 |     3 |
| `rosa-grafica` / `folha`                                | só campo, nunca texto  |      3,34 |     — |
| `suave` / `rosa-grafica`                                | **proibido**           |      2,25 |   4,5 |

**Escuro**

| Par                                             | Uso                           | Contraste | Exige |
| ----------------------------------------------- | ----------------------------- | --------: | ----: |
| `dark-tinta` `#f2f2ef` / `dark-papel` `#0f0f0f` | texto no chão                 |     17,09 |   4,5 |
| `dark-tinta` / `dark-folha` `#181818`           | texto principal               |     15,83 |   4,5 |
| `dark-tinta` / `dark-elevado` `#232323`         | texto do chip                 |     14,01 |   4,5 |
| `dark-suave` `#b5b5ae` / `dark-folha`           | secundário                    |      8,61 |   4,5 |
| `dark-apagada` `#96968f` / `dark-folha`         | meta, placeholder             |      5,97 |   4,5 |
| `dark-apagada` / `dark-elevado`                 | meta em hover                 |      5,28 |   4,5 |
| `dark-rosa-grafica` `#ff4f98` / `dark-folha`    | série, ponto ao vivo          |      5,77 |     3 |
| `tinta` `#141414` / `dark-rosa-grafica`         | texto no cartaz escuro        |      5,99 |   4,5 |
| `dark-rosa-texto` `#ff7fb4` / `dark-folha`      | link de texto                 |      7,56 |   4,5 |
| `dark-controle` `#6e6e6e` / `dark-folha`        | borda de campo                |      3,48 |     3 |
| `dark-positivo` `#4cc38a` / `dark-folha`        | número que melhorou           |      8,02 |   4,5 |
| `dark-negativo` `#ff7b72` / `dark-folha`        | número que piorou             |      7,04 |   4,5 |
| `dark-aviso` `#f0b45a` / `dark-folha`           | aviso                         |      9,62 |   4,5 |
| `dark-positivo` / `#16291f`                     | pílula positiva               |      6,91 |   4,5 |
| `dark-negativo` / `#2e1a19`                     | pílula negativa, chip vencido |      6,52 |   4,5 |
| `dark-aviso` / `#2b2213`                        | chip perto do limite          |      8,49 |   4,5 |
| `dark-cat-3` `#3fa37e` / `dark-folha`           | categoria 3                   |      5,71 |     3 |
| `dark-cat-4` `#e8893a` / `dark-folha`           | categoria 4                   |      6,82 |     3 |
| `dark-cat-5` `#6e9be8` / `dark-folha`           | categoria 5                   |      6,36 |     3 |

No escuro, o cartaz continua rosa (`dark-rosa-grafica`) com tinta escura por cima, e o botão primário
inverte (fundo `dark-tinta`, rótulo `tinta`).

## Typography

**Archivo** (Omnibus-Type, SIL OFL, variável em largura 62–125 e peso 100–900) para tudo, e
**JetBrains Mono** (SIL OFL) só para slugs, chaves de API e código.

Por que Archivo:

- **É a madeira do lambe-lambe sem fantasia.** Na largura 62 e no peso 850, ela tem o corte condensado
  e pesado do tipo de madeira das gráficas populares, mas é uma grotesca de trabalho, não uma fonte de
  display de uma nota só. A mesma família, na largura 100, compõe tabela e formulário.
- **O eixo de largura é o produto.** Encurtar é condensar. O link longo pode entrar largo e o curto
  sair condensado na mesma fonte, com `font-variation-settings`, sem trocar de família (ver motion).
- **Uma família só** mantém o app quieto: a personalidade vem da largura, não de um segundo rosto.
- **Não é a fonte do Pontual** (Hanken Grotesk) nem uma das fontes-padrão de interface gerada (Inter,
  Geist, DM Sans, Space Grotesk).

Por que JetBrains Mono, e só para slugs, chaves e código: o slug é base62 aleatório e inclui `l`, `I`,
`1`, `O` e `0` (ADR 0001). Numa grotesca esses caracteres se confundem; na JetBrains o zero tem ponto,
o `l` tem cauda e o `I` tem serifas. É função, não fantasia "técnica".

**Algarismos tabulares:** `font-variant-numeric: tabular-nums` em toda tabela, faixa de números, eixo e
contador. **Medido na fase 7:** com a Archivo Variable carregada, `tabular-nums` iguala a largura dos
dígitos (a 40 px, "1111" e "0000" medem 90,9 px; sem tnum, 83,4 e 91,7 px). Os números ficam na
Archivo; a JetBrains Mono continua só para slug, chave e código.

**Carregamento:** auto-hospedadas pelo `@fontsource-variable/archivo/wdth.css` (eixos de largura 62–125
e peso 100–900 num arquivo só, por faixa Unicode) e pelo `@fontsource-variable/jetbrains-mono`, com
`font-display: swap`. Nenhum pedido ao Google Fonts. As famílias se chamam `Archivo Variable` e
`JetBrains Mono Variable`. As páginas pequenas do redirect não baixam fonte: usam a Archivo se estiver
instalada e a condensada do sistema no título.

### Escala da landing (Persuade, cinco tamanhos)

| Papel           | Tamanho                                 | Largura / peso       | Entrelinha | Uso                                       |
| --------------- | --------------------------------------- | -------------------- | ---------- | ----------------------------------------- |
| `cartaz`        | `clamp(3.5rem, 1rem + 8vw, 8.5rem)`     | 62 / 850, caixa-alta | 0,9        | a frase do hero e o fechamento            |
| `declaracao`    | `clamp(1.75rem, 1.2rem + 2vw, 2.25rem)` | 75 / 700             | 1,1        | títulos de seção e perguntas do FAQ       |
| lead            | `1.25rem`                               | 100 / 400            | 1,45       | frase de apoio                            |
| `texto-landing` | `1.0625rem`                             | 100 / 400            | 1,55       | texto corrido, 45–70 caracteres por linha |
| pequeno         | `0.875rem`                              | 100 / 500            | 1,4        | crédito, rodapé                           |

O `cartaz` passa do teto de 6rem do craft floor do impeccable de propósito: a frase de cartaz é o mundo
escolhido, e o craft floor deixa a direção vencer onde a regra não é proibição. O teto real é a
regra de duas linhas em qualquer largura.

### Escala do app (Operate, 12/14/16/24 e um número)

| Papel    | px    | Largura / peso | Uso                                                              |
| -------- | ----- | -------------- | ---------------------------------------------------------------- |
| `numero` | 32/36 | 75 / 650       | o maior número da tela (humanos no período) e o contador ao vivo |
| `titulo` | 24/30 | 100 / 700      | título da tela                                                   |
| figura   | 24/30 | 75 / 600       | os outros números da faixa                                       |
| `secao`  | 16/24 | 100 / 600      | título de folha                                                  |
| `corpo`  | 14/20 | 100 / 400      | célula, navegação, formulário                                    |
| `rotulo` | 12/16 | 100 / 500      | rótulos, eixos, chips; nada abaixo de 12 px                      |
| `slug`   | 14/20 | mono / 500     | slug e chave; 24 px no título da página do link                  |

O app nunca usa o `cartaz` e nenhum número passa de 40 px. Pesos: 400, 600 e 700; o 700 tem um trabalho
por tela (o título).

## Layout

- **Base de 4 px.** Passos: 4, 8, 12, 16, 24, 32, 48, 64, 96, 160.
- **Landing:** 12 colunas, calha de 24 px, margens externas iguais de `clamp(16px, 3vw, 40px)`. Seções a
  160 px umas das outras no desktop e 96 px no celular. A frase do cartaz vai de margem a margem; o
  texto corrido nunca passa de 70 caracteres.
- **App, casca "Open plane":** barra lateral de 232 px no próprio chão de papel, sem barra superior e
  sem fio entre barra e tela. Tela fluida com calha de 32 px, conteúdo até 1280 px, 12 colunas, folhas
  16 px uma da outra. A barra lateral tem a marca e o nome no topo, o seletor de conta, a navegação em
  passo de 34 px (Links e Chaves de API; a "Visão geral" fica para uma fase seguinte) e, no pé, o tema
  (sistema → claro → escuro) e o usuário com Sair.
- **Pontos de quebra:** até 640 px (celular), de 641 a 1100 px (tablet, com a barra lateral dobrada) e
  acima disso o desktop.
- **Celular:** a barra lateral vira uma barra de 56 px (alvos de 44 px) com o nome da tela, um menu em folha inteira e
  uma ação (Novo link). Tabelas viram listas de duas linhas abaixo de 640 px. Alvos de toque de 44 px.
- **Densidade:** média. Linhas de 56 px na lista de links (slug e título em duas linhas) e de 44 px nas
  tabelas de dimensão; 20 px de padding de folha.

## Elevation & Depth

Chapado. A profundidade vem de um degrau de tom (papel → folha → elevado) e da borda de 1 px.

- **Nada tem sombra em repouso**, nem na landing.
- **Sombra só no que flutua:** menu, popover, tooltip, diálogo e toast, com
  `0 8px 24px rgb(20 20 20 / 0.12)` e borda de 1 px. No escuro, `0 8px 24px rgb(0 0 0 / 0.5)` mais a
  borda `dark-borda`.
- **A tira colada** da landing não tem sombra: quem a separa do cartaz é o branco contra o rosa e a
  inclinação de 1 a 2 graus.
- Sem vidro, sem desfoque, sem brilho, sem gradiente e sem sombra dura deslocada.

## Shapes

- **Papel (0 px):** campos da landing, a tira de URL, o botão do cartaz, o favicon e o QR.
- **Chip (2 px):** chips de regra e pílulas de status. Sempre retangulares, nunca pílula redonda.
- **Controle (4 px):** botões, campos e o seletor de período do app.
- **Folha (6 px):** cartões, tabelas e diálogos do app.
- **Inclinação:** só as tiras coladas da landing, entre -2 e 2 graus. Ao receber foco ou o cursor, a
  tira endireita (0 grau). Nada mais no sistema gira.
- **Hachura:** os bots e as prévias são desenhados com hachura diagonal de 1 px sobre `elevado`, no
  passo de 4 px, em `apagada`. Desconhecido no mapa é `elevado` liso.

## Components

### Input de URL

- **Na landing (`tira-url`):** tira de folha branca de 72 px de altura e até 640 px de largura,
  inclinada -1,5°, com o rótulo visível "Link para encurtar" em 12 px acima do texto, o campo a 20 px e o
  botão `botao-cartaz` "Encurtar" encostado na ponta direita. Placeholder com um exemplo real de quem
  usa: `https://sualoja.com.br/black-friday?utm_source=instagram`.
- **No app (`campo`):** campo de 36 px com o mesmo rótulo, ao lado de "Alias (opcional)", no topo da
  lista de links e no diálogo de criação.
- **Comportamento:** aceita colar sem `https://` e completa. Valida ao sair do campo ou ao enviar,
  nunca a cada tecla. O erro fica embaixo, ligado por `aria-describedby`, em frase: "Isso não parece um
  endereço da web. Ele precisa ter um domínio, como loja.com.br."
- **Prévia do destino** (rota `preview`), logo abaixo, depois de 400 ms sem digitar: favicon, título,
  domínio final e "passou por 2 redirecionamentos" quando houver. Carregando, é uma linha de skeleton da
  mesma altura. Se a prévia falhar, aparece "Não deu para ver a página agora; o link funciona mesmo
  assim.", sem bloquear o envio.
- **Estados:** vazio, digitando, inválido, enviando ("Encurtando…" com o botão desabilitado e a mesma
  largura), limite de 10 por minuto ("Você encurtou 10 links no último minuto. Tente de novo em 40 s.").

### Cartão de link

O resultado na landing e a linha da lista no celular.

- O **link curto** em `slug` a 20 px (landing) ou 16 px (lista), com o domínio em `suave` e o slug em
  `tinta`: `pulo.to/` + `aB3xK9q`.
- **Copiar** como botão primário de verdade. Ao copiar, o rótulo vira "Copiado" por 2 s, e o leitor de
  tela ouve "Link copiado".
- **QR** quadrado, de cantos retos, em tinta sobre branco, com uma margem de 4 módulos. Baixa em SVG ou
  PNG.
- Embaixo, o destino (favicon e domínio) e o título, em `suave`.
- No link anônimo, uma linha honesta: "Vale até 9 de dezembro. Para escolher o nome, a validade e as
  regras, crie uma conta."

### Linha da tabela (lista de links)

| Coluna          | Conteúdo                                                                            |
| --------------- | ----------------------------------------------------------------------------------- |
| Link            | slug em `slug` 14 px e o título em 12 px `suave` na segunda linha                   |
| Destino         | favicon de 16 px e domínio, cortado no meio quando longo (`loja.com.br/…/natal`)    |
| Regras          | até três chips; o resto em "+2" com a lista no tooltip                              |
| Humanos (total) | à direita, tabular, em tinta; zero aparece como 0 (a listagem traz o total do link) |
| Criado          | data curta, `12 nov.`                                                               |
| Ações           | Copiar sempre visível; menu (editar, QR, desativar, apagar)                         |

Altura de 56 px, fio de 1 px entre linhas, sem zebra e sem faixa no cabeçalho. Cabeçalhos em 12 px
`suave`, em caixa normal, numéricos à direita. Hover em `elevado`, a linha inteira leva à página do
link e o Copiar não propaga o clique. Desativado: a linha inteira em `suave` e o chip "Desativado".

### Chip de regra

Cada regra vira uma frase curta, na ordem em que o redirect a avalia (ADR 0002):

| Regra       | Chip                                               |
| ----------- | -------------------------------------------------- |
| expiração   | "Expira 12/12 23:59"                               |
| senha       | "Com senha"                                        |
| limite      | "Para em 500" ou, perto do fim, "Faltam 12 de 500" |
| país        | "BR, PT → /pt"                                     |
| dispositivo | "iPhone → App Store"                               |
| tipo        | "301" (só quando não for o padrão 302)             |
| repasse     | "Repassa ?utm"                                     |

O chip tem 22 px, raio de 2 px, fundo `elevado`, ícone de 12 px e o texto em tinta. Quando o limite
passa de 90 % do uso, vira o par de aviso; quando a regra venceu ("Expirou 31/10", "Limite atingido"),
vira o par negativo. O chip nunca é a única pista: o mesmo estado aparece em texto na página do link.

### Contador ao vivo

- Fica no título da página do link, à direita: o rótulo "Ao vivo", um ponto de 8 px em `rosa-dado` e o
  número de cliques humanos de hoje em `numero`, com o delta "+3 no último minuto" em 12 px
  `rosa-texto`.
- **Conexão:** usa SSE. Conectado, o ponto fica cheio; reconectando, o ponto fica vazado e aparece
  "reconectando…"; offline, o ponto some e fica "Ao vivo pausado · atualizado às 14:32", com
  Retomar.
- **Honestidade:** a dica do ponto diz "Atualiza até 1 s depois do clique. Só cliques humanos." O
  número do ao vivo e o da faixa de números são a mesma variável.
- **Acessibilidade:** a região `aria-live="polite"` anuncia no máximo a cada 30 s, já agregado ("5 novos
  cliques, 1.284 hoje"), e o usuário pode silenciar.

### Régua honesta (o elemento que só o Pulo tem)

Uma barra horizontal de 12 px, 100 % do período, em três partes separadas por uma costura de 2 px:
humanos em `rosa-dado`, bots em hachura e prévias em pontilhado. Os rótulos ficam embaixo, com o valor
e a porcentagem: "Humanos 12.480 (91 %) · Bots 802 · Prévias 431 (WhatsApp 390, Slack 41)". Ao lado,
uma frase: "Só humanos entram no total e no limite de cliques."

### Como foi construído (fase 7)

| Peça                                                   | Onde                                                                     | Biblioteca                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Diálogos, confirmação, menus, dicas, seletor de países | `components/ui.tsx`, `Qr.tsx`, `EditLinkDialog.tsx`, `CountryPicker.tsx` | Base UI (`@base-ui/react`)                                                             |
| Avisos curtos ("Regras salvas.", "Chave revogada")     | `routes/Root.tsx`                                                        | Sonner, com as cores de folha                                                          |
| Série temporal                                         | `components/Charts.tsx`                                                  | Recharts, sem animação de entrada e sem camada de foco própria                         |
| Mapa coroplético                                       | `components/Charts.tsx`                                                  | `world-atlas` 110 m, `topojson-client` e `d3-geo` (Equal Earth), carregado sob demanda |
| QR (tela, PNG e SVG)                                   | `components/Qr.tsx`                                                      | `qrcode`, margem de 4 módulos, tinta sobre branco                                      |

- **Botões:** primário em tinta (36 px, raio 4), secundário em `elevado`, fantasma transparente, perigo
  em `negativo` com rótulo `on-tinta`. Pressionar dá `scale(0.97)` em 160 ms; hover só com ponteiro
  fino. O Copiar troca o rótulo por "Copiado" sem mudar de largura (os dois rótulos ocupam a mesma
  célula do grid).
- **Campos:** 36 px (44 px e 16 px de fonte em tela de toque, sem zoom do iOS), borda `controle`, foco
  com anel de 2 px em tinta. O erro fica embaixo, em `negativo`, ligado por `aria-describedby`.
- **Filtros da lista:** busca com 300 ms de debounce, status em segmentos (Todos · Ativos · Desativados
  · Expirados), senha, intervalo de criação e ordenação; tudo vai para a URL. Paginação por cursor com
  "Carregar mais" e carga automática perto do fim.
- **Página do link:** contador ao vivo à direita do título; chips de regra; seletor de período (24 h,
  7 d, 30 d, 90 d, 12 m e personalizado) como grupo de rádio com setas; faixa de quatro números; régua
  honesta; série em dois terços (humanos em rosa, únicos do dia tracejados em tinta, só na série
  diária) com "Ver tabela"; países com mapa e lista; folhas de cidades, referrers, navegadores,
  sistemas e aparelhos. A série escolhe a granularidade (até 2 dias por hora, até ~13 meses por dia,
  depois por mês); totais e listas contam dias UTC inteiros, e a tela diz isso.
- **Editar regras:** diálogo largo que começa pelas frases ("Como o link decide, em ordem") e só depois
  mostra os campos; aviso em `aviso-fundo` ao escolher 301/308; o 412 vira "Alguém editou este link em
  outra aba." com Recarregar.
- **Chaves de API:** configuração em duas colunas; a chave nova aparece uma vez, em mono, com Copiar e
  "Guarde agora: depois ela não aparece mais."; revogar pede confirmação com o nome.
- **Sessão expirada:** diálogo de alerta que não fecha sozinho, com "Entrar de novo" voltando para a
  mesma tela depois do login; se o logout veio de outra aba, ele diz isso.

## Data Patterns

### Números

- `Intl.NumberFormat('pt-BR')`: `12.480`, `6,4 ms`, `91 %`. O compacto (`12,4 mil`) só nos eixos.
- Deltas com sinal e com a base escrita: "+214 em relação aos 30 dias anteriores". Zero ou sem base é
  cinza; de zero para algo é "+4 (novo)".
- A cor de um delta diz se é bom ou ruim, não se subiu ou desceu. Cliques humanos subindo é positivo;
  bots subindo é neutro.
- **Únicos:** o rótulo é sempre "Únicos por dia (soma)", com a dica "O mesmo visitante em dois dias
  diferentes conta duas vezes. Não guardamos IP." Nunca "visitantes únicos".
- **Desconhecido** é uma categoria com nome: país, cidade, navegador ou referrer ausentes aparecem
  como "Desconhecido" ou "Direto (sem referrer)", e entram na soma.
- Ausente ou não se aplica é um travessão cinza `—` no tamanho do texto.

### Gráficos

- **Série temporal:** uma linha de 2 px em segmentos retos, sem suavização e sem marcadores, em
  `rosa-dado`, para os humanos. O período anterior, quando ligado, fica em `apagada` com 1 px. Área só
  com tinta chapada de 12 %. Eixo y com 4 ou 5 marcas redondas, zero na base e grade horizontal em
  `grade`. Rótulos do eixo x retos, de 4 a 8, com passo regular (hora, dia ou mês conforme o período).
- **Barras** de canto reto, para contagens por período e para o top de dimensões, em lista ordenada
  com o valor no fim da barra.
- **Paleta categórica** (navegadores, sistemas, dispositivos, comparação entre links), no máximo cinco
  partes e o resto em "Outros" cinza: `cat-1` rosa, `cat-2` tinta, `cat-3` verde, `cat-4` âmbar, `cat-5`
  azul (no escuro, `dark-rosa-grafica`, `dark-tinta`, `dark-cat-3` a `dark-cat-5`). A ordem foi escolhida
  para o rosa e a tinta, que dominam, se separarem também para daltonismo, e cada fatia tem rótulo
  direto.
- **Paleta sequencial do mapa:** cinco classes de `seq-1` a `seq-5` (rosa claro a rosa fundo; no
  escuro, `dark-seq-1` a `dark-seq-5`, do escuro ao claro), em escala logarítmica, porque um país
  concentra a maior parte dos cliques. Sem cliques fica em `elevado`, e as fronteiras são de 0,5 px em
  `folha`. A legenda mostra os intervalos reais ("1–9", "10–99"…). Ao lado vai sempre a lista dos 10
  países com bandeira em texto (código ISO), número e porcentagem. O mapa é ilustração; a lista é o
  dado.
- **Crédito (licença CC BY 4.0):** "IP Geolocation by DB-IP", com link para https://db-ip.com, e
  "(DB-IP Lite, CC BY 4.0)" em 12 px: sob o mapa, no rodapé de toda tela do app e no rodapé da landing.

### Estados

| Estado                   | Como aparece                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vazio (primeira vez)** | A lista mantém título e colunas; no lugar das linhas, o campo de URL com o foco e uma frase.                                                                    |
| **Vazio (filtro)**       | "Nenhum link com 'natal' nos títulos ou destinos." e o botão Limpar busca.                                                                                      |
| **Período sem cliques**  | A linha do zero desenhada e "Nenhum clique humano entre 1 e 7 de nov." Bots e prévias, se houver, aparecem mesmo assim.                                         |
| **Carregando**           | O layout final, com cada valor trocado por uma barra cinza chapada do tamanho real (24 px de valor dá 24 px de barra). Sem brilho animado e sem pulo de layout. |
| **Atualizando**          | Os valores antigos ficam, e o carimbo "atualizado às 14:32" muda.                                                                                               |
| **Erro**                 | Dentro do bloco que falhou, nunca em banner: "Não deu para carregar os referrers. Últimos dados das 14:32." e Tentar de novo.                                   |
| **Sem base geo**         | "Sem dados de país neste ambiente." O mapa vira cinza, e a lista mostra "Desconhecido".                                                                         |

## Motion

Implementado na fase 7 com `emil-design-eng` e `animate`. Os valores usados (tokens em `tokens.css`):
`--ease-saida` `cubic-bezier(0.2, 0.8, 0.2, 1)`, `--dur-retorno` 160 ms e `--dur-assinatura` 420 ms.

| Movimento                | Ferramenta                                         | Valores                                                                                       |
| ------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Tira com a URL longa sai | transição CSS (troca de classe)                    | `translateY(8px)` e opacidade, 180 ms, `--ease-saida`                                         |
| Tira nova é colada       | animação CSS (rara: uma vez por envio)             | de `rotate(-3deg) scale(1.02)` e opacidade 0 para `rotate(-1.5deg)`, 420 ms                   |
| Link condensa            | animação CSS de `font-variation-settings`          | `wdth` 100 → 62, 420 ms                                                                       |
| Papel endireita          | transição CSS                                      | `rotate(0)` no foco (sempre) e no hover (só ponteiro fino), 160 ms, `ease`                    |
| Pressionar               | transição CSS                                      | `scale(0.97)`, 160 ms                                                                         |
| Menus e dicas            | transição CSS com `data-starting-style` do Base UI | `scale(0.96)` e opacidade a partir do gatilho (`--transform-origin`), 160 ms; saída em 100 ms |
| Diálogos                 | idem                                               | centrados, `scale(0.97)` e opacidade, 200 ms (no celular sobem 24 px, como folha)             |
| Delta do ao vivo         | animação CSS que renasce a cada clique (`key`)     | fundo rosa a 22 % → transparente, 600 ms; o número troca sem animar                           |
| Barras das dimensões     | transição CSS                                      | `scaleX`, 200 ms, quando o período muda                                                       |

Princípios:

1. **Um momento assinatura e mais nada que se apresente.** Na landing, o link curto nascendo: a tira
   com a URL longa é substituída por uma tira nova, colada por cima, e o texto do link passa da largura
   100 para a 62 enquanto encolhe. No app nada tem animação de entrada.
2. **Movimento é retorno:** pressionar, hover, foco, abrir menu, chegar uma linha nova. Entre 120 e
   200 ms, saída rápida (`cubic-bezier(0.2, 0.8, 0.2, 1)` como ponto de partida).
3. **Número troca, não rola.** O contador ao vivo troca os dígitos de uma vez, como um placar, e o
   delta acende em rosa por 600 ms. Contar de 0 até o valor inventa números que não existiram.
4. **O papel endireita.** A única coisa inclinada do sistema, a tira colada, vai a 0 grau no hover e no
   foco. Esse é o único "gesto físico" do sistema.
5. **Gráficos não desenham na entrada.** A série aparece pronta; quando o período muda, os valores
   trocam em até 200 ms.
6. **`prefers-reduced-motion`:** some todo deslocamento e toda variação de largura. O link curto
   aparece de uma vez, a tira já nasce reta e o delta do ao vivo fica sublinhado em vez de piscar.
7. Só transform, opacity e `font-variation-settings`, e nada que bloqueie leitura ou clique.

## Accessibility

- **WCAG 2.2 AA**, com os contrastes da tabela acima. Texto que carrega palavras passa de 4,5:1 em todas
  as superfícies, placeholder incluído.
- **Foco visível:** anel de 2 px em `tinta` (no escuro, `dark-tinta`) com 2 px de recuo, também sobre o
  rosa (5,52:1). Nunca `outline: none` sem substituto.
- **Alvos:** 24 × 24 px no mínimo no desktop e 44 px no celular.
- **Gráficos:** cada gráfico tem um resumo em texto ("12.480 cliques humanos de 1 a 30 de nov., pico de
  1.102 em 24 de nov.") e uma tabela equivalente a um clique. O mapa tem a lista de países ao lado.
- **Cor nunca sozinha:** bots em hachura, prévias em pontilhado, estados de regra com texto, deltas com
  sinal.
- **Teclado:** a tabela é navegável por linha, o seletor de período funciona com setas, e todo menu fecha
  com Esc e devolve o foco.
- **Leitor de tela:** `lang="pt-BR"`; o slug é lido caractere por caractere numa etiqueta própria
  (`aria-label="pulo ponto to barra a B 3 x K 9 q"`) quando o usuário foca o link curto; o contador ao
  vivo fala de modo agregado e pode ser silenciado.
- **Movimento:** respeita `prefers-reduced-motion` (ver Motion).
- **Zoom:** 200 % sem rolagem horizontal da página; a tabela rola dentro do próprio quadro.

## Do's and Don'ts

**Faça**

- Ponha o link curto como o maior texto da linha e o Copiar a um clique.
- Escreva cada regra como frase antes de mostrar o campo.
- Mostre bots e prévias à parte, sempre, e diga que os únicos são por dia.
- Use o rosa em campos inteiros na landing e só em dado no app.
- Mantenha tudo em tinta sobre o rosa.

**Não faça**

- Gradiente, vidro, brilho, sombra em repouso ou sombra dura deslocada.
- Pílula redonda, card de KPI com ícone em círculo, sparkline em KPI, gráfico arco-íris.
- Rótulo pequeno em caixa-alta espaçada acima de título, ou numeração 01/02/03.
- Mono como fantasia técnica: ela é só para slug, chave e código.
- Inventar prova: clientes, depoimentos, "milhares de links encurtados" ou preço.
- Herdar qualquer coisa do Pontual: Hanken Grotesk, cobalto, pílulas, raio de 16 px.
