# Visão de arquitetura

## Estado atual — M0.2

Monorepo pnpm, Astro/TypeScript strict, homepage pré-renderizada e scripts pequenos para menu, Builder e formulário. `packages/contracts` define o contrato validado no navegador e servidor. Captação usa endpoint Astro Node e SQLite local com transações, idempotência, consentimento auditável e attribution. A política de privacidade é renderizada com configuração runtime. O build contém `dist/client` e `dist/server`; requer processo Node. Analytics é somente um adaptador de eventos locais sem PII, sem fornecedor externo. Veja [ADR 0002](../adr/0002-lead-capture.md) e [operação](m0-1b-lead-capture.md).

M0.2 adiciona imagem Docker multi-stage, Compose de uma instância, exemplo opcional Caddy, endpoints de saúde e operação controlada de dados/imagens. Publicação GHCR é preparada para ocorrer após checks em main; deploy real continua pendente. Veja [ADR 0003](../adr/0003-landing-deployment.md) e [runbook](../operations/landing-deployment.md).

## Arquitetura planejada

- **Landing:** Astro e TypeScript, homepage pré-renderizada e endpoint Node atrás de reverse proxy Caddy em milestone futura.
- **Aplicativos de clientes:** React Native com Expo, compilação Android e iOS a partir de uma base white label compartilhada.
- **Painel administrativo:** Angular para operação da plataforma e das pizzarias.
- **Backend:** NestJS, MikroORM e PostgreSQL, com isolamento multi-tenant definido antes da implementação dos fluxos de negócio.
- **Infraestrutura inicial:** Docker Compose em VPS Ubuntu da Hostinger e Caddy como reverse proxy.
- **CI/CD:** GitHub Actions para instalar dependências, verificar formatação, lint, tipos e testes, e compilar a landing.

## Limites importantes

Além da captação temporária, M1.1 adiciona a fundação da API NestJS em `apps/api` ([ADR 0004](../adr/0004-api-foundation.md)): `/health`, configuração validada, logs estruturados, erro padronizado e OpenAPI, sem banco nem rotas de negócio. Não há tenants, autenticação, pagamentos ou deploy de produção. A infraestrutura Orbia não faz parte deste projeto. Logística, frete, roteirização, entregadores e rastreamento estão excluídos.

Detalhes de isolamento de tenant, autenticação, pagamentos, observabilidade, segurança e deploy serão decididos em ADRs quando as milestones correspondentes tiverem requisitos concretos.
