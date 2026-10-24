# Ciclo de vida do pedido

Status: especificação M0.3, sem implementação. Define carrinho, checkout, estados, transições, cancelamento, histórico, ocorrências e regras de funcionamento da loja. Entidades em [domain-model](../architecture/domain-model.md); preços em [pizza-builder-rules](pizza-builder-rules.md).

## Carrinho

- Local no dispositivo, separado por pizzaria (`storeSlug`). Não há carrinho no servidor no MVP: evita estado abandonado no banco e funciona com o app recém-aberto.
- O app calcula preços com o pacote de preço para exibição; a API recalcula em `quote` e na criação.
- O carrinho guarda IDs e configurações, não preços. Ao abrir o app, itens arquivados ou indisponíveis são marcados e não podem seguir para o checkout.
- Limites: até 30 linhas e quantidade de 1 a 20 por linha.

Alternativa descartada: carrinho persistido na API. Útil para recuperar carrinho entre dispositivos ou campanhas de abandono, que não estão no MVP.

## Checkout

```mermaid
flowchart LR
  A[Carrinho] --> B{Entrega ou retirada}
  B -->|Entrega| C[Endereço]
  B -->|Retirada| D[Pagamento]
  C --> D
  D --> E[Revisão<br/>POST quote]
  E -->|preço ou disponibilidade mudou| A
  E --> F[Confirmar<br/>POST orders + Idempotency-Key]
  F --> G[Acompanhamento]
```

Validações na criação (todas no servidor, na mesma transação):

1. Cliente autenticado no tenant do `storeSlug` (ou pedido sem conta, se Q-05 aprovar).
2. Tenant `ACTIVE` e loja aberta (regras abaixo).
3. Modo (`DELIVERY`/`PICKUP`) habilitado em `StoreSettings`.
4. Entrega: endereço completo (CEP, rua, número, bairro, cidade, UF). Sem validação de área por distância; o texto da área atendida é exibido antes da confirmação e a pizzaria pode recusar com `OUT_OF_DELIVERY_AREA`.
5. Todos os itens válidos e disponíveis; preços recalculados.
6. `itemsSubtotalCents ≥ minimumOrderCents`.
7. Forma de pagamento aceita pela loja; troco (`changeForCents`) só em dinheiro e maior ou igual ao total.
8. `Idempotency-Key` UUID: repetição com o mesmo conteúdo retorna o mesmo pedido; mesma chave com conteúdo diferente retorna 409 (mesma semântica do formulário de leads). Chave válida por 24 horas.

Totais: `total = subtotal de itens + taxa de entrega − desconto` (desconto sempre 0 no MVP). A taxa de entrega é fixa por pizzaria e zero em retirada (Q-04).

Pagamento no MVP é sempre offline (dinheiro, cartão na entrega/retirada, Pix presencial) e apenas registrado. Não há status de pagamento, captura ou estorno; isso entra com o pagamento online (Q-03).

## Funcionamento da loja

A loja aceita pedidos quando **todas** as condições valem no instante da criação, no fuso do tenant:

1. Tenant `ACTIVE`.
2. Sem pausa manual vigente (`pausedUntil` nulo ou no passado). A equipe pausa por 15, 30 ou 60 minutos, ou até reabrir manualmente.
3. Nenhuma `ClosureException` fechando a data local.
4. O instante está dentro de uma `OpeningRule` do dia (ou da regra do dia anterior que atravessa a meia-noite). `closesAt` é o último instante para **criar** pedidos; pedidos já criados continuam sendo processados após o fechamento.

O cardápio continua visível com a loja fechada, com aviso e próximo horário de abertura. Pedidos agendados não existem no MVP. Antecedência de corte (ex.: parar de aceitar 15 minutos antes de fechar) é questão aberta (OL-Q2).

## Estados

| Estado             | Rótulo para o cliente                     | Significado                                               |
| ------------------ | ----------------------------------------- | --------------------------------------------------------- |
| `PLACED`           | Aguardando confirmação                    | Pedido criado; a pizzaria ainda não aceitou.              |
| `PREPARING`        | Em preparo                                | Aceito pela pizzaria.                                     |
| `READY`            | Pronto (retirada: “Pronto para retirada”) | Preparado, aguardando saída ou retirada.                  |
| `OUT_FOR_DELIVERY` | Saiu para entrega                         | Marcado manualmente; sem rastreamento.                    |
| `COMPLETED`        | Entregue / Retirado                       | Terminal. Gera evento faturável.                          |
| `REJECTED`         | Recusado pela loja                        | Terminal. Não aceito (pela equipe ou por tempo esgotado). |
| `CANCELED`         | Cancelado                                 | Terminal. Cancelado depois de criado.                     |

Alternativa descartada: estado `ACCEPTED` separado de `PREPARING`. Em pizzarias pequenas aceitar significa começar o preparo; um estado extra só aumenta cliques. Se surgir fila de produção, o estado pode ser adicionado sem quebrar os demais.

```mermaid
stateDiagram-v2
  [*] --> PLACED: cliente confirma
  PLACED --> PREPARING: equipe aceita
  PLACED --> REJECTED: equipe recusa / tempo esgotado
  PLACED --> CANCELED: cliente cancela
  PREPARING --> READY: equipe
  PREPARING --> CANCELED: equipe (motivo)
  READY --> OUT_FOR_DELIVERY: equipe (entrega)
  READY --> COMPLETED: equipe (retirada)
  READY --> CANCELED: equipe (motivo)
  OUT_FOR_DELIVERY --> COMPLETED: equipe (entregue)
  OUT_FOR_DELIVERY --> CANCELED: equipe (motivo)
  COMPLETED --> [*]
  REJECTED --> [*]
  CANCELED --> [*]
```

## Transições

| De                 | Para               | Quem    | Condição                               | Motivo obrigatório |
| ------------------ | ------------------ | ------- | -------------------------------------- | :----------------: |
| `PLACED`           | `PREPARING`        | STAFF+  | —                                      |                    |
| `PLACED`           | `REJECTED`         | STAFF+  | —                                      |         ✓          |
| `PLACED`           | `REJECTED`         | SYSTEM  | `acceptTimeoutMinutes` esgotado (Q-07) |  `ACCEPT_TIMEOUT`  |
| `PLACED`           | `CANCELED`         | Cliente | Ainda não aceito                       | `CUSTOMER_REQUEST` |
| `PREPARING`        | `READY`            | STAFF+  | —                                      |                    |
| `PREPARING`        | `CANCELED`         | STAFF+  | —                                      |         ✓          |
| `READY`            | `OUT_FOR_DELIVERY` | STAFF+  | `fulfillment = DELIVERY`               |                    |
| `READY`            | `COMPLETED`        | STAFF+  | `fulfillment = PICKUP`                 |                    |
| `READY`            | `CANCELED`         | STAFF+  | —                                      |         ✓          |
| `OUT_FOR_DELIVERY` | `COMPLETED`        | STAFF+  | —                                      |                    |
| `OUT_FOR_DELIVERY` | `CANCELED`         | STAFF+  | —                                      |         ✓          |

STAFF+ significa qualquer papel da pizzaria (STAFF, MANAGER, OWNER). Qualquer transição fora desta tabela é rejeitada com `ORDER_INVALID_TRANSITION`.

Regras gerais:

- A requisição informa o estado esperado (`from`). Se o pedido já mudou (outra pessoa da equipe agiu), a API retorna 409 e o painel recarrega. Isso evita aceitar e recusar o mesmo pedido em duas telas.
- Transições são idempotentes: repetir a mesma transição já aplicada retorna sucesso sem gravar novo histórico.
- Cada transição grava `OrderStatusChange` e, quando feita pela equipe, `AuditEvent`, na mesma transação.
- A ida para `COMPLETED` grava `BillingEntry` na mesma transação.
- Não há transição saindo de estados terminais. Correção de pedido concluído por engano é feita por estorno de cobrança, sem mudar o estado (ver [domain-model](../architecture/domain-model.md)).
- Recusa automática: job periódico (a cada minuto) por tenant, transição feita pelo ator `SYSTEM`.
- Suspensão do tenant não altera pedidos em andamento; a equipe OWNER ainda consegue concluí-los ou cancelá-los.

### Motivos

| Código                 | Uso                                            |
| ---------------------- | ---------------------------------------------- |
| `CUSTOMER_REQUEST`     | Cliente cancelou no app ou pediu por telefone. |
| `ITEM_UNAVAILABLE`     | Ingrediente ou produto acabou.                 |
| `STORE_TOO_BUSY`       | Pizzaria sem capacidade.                       |
| `OUT_OF_DELIVERY_AREA` | Endereço fora da área atendida.                |
| `CUSTOMER_UNREACHABLE` | Cliente não atendeu ou não estava no endereço. |
| `NOT_PICKED_UP`        | Retirada não realizada.                        |
| `SUSPECTED_FRAUD`      | Pedido suspeito (trote).                       |
| `ACCEPT_TIMEOUT`       | Exclusivo do sistema.                          |
| `OTHER`                | Exige texto livre de até 280 caracteres.       |

O cliente vê um texto amigável derivado do código, nunca o texto interno de `OTHER`.

## Cancelamento

- **Cliente:** só em `PLACED`, pelo app. Depois do aceite, o app mostra o telefone da pizzaria; a equipe cancela com `CUSTOMER_REQUEST` se concordar.
- **Pizzaria:** recusa em `PLACED` e cancelamento em `PREPARING`, `READY` e `OUT_FOR_DELIVERY`, sempre com motivo.
- **Financeiro:** como o pagamento é offline, cancelar não gera estorno no sistema. Pedidos cancelados ou recusados não geram `BillingEntry`.
- Taxa de cancelamento não existe no MVP.

## Acompanhamento e notificações

- App: tela do pedido com estado atual, linha do tempo (horários de cada transição) e previsão simples (`estimatedPrepMinutes` + `estimatedDeliveryMinutes`, sem cálculo de rota). Atualização por polling a cada 20 segundos enquanto a tela estiver aberta.
- Push ao cliente em cada mudança de estado depende da aprovação do Expo Push (Q-11).
- Painel: quadro com colunas por estado ativo (`PLACED`, `PREPARING`, `READY`, `OUT_FOR_DELIVERY`), polling a cada 10 segundos, alerta sonoro e destaque enquanto houver pedido em `PLACED`, contador de tempo desde a criação.

## Histórico

- Cliente: lista dos próprios pedidos, mais recentes primeiro, com paginação por cursor, detalhe com itens (do snapshot), totais e linha do tempo. Botão “pedir novamente” recria o carrinho com as configurações, revalidadas no catálogo atual.
- Equipe: listagem com filtros por data, estado, modo e número; detalhe com histórico completo de transições e autores.
- Relatório diário simples: quantidade e soma de `COMPLETED` por dia, separados por modo e forma de pagamento.
- Retenção: pedidos são mantidos enquanto o tenant estiver ativo e pelo prazo fiscal aplicável depois do encerramento (questão jurídica aberta). Exclusão de conta do cliente anonimiza os dados pessoais do pedido.

## Ocorrências

- Registradas pela equipe em qualquer pedido, até 30 dias depois de terminal, com tipo, descrição e estado (`OPEN`/`RESOLVED`).
- Não mudam o estado nem os valores do pedido e não geram reembolso; servem para atendimento e histórico.
- O cliente relata problemas pelos contatos da pizzaria; relato pelo app é questão aberta (OL-Q3).
- Não são ferramenta de logística: sem rastreio, roteirização ou gestão de entregador.

## Questões em aberto

| ID    | Questão                                         | Recomendação                                  |
| ----- | ----------------------------------------------- | --------------------------------------------- |
| Q-04  | Taxa de entrega                                 | Taxa fixa única, permitindo zero              |
| Q-05  | Pedido sem conta                                | Exigir conta no MVP; reavaliar após piloto    |
| Q-07  | Tempo para aceite antes de recusa automática    | Configurável, padrão 10 minutos               |
| OL-Q1 | Pizzaria pode editar itens de um pedido aceito? | Não; cancelar e o cliente refaz               |
| OL-Q2 | Corte de pedidos antes do fechamento            | Configurável, padrão 0 minuto                 |
| OL-Q3 | Cliente registra ocorrência pelo app            | Não no MVP                                    |
| OL-Q4 | Prazo legal de retenção de pedidos              | Validar com contador/jurídico antes do piloto |
