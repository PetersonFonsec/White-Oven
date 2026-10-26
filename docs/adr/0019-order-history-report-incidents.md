# ADR 0019: histórico, relatório diário e ocorrências de pedido

- **Status:** implementado em M4.6
- **Data:** 2026-10-26
- **Milestone:** M4.6

## Contexto

A M4.6 fecha o M4 com três leituras e um registro para a equipe ([order-lifecycle](../product/order-lifecycle.md#histórico), [domain-model](../architecture/domain-model.md#orderincident)):

- histórico com filtros por data, estado, modo e número;
- detalhe com as transições e seus autores;
- relatório diário com quantidade e soma dos pedidos `COMPLETED`, separados por modo e forma de pagamento;
- ocorrências ligadas a pedidos, que não mudam estado nem valores.

Três pontos não estavam decididos: o que é "dia" no histórico e no relatório, quem vê o relatório e como garantir no banco que uma ocorrência não altera o pedido.

## Decisão

- **Rotas** (token de equipe, loja do token, RLS, `Cache-Control: no-store` nas leituras):
  - `GET /v1/admin/orders/history`, para OWNER, MANAGER e STAFF.
    - Filtros opcionais: `from`, `to`, `status`, `fulfillment` e `number`.
    - A paginação usa `cursor`, com 50 pedidos por página do número mais alto para o mais baixo e `nextCursor` com o último número da página.
    - Um filtro desconhecido, repetido ou malformado é `422 VALIDATION_FAILED`.
  - `GET /v1/admin/orders/{id}` passa a trazer `actorName` em cada transição feita pela equipe e a lista `incidents`. A mudança é só aditiva; o quadro da M4.5 não muda.
  - `POST /v1/admin/orders/{id}/incidents` e `POST /v1/admin/orders/{id}/incidents/{incidentId}/resolve`, para todos os papéis.
  - `GET /v1/admin/reports/daily?from&to`, **só para o OWNER**, como "Ver relatórios financeiros" na tabela de permissões de [system-overview](../architecture/system-overview.md#autorização).
- **"Dia" é o dia civil no fuso da loja** (`tenants.timezone`):
  - No histórico, a data é a do `placedAt` do pedido.
  - No relatório, a data é a da transição para `COMPLETED`. Um pedido feito às 23h50 e concluído às 0h20 conta no dia seguinte, junto com o caixa em que entrou.
  - Alternativa descartada: a data operacional dos turnos ([ADR 0016](0016-store-open-status.md)), em que um turno que cruza a meia-noite pertence ao dia em que começa. Ela depende dos horários vigentes, que mudam com o tempo, e a mesma consulta daria resultados diferentes depois de uma edição de horários. O dia civil é estável, e é o mesmo critério do período de cobrança (`BillingEntry.period`).
- **O relatório soma só `COMPLETED`.**
  - A consulta junta a transição para `COMPLETED` com o pedido ainda `COMPLETED`; recusados, cancelados e abertos nunca entram.
  - Os valores vêm do snapshot do pedido (total, subtotal e taxa), não de `billing_entries`. O ledger serve à cobrança da plataforma e terá estornos (M6.2); o relatório da loja mostra vendas.
  - Cada consulta cobre até 31 dias. Todos os dias do período aparecem, com zero quando não houve venda.
  - As somas usam `bigint` no banco e inteiros em centavos na API.
- **Ocorrências** (`order_incidents`, RLS forçada, nova migration):
  - Campos:
    - tipo: `MISSING_ITEM`, `WRONG_ITEM`, `LATE_DELIVERY`, `QUALITY`, `DELIVERY_PROBLEM` ou `OTHER`;
    - descrição de 1 a 1000 caracteres;
    - `reportedBy`: `CUSTOMER` quando o cliente falou com a loja, `STAFF` quando a equipe percebeu;
    - autor, data e, se resolvida, quem resolveu, quando e uma nota opcional.
  - **Não tocam no pedido:** são linhas ao lado dele. A aplicação não tem `UPDATE` em valores, itens nem endereço desde a M4.3, e o serviço de ocorrências não escreve em `orders`.
  - **Só abrir e resolver uma vez:**
    - a aplicação tem `SELECT` e `INSERT`;
    - `UPDATE` só nas colunas de resolução;
    - não há `DELETE` nem `TRUNCATE`;
    - um gatilho só permite `OPEN → RESOLVED`, então uma ocorrência resolvida não é reaberta nem reescrita;
    - duas pessoas resolvendo juntas: a segunda recebe `409 INCIDENT_ALREADY_RESOLVED`.
  - **Prazo:** pedidos em andamento aceitam ocorrência a qualquer momento. Pedidos encerrados aceitam até 30 dias depois da transição terminal; depois disso, `422 INCIDENT_WINDOW_CLOSED`.
  - **Status do tenant:** a capacidade `incidentWrite` vale para todos os papéis em loja `ACTIVE` e só para o OWNER em loja `SUSPENDED`. A escrita trava a linha do tenant `FOR SHARE`, como as transições, então uma suspensão em andamento entra antes ou depois, nunca no meio.
  - **Auditoria:** registrar e resolver gravam `AuditEvent` (`order.incident_reported` e `order.incident_resolved`) com o pedido e o tipo, **sem o texto livre**, que pode citar o cliente.
  - Registrar ocorrência não usa `Idempotency-Key`. Um retry pode duplicar uma ocorrência, mas a duplicata é visível, não tem efeito em valores e pode ser resolvida com uma nota.
- **Autores** vêm do nome atual em `staff_users`. Transições do cliente aparecem como "pelo cliente" e as do sistema como "automático".
- **Painel:**
  - Páginas `/loja/historico` (todos os papéis) e `/loja/relatorio` (OWNER), carregadas sob demanda.
  - O detalhe do histórico mostra itens, transições com autor e ocorrências, com os formulários de registrar e resolver.
  - O texto de ajuda pede para evitar dados pessoais desnecessários na descrição.

## Consequências

- Índices novos:
  - `orders (tenant_id, placed_at)`, para os filtros de data;
  - `order_status_changes (tenant_id, at) where to_status = 'COMPLETED'`, para o relatório;
  - `order_incidents (tenant_id, order_id, created_at)`.
- O relatório é por dia civil. Uma pizzaria que fecha às 2h vê as vendas da madrugada no dia seguinte. Se o piloto pedir o dia operacional, ele pode ser um parâmetro novo sem mudar dados.
- A descrição das ocorrências continua depois da exclusão da conta do cliente, porque a anonimização da [ADR 0017](0017-customer-identity.md) cobre os campos do pedido, não texto livre da equipe. Fica para a revisão de privacidade da M7.2.
- O nome do autor é o atual: renomear uma pessoa da equipe muda o nome no histórico antigo. A trilha imutável continua em `audit_events`, pelo id.
- O relatório mensal (M6.3) e o ledger (M6.2) seguem separados; esta ADR não muda a base de cobrança.
