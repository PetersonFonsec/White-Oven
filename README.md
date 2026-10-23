# WhiteOven

Plataforma SaaS white label planejada para pizzarias. O repositório está na milestone **M0 — Fundação**: hoje contém a base do monorepo e uma landing page estática de apresentação. Os aplicativos, painel e backend descritos na documentação são planejados, ainda não implementados.

## Requisitos

- Node.js 22 LTS (22.12 ou superior) ou 24 LTS; CI fixada em 22.23.2
- pnpm 11.25.0 (o campo `packageManager` permite ativação via Corepack quando necessário)

## Começar

```sh
pnpm install
pnpm dev
```

## Comandos na raiz

| Comando          | Descrição                                               |
| ---------------- | ------------------------------------------------------- |
| `pnpm dev`       | Inicia a landing page Astro em modo de desenvolvimento. |
| `pnpm build`     | Gera o site estático em `apps/landing/dist`.            |
| `pnpm typecheck` | Verifica os componentes e tipos Astro/TypeScript.       |
| `pnpm lint`      | Executa ESLint nos arquivos do workspace.               |
| `pnpm format`    | Formata os arquivos compatíveis com Prettier.           |
| `pnpm check`     | Verifica formatação, lint e tipos.                      |

## Estrutura

- `apps/landing`: landing page Astro, a única aplicação implementada em M0.
- `packages/design-tokens`: identidade visual compartilhada; veja [diretrizes visuais](docs/architecture/design-system.md).
- `packages/contracts`: espaço para contratos compartilhados quando houver consumidores; sem contratos de produto nesta milestone.
- `docs/product`: visão e escopo planejado.
- `docs/architecture`: arquitetura atual e planejada.
- `docs/adr`: decisões arquiteturais.

O build estático poderá ser servido pelo Caddy em uma milestone futura. M0 não configura deploy nem altera a infraestrutura da Orbia. Consulte [docs/product/mvp-scope.md](docs/product/mvp-scope.md) para o estado dos recursos e suas exclusões.

## Validação da M0

O lockfile real está presente. A instalação congelada, lint, typecheck e build passaram localmente. O commit do lockfile, a PR e uma execução bem-sucedida da CI ainda estão pendentes por restrição de escrita em `.git` e autenticação do GitHub CLI. Veja [registro de validação](docs/architecture/m0-validation.md).
