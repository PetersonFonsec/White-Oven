# WhiteOven

Plataforma SaaS white label planejada para pizzarias. A milestone **M0.1-A** implementa uma landing comercial Astro com demonstração local do Pizza Builder, planos preliminares e formulário de interesse com envio desabilitado. Aplicativos mobile, painel administrativo e backend continuam planejados.

## Requisitos

- Node.js 22 LTS (22.12 ou superior) ou 24 LTS; CI fixada em 22.23.2
- pnpm 11.25.0 (o campo `packageManager` permite ativação via Corepack quando necessário)

## Começar

```sh
pnpm install
pnpm dev
```

## Comandos na raiz

| Comando          | Descrição                                                                      |
| ---------------- | ------------------------------------------------------------------------------ |
| `pnpm dev`       | Inicia a landing page Astro em modo de desenvolvimento.                        |
| `pnpm build`     | Gera o site estático em `apps/landing/dist`.                                   |
| `pnpm typecheck` | Verifica os componentes e tipos Astro/TypeScript.                              |
| `pnpm lint`      | Executa ESLint nos arquivos do workspace.                                      |
| `pnpm format`    | Formata os arquivos compatíveis com Prettier.                                  |
| `pnpm test`      | Testa seleção de sabores e preço demonstrativo com o test runner do Node.      |
| `pnpm test:e2e`  | Gera o build e verifica a integração DOM/SVG em desktop/mobile com Playwright. |
| `pnpm check`     | Verifica formatação, lint e tipos.                                             |

## Estrutura

- `apps/landing`: landing page Astro, a única aplicação implementada; inclui demos executadas no navegador.
- `packages/design-tokens`: identidade visual compartilhada; veja [diretrizes visuais](docs/architecture/design-system.md).
- `packages/contracts`: espaço para contratos compartilhados quando houver consumidores; sem contratos de produto nesta milestone.
- `docs/product`: visão e escopo planejado.
- `docs/architecture`: arquitetura atual e planejada.
- `docs/adr`: decisões arquiteturais.

O build estático poderá ser servido pelo Caddy em uma milestone futura. M0 não configura deploy nem altera a infraestrutura da Orbia. Consulte [docs/product/mvp-scope.md](docs/product/mvp-scope.md) para o estado dos recursos e suas exclusões.

## Estado e validação

A fundação M0 foi incorporada em `main`. O histórico de validação local está em [M0](docs/architecture/m0-validation.md). A implementação e os limites da landing atual estão em [M0.1-A](docs/architecture/m0-1a-landing.md).

Execute `pnpm check`, `pnpm test` e `pnpm build`. O workflow CI executa as mesmas verificações, após instalação congelada pelo lockfile. O formulário não envia ou salva dados; as escolhas do Builder existem apenas em memória. Nenhuma API, analytics ou integração de pagamentos foi adicionada.

## Testes de navegador e revisão visual

Instale o navegador com `pnpm exec playwright install chromium` e execute `pnpm test:e2e`. Os testes iniciam e encerram o preview local automaticamente. A CI usa Chromium com suas dependências Linux. Capturas e instruções de reprodução estão em [docs/design](docs/design/README.md). A aprovação de fidelidade à referência visual está pendente do asset solicitado nesse documento.
