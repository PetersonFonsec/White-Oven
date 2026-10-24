# Escopo do MVP

Status: especificação M0.3, sem implementação. Os módulos do SaaS ainda não existem; apenas a landing, a demonstração do Pizza Builder e a captação de interesse estão implementadas (M0.1-B). Este documento define o que o primeiro MVP comercial deve entregar, o que fica fora e quais decisões de produto continuam abertas.

Documentos relacionados: [visão](vision.md), [regras do Pizza Builder](pizza-builder-rules.md), [ciclo de vida do pedido](order-lifecycle.md), [arquitetura do sistema](../architecture/system-overview.md), [modelo de domínio](../architecture/domain-model.md), [isolamento de tenants](../architecture/tenant-isolation.md) e [roadmap](../architecture/mvp-roadmap.md).

## Estado atual da landing (implementado)

A landing M0.1-A apresenta a visão comercial do WhiteOven, recursos planejados, uma demonstração interativa local do Pizza Builder, prévias ilustrativas do aplicativo/painel e, desde M0.1-B, formulário real de interesse com SQLite, consentimento auditável, attribution e proteção básica contra abuso. A captação precisa ser ativada/configurada. Analytics externo não implementado; existe adaptador de eventos locais sem PII.

O Builder da landing demonstra pizza inteira ou meio a meio, ingredientes por metade e preços fictícios em reais. Meio a meio cobra o maior preço dos sabores. Não gera pedidos. No MVP essa regra passa a ser uma das estratégias configuráveis por pizzaria (ver [regras do Pizza Builder](pizza-builder-rules.md)).

Os planos são condições preliminares: Flex sem mensalidade e 3% por venda paga pelo aplicativo; Pro a R$ 199/mês sem comissão WhiteOven. Ambos terão as mesmas funcionalidades no MVP. Taxas dos provedores de pagamento são separadas. Não há contratação disponível.

App Store e Google Play são indicadas como “Em breve”, sem links de download. Os aplicativos serão próprios de cada pizzaria, com publicação sujeita à análise das lojas.

## Objetivo do MVP

Permitir que uma pizzaria piloto receba pedidos reais pelo próprio aplicativo com sua marca, com cardápio e Pizza Builder de dois sabores configurados no painel, e que o WhiteOven registre os dados necessários para cobrar Flex ou Pro no futuro, sem cobrar nem processar pagamentos online ainda.

Critério de sucesso do MVP: uma pizzaria piloto opera um período combinado recebendo pedidos de entrega e retirada pelo aplicativo, sem vazamento de dados entre tenants e com preços calculados de forma idêntica no aplicativo, na API e no painel.

## Usuários

| Ator                       | Canal                  | Objetivo no MVP                                                          |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| Cliente final              | Aplicativo da pizzaria | Montar pizzas, fazer pedido, acompanhar status e ver histórico.          |
| Dono da pizzaria (OWNER)   | Painel Angular         | Configurar marca, cardápio, preços, horários, equipe e operar pedidos.   |
| Gerente (MANAGER)          | Painel Angular         | Manter cardápio, disponibilidade e pedidos.                              |
| Atendente (STAFF)          | Painel Angular         | Aceitar, preparar, despachar, cancelar pedidos e registrar ocorrências.  |
| Operador WhiteOven         | Painel Angular         | Criar tenants, convidar o dono, suspender tenant, consultar faturamento. |
| Suporte WhiteOven (futuro) | Painel Angular         | Acesso assistido e auditado; fora do MVP inicial (ver questões).         |

## Funcionalidades essenciais (dentro do MVP)

### Plataforma e multi-tenancy

- Cadastro de pizzaria (tenant) pelo operador WhiteOven, com convite do dono por e-mail.
- Isolamento de dados por tenant em todas as camadas ([estratégia](../architecture/tenant-isolation.md)).
- Usuários da equipe com papéis OWNER, MANAGER e STAFF por tenant.
- Suspensão de tenant: bloqueia novos pedidos, configuração e acesso de MANAGER/STAFF, recusa pedidos ainda não aceitos e deixa o OWNER apenas ler e encerrar pedidos em andamento; preserva dados.
- Trilha de auditoria de ações administrativas.

### Catálogo e cardápio

- Categorias ordenáveis.
- Tamanhos de pizza com fatias e número máximo de sabores (1 ou 2).
- Sabores com descrição, ingredientes, imagem e preço por tamanho.
- Bordas com preço por tamanho.
- Adicionais com preço por tamanho para pizza inteira e para meia pizza.
- Remoção de ingredientes marcados como removíveis, sem alteração de preço.
- Produtos simples (bebidas, sobremesas) com preço único.
- Disponibilidade imediata (ativar/esgotar) por item.
- Imagens de sabores, produtos e marca.

### Pizza Builder

- Pizza inteira ou de dois sabores, com cada metade visualmente distinta.
- Adicionais e remoções por metade ou na pizza inteira.
- Estratégia de preço de meio a meio configurável por pizzaria.
- Mesmo motor de preço no aplicativo, na API e no painel, com a API como autoridade.

Regras completas em [pizza-builder-rules.md](pizza-builder-rules.md).

### Pedidos

- Carrinho local no aplicativo, com revalidação de preço e disponibilidade no servidor.
- Checkout com entrega (endereço digitado) ou retirada.
- Taxa de entrega fixa por pizzaria (ver questões abertas) e pedido mínimo opcional.
- Pagamento na entrega/retirada (dinheiro com troco, cartão na maquininha, Pix presencial), apenas registrado.
- Horário de funcionamento semanal, exceções por data e pausa manual de recebimento.
- Estados do pedido, histórico de transições, cancelamento e recusa com motivo.
- Quadro de pedidos no painel com atualização automática e alerta sonoro.
- Ocorrências ligadas a pedidos (por exemplo, problema informado na entrega).
- Histórico de pedidos do cliente no aplicativo.

Regras completas em [order-lifecycle.md](order-lifecycle.md).

### White label

- Nome, logotipo, ícone, splash, cores e imagens por pizzaria, a partir de uma única base de código.
- Tema aplicado em runtime no aplicativo; identidade de loja (nome, ícone, bundle) aplicada em build por tenant.
- Validação de contraste das cores antes de publicar o tema.

### Cobrança (somente dados)

- Plano vigente por tenant (Flex ou Pro) com histórico de mudanças.
- Registro imutável de eventos faturáveis por pedido concluído e estornos.
- Relatório mensal por tenant para conferência, sem emissão de cobrança.

## Fora do MVP

Exclusões firmes (já decididas em documentos anteriores):

- Logística, cálculo de frete por distância, roteirização, gestão de entregadores e rastreamento.
- Ocorrências de entrega são registros de atendimento; não são ferramentas de logística.
- Criar aplicações futuras vazias apenas para preencher diretórios.

Exclusões recomendadas nesta especificação (dependem de confirmação do Product Owner, ver questões abertas):

- Pagamento online no aplicativo (cartão, Pix com confirmação automática) e cobrança efetiva dos planos.
- Fidelidade, recompensas, cupons e promoções. O escopo anterior listava fidelidade e recompensas no painel; recomendamos movê-las para depois do piloto porque dependem do fluxo de pedidos estável e não são necessárias para validar o produto.
- Pizzas com três ou mais sabores.
- Pedidos agendados para outro horário.
- Múltiplas unidades (filiais) por pizzaria.
- Domínio próprio da pizzaria e cardápio web/PWA.
- Integrações com marketplaces, impressoras fiscais/térmicas e ERPs.
- Emissão de nota fiscal.
- Notificações por WhatsApp ou SMS.
- Relatórios avançados e dashboards analíticos; o MVP terá apenas totais diários e listagem de pedidos.
- Suporte com acesso assistido (impersonação) a dados de tenants.

## Questões de produto em aberto

Cada questão tem recomendação, mas nenhuma está decidida. As milestones que dependem de cada uma estão no [roadmap](../architecture/mvp-roadmap.md).

| ID   | Questão                                                                                   | Alternativas                                                        | Recomendação                                                                              |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Q-01 | O Flex cobra 3% sobre pedidos pagos na entrega, ou só sobre “venda paga pelo aplicativo”? | Só online; todos os pedidos concluídos; mínimo fixo mensal          | Registrar todos os pedidos concluídos com método de pagamento; decidir a base antes de M6 |
| Q-02 | Base de cálculo dos 3%: itens, itens + taxa de entrega, ou total pago?                    | Subtotal de itens; total                                            | Registrar componentes separados; recomendação inicial: subtotal de itens                  |
| Q-03 | Pagamento online entra no MVP?                                                            | Sim (com PSP); não (só offline)                                     | Não no piloto; avaliar PSP em ADR própria                                                 |
| Q-04 | Taxa de entrega                                                                           | Sem taxa; taxa fixa única; taxa por bairro                          | Taxa fixa única, permitindo zero                                                          |
| Q-05 | Login do cliente                                                                          | Pedido sem conta; e-mail + senha; código por e-mail; código por SMS | E-mail + senha com recuperação por e-mail; avaliar pedido sem conta                       |
| Q-06 | Estratégia padrão de preço meio a meio                                                    | Maior preço; média; média + taxa                                    | Maior preço como padrão (igual à landing), configurável                                   |
| Q-07 | Tempo para a pizzaria aceitar antes de recusa automática                                  | Sem limite; limite configurável                                     | Configurável, padrão 10 minutos                                                           |
| Q-08 | Fidelidade/recompensas no MVP?                                                            | Sim; depois do piloto                                               | Depois do piloto                                                                          |
| Q-09 | Quem publica os apps nas lojas e quem paga as contas de desenvolvedor?                    | Conta da pizzaria; conta WhiteOven                                  | Conta da pizzaria (exigência provável da Apple), com operação feita pelo WhiteOven        |
| Q-10 | Troca de plano no meio do mês, período de teste, inadimplência e cancelamento             | Pró-rata; troca só no ciclo seguinte                                | Troca vale no ciclo seguinte                                                              |
| Q-11 | Notificações push aos clientes (Expo Push é serviço externo)                              | Sem push; Expo Push; FCM/APNs direto                                | Expo Push, após aprovação do fornecedor                                                   |
| Q-12 | Provedor de e-mail transacional (convites, recuperação de senha)                          | Provedor SMTP/API a escolher                                        | Escolher em ADR antes de M1.4                                                             |
| Q-13 | Armazenamento de imagens                                                                  | Volume local na VPS; armazenamento S3 compatível                    | Abstração de storage com volume local no piloto                                           |
