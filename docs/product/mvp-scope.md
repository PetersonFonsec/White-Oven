# Escopo do MVP

Este documento descreve o escopo de produto planejado. Os módulos do SaaS ainda não estão implementados, exceto pelas demonstrações da landing descritas abaixo.

## Primeira entrega comercial

A landing M0.1-A apresenta a visão comercial do WhiteOven, recursos planejados, uma demonstração interativa local do Pizza Builder, prévias ilustrativas do aplicativo/painel e, desde M0.1-B, formulário real de interesse com SQLite, consentimento auditável, attribution e proteção básica contra abuso. A captação precisa ser ativada/configurada. Analytics externo não implementado; existe adaptador de eventos locais sem PII.

O Builder demonstra pizza inteira ou meio a meio, ingredientes por metade e preços fictícios em reais. Meio a meio cobra o maior preço dos sabores. Não gera pedidos.

Os planos são condições preliminares: Flex sem mensalidade e 3% por venda paga pelo aplicativo; Pro a R$ 199/mês sem comissão WhiteOven. Ambos terão as mesmas funcionalidades no MVP. Taxas dos provedores de pagamento são separadas. Não há contratação disponível.

App Store e Google Play são indicadas como “Em breve”, sem links de download. Os aplicativos serão próprios de cada pizzaria, com publicação sujeita à análise das lojas.

## MVP de produto planejado

- Aplicativo Android e iOS com identidade visual configurável por pizzaria, baseado em React Native e Expo.
- Catálogo de pizzas, sabores e ingredientes.
- Pizza Builder visual com pizzas de dois sabores e ingredientes distribuídos por metade.
- Fluxo de pedidos para clientes e gestão de pedidos no painel.
- Painel Angular com dashboard, relatórios, gestão de cardápio e ingredientes, configurações do Builder, editor white label, financeiro e pagamentos, clientes, fidelidade e recompensas.
- Registro e histórico de ocorrências relacionadas a pedidos, incluindo problemas informados na entrega.
- Backend NestJS com MikroORM e PostgreSQL.

## Restrições e exclusões

- Não haverá logística, cálculo de frete, roteirização, gestão de entregadores ou rastreamento.
- Ocorrências de entrega são registros de atendimento ligados a pedidos; não são ferramentas de logística.
- M0.1-B implementa somente o endpoint temporário de captação Astro e SQLite. Não implementa API NestJS, PostgreSQL SaaS, autenticação, pagamentos, CRM, mensagens automáticas ou deploy. M1 requer nova aprovação.
- Não criar aplicações futuras vazias apenas para preencher diretórios.
