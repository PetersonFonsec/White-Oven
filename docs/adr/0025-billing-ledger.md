# ADR 0025: ledger de cobrança com snapshot do plano e estorno pelo operador

- **Status:** em desenvolvimento em M6.2
- **Data:** 2026-10-30
- **Milestone:** M6.2

## Contexto

M4.4 já grava um `BillingEntry` `ORDER_COMPLETED` na mesma transação em que o pedido vai para `COMPLETED`, com os componentes de valor separados (subtotal de itens, taxa de entrega e total). Faltavam o snapshot do plano vigente, o mês de competência no fuso da loja e o estorno previsto no modelo de domínio: `COMPLETED` é terminal e um lançamento nunca muda nem é apagado. M6.1 (ADR 0024) deixou um período de plano vigente garantido para toda loja ativa. Q-01, Q-02 e Q-10 continuam abertas, então M6.2 não calcula valor devido.

## Decisão

- **Snapshot no lançamento:** `billing_entries` ganha `plan`, `fee_basis_points` e `subscription_id` (o período de `plan_subscriptions` vigente no instante da conclusão) e `period` (`YYYY-MM` no fuso do tenant). Os valores vêm do período, que já é um snapshot do catálogo, e nunca do catálogo. O relatório de M6.3 aplica a regra decidida sobre esses dados sem reler o histórico de planos.
- **Escrita só por função:** o papel da app perde `insert` em `billing_entries` e fica só com `select` da própria loja. A conclusão chama `whiteoven_record_order_completion(order_id)`, `SECURITY DEFINER`, que lê o pedido concluído da loja do contexto, o período vigente (`clock_timestamp()`) e o fuso, e grava o lançamento; um retry da mesma conclusão não grava outro (`on conflict do nothing` na chave única por pedido e tipo). Sem período vigente a conclusão falha com `409 PLAN_REQUIRED` em vez de gravar um lançamento sem plano.
- **Append-only no banco:** gatilhos recusam `update`, `delete` e `truncate` em `billing_entries` para qualquer papel, inclusive o dono das migrations (`42501`). A garantia não depende do código da API.
- **Estorno pelo operador:** `POST /v1/platform/tenants/{id}/billing-entries/{entryId}/reversal` com `{ "reasonCode": "COMPLETED_BY_MISTAKE" | "SALE_UNDONE" }`, rota `@PlatformRoute()` (operador com sessão MFA) que chama `whiteoven_reverse_billing_entry`. A função trava o lançamento original, grava um `ORDER_REVERSED` com os componentes negados, o mesmo snapshot de plano e período de assinatura do original, `reverses_entry_id`, o motivo e o operador (`created_by`), no mês em que o estorno acontece. O pedido continua `COMPLETED`.
  - Um pedido tem no máximo um estorno. Repetir o pedido de estorno devolve o existente (`200`, `changed: false`) sem novo evento de auditoria; o primeiro responde `201`.
  - Só um `ORDER_COMPLETED` da loja indicada pode ser estornado; um estorno, um lançamento de outra loja ou um id desconhecido respondem `404 BILLING_ENTRY_NOT_FOUND`.
  - O motivo é um código fechado, sem texto livre, para o ledger não receber dados pessoais. A solicitação do OWNER continua fora do sistema no MVP (canal de suporte).
- **Leitura:** `GET /v1/platform/tenants/{id}/billing-entries?period=YYYY-MM` lista um mês da loja (o mês corrente no fuso dela quando omitido), em ordem cronológica, com número do pedido, snapshot do plano, componentes, motivo e `reversedByEntryId` no lançamento estornado.
- **Auditoria:** `billing_entry.reversed` em `audit_events`, com o lançamento estornado, o pedido, o motivo, o total negativo e o mês, na mesma transação.
- **Dados existentes:** a migration preenche `period` e o snapshot dos lançamentos de desenvolvimento a partir do período vigente quando ocorreram. As restrições de snapshot e de forma do estorno entram como `NOT VALID`: valem para toda linha nova sem bloquear a migration por dados antigos de desenvolvimento (não existe produção).
- **Sem painel em M6.2:** a operação fica na API, como o ciclo de vida do M1.5 antes do M3.2; a tela de lançamentos e estorno entra junto do relatório de M6.3.

## Consequências

O ledger passa a ser reprodutível: cada linha diz sob qual plano e em que mês foi gerada, e a soma de um mês inclui os estornos daquele mês. Um estorno de um pedido concluído no mês anterior cai no mês do estorno; se a Q-02 decidir outra competência, M6.3 agrupa por `reverses_entry_id`. `SUBSCRIPTION_PERIOD` e `ADJUSTMENT` continuam sem escritor até as decisões de cobrança (Q-01, Q-02, Q-10).
