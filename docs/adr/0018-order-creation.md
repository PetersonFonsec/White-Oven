# ADR 0018: cotação e criação de pedido

- **Status:** implementado em M4.3
- **Data:** 2026-10-30
- **Milestone:** M4.3

## Contexto

A M4.3 entrega a cotação e a criação idempotente de pedidos ([order-lifecycle](../product/order-lifecycle.md#checkout), [domain-model](../architecture/domain-model.md#pedido)). Três pontos não estavam decididos:

- Como a API usa o motor de preço `@whiteoven/pizza-pricing`, que é TypeScript em ESM com imports `.ts`, enquanto a API compila para CommonJS com `tsc`.
- Como coordenar a criação com a suspensão da loja, a exclusão da conta e retries concorrentes.
- Como guardar o pedido sem permitir mudar valores depois.

A Q-04 foi decidida pelo PO em 2026-10-26: **taxa de entrega fixa única por loja, zero permitido**, já guardada em `store_settings` desde a M3.4. Retirada não paga taxa.

## Decisão

- **O motor de preço é o mesmo do app e do painel.**
  - A API depende de `@whiteoven/pizza-pricing` e `@whiteoven/contracts` como pacotes do workspace e carrega o código-fonte TypeScript em tempo de execução: Node 22 remove os tipos (os pacotes já usam só sintaxe apagável) e `require` carrega o ESM.
  - O `tsc` da API checa esses fontes com `rewriteRelativeImportExtensions`, sem emiti-los.
  - O `Dockerfile` da API leva os dois pacotes para a imagem.
  - Alternativa descartada: compilar os pacotes para JavaScript. Seria um passo de build a mais em cada pacote, só para a API.
- **Rotas** (com token de cliente, capacidade `createOrder`, loja `ACTIVE`):
  - `POST /v1/customer/stores/{slug}/me/orders/quote` calcula sem gravar.
  - `POST /v1/customer/stores/{slug}/me/orders` cria, com `Idempotency-Key` (UUID).
  - As duas recebem o mesmo corpo: modo, endereço salvo (`addressId`), forma de pagamento, troco, observação e linhas.
    - Pizza: `{ kind: "PIZZA", pizza: PizzaConfiguration }`.
    - Produto: `{ kind: "PRODUCT", productId, quantity }`.
- **O preço vem só do catálogo.**
  - O corpo não tem campos de preço; um campo desconhecido é `422`.
  - `expectedTotalCents` é o total que o app mostrou e o cliente confirmou.
    - Na cotação é opcional e só vira `priceChanged`.
    - Na criação é **obrigatório** (revisão da PR #29): ausente, nulo ou fora de `0..ORDER_CENTS_MAX` é `422 VALIDATION_FAILED` no caminho `expectedTotalCents`. Um total diferente do servidor responde `409 ORDER_PRICE_CHANGED` sem gravar nem consumir número, para o cliente confirmar o novo valor. Assim nenhum pedido é criado por um preço que o cliente não viu.
    - A comparação vem depois da chave: a repetição da mesma chave e corpo devolve o pedido original mesmo que o catálogo tenha mudado depois.
- **Ordem das verificações na criação**, numa transação sob o advisory lock do cliente (ADR 0017):
  1. Chave já usada, viva (24 horas) e com o mesmo corpo (SHA-256 do pedido validado, com chaves em ordem fixa): `200` com o mesmo pedido, mesmo que a loja tenha fechado depois. Corpo diferente: `409 IDEMPOTENCY_CONFLICT`, a semântica do formulário de leads e da plataforma.
  2. Linha do tenant em `FOR SHARE` (`whiteoven_lock_tenant_status`). Se a loja não está `ACTIVE`: `403 TENANT_NOT_ACTIVE`.
  3. Loja aberta (`readStoreStatus`, ADR 0016); fechada ou pausada é `409 STORE_CLOSED`, com o motivo. Sem configurações: `409 STORE_NOT_CONFIGURED`.
  4. `priceOrder` (função pura) checa modo, endereço do próprio cliente, forma de pagamento, itens (pipeline do motor), pedido mínimo sobre o subtotal de itens e troco sobre o total. Qualquer falha é `422 ORDER_INVALID` com `details.errors: [{ code, path }]`.
     - **Limite de valores** (revisão da PR #29): preço unitário e total de cada linha, subtotal, taxa e total ficam em até `ORDER_CENTS_MAX` = R$ 100.000,00 (10.000.000 centavos), o mesmo teto dos valores que o app envia (troco e total confirmado). Acima disso é `ORDER_TOTAL_EXCEEDED` (no caminho da linha, ou `items` para subtotal e total), com `maxTotalCents`. O teto fica muito abaixo do `integer` do PostgreSQL (2.147.483.647) e dos inteiros seguros do JavaScript: preços do catálogo (até `integer`) vezes quantidade 20 continuam exatos, e nenhuma soma de 30 linhas dentro do teto transborda. Os valores continuam inteiros em centavos; o motor de preço não mudou.
  5. O número vem de `tenant_order_counters`, um contador por loja atualizado com `insert ... on conflict do update`. A linha fica travada até o commit, então os números são sequenciais e sem buracos.
  6. Pedido, itens e chave são gravados. Uma chave expirada é reaproveitada para o novo pedido.
- **Concorrência:**
  - Retries com a mesma chave são do mesmo cliente e se enfileiram no advisory lock do cliente; o segundo encontra a chave confirmada e devolve o mesmo pedido.
  - A suspensão trava a linha do tenant (`FOR UPDATE`). Se vier antes, a criação vê `SUSPENDED` e recusa. Se vier depois, espera a criação e recusa o pedido novo junto com os outros `PLACED`.
  - A exclusão de conta toma o mesmo advisory lock. Se vier antes, a criação recusa a sessão; se vier depois, anonimiza o pedido novo.
  - Não há ciclo: a criação trava advisory, cliente e sessão, tenant, contador, nessa ordem, e nenhuma outra operação trava esses recursos na ordem inversa.
- **Snapshot imutável:**
  - Cada item guarda nomes e preços usados, a estratégia e o detalhamento do cálculo (`snapshot` JSONB).
  - O pedido guarda nome e telefone do cliente, endereço copiado, taxa, subtotal e total, com `check` de consistência no banco.
  - A app não pode alterar valores nem itens: `UPDATE` em `orders` só nas colunas de status e anonimização, e nenhum `UPDATE` ou `DELETE` em `order_items`.
- **Exclusão de conta** (ADR 0017) passa a anonimizar os pedidos do cliente: nome, telefone, endereço e observação ficam nulos e `anonymized_at` é preenchido. Itens e valores ficam para a loja.
- **Migração:** `orders` ganha colunas `NOT NULL` sem default. Antes da M4.3 nada criava pedidos, então nenhum ambiente tem linhas; se tivesse, o `alter table` falharia sem mudar nada. É só de avanço, como as demais (ADR 0005).

## Consequências

- O catálogo é lido inteiro a cada cotação e criação, dentro da transação. Serve aos catálogos do piloto; se pesar, dá para reaproveitar o cache por versão do cardápio público (ADR 0011).
- Um cliente cria um pedido por vez (advisory lock), e uma loja numera um pedido por vez (linha do contador, travada só no fim da transação).
- Não há rate limit específico de criação de pedido; fica para a revisão de segurança (M7.3).
- Leitura e histórico do pedido pelo cliente (M5.4) e pela equipe (M4.5, M4.6), transições (M4.4) e o `OrderStatusChange` inicial ficam para as próximas etapas.
- Q-04 decidida: taxa fixa única, zero permitido. Taxa por bairro pode vir depois sem mudar pedidos já gravados, que copiam a taxa.
