# ADR 0001: Monorepo com pnpm workspaces

- **Status:** Aceito
- **Data:** 2026-10-23

## Contexto

WhiteOven terá aplicações web e mobile e um backend, além de contratos compartilhados. No início, porém, somente a landing page está no escopo. Precisamos compartilhar configuração e documentação sem criar projetos futuros vazios.

## Decisão

Usar um monorepo com pnpm workspaces. A landing fica em `apps/landing`; contratos compartilhados poderão ficar em `packages/contracts` quando forem necessários. Outras aplicações serão adicionadas nas milestones que as implementarem.

## Consequências

- Scripts comuns e CI podem ser executados a partir da raiz.
- Dependências e limites entre aplicações ficam visíveis em um único repositório.
- Não há custo de manutenção de aplicações sem uso.
- Requisitos de build, publicação independente e ownership poderão motivar ajustes futuros, documentados em novas ADRs.
