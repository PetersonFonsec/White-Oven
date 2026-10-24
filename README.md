# WhiteOven

SaaS white label planejado para pizzarias. **M0** entregou a landing Astro, o Pizza Builder demonstrativo, a captação real de interesse com SQLite local e o empacotamento Docker/Compose. **M1.1** inicia a API NestJS em `apps/api` (configuração validada, `/health`, logs estruturados, erro padronizado e OpenAPI), ainda sem banco, tenants ou autenticação. Nenhum deploy real foi feito. Angular, React Native/Expo, pagamentos e onboarding continuam planejados.

## Requisitos e início local

Node.js 22 LTS (22.12+) ou 24 LTS e pnpm 11.25.0; CI usa Node 22.23.2. SQLite requer addon nativo: se não houver binário para sua plataforma, a instalação usa compilador C/C++ e Python via node-gyp. Não ignore os scripts de instalação autorizados em `pnpm-workspace.yaml`.

```sh
pnpm install --frozen-lockfile
cp apps/landing/.env.example apps/landing/.env
# Preencha controlador real e e-mail de privacidade; então LEADS_ENABLED=true.
pnpm dev
```

Abra `http://localhost:4321`. Sem configuração completa, o formulário permanece indisponível. O arquivo `.env` é ignorado pelo Git e carregado pelos comandos dev/start/CLI; variáveis já presentes no processo têm prioridade. Use somente dados sintéticos em testes locais.

## Comandos na raiz

| Comando                                           | Descrição                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm dev`                                        | Servidor Astro de desenvolvimento.                                                 |
| `pnpm build`                                      | Landing pré-renderizada em `apps/landing/dist/client` e servidor em `dist/server`. |
| `pnpm start`                                      | Inicia o build Astro pelo inicializador Node com limites de conexão, após build.   |
| `pnpm check`                                      | Formatação, ESLint e tipos strict de todos os pacotes.                             |
| `pnpm test`                                       | Testes de todos os pacotes (landing, API) e dos scripts de operação.               |
| `pnpm api:dev`                                    | Compila e sobe a API em `http://127.0.0.1:3000`.                                   |
| `pnpm test:e2e`                                   | Build + Playwright desktop/mobile com servidor e banco sintéticos.                 |
| `pnpm leads inspect`                              | Lista IDs, datas, plano e volume, sem nome ou WhatsApp.                            |
| `pnpm leads export .data/lead-exports/leads.json` | Exportação JSON restrita, sem sobrescrever arquivo existente.                      |
| `pnpm leads purge`                                | Exclui dados expirados.                                                            |
| `pnpm leads delete <uuid>`                        | Exclui um cadastro e suas chaves de retry.                                         |
| `pnpm leads clear-dev --confirm`                  | Limpa somente banco cujo nome é `leads.dev.sqlite`, fora de produção.              |

Instale Chromium com `pnpm exec playwright install chromium`. Alternativamente, com Chrome instalado: `WHITEOVEN_BROWSER_CHANNEL=chrome pnpm test:e2e`. A CI instala Chromium com dependências Linux. O banco E2E `.data/leads.e2e.sqlite` é separado do banco local, usa identidade sintética e pode ser removido com o servidor parado.

## Estrutura e operação

- `apps/landing`: interface, endpoint Astro `/api/leads`, política `/privacidade` e persistência temporária.
- `apps/api`: API NestJS. Configuração em `apps/api/.env.example`; OpenAPI em `/v1/openapi.json` fora de produção. Decisões no [ADR 0004](docs/adr/0004-api-foundation.md).
- `packages/contracts`: contrato e validação isomórfica do lead, sem dependências de servidor.
- `packages/design-tokens`: identidade visual reutilizável.
- `docs/product`, `docs/architecture`, `docs/adr`: estado do produto e decisões.

Use `pnpm start`, que aplica limites HTTP, identifica clientes pela conexão e ignora cabeçalhos de encaminhamento não confiáveis. Origem pública exige `LEADS_TRUSTED_PROXIES` com IPs exatos do último proxy e substituição de `X-Forwarded-For`; consulte o runbook. Executar o entrypoint Astro diretamente em produção mantém a captação bloqueada.

O build agora **exige processo Node para captação e política dinâmica**; servir apenas arquivos estáticos não oferece esse fluxo. A decisão e as alternativas estão no [ADR 0002](docs/adr/0002-lead-capture.md). Veja [operação, privacidade e métricas](docs/architecture/m0-1b-lead-capture.md). Caddy poderá atuar como reverse proxy em uma milestone futura; não há deploy nem alterações de infraestrutura Orbia nesta entrega.

A CI usa instalação congelada, formatação, lint, typecheck, testes de domínio/endpoint, build e E2E. As decisões de M0 e M0.1-A estão mantidas como registros históricos; não descrevem o formulário atual. A captação não envia mensagens automáticas, e o adaptador de analytics atual emite apenas eventos locais sem PII, sem fornecedor externo.

## Deploy e operação — M0.2

Consulte o [runbook](docs/operations/landing-deployment.md) antes de executar comandos de infraestrutura. `Dockerfile` multi-stage compila addons para Linux, executa como UID 1000 e preserva o inicializador seguro. `compose.yaml` mantém dados/backups em volumes e publica Node somente em loopback. Caddy é exemplo opcional separado, sem domínio ou servidor presumido.

`/health/live` verifica HTTP; `/health/ready` distingue prontidão, captação e armazenamento sem gravar no banco. Scripts de atualização/rollback preservam o banco atual; restauração é offline e explícita. Backup usa a API online do SQLite, com integridade, prazo e diário de exclusões.

Teste de containers (Docker obrigatório): `node --experimental-strip-types tests/deployment/containers.mjs`. Cria e remove somente recursos sintéticos identificados por projeto aleatório. CI executa essa suíte e os checks existentes; após merge em main, publica a imagem testada no GHCR com tag SHA, sem deploy automático. GHCR/HTTPS público e o destino real só serão verificados após configuração futura autorizada.

## API em desenvolvimento — M1.1

```sh
pnpm api:dev                                    # local, porta 3000
docker compose -f compose.dev.yaml up --build api   # container, loopback 127.0.0.1:3000
curl http://127.0.0.1:3000/health               # {"status":"ok"}
```

Configuração inválida (por exemplo `API_PORT=abc`) encerra o processo com código 1 antes de abrir a porta. `compose.dev.yaml` é só para desenvolvimento; PostgreSQL entra nele em M1.2. O `compose.yaml` de produção continua servindo apenas a landing.
