# Visão de arquitetura

## Estado atual — M0.1-A

O repositório usa pnpm workspaces. `apps/landing` contém uma landing page Astro com TypeScript strict e saída estática. `packages/contracts` é apenas o espaço reservado para contratos compartilhados quando houver um consumidor real; ainda não define contratos de produto. O build gera arquivos em `apps/landing/dist`. Componentes Astro renderizam o conteúdo estático; scripts TypeScript pequenos cuidam do menu, seleção de planos e Builder sem frameworks adicionais. A lógica de preço e seleção em `src/lib/pizza.ts` é testada pelo test runner nativo do Node.

## Arquitetura planejada

- **Landing:** Astro e TypeScript, exportação estática, preparada para ser servida pelo Caddy em uma milestone de deploy.
- **Aplicativos de clientes:** React Native com Expo, compilação Android e iOS a partir de uma base white label compartilhada.
- **Painel administrativo:** Angular para operação da plataforma e das pizzarias.
- **Backend:** NestJS, MikroORM e PostgreSQL, com isolamento multi-tenant definido antes da implementação dos fluxos de negócio.
- **Infraestrutura inicial:** Docker Compose em VPS Ubuntu da Hostinger e Caddy como reverse proxy.
- **CI/CD:** GitHub Actions para instalar dependências, verificar formatação, lint, tipos e testes, e compilar a landing.

## Limites importantes

A landing tem build estático, com interações locais no navegador. O formulário de interesse é somente um protótipo desabilitado. Não há backend, banco, autenticação, integrações, analytics ou submissão de leads. A infraestrutura existente da Orbia não faz parte deste projeto e não deve ser alterada. Não estão planejadas funções de logística, frete, roteirização, entregadores ou rastreamento.

Detalhes de isolamento de tenant, autenticação, pagamentos, observabilidade, segurança e deploy serão decididos em ADRs quando as milestones correspondentes tiverem requisitos concretos.
