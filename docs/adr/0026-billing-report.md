# ADR 0026: relatório mensal de cobrança como estimativa

- **Status:** em desenvolvimento em M6.3
- **Data:** 2026-10-30
- **Milestone:** M6.3

## Contexto

M6.2 (ADR 0025) deixou um ledger append-only em que cada lançamento traz o snapshot do plano vigente na conclusão e o mês da loja. Em 2026-10-30 o produto aceitou as recomendações das questões que bloqueavam M6.3: Q-01 (o Flex cobra sobre todos os pedidos concluídos, qualquer que seja a forma de pagamento), Q-02 (a comissão incide sobre o subtotal dos itens, sem a taxa de entrega) e Q-10 (troca de plano vale no ciclo seguinte, sem pró-rata). Período de teste, inadimplência, cancelamento, mínimo, teto e nota fiscal continuam sem decisão, e nada é cobrado no MVP.

## Decisão

- **Relatório derivado, sem tabela própria:** o relatório de um mês (`YYYY-MM` no fuso da loja) é calculado a cada leitura a partir de `billing_entries` daquele `period` e dos períodos de `plan_subscriptions`. Nada é gravado; o mesmo ledger sempre produz o mesmo relatório. A regra fica numa função pura (`buildBillingReport`, `apps/api/src/billing/billing-report.ts`) com testes de unidade.
- **Regra aplicada:**
  - entram todos os `ORDER_COMPLETED` e `ORDER_REVERSED` do mês (Q-01); estornos subtraem no mês em que foram feitos (ADR 0025);
  - uma linha por snapshot de plano (`plan`, `feeBasisPoints`) com quantidade de pedidos e de estornos e somas líquidas de itens, entrega e total;
  - comissão da linha = subtotal líquido de itens × pontos-base ÷ 10.000, arredondada para o centavo com meio para longe de zero (Q-02); lançamentos de desenvolvimento sem snapshot aparecem numa linha "sem plano" com comissão zero;
  - mensalidade: soma da `monthlyFeeCents` integral de cada período de plano vigente em algum instante do mês (Q-10, sem pró-rata); um período que termina exatamente no início do mês não conta;
  - total estimado = comissão + mensalidades. Pode ser negativo se o mês só tiver estornos; o relatório mostra o valor como está.
- **Sempre estimativa:** a resposta traz `estimate: true` e o painel diz "Estimativa. Nada é cobrado ainda" com a regra resumida.
- **Acesso:**
  - operador com MFA: `GET /v1/platform/tenants/{id}/billing-report?period=` pelas funções de plataforma já existentes (`whiteoven_platform_plan_subscriptions`, `whiteoven_platform_tenants`, `whiteoven_platform_billing_entries`), sem nova função nem migration;
  - OWNER da loja ativa: `GET /v1/admin/reports/billing?period=` (`@AdminRoute("OWNER")`, `Cache-Control: no-store`), lendo o ledger e os planos da própria loja sob RLS. MANAGER e STAFF não veem cobrança.
  - sem `period`, o mês atual é calculado no banco no fuso da loja, não no navegador.
- **Painel:** seção "Cobrança" da loja para o OWNER (seletor de mês) e diálogo "Cobrança" de cada pizzaria na área de plataforma, com o mesmo relatório, os lançamentos do mês e o estorno com motivo fixo (a tela prometida no ADR 0025). Lançamento sem snapshot aparece sem botão de estorno.

## Consequências

Cobrança efetiva, faturas, período de teste, inadimplência, cancelamento, mínimo, teto e nota fiscal continuam fora do MVP. Se a regra mudar, muda `buildBillingReport` e seus testes; o ledger guarda os componentes e o snapshot necessários para recalcular qualquer mês passado. Mensalidade pró-rata ou cobrança de `SUBSCRIPTION_PERIOD` no ledger exigiriam nova decisão e um ADR.
