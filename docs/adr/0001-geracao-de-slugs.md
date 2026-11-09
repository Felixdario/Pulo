# ADR 0001 — Geração de slugs e unicidade

- **Status:** aceito (fase 1, validado em modo trio)
- **Data:** 2026-11-09

## Contexto

Cada link precisa de um identificador curto (`enc.ta/Xk3P9aB`). Ele vai impresso em QR codes e
cartazes, então nunca pode ser reaproveitado para outro destino. Também não deve permitir que alguém
descubra os links de outras pessoas por enumeração, porque muitos apontam para documentos privados.
A unicidade precisa valer com várias instâncias da API criando links ao mesmo tempo, sem corrida
entre o "verificar" e o "inserir".

Requisitos:
1. Curto: no máximo 8 caracteres para links aleatórios.
2. Não enumerável: conhecer um slug não ajuda a achar outro.
3. Único sob concorrência, garantido pelo banco e não pela aplicação.
4. Sem coordenação entre processos (nenhum "worker id" para distribuir).
5. Aliases personalizados (`enc.ta/black-friday`) no mesmo espaço de nomes, sem colidir com as rotas
   do sistema.

## Opções

### A. Base62 aleatório + checagem no banco
Sorteia `k` caracteres de `[0-9A-Za-z]` com `crypto.randomBytes` e insere. O índice único decide.

Espaço `N = 62^k`:

| k | N | 1 colisão a cada ~ inserts com 10⁶ links | com 10⁹ links |
| - | - | - | - |
| 6 | 5,68 × 10¹⁰ | 56.800 | 57 |
| 7 | 3,52 × 10¹² | 3,5 milhões | 3.520 |
| 8 | 2,18 × 10¹⁴ | 218 milhões | 218.000 |

A conta: com `n` slugs já gravados, um sorteio novo colide com probabilidade `p = n / N`. Com `k = 7`
e `n = 10⁹`, `p = 2,84 × 10⁻⁴`. Precisar de duas novas tentativas seguidas tem probabilidade
`p² = 8 × 10⁻⁸`. O custo esperado de tentativas é `1 / (1 − p) ≈ 1,0003` insert por link.

Paradoxo do aniversário, ou seja, a chance de existir **alguma** colisão entre `n` sorteios:
`P ≈ 1 − e^(−n² / 2N)`.

| n sorteios | k = 6 | k = 7 | k = 8 |
| - | - | - | - |
| 10⁵ | 8,4 % | 0,14 % | 0,002 % |
| 10⁶ | ≈ 100 % (8,8 pares esperados) | 13,2 % (0,14 par esperado) | 0,23 % |
| 10⁸ | ≈ 100 % | ≈ 100 % (1.420 pares) | ≈ 100 % (22,9 pares) |

Colisões **vão** acontecer em qualquer comprimento razoável. A checagem no banco é obrigatória e não um
detalhe; o comprimento só controla quantas vezes ela dispara.

Viés de módulo: um byte tem 256 valores e `256 = 4 × 62 + 8`. Fazer `byte % 62` deixaria os 8
primeiros caracteres 25 % mais prováveis. Por isso usamos amostragem por rejeição: descartamos bytes
≥ 248 (3,1 % dos bytes).

- ✅ Não enumerável (≈ 41,7 bits de entropia com k = 7).
- ✅ Nenhuma coordenação: qualquer processo gera sem conversar com ninguém.
- ✅ Curto (7).
- ❌ Precisa de tratamento de colisão, que é exatamente o que queremos demonstrar.

### B. Contador do banco + Sqids
`nextval('links_seq')` codificado com Sqids (alfabeto embaralhado, `minLength`, lista de bloqueio
de palavrões).

- ✅ Zero colisão por construção, e o slug fica com 5 ou 6 caracteres até 10⁹ links.
- ❌ **Enumerável.** A própria documentação do Sqids diz que ele não é criptografia. Com o alfabeto
  padrão qualquer um decodifica; com alfabeto secreto, vazar um par (id, slug) entrega o resto.
  Slugs vizinhos são links vizinhos.
- ❌ Vaza volume: o slug de hoje menos o de ontem diz quantos links a plataforma criou.
- ❌ A lista de bloqueio faz o Sqids pular ids, o que é inofensivo mas exige teste próprio.

### C. Snowflake (41 bits de tempo + 10 de máquina + 12 de sequência)
- ✅ Sem colisão e ordenável por tempo, sem passar pelo banco.
- ❌ 63 bits em base62 dão **11 caracteres**, longe do requisito 1.
- ❌ Precisa distribuir worker ids e confiar no relógio: um relógio que volta gera duplicata.
- ❌ Vaza o instante de criação e é parcialmente previsível.
- Resolve um problema que não temos: um único Postgres já ordena e garante unicidade.

## Decisão

**Opção A**, com `k = 7`.

```sql
CREATE UNIQUE INDEX links_slug_key ON links (slug COLLATE "C");
```

```sql
INSERT INTO links (slug, user_id, destination, ...)
VALUES ($1, $2, $3, ...)
ON CONFLICT (slug) DO NOTHING
RETURNING id;
```

- Zero linhas no `RETURNING` significa colisão: sorteia outro slug e tenta de novo, até 5 vezes. Da 4ª
  tentativa em diante usa `k = 8`. Esgotar as 5 tentativas tem probabilidade `< 10⁻¹⁷` com `k = 7` e
  resulta em 503 com métrica `slug_exhausted_total`. Na prática, esse caminho só é coberto pelo teste
  com alfabeto reduzido.
- Não existe `SELECT` antes do `INSERT`. Quem decide é o índice único, de forma atômica, então duas
  requisições simultâneas que sortearem o mesmo slug resultam em um sucesso e uma nova tentativa.
- `ON CONFLICT DO NOTHING` não aborta a transação, ao contrário de capturar `23505`, então o lote
  (`POST /v1/links/batch`) não perde as outras linhas.
- **Slugs diferenciam maiúsculas** (`COLLATE "C"`). Sem isso o espaço cairia para `36^7`.
- **Links apagados (soft delete) continuam ocupando o slug para sempre.** Reaproveitar um slug impresso
  num QR para outro destino seria um vetor de phishing.

### Alias personalizado
- Formato `^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$`, no mesmo índice único. Um conflito vira **409**, sem nova
  tentativa: o usuário pediu aquele nome.
- **Palavras reservadas**, comparadas sem diferenciar maiúsculas: `api`, `v1`, `docs`, `metrics`,
  `health`, `healthz`, `ready`, `admin`, `login`, `logout`, `signup`, `app`, `dashboard`, `static`,
  `assets`, `favicon.ico`, `robots.txt`, `sitemap.xml`, `.well-known`, `www`, `qr`, `s`, `l` e
  variações óbvias. A lista fica em `packages/shared` e é usada pelo redirect para saber o que não é
  slug.
- Um alias com exatamente 7 caracteres alfanuméricos pode coincidir com um slug sorteado no futuro.
  Não é problema: o sorteio colide, tenta de novo e o alias continua de quem o criou.

## Consequências

- O gerador e o validador de alias ficam em `packages/shared`, sem I/O, e são testados com fast-check.
- Testes da fase 1:
  1. **Propriedade, 1.000.000 de slugs:** todos com 7 caracteres do alfabeto; nenhum reservado;
     distribuição por posição dentro de um qui-quadrado com p > 0,001 (pega viés de módulo); número de
     pares repetidos ≤ 3. O esperado é 0,14 e `P(Poisson(0,14) > 3) ≈ 2,5 × 10⁻⁵`.
  2. **Colisão forçada:** um gerador com alfabeto de 2 símbolos e `k = 3` (8 slugs possíveis), 50
     `createLink` concorrentes contra o Postgres real: exatamente 8 sucessos, 42 erros controlados e
     nenhum slug duplicado.
  3. **Corrida:** 20 requisições concorrentes com o mesmo alias resultam em 1 × 201 e 19 × 409.
- O custo de um link novo é um único `INSERT` em quase 100 % dos casos.
- **Lotes ordenados por slug:** o Validador provocou deadlock (`40P01`) em 1 de 40 lotes, com dois lotes
  simultâneos levando os mesmos 200 aliases em ordens inversas. Cada transação trava as chaves do
  índice único na ordem do `VALUES`. A solução foi ordenar cada rodada do lote por ponto de código,
  que é a mesma ordem do `COLLATE "C"`, antes do `INSERT`. Sem a ordenação o teste falha 3 de 3 vezes;
  com ela passa 3 de 3.
- Violações de CHECK ou FK abortam o lote inteiro. Só conflito de slug é tratado item a item, então a
  API valida as faixas e o destino antes.

## Números medidos (fase 1)

| Medida | Resultado |
| - | - |
| Gerar 1.000.000 de slugs | 739–857 ms (Node 22, Windows 11) |
| Pares repetidos em 1M (esperado 0,14) | 0, 0, 0, 1, 0, 1, 0, 0, 0 em 9 execuções |
| Qui-quadrado por posição (61 g.l.) | 37,98–83,50; menor p = 0,030 |
| Critério | p > 0,001/7 em cada posição (Bonferroni, ~0,1 % de falso alarme) e ≤ 3 pares |
| Mutante `byte % 62` | χ² ≈ 6.400–6.900, reprovado |
| Mutante leve (um símbolo ~12 % mais provável) | p ≈ 1e-41, reprovado |
| Mutante que repete 1 slug a cada 100 mil | 10 pares, reprovado pelo critério de pares |
| 50 `createLink` concorrentes num espaço de 8 slugs | 8 ok, 42 `SlugExhaustedError`, 8 slugs distintos |
| 20 pedidos concorrentes do mesmo alias | 1 ok, 19 `SlugTakenError` |
| Lote de 1.000 itens | 1 `INSERT` (`begin, insert, commit`) |

**Segurança do destino:** o Validador testou cerca de 100 ataques. Passaram, por exemplo, `0x7f.1`,
`127。0。0。1`, `[::ffff:a9fe:a9fe]`, `java\tscript:`, `ｅｎｃ.ta` e `enc%2eta`. Ele também encontrou
furos, todos corrigidos:
- `ip6-localhost` e hosts de um rótulo só (`http://router/`) agora viram `private_host`;
- `shortDomains` malformado agora lança `TypeError` (`normalizeShortDomains`).
- Abrimos mão de slugs ordenáveis por tempo, que não são necessários, porque a ordenação usa
  `created_at` e `id`.
