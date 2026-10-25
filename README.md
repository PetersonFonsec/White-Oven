# WhiteOven

SaaS white label planejado para pizzarias. **M0** entregou a landing Astro, o Pizza Builder demonstrativo, a captação real de interesse com SQLite local e o empacotamento Docker/Compose. **M1.1–M1.5** entregaram fundação da API, PostgreSQL, isolamento tenant, autenticação/MFA e operações de plataforma. **M2.1–M2.5** entregaram contratos, motor de preço, catálogo administrativo e storage autenticado de imagens; **M2.6** está em revisão com o cardápio público por loja e cache por versão do catálogo. Nenhum deploy real foi feito. Angular, React Native/Expo, pagamentos e onboarding continuam planejados.

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
| `pnpm db:up`                                      | Sobe o PostgreSQL de desenvolvimento (`compose.dev.yaml`) em `127.0.0.1:5432`.     |
| `pnpm api:migrate`                                | Aplica as migrations como `whiteoven_owner` (`apps/api/.env.migrate`).             |
| `pnpm test:e2e`                                   | Build + Playwright desktop/mobile com servidor e banco sintéticos.                 |
| `pnpm leads inspect`                              | Lista IDs, datas, plano e volume, sem nome ou WhatsApp.                            |
| `pnpm leads export .data/lead-exports/leads.json` | Exportação JSON restrita, sem sobrescrever arquivo existente.                      |
| `pnpm leads purge`                                | Exclui dados expirados.                                                            |
| `pnpm leads delete <uuid>`                        | Exclui um cadastro e suas chaves de retry.                                         |
| `pnpm leads clear-dev --confirm`                  | Limpa somente banco cujo nome é `leads.dev.sqlite`, fora de produção.              |

Instale Chromium com `pnpm exec playwright install chromium`. Alternativamente, com Chrome instalado: `WHITEOVEN_BROWSER_CHANNEL=chrome pnpm test:e2e`. A CI instala Chromium com dependências Linux. O banco E2E `.data/leads.e2e.sqlite` é separado do banco local, usa identidade sintética e pode ser removido com o servidor parado.

## Estrutura e operação

- `apps/landing`: interface, endpoint Astro `/api/leads`, política `/privacidade` e persistência temporária.
- `apps/api`: API NestJS. Configuração em `apps/api/.env.example` (API) e `apps/api/.env.migrate.example` (migrations); OpenAPI em `/v1/openapi.json` fora de produção. Decisões nos ADRs [0004](docs/adr/0004-api-foundation.md), [0005](docs/adr/0005-database-roles-migrations.md) e [0006](docs/adr/0006-tenant-isolation.md).
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

## API em desenvolvimento — M1.1 a M1.4

```sh
docker compose -f compose.dev.yaml up --build api   # postgres → migrate → api, loopback 127.0.0.1:3000
curl http://127.0.0.1:3000/health               # liveness: {"status":"ok"}
curl http://127.0.0.1:3000/health/ready         # prontidão: exige o banco

# Sem container para a API:
pnpm db:up
cp apps/api/.env.migrate.example apps/api/.env.migrate && pnpm api:migrate
cp apps/api/.env.example apps/api/.env && pnpm api:dev
```

A API conecta apenas como `whiteoven_app` (sem `BYPASSRLS` e sem DDL); as migrations rodam em processo separado como `whiteoven_owner`. Configuração inválida (por exemplo `API_PORT=abc`), credencial de dono no ambiente da API, papel de banco inseguro ou banco inacessível encerram o processo com código 1 antes de abrir a porta. Testes de integração da API usam PostgreSQL real: com `pnpm db:up`, rode `TEST_DATABASE_OWNER_URL=postgres://whiteoven_owner:whiteoven-dev-owner-password@127.0.0.1:5432/whiteoven pnpm test`; sem a variável essas suítes são puladas localmente e falham na CI. Dados de pizzarias ficam isolados por RLS forçado: toda tabela com `tenant_id` segue o padrão do [ADR 0006](docs/adr/0006-tenant-isolation.md) e entra nos testes de isolamento. A equipe autentica em `/v1/admin/auth` ([ADR 0007](docs/adr/0007-staff-authentication.md)); em produção a API exige `AUTH_ACCESS_TOKEN_PRIVATE_KEY` (Ed25519 PKCS#8 DER em base64), `AUTH_MFA_ENCRYPTION_KEY` (32 bytes em base64) e `OWNER_INVITE_SECRET` (32 bytes em base64, exclusivo e persistente; gere com `openssl rand -base64 32`). A chave de convite é independente da assinatura JWT; mantenha o valor estável para que retries idempotentes reproduzam o mesmo link após reinícios. Fora de produção, os segredos ausentes são efêmeros. O primeiro operador é criado com `printf '%s\n' "$SENHA" | pnpm api:create-operator email@exemplo nome` e, no primeiro login, só consegue cadastrar o segundo fator. Imagens do catálogo usam o diretório configurado por `IMAGE_STORAGE_DIRECTORY` (padrão `.data/images`; produção exige caminho absoluto); em Compose de desenvolvimento, ficam no volume `image-data`. Esse volume não é coberto pelo backup operacional da landing: antes de captar imagens reais, defina cópia externa cifrada, retenção/acesso, e ensaie restauração junto dos metadados PostgreSQL. `compose.dev.yaml` e suas senhas são só para desenvolvimento; o `compose.yaml` de produção continua servindo apenas a landing.
