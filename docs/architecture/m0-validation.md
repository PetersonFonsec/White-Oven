# Validação da M0

Data: 2026-10-23. A M0 continua pendente de validação remota e versionamento.

## Correções

- Corrigido o pacote ESLint para `eslint-plugin-astro` e sua configuração flat.
- Adicionado `prettier-plugin-astro` e parser Astro; aplicado o formatador.
- Ativado ESM na raiz e integrado `eslint-config-prettier` ao ESLint.
- Declarado TypeScript diretamente na raiz para os consumidores de lint.
- Alinhados engines (Node 22.12+ na linha 22 ou Node 24; pnpm 11.25.0) e CI (Node 22.23.2).
- Autorizados somente os scripts de instalação necessários de esbuild e sharp no pnpm 11.
- Gerado `pnpm-lock.yaml` pelo pnpm, sem edição manual.
- CI instala pnpm antes das dependências, usa instalação congelada e executa formatação, lint, tipos e build em etapas que falham em caso de erro.

## Resultados observados

O DNS do registry falhou dentro do sandbox. A instalação com permissão de rede alcançou o npm e gerou o lockfile. A primeira instalação terminou com erro de scripts bloqueados; após configurar `allowBuilds`, `pnpm install --frozen-lockfile` passou com pnpm 11.25.0 (o ambiente com permissão ampliada utiliza Node 24.19.0).

`pnpm format`, `pnpm lint`, `pnpm typecheck` e `pnpm build` passaram. Astro 5.18.2 retornou zero erros, avisos e hints no typecheck e gerou uma página estática em `apps/landing/dist`. Shell de validação: Node 22.23.2. `pnpm list --depth 0 -r` encontrou restrição SQLite do store no sandbox; isso não impediu lint, tipos ou build.

A tentativa de criar `codex/feat-whiteoven-monorepo` falhou por escrita bloqueada em `.git`. `gh auth status` reportou token inválido; nenhum token foi exibido. As alterações e o lockfile continuam sem commit em `main`. Nenhuma PR foi criada e nenhuma execução remota da CI foi confirmada.

`pnpm format:check` e `git diff --check` passaram na revisão final. `pnpm dev --host 127.0.0.1` iniciou com permissão ampliada e uma consulta HTTP no mesmo ambiente retornou `200 OK`; o servidor foi encerrado após a verificação. O sandbox havia bloqueado a abertura da porta (`EPERM`).

## Concluir localmente

Execute na raiz do checkout com acesso ao npm, escrita no Git e autenticação do GitHub:

```sh
git switch -c codex/feat-whiteoven-monorepo
pnpm install --frozen-lockfile
pnpm check
pnpm build
git diff --check
git add README.md AGENTS.md package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json eslint.config.js .npmrc .gitignore .prettierignore .prettierrc.json .github apps packages docs
git commit -m "feat: bootstrap WhiteOven monorepo"
gh auth login --hostname github.com
git push -u origin codex/feat-whiteoven-monorepo
gh pr create --base main --title "feat: bootstrap WhiteOven monorepo" --body-file docs/architecture/m0-pr.md
gh run list --workflow ci.yml --branch codex/feat-whiteoven-monorepo --limit 1
```

Acompanhe a execução mostrada com `gh run watch ID_DA_EXECUCAO --exit-status`. Só considerar a M0 validada depois de o lockfile estar commitado e o workflow terminar com sucesso. Não iniciar M0.1 automaticamente.
