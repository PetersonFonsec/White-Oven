# Visão de arquitetura

## Estado atual — M0

O repositório usa pnpm workspaces. `apps/landing` contém uma landing page Astro com TypeScript strict e saída estática. `packages/contracts` é apenas o espaço reservado para contratos compartilhados quando houver um consumidor real; ainda não define contratos de produto. O build gera arquivos em `apps/landing/dist`.

## Arquitetura planejada

- **Landing:** Astro e TypeScript, exportação estática, preparada para ser servida pelo Caddy em uma milestone de deploy.
- **Aplicativos de clientes:** React Native com Expo, compilação Android e iOS a partir de uma base white label compartilhada.
- **Painel administrativo:** Angular para operação da plataforma e das pizzarias.
- **Backend:** NestJS, MikroORM e PostgreSQL, com isolamento multi-tenant definido antes da implementação dos fluxos de negócio.
- **Infraestrutura inicial:** Docker Compose em VPS Ubuntu da Hostinger e Caddy como reverse proxy.
- **CI/CD:** GitHub Actions para instalar dependências, verificar formatação, lint e tipos, e compilar a landing.

## Limites importantes

A landing de M0 é somente estática. Não há backend, banco, autenticação, integrações, analytics ou submissão de leads. A infraestrutura existente da Orbia não faz parte deste projeto e não deve ser alterada. Não estão planejadas funções de logística, frete, roteirização, entregadores ou rastreamento.

Detalhes de isolamento de tenant, autenticação, pagamentos, observabilidade, segurança e deploy serão decididos em ADRs quando as milestones correspondentes tiverem requisitos concretos.
