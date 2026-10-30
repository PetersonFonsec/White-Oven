# ADR 0024: assinatura de plano por pizzaria

- **Status:** em desenvolvimento em M6.1
- **Data:** 2026-10-30
- **Milestone:** M6.1

## Contexto

O modelo de domínio prevê `PlanSubscription` com histórico por tenant e a invariante de que um tenant `ACTIVE` sempre tem exatamente uma assinatura vigente. Os planos ainda são condições preliminares (Flex: 3% por venda, sem mensalidade; Pro: R$ 199/mês, sem comissão) e Q-01, Q-02 e Q-10 continuam abertas. M6.2 vai gravar o `BillingEntry` com o snapshot do plano vigente, então o histórico precisa existir antes, mesmo sem cobrança efetiva.

## Decisão

- **Catálogo global `plans`:** códigos `FLEX` (300 pontos-base, R$ 0/mês) e `PRO` (0 pontos-base, R$ 199/mês), valores em centavos e pontos-base. Só a migration (papel owner) altera o catálogo; o papel da app não lê nem escreve nele, e o operador o consulta por `GET /v1/platform/plans`.
- **Tabela de tenant `plan_subscriptions`:** `plan`, `fee_basis_points`, `monthly_fee_cents`, `valid_from`, `valid_to` (nulo = vigente sem fim), `created_by` (operador; nulo para a migração e o seed demo). Os valores são copiados do catálogo na criação de cada período, então uma mudança comercial futura não altera históricos. RLS forçado como toda tabela de tenant; o papel da app só tem `select` (M6.2 lê o período vigente).
- **Sem sobreposição no banco:** restrição de exclusão GiST `(tenant_id with =, tstzrange(valid_from, valid_to, '[)') with &&)`, com a extensão confiável `btree_gist`, e `valid_to > valid_from`. A garantia não depende do código da API.
- **Troca pelo operador:** `PUT /v1/platform/tenants/{id}/plan` com `{ "plan": "FLEX" | "PRO" }`, rota `@PlatformRoute()` (operador com sessão MFA) que chama a função `whiteoven_change_tenant_plan`, no mesmo padrão `SECURITY DEFINER` do M1.5. A operação é idempotente por estado desejado:
  - sem período vigente, o plano começa agora;
  - com período vigente, a troca vale no início do próximo mês civil no fuso do tenant (recomendação da Q-10): o período atual é fechado nesse instante e o novo é agendado;
  - pedir o plano já vigente ou já agendado não muda nada (`changed: false`);
  - uma troca agendada que ainda não começou pode ser substituída ou cancelada (voltar ao plano atual reabre o período vigente). Só períodos futuros são apagados; períodos que já valeram nunca mudam de plano ou valores.
  - sem período vigente mas com um período futuro (só alcançável por dados gravados fora da função), o plano escolhido começa agora e termina onde o período futuro começa, preenchendo o intervalo sem sobreposição; o período futuro é mantido. Mais de um período futuro responde `409 PLAN_SCHEDULE_CONFLICT`, assim como qualquer violação da restrição de exclusão, em vez de expor o erro SQL.
  - a função trava a linha do tenant e lê o relógio (`clock_timestamp()`) depois do lock, não o início da transação (`now()`): uma chamada que esperou o lock enxerga o período iniciado por outra e agenda em vez de sobrepor. A ativação usa o mesmo relógio.
- **Leitura:** `GET /v1/platform/tenants/{id}/plans` lista os períodos, mais recentes primeiro. A lista de tenants passa a trazer `plan` (vigente), `scheduledPlan` (agendado) e `timeZone` (fuso IANA da loja). As datas continuam instantes UTC no contrato; o painel as formata no fuso da loja, porque o período começa à meia-noite local dela, e cai para UTC rotulado se o fuso for desconhecido.
- **Ativação:** `whiteoven_change_tenant_status` passa a recusar `ACTIVE` sem período vigente com `409 PLAN_REQUIRED`. Tenants de desenvolvimento já `ACTIVE`/`SUSPENDED` recebem Flex desde a criação na migration (não existe produção) e o seed demo cria o período Flex.
- **Auditoria:** `plan_subscription.started`, `plan_subscription.change_scheduled` e `plan_subscription.change_cancelled` em `audit_events`, com plano, valores e início, sem dados pessoais, na mesma transação da mudança. Quando um agendamento é substituído, o cancelamento traz `reason: "REPLACED"` e `replacedBySubscriptionId`, e o novo agendamento traz `replacesSubscriptionId`; voltar ao plano atual registra `reason: "REVERTED"`. Operações sem efeito não geram eventos.
- **Painel:** a área de plataforma mostra o plano vigente e o agendado de cada pizzaria e um diálogo "Plano" com os termos de cada plano, o momento em que a troca vale e o histórico. O catálogo de planos carrega à parte da lista de pizzarias: em falha, a lista continua utilizável, o botão "Plano" fica desabilitado e há "Tentar novamente".

## Consequências

M6.2 pode copiar `plan` e `fee_basis_points` do período vigente para cada `BillingEntry` sem ambiguidade. A regra de troca no próximo ciclo é uma recomendação e fica concentrada em uma função; se a Q-10 decidir troca imediata ou pró-rata, muda essa função e o teste correspondente, não o modelo. Período de teste, inadimplência, cancelamento do plano e cobrança efetiva continuam fora de M6.1. O dono da pizzaria ainda não vê o plano no painel da loja.
