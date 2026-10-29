# ADR 0021: cardápio, Pizza Builder e imagens públicas no app

- **Status:** implementado em M5.2 (PR #34)
- **Data:** 2026-10-26
- **Milestone:** M5.2

## Contexto

O M5.2 leva o cardápio e o Pizza Builder ao app white label. O roadmap pede três coisas:

- metades visualmente distintas, com adicionais e remoções por metade;
- regras PB-xx aplicadas via `pizza-pricing` e descrição textual de cada metade;
- acessibilidade, incluindo respeito ao movimento reduzido.

A [ADR 0020](0020-mobile-app-base.md) deixou para esta etapa o logotipo e a rota pública das imagens do cardápio. As imagens da [ADR 0010](0010-image-storage.md) eram só administrativas. O Peterson decidiu incluir a rota pública e o logotipo nesta mesma PR.

## Decisão

### API

- **Rota pública de imagens:** `GET /v1/public/stores/{slug}/images/{id}/{thumbnail|menu}`, com `@StoreTenant()` e a capacidade `publicMenu`.
  - Loja não `ACTIVE`: `403 TENANT_NOT_ACTIVE`, sem dizer o motivo. Slug desconhecido: `404`.
  - Serve só o que a loja publica:
    - imagens de sabores e produtos que aparecem no cardápio público;
    - o logotipo da marca.
  - Qualquer outro id recebe o mesmo `404 IMAGE_NOT_FOUND` de um id desconhecido, inclusive:
    - upload ainda não associado;
    - imagem de item indisponível ou arquivado;
    - ícone da marca;
    - imagem de outra loja;
    - variante inexistente.
  - A lista de imagens publicadas sai do próprio `PublicMenuService`, com o mesmo cache por versão do catálogo. As regras de visibilidade ficam num lugar só: quando um item sai do cardápio, sua imagem deixa de ser servida na hora.
  - O arquivo é lido do `ImageStorage` do tenant da URL. Metadado sem arquivo responde `503 IMAGE_STORAGE_MISSING` e registra o evento, como na rota administrativa, sem caminho do disco.
  - Cabeçalhos: `Cache-Control: no-cache` com ETag, a mesma política do cardápio e do perfil, e `X-Content-Type-Options: nosniff`. O app revalida a cada uso e recebe `304` se nada mudou. Item retirado e loja suspensa param de ser servidos na hora.
- **Cardápio público:** sabores e produtos ganham `imageId` (`uuid` ou `null`). É um campo novo; nenhum existente muda.
- **Perfil público:** `brand.logoImageId` (`uuid` ou `null`). O ícone continua fora: ele pertence à build (M5.6).

### App

- **`pizza-pricing` no app:**
  - `@whiteoven/contracts` e `@whiteoven/pizza-pricing` entram como dependências `workspace:*`. São pacotes do monorepo, não dependências externas.
  - O Metro do Expo resolve o código-fonte TypeScript dos dois, e o `node --test` também.
- **Do cardápio ao catálogo:**
  - `parseMenu` valida o corpo do cardápio campo a campo. Uma entrada malformada recusa o cardápio inteiro: um cardápio parcial poderia montar uma pizza sem uma das partes.
  - `pizzaCatalog` converte o cardápio no `PizzaCatalog` do pacote, com todo item disponível e não arquivado, porque o cardápio público só lista itens pedíveis.
  - O teste confere que o resultado passa em `validatePizzaCatalog`. O app não chama essa função em runtime porque ela usa `structuredClone`, que o Hermes não garante.
- **Estado do builder** (`src/builder/builder.ts`, puro e testado):
  - Guarda tamanho, modo, sabor por metade, borda, adicionais e remoções por metade, e quantidade.
  - Em `WHOLE`, a metade `LEFT` representa a pizza inteira.
  - O builder não aplica regra PB própria. `evaluatePizza` faz validação, normalização e preço, a mesma função que a API usa no pedido. Exemplos:
    - um adicional nas duas metades é enviado como `LEFT` + `RIGHT` e o pacote o normaliza para `WHOLE` (PB-10);
    - o mesmo sabor nas duas metades vira pizza inteira sem sobretaxa (PB-05).
  - As transições só mantêm o estado coerente com o que a tela mostra:
    - trocar o sabor de uma metade descarta as remoções daquela metade;
    - ir de inteira para meio a meio copia os adicionais para as duas metades.
- **Troca de tamanho** (`changeSize`): o app confere a troca antes de aplicá-la, para que nenhuma escolha seja descartada sem o cliente saber.
  - Um sabor sem preço no novo tamanho bloqueia a troca. A mensagem nomeia o sabor, e o app nunca troca o sabor por outro.
  - Meio a meio num tamanho de um sabor:
    - vira pizza inteira só quando nada se perde: a metade direita ainda sem sabor, ou o mesmo sabor e as mesmas escolhas nas duas metades;
    - nos outros casos, a troca é bloqueada e o cliente escolhe "Um sabor" antes, decidindo qual sabor fica.
  - Uma borda ou um adicional sem preço no novo tamanho pede confirmação. A mensagem nomeia o que sai, com as opções "Trocar e remover" e "Manter" o tamanho atual.
  - Uma troca bloqueada ou não confirmada deixa o estado como estava. Na troca aplicada, sabores, remoções, adicionais compatíveis e quantidade ficam, e o preço sai de novo de `evaluatePizza`.
  - Um cardápio que mudou com o builder aberto ainda pode deixar a pizza inválida para o tamanho; `pizza-pricing` reporta isso como em qualquer outro estado.
  - Cada `PizzaError` vira uma mensagem em português que nomeia a metade quando o erro tem uma.
  - O limite de adicionais (PB-11) também desabilita os chips da metade cheia, mas quem decide é o pacote.
- **Descrição de cada metade:**
  - `describePizza` descreve a configuração normalizada, ou seja, o que a pizzaria vai fazer, e não os toques. Por exemplo: "Metade esquerda: Calabresa, sem Cebola, com Bacon."
  - Antes de a pizza ficar válida, descreve as escolhas como estão ("sabor a escolher").
  - O mesmo texto aparece na tela e é o rótulo de acessibilidade da imagem da pizza.
- **Metades visualmente distintas:** a pizza vista de cima é uma `View` circular, sem SVG e sem dependência nova. As metades se distinguem sem depender de cor, inclusive em escala de cinza:
  - a esquerda é preenchida com a cor primária;
  - a direita é clara;
  - um divisor escuro separa as duas;
  - cada metade tem o nome escrito.
- **Acessibilidade:**
  - Os chips declaram papel (`radio` ou `checkbox`) e estado. A seleção aparece por preenchimento, borda e marca ✓.
  - Rótulos com contexto, como "Bacon na metade esquerda, + R$ 3,50".
  - Alvos de toque de 48 dp e texto que acompanha a fonte do sistema.
  - Resumo e preço em região viva (`accessibilityLiveRegion`); erros com papel `alert`.
  - O botão voltar do Android sai do builder.
- **Movimento reduzido:** o único movimento é a metade direita aparecendo ao dividir a pizza (220 ms).
  - `useReducedMotion` acompanha `AccessibilityInfo.isReduceMotionEnabled` e o evento `reduceMotionChanged`.
  - Com movimento reduzido, `transitionMs` devolve 0 e a mudança é imediata.
- **Cardápio:**
  - Mostra as categorias na ordem da API. Cada sabor aparece com o menor preço ("a partir de") e abre o builder; os produtos aparecem com o preço.
  - As imagens são decorativas (o nome ao lado diz o que são) e vêm da variante `thumbnail`. O logotipo aparece no topo.
  - Uma loja fechada continua navegável, com o aviso no topo. A tela "Pizzaria indisponível" continua para quem não está servindo.
- **Navegação** (`screenFor`, pura e testada): um só lugar decide a tela.
  - Loja confirmada como indisponível (403/404) mostra só a tela de indisponibilidade, mesmo com uma montagem aberta.
  - Uma atualização que confirma a indisponibilidade também fecha a montagem (`buildingAfterRefresh`). Quando a loja volta, o app abre no cardápio, não na pizza antiga.
  - Loja fechada e loja sem confirmação (offline) mantêm cardápio e builder, com seus avisos. Offline não é suspensão.
  - O botão voltar do Android e o "Voltar ao cardápio" fecham a montagem.
  - Sem política de preço da loja, o cardápio aparece, mas o builder avisa que a montagem ainda não tem preço.
- **Carregamento do cardápio:**
  - Uma carga por vez (`createMenuLoader`): uma nova aborta a anterior, a resposta abortada é descartada e só a carga mais recente muda o estado.
  - O estado `MenuState` é `loading`, `failed` ou `ok` com `stale`. A primeira carga que falha mostra o erro com "Tentar de novo".
  - Uma falha com cardápio na tela mantém esse cardápio e marca `stale`. O aviso diz que preços e disponibilidade podem ter mudado e aparece em três lugares: no cardápio (com "Atualizar cardápio"), no topo do builder e junto do total estimado.
  - Só uma carga bem-sucedida tira o aviso. Ele é separado do `brandStale` da marca (ADR 0020).
  - O cardápio não vai para cache no aparelho: preços mudam, e o pedido é precificado de novo pela API (M5.3).
- **Fora do escopo:** carrinho, conta, checkout e pedido ficam para M5.3. O builder mostra o "total estimado" com o aviso de que a pizzaria confirma o valor; não há botão de adicionar.

## Alternativas descartadas

- **Servir qualquer imagem do tenant pela rota pública:** exporia uploads ainda não publicados e imagens de itens retirados. A regra "só o que o cardápio ou a marca mostram" é a mesma que o cardápio já aplica.
- **`Cache-Control: public, max-age`:** pouparia a revalidação, mas manteria imagem de item retirado e de loja suspensa em caches intermediários. O ETag já reduz a revalidação a um `304`.
- **Regras de montagem reimplementadas no app:** seriam uma segunda versão das regras PB, que poderia divergir da API. O roadmap pede `pizza-pricing`.
- **SVG (`react-native-svg`) para a pizza:** seria uma dependência nativa a mais para desenhar dois semicírculos, e as `View`s resolvem.
- **Biblioteca de navegação:** são duas telas, cardápio e builder. O estado no `App` e o `BackHandler` bastam. A navegação volta a ser avaliada com conta e checkout (M5.3).

## Consequências

- Uma imagem associada a um item visível fica pública, sem sessão, para quem souber o slug e o id. É o mesmo nível de exposição do próprio cardápio.
- Cada leitura de imagem consulta o cardápio, que vem do cache por versão. O custo é uma consulta de versão e, para o logotipo, uma consulta a `brand_themes`.
- O preço que o app mostra sai da mesma função da API. A API continua sendo a autoridade no `quote` e na criação do pedido (M5.3).
