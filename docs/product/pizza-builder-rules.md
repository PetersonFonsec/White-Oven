# Regras do Pizza Builder

Status: especificação M0.3. Contratos em `packages/contracts` (M2.1) e pipeline de validação, normalização e preço em `packages/pizza-pricing` (M2.2). Define a montagem, a validação, o preço e a representação visual de pizzas no MVP. É a referência do pacote `packages/pizza-pricing` previsto no [roadmap](../architecture/mvp-roadmap.md), usado por API, aplicativo e painel. A API é sempre a autoridade do preço.

A demonstração atual (`apps/landing/src/lib/pizza.ts`) cobre pizza inteira e meio a meio com a regra do maior preço, sem tamanhos, bordas ou adicionais. Ela continua sendo demonstração e não precisa ser migrada para o pacote.

## Termos

| Termo     | Definição                                                                              |
| --------- | -------------------------------------------------------------------------------------- |
| Tamanho   | `PizzaSize`: nome, fatias e `maxFlavors` (1 ou 2).                                     |
| Sabor     | `Flavor` com preço por tamanho (`FlavorPrice`) e ingredientes.                         |
| Modo      | `WHOLE` (um sabor) ou `HALVES` (dois sabores, uma metade cada).                        |
| Metade    | `LEFT` ou `RIGHT`. Posição visual; não altera preço.                                   |
| Posição   | Onde um adicional ou remoção se aplica: `WHOLE`, `LEFT` ou `RIGHT`.                    |
| Borda     | `Crust`, opcional, sempre na pizza inteira.                                            |
| Adicional | `Extra` com `wholePriceCents` e `halfPriceCents` por tamanho.                          |
| Remoção   | Ingrediente removível retirado de um sabor, sem alteração de preço.                    |
| Política  | `PricingPolicy` da pizzaria: estratégia meio a meio, sobretaxa e limite de adicionais. |

## Configuração de uma pizza

```ts
// Forma do contrato; nomes definitivos ficam em packages/contracts.
type Placement = "WHOLE" | "LEFT" | "RIGHT";

interface PizzaConfiguration {
  sizeId: string;
  mode: "WHOLE" | "HALVES";
  flavors: { LEFT: string; RIGHT?: string }; // RIGHT obrigatório só em HALVES
  crustId: string | null;
  extras: { extraId: string; placement: Placement }[];
  removals: { ingredientId: string; placement: Placement }[];
  quantity: number;
}
```

Em `WHOLE`, o sabor único fica em `flavors.LEFT` e só a posição `WHOLE` é aceita para adicionais e remoções.

## Regras de montagem

| ID    | Regra                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PB-01 | Tamanho obrigatório, disponível e não arquivado.                                                                                                                                                                                                                                                                                                                                                                         |
| PB-02 | `WHOLE` exige exatamente um sabor. `HALVES` exige dois sabores e `maxFlavors = 2` no tamanho escolhido.                                                                                                                                                                                                                                                                                                                  |
| PB-03 | Cada sabor precisa estar disponível, não arquivado, em categoria de pizza e ter `FlavorPrice` para o tamanho. Sem preço = indisponível no tamanho.                                                                                                                                                                                                                                                                       |
| PB-04 | As metades dividem a pizza em duas partes iguais (50% cada). Não há divisão desigual, terços ou quartos no MVP.                                                                                                                                                                                                                                                                                                          |
| PB-05 | `HALVES` com o mesmo sabor nas duas metades é cobrado como esse sabor único, sem sobretaxa. Na etapa 5 do pipeline (depois da normalização de adicionais), vira `WHOLE` somente se não restar adicional de metade e as remoções da esquerda forem iguais às da direita; caso contrário continua `HALVES` (ex.: Calabresa dos dois lados com bacon só de um lado). Ver [pipeline](#pipeline-de-validação-e-normalização). |
| PB-06 | `LEFT` e `RIGHT` são posições visuais. Trocar os sabores de lado não muda preço nem validade.                                                                                                                                                                                                                                                                                                                            |
| PB-07 | No máximo uma borda. A borda precisa estar disponível e ter preço para o tamanho. Sempre se aplica à pizza inteira.                                                                                                                                                                                                                                                                                                      |
| PB-08 | Adicionais em `WHOLE` só são aceitos com posição `WHOLE`. Em `HALVES`, aceitam `WHOLE`, `LEFT` ou `RIGHT`.                                                                                                                                                                                                                                                                                                               |
| PB-09 | Cada adicional aparece no máximo uma vez por posição (sem “bacon duplo” no MVP) e precisa ter preço para o tamanho. Entrada repetida com o mesmo adicional e a mesma posição é rejeitada (`PIZZA_EXTRA_DUPLICATED`), nunca deduplicada em silêncio.                                                                                                                                                                      |
| PB-10 | O mesmo adicional em `LEFT` e `RIGHT` é normalizado para uma única entrada `WHOLE` (etapa 4 do pipeline). O mesmo adicional em `WHOLE` e em uma metade é inválido (`PIZZA_EXTRA_DUPLICATED`).                                                                                                                                                                                                                            |
| PB-11 | Limite: em cada metade, adicionais da metade + adicionais `WHOLE` ≤ `maxExtrasPerHalf`. Em `WHOLE`, adicionais ≤ `maxExtrasPerHalf`.                                                                                                                                                                                                                                                                                     |
| PB-12 | Remoção só de ingrediente marcado como removível e presente no sabor daquela posição. Em `WHOLE`, posição `WHOLE`; em `HALVES`, `LEFT` ou `RIGHT`.                                                                                                                                                                                                                                                                       |
| PB-13 | Remoções não têm custo nem limite de quantidade. Em `HALVES`, remover o mesmo ingrediente das duas metades exige duas entradas. Remoção repetida com o mesmo ingrediente e a mesma posição é rejeitada (`PIZZA_REMOVAL_DUPLICATED`).                                                                                                                                                                                     |
| PB-14 | `quantity` inteiro de 1 a 20.                                                                                                                                                                                                                                                                                                                                                                                            |
| PB-15 | Observações livres por item não existem no MVP (evita instruções que mudam preço). Há uma observação geral por pedido.                                                                                                                                                                                                                                                                                                   |

## Pipeline de validação e normalização

App, API e painel executam exatamente estas etapas, nesta ordem, por meio da mesma função do pacote `pizza-pricing`. O pipeline para na primeira etapa que encontrar erro e devolve **todos** os erros dessa etapa, em ordem estável (por campo e índice). As etapas 1 a 3 sempre olham a entrada **original**; nenhuma regra é avaliada sobre dados parcialmente normalizados.

| Etapa | Nome                  | O que faz                                                                                                                                                                                                                            | Regras                                       |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| 1     | Estrutura             | Tipos, campos obrigatórios, enums, campos desconhecidos, `quantity` inteiro de 1 a 20, forma de `flavors` coerente com `mode`. Erro: `PIZZA_INVALID_STRUCTURE`.                                                                      | PB-02 (forma), PB-14                         |
| 2     | Referências           | Carrega tamanho, sabores, borda, adicionais e ingredientes no catálogo do tenant. Verifica existência, arquivamento, disponibilidade, preço para o tamanho e `maxFlavors`.                                                           | PB-01 a PB-03, PB-07, PB-09 (preço)          |
| 3     | Posições e duplicatas | Posição permitida para o modo, adicional repetido na mesma posição, adicional em `WHOLE` e em metade, remoção de ingrediente não removível ou ausente do sabor daquela posição, remoção repetida.                                    | PB-08, PB-09, PB-10 (inválido), PB-12, PB-13 |
| 4     | Normalizar adicionais | Em `HALVES`, cada adicional presente em `LEFT` e em `RIGHT` vira uma entrada `WHOLE`.                                                                                                                                                | PB-10                                        |
| 5     | Normalizar sabores    | Em `HALVES` com o mesmo sabor dos dois lados: se não houver adicional de metade e o conjunto de remoções de `LEFT` for igual ao de `RIGHT`, vira `WHOLE` com esse sabor e essas remoções em posição `WHOLE`. Senão, mantém `HALVES`. | PB-05                                        |
| 6     | Ordem canônica        | Ordena adicionais e remoções por (posição `WHOLE`, `LEFT`, `RIGHT`; depois id). A saída é a forma usada no carrinho, no snapshot e na comparação de linhas.                                                                          | PB-06                                        |
| 7     | Limites               | `maxExtrasPerHalf` sobre a configuração normalizada. Como a etapa 4 nunca aumenta a contagem de uma metade, o resultado é o mesmo que seria obtido na entrada original.                                                              | PB-11                                        |
| 8     | Preço                 | Fórmula abaixo sobre a configuração normalizada.                                                                                                                                                                                     | Seção Preço                                  |

Propriedades que os testes do pacote devem garantir:

- **Determinismo:** a mesma entrada gera a mesma saída e os mesmos erros, em qualquer ambiente.
- **Idempotência:** aplicar o pipeline à saída normalizada devolve a mesma saída.
- **Equivalência:** entradas que diferem só na ordem de adicionais ou remoções, ou em adicionais `LEFT`+`RIGHT` versus `WHOLE`, produzem a mesma forma canônica e o mesmo preço.
- **Não encarece:** a normalização nunca aumenta o total.

Casos obrigatórios de normalização (catálogo dos exemplos de preço):

| #   | Entrada                                                          | Resultado                                                                            |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| N1  | `HALVES` Calabresa/Calabresa, sem adicionais nem remoções        | `WHOLE` Calabresa                                                                    |
| N2  | `HALVES` Calabresa/Calabresa, bacon em `LEFT` e `RIGHT`          | `WHOLE` Calabresa + bacon `WHOLE` (4.900 + 800)                                      |
| N3  | `HALVES` Calabresa/Calabresa, bacon só em `LEFT`                 | Continua `HALVES`; 4.900 + 500, sem sobretaxa                                        |
| N4  | `HALVES` Calabresa/Calabresa, sem cebola em `LEFT` e em `RIGHT`  | `WHOLE` Calabresa, sem cebola `WHOLE`                                                |
| N5  | `HALVES` Calabresa/Calabresa, sem cebola só em `LEFT`            | Continua `HALVES`; 4.900                                                             |
| N6  | Bacon `LEFT` informado duas vezes                                | Erro `PIZZA_EXTRA_DUPLICATED` na etapa 3                                             |
| N7  | Bacon `WHOLE` e bacon `LEFT`                                     | Erro `PIZZA_EXTRA_DUPLICATED` na etapa 3                                             |
| N8  | `WHOLE` Calabresa com bacon `LEFT`                               | Erro de posição na etapa 3 (PB-08)                                                   |
| N9  | `maxExtrasPerHalf = 1`: bacon `LEFT` e `RIGHT` + azeitona `LEFT` | Após etapa 4: `LEFT` conta bacon + azeitona = 2; erro `PIZZA_EXTRA_LIMIT` na etapa 7 |
| N10 | Sabor arquivado e adicional repetido na mesma entrada            | Só o erro da etapa 2 (sabor); a etapa 3 não roda                                     |
| N11 | Mesma pizza com adicionais em ordens diferentes                  | Mesma forma canônica e mesmo preço                                                   |

Em N9, azeitona é um adicional de exemplo com preço para o tamanho; “sem cebola” em N4 e N5 é remoção de ingrediente removível da Calabresa.

Erros de validação têm código estável e caminho do campo (`path`, ex.: `extras[2].placement`) para o app mostrar a mensagem certa. A lista completa fica em `PIZZA_ERROR_CODES` de `packages/contracts`:

| Etapa | Códigos                                                                                                                                                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `PIZZA_INVALID_STRUCTURE`                                                                                                                                                                 |
| 2     | `PIZZA_SIZE_UNAVAILABLE`, `PIZZA_HALVES_NOT_ALLOWED`, `PIZZA_FLAVOR_UNAVAILABLE`, `PIZZA_CRUST_UNAVAILABLE`, `PIZZA_EXTRA_UNAVAILABLE`, `PIZZA_REMOVAL_INVALID` (ingrediente inexistente) |
| 3     | `PIZZA_EXTRA_PLACEMENT_INVALID`, `PIZZA_EXTRA_DUPLICATED`, `PIZZA_REMOVAL_PLACEMENT_INVALID`, `PIZZA_REMOVAL_INVALID`, `PIZZA_REMOVAL_DUPLICATED`                                         |
| 7     | `PIZZA_EXTRA_LIMIT` (`path` = `extras` em `WHOLE`, `extras.LEFT` ou `extras.RIGHT` em `HALVES`)                                                                                           |

## Preço

### Configuração por pizzaria

| Parâmetro                   | Valores              | Padrão sugerido                                      |
| --------------------------- | -------------------- | ---------------------------------------------------- |
| `halfAndHalfStrategy`       | `HIGHEST`, `AVERAGE` | `HIGHEST` (comportamento da landing; Q-06 em aberto) |
| `halfAndHalfSurchargeCents` | inteiro ≥ 0          | 0                                                    |
| `maxExtrasPerHalf`          | inteiro de 0 a 10    | 5                                                    |

Restrição de cadastro de adicionais: `halfPriceCents ≤ wholePriceCents ≤ 2 × halfPriceCents`. Isso garante que a normalização PB-10 nunca encarece a pizza.

### Fórmula

Todos os valores em centavos inteiros. `P(s)` é o preço do sabor `s` no tamanho escolhido.

```text
base =
  WHOLE:              P(sabor)
  HALVES + HIGHEST:   max(P(esquerda), P(direita))
  HALVES + AVERAGE:   ceil((P(esquerda) + P(direita)) / 2)

sobretaxa = HALVES com sabores diferentes ? halfAndHalfSurchargeCents : 0
borda     = crust ? CrustPrice(crust, tamanho) : 0
adicionais = soma de: WHOLE → wholePriceCents; LEFT/RIGHT → halfPriceCents

unitário = base + sobretaxa + borda + adicionais
total do item = unitário × quantity
```

Regras de cálculo:

- O único arredondamento é o `ceil` da média, para o centavo inteiro acima (a média de dois inteiros tem no máximo meio centavo). Recomendação registrada: arredondar a favor da pizzaria; alternativa é arredondar para baixo, a favor do cliente.
- A normalização (PB-05 e PB-10) acontece **antes** do cálculo. Pizza com o mesmo sabor nos dois lados nunca paga sobretaxa; em `HALVES` com sabor repetido, `HIGHEST` e `AVERAGE` resultam no próprio preço do sabor.
- Remoções não alteram preço.
- Estratégia e sobretaxa valem para todos os tamanhos. Estratégia por tamanho é questão aberta.

### Exemplos

Catálogo de exemplo, tamanho Grande (preços dos sabores iguais aos da landing):

| Item                   | Preço     |
| ---------------------- | --------- |
| Calabresa              | 4.900     |
| Margherita             | 5.200     |
| Portuguesa             | 5.595     |
| Quatro queijos         | 6.200     |
| Borda catupiry         | 1.000     |
| Bacon (inteira/metade) | 800 / 500 |

| #   | Configuração                                                                | Política                 | Cálculo                                     | Total  |
| --- | --------------------------------------------------------------------------- | ------------------------ | ------------------------------------------- | ------ |
| E1  | Inteira Calabresa                                                           | qualquer                 | 4.900                                       | 4.900  |
| E2  | Calabresa / Margherita                                                      | `HIGHEST`, sobretaxa 0   | max(4.900, 5.200)                           | 5.200  |
| E3  | Calabresa / Margherita                                                      | `AVERAGE`, sobretaxa 0   | (4.900 + 5.200) / 2                         | 5.050  |
| E4  | Calabresa / Portuguesa                                                      | `AVERAGE`, sobretaxa 0   | ceil(10.495 / 2) = ceil(5.247,5)            | 5.248  |
| E5  | Calabresa / Margherita, borda catupiry, bacon só na Calabresa, quantidade 2 | `HIGHEST`, sobretaxa 300 | (5.200 + 300 + 1.000 + 500) × 2             | 14.000 |
| E6  | Margherita / Margherita                                                     | `HIGHEST`, sobretaxa 300 | normalizada para inteira: 5.200             | 5.200  |
| E7  | Calabresa / Quatro queijos, bacon nas duas metades                          | `HIGHEST`, sobretaxa 0   | normalizado para bacon inteiro: 6.200 + 800 | 7.000  |
| E8  | Quatro queijos / Calabresa (lados trocados de E7, sem bacon)                | `HIGHEST`, sobretaxa 0   | 6.200                                       | 6.200  |

Esses exemplos devem virar casos de teste do pacote de preço, junto com testes de propriedade: simetria entre lados, preço `HALVES` entre o menor e o maior sabor (sem sobretaxa), e normalização nunca aumentando o total.

### Autoridade e divergência

1. O app calcula o preço localmente com o mesmo pacote para exibir em tempo real.
2. Antes de finalizar, o app chama `quote`; a API recalcula com o catálogo e a política vigentes.
3. Se o valor mudou ou algum item ficou indisponível, o app mostra a diferença e exige nova confirmação do cliente.
4. Na criação do pedido a API recalcula de novo; o valor enviado pelo app nunca é gravado.
5. O pedido guarda snapshot de nomes, preços unitários, estratégia, sobretaxa e detalhamento (ver [domain-model](../architecture/domain-model.md)).

## Representação visual

Requisito obrigatório: em uma pizza de dois sabores, cada metade deve ser visualmente distinta e identificável sem depender só de cor.

- A pizza é um círculo dividido por uma linha vertical. `LEFT` mostra o sabor da esquerda e `RIGHT` o da direita, cada um com a imagem do sabor recortada em semicírculo.
- A linha divisória é sempre desenhada, com contraste suficiente sobre as duas imagens, mesmo quando as imagens forem parecidas.
- Rótulos com o nome do sabor ficam associados a cada metade (abaixo ou ao lado no layout compacto).
- Adicionais de metade aparecem como camada de ingredientes só na metade correspondente; adicionais `WHOLE` aparecem nas duas. Remoções aparecem em texto (“sem cebola”), não como imagem.
- Sem imagem do sabor, usar ilustração padrão de pizza com padrão gráfico diferente por metade e o nome do sabor.
- A metade selecionada para edição recebe contorno e estado de foco visíveis; tocar uma metade a seleciona. O mesmo controle é acessível por botões “Metade esquerda” e “Metade direita”.
- Leitores de tela recebem descrição textual equivalente, no padrão da landing: “Metade esquerda: Calabresa, sem cebola, com bacon. Metade direita: Margherita. Borda catupiry.”
- Troca de sabor usa transição curta, desativada quando o sistema pede movimento reduzido.
- Em `WHOLE`, a mesma imagem ocupa o círculo inteiro, sem linha divisória.

### Imagens de sabor

- Formato de envio: PNG, JPEG ou WebP, quadrado, mínimo 1024 × 1024, pizza vista de cima, centralizada, ocupando ao menos 90% do quadro, fundo transparente ou neutro.
- O servidor gera variantes (256, 512, 1024) em WebP e guarda sob o prefixo do tenant.
- O recorte em semicírculo é feito no app (máscara), não no servidor, para que a mesma imagem sirva para inteira e meia.

### Comanda e painel

A equipe não precisa saber o lado visual. O painel e a comanda mostram:

```text
1x Pizza Grande — meio a meio
  1/2 Calabresa — sem cebola — + bacon
  1/2 Margherita
  Borda: catupiry
```

A ordem das metades segue `LEFT` e depois `RIGHT`.

## Carrinho

- Linhas do carrinho com configuração idêntica (após normalização) são somadas na quantidade, respeitando PB-14. Pizzas espelhadas (lados trocados) ficam em linhas separadas com o mesmo preço.
- O carrinho fica no dispositivo, por tenant, e é descartado quando o catálogo publicado muda de forma incompatível (item removido); nesse caso o app avisa quais itens saíram.

## Questões em aberto

| ID    | Questão                                                                   | Recomendação                                                                      |
| ----- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Q-06  | Estratégia padrão para novas pizzarias                                    | `HIGHEST`, como na landing                                                        |
| PB-Q1 | Estratégia diferente por tamanho                                          | Não no MVP                                                                        |
| PB-Q2 | Adicional em meia pizza de sabor único sem o cliente escolher meio a meio | Não no modo `WHOLE` (PB-08); possível montando `HALVES` com o mesmo sabor (PB-05) |
| PB-Q3 | Arredondamento da média: para cima ou para baixo                          | Para cima                                                                         |
| PB-Q4 | Três ou mais sabores                                                      | Fora do MVP; o modelo de posições permite evoluir                                 |
| PB-Q5 | Adicional em dobro                                                        | Fora do MVP                                                                       |
| PB-Q6 | Bordas recheadas por metade                                               | Fora do MVP                                                                       |
