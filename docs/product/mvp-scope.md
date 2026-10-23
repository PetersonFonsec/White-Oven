# Escopo do MVP

Este documento descreve o escopo de produto planejado. Os itens abaixo ainda não estão implementados em M0, exceto onde indicado.

## Primeira entrega comercial

A landing page estática apresenta a visão do WhiteOven e ajuda a comunicar a proposta para validar demanda. Em M0 ela não possui formulário, analytics ou captação de leads.

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
- M0 não implementa backend, autenticação, persistência, pagamentos, captação de leads ou deploy de produção.
- Não criar aplicações futuras vazias apenas para preencher diretórios.
