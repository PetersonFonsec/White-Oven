# ADR 0023: acompanhamento e histórico de pedidos no app

- **Status:** em desenvolvimento em M5.4
- **Data:** 2026-10-29
- **Milestone:** M5.4

## Contexto

M5.3 (PR #37, ADR 0022) permite criar pedidos e recuperar uma confirmação idempotente. A API já registra estados imutáveis e transições em M4.4, mas não oferecia leitura de pedidos pelo cliente. O app precisa mostrar o progresso e permitir recomprar itens sem confiar em preços históricos.

## Decisão

- **API de cliente:** `GET /v1/customer/stores/{slug}/me/orders?cursor={number}` lista até 50 pedidos, mais recentes primeiro. `nextCursor` é o número do último pedido da página e a próxima página retorna números menores. Parâmetros desconhecidos ou malformados respondem `422 VALIDATION_FAILED`.
- **Autorização e isolamento:** as rotas de leitura usam `@CustomerRoute()` e a capacidade `customerAccount`, então permanecem disponíveis em lojas suspensas/encerradas para consultas de conta. Cada consulta filtra o `customer_id` verificado e roda sob `TenantTransactions`/RLS. O detalhe exige ao mesmo tempo o ID do pedido e o ID do cliente; um pedido alheio responde como inexistente (`404`). Todas as respostas usam `Cache-Control: no-store`.
- **Resumo:** a lista retorna apenas id, número, estado, data, modo e total. O detalhe retorna snapshot imutável dos itens, totais, pagamento, observação do próprio pedido e transições em ordem temporal. A linha do tempo não inclui `reason_text` livre nem autor interno; a tela converte códigos estáveis em texto amigável.
- **Estimativa e contato:** o detalhe pode incluir os minutos estimados de preparo/entrega e telefone comercial configurados atualmente. A previsão é calculada no dispositivo a partir de `placedAt` e desses minutos: preparo para retirada, preparo mais entrega para delivery. É aproximada, não usa rota e não representa um compromisso histórico congelado. Não é mostrada para estados terminais.
- **Atualização:** o app consulta o detalhe a cada 20 segundos somente enquanto a tela daquele pedido está montada e o app está em primeiro plano. Ao voltar do background, busca imediatamente. Ao sair da tela ou entrar em estado terminal, o intervalo é encerrado. Não há push neste marco.
- **Cancelamento:** aproveita a transição de cliente existente em M4.4, somente `PLACED → CANCELED` com motivo `CUSTOMER_REQUEST` e chave idempotente nova por ação. Depois do aceite, o cliente deve contatar a pizzaria; o app mostra o telefone comercial quando disponível.
- **Pedir novamente:** reconstrói a configuração a partir dos snapshots somente em memória e valida estrutura com `validatePizzaConfiguration`, disponibilidade/preço com `evaluatePizza` contra o menu público atual. Produtos ou pizzas que não podem mais ser pedidos são informados e ignorados. O cliente confirma a substituição do carrinho atual. Nenhum preço ou endereço/observação antigo é reutilizado: o checkout pede nova cotação antes de criar outro pedido.
- **Persistência:** a lista e o detalhe são estado volátil da tela; não são gravados em SecureStore nem no cache público. Somente o carrinho recomposto usa a persistência comercial já descrita no ADR 0022.
- **Sem nova infraestrutura:** as consultas usam as tabelas `orders`, `order_items`, `order_status_changes` e `store_settings` existentes, sem migration, fornecedor ou integração adicional.

## Consequências

O histórico do cliente passa a usar o mesmo snapshot e trilha auditável da equipe, sem campos operacionais internos. Paginação por número é estável sob novos pedidos e simples de retomar. Uma nova compra sempre passa pelas regras atuais de catálogo, disponibilidade, loja, endereço, pagamento e preço; snapshots servem para reconstruir escolhas, não para repetir o pedido antigo cegamente.

Push, rastreamento de entregador, ocorrências pelo cliente e sincronização de histórico offline continuam fora de M5.4.
