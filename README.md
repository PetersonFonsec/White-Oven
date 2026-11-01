# WhiteOven

SaaS white label planejado para pizzarias. **M0** entregou a landing Astro, o Pizza Builder demonstrativo, a captação real de interesse com SQLite local e o empacotamento Docker/Compose. **M1.1–M1.5** entregaram fundação da API, PostgreSQL, isolamento tenant, autenticação/MFA e operações de plataforma. **M2.1–M2.6** entregaram o catálogo e o cardápio público. **M3.1** integrou o painel Angular (`apps/admin`): login com MFA, sessão restaurada pelo cookie de refresh, seleção de loja e rotas por papel ([ADR 0012](docs/adr/0012-admin-panel.md)). **M3.2 está em desenvolvimento**: gestão de lojas, convites OWNER e suspensão/reativação na área de plataforma. Os links de convite são removidos da barra de endereço ao abrir; como o token fica apenas em memória, atualizar a página de aceitação exige abrir novamente o link original. Nenhum deploy real foi feito. As demais telas do painel, React Native/Expo e pagamentos continuam planejados.

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

| Comando                                              | Descrição                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                           | Servidor Astro de desenvolvimento.                                                                                           |
| `pnpm build`                                         | Landing pré-renderizada em `apps/landing/dist/client` e servidor em `dist/server`.                                           |
| `pnpm start`                                         | Inicia o build Astro pelo inicializador Node com limites de conexão, após build.                                             |
| `pnpm check`                                         | Formatação, ESLint e tipos strict de todos os pacotes.                                                                       |
| `pnpm test`                                          | Testes de todos os pacotes (landing, API) e dos scripts de operação.                                                         |
| `pnpm api:dev`                                       | Compila e sobe a API em `http://127.0.0.1:3000`.                                                                             |
| `WHITEOVEN_TENANT=pizzaria-centro pnpm mobile:start` | App Expo de uma pizzaria (manifesto em `apps/mobile/manifests`).                                                             |
| `pnpm mobile:release-check pizzaria-centro store`    | Confere se o manifesto de uma pizzaria está pronto para build no EAS ([ADR 0028](docs/adr/0028-mobile-build-publishing.md)). |
| `pnpm db:up`                                         | Sobe o PostgreSQL de desenvolvimento (`compose.dev.yaml`) em `127.0.0.1:5432`.                                               |
| `pnpm api:migrate`                                   | Aplica as migrations como `whiteoven_owner` (`apps/api/.env.migrate`).                                                       |
| `pnpm test:e2e`                                      | Build + Playwright desktop/mobile com servidor e banco sintéticos.                                                           |
| `pnpm leads inspect`                                 | Lista IDs, datas, plano e volume, sem nome ou WhatsApp.                                                                      |
| `pnpm leads export .data/lead-exports/leads.json`    | Exportação JSON restrita, sem sobrescrever arquivo existente.                                                                |
| `pnpm leads purge`                                   | Exclui dados expirados.                                                                                                      |
| `pnpm leads delete <uuid>`                           | Exclui um cadastro e suas chaves de retry.                                                                                   |
| `pnpm leads clear-dev --confirm`                     | Limpa somente banco cujo nome é `leads.dev.sqlite`, fora de produção.                                                        |

Instale Chromium com `pnpm exec playwright install chromium`. Alternativamente, com Chrome instalado: `WHITEOVEN_BROWSER_CHANNEL=chrome pnpm test:e2e`. A CI instala Chromium com dependências Linux. O banco E2E `.data/leads.e2e.sqlite` é separado do banco local, usa identidade sintética e pode ser removido com o servidor parado.

## Estrutura e operação

- `apps/landing`: interface, endpoint Astro `/api/leads`, política `/privacidade` e persistência temporária.
- `apps/api`: API NestJS. Configuração em `apps/api/.env.example` (API) e `apps/api/.env.migrate.example` (migrations); OpenAPI em `/v1/openapi.json` fora de produção. Decisões nos ADRs [0004](docs/adr/0004-api-foundation.md), [0005](docs/adr/0005-database-roles-migrations.md) e [0006](docs/adr/0006-tenant-isolation.md).
- `apps/mobile`: app Expo white label do cliente, um binário por pizzaria a partir do manifesto ([ADR 0020](docs/adr/0020-mobile-app-base.md)), com cardápio e Pizza Builder ([ADR 0021](docs/adr/0021-mobile-menu-pizza-builder.md)); build e publicação nas lojas pelo EAS ([ADR 0028](docs/adr/0028-mobile-build-publishing.md), [checklist](docs/operations/mobile-publishing.md)).
- `packages/contracts`: contrato e validação isomórfica do lead, sem dependências de servidor.
- `packages/design-tokens`: identidade visual reutilizável.
- `docs/product`, `docs/architecture`, `docs/adr`: estado do produto e decisões.

Use `pnpm start`, que aplica limites HTTP, identifica clientes pela conexão e ignora cabeçalhos de encaminhamento não confiáveis. Origem pública exige `LEADS_TRUSTED_PROXIES` com IPs exatos do último proxy e substituição de `X-Forwarded-For`; consulte o runbook. Executar o entrypoint Astro diretamente em produção mantém a captação bloqueada.

O build agora **exige processo Node para captação e política dinâmica**; servir apenas arquivos estáticos não oferece esse fluxo. A decisão e as alternativas estão no [ADR 0002](docs/adr/0002-lead-capture.md). Veja [operação, privacidade e métricas](docs/architecture/m0-1b-lead-capture.md). Caddy poderá atuar como reverse proxy em uma milestone futura; não há deploy nem alterações de infraestrutura Orbia nesta entrega.

A CI usa instalação congelada, formatação, lint, typecheck, testes de domínio/endpoint, build e E2E. As decisões de M0 e M0.1-A estão mantidas como registros históricos; não descrevem o formulário atual. A captação não envia mensagens automáticas, e o adaptador de analytics atual emite apenas eventos locais sem PII, sem fornecedor externo.

## Deploy e operação — M0.2

Consulte o [runbook](docs/operations/landing-deployment.md) antes de executar comandos de infraestrutura. Backup e restauração da API (PostgreSQL e imagens) seguem o [runbook da API](docs/operations/api-backup-restore.md) e o `ops/api-backup.sh` ([ADR 0029](docs/adr/0029-api-backup-restore.md)). `Dockerfile` multi-stage compila addons para Linux, executa como UID 1000 e preserva o inicializador seguro. `compose.yaml` mantém dados/backups em volumes e publica Node somente em loopback. Caddy é exemplo opcional separado, sem domínio ou servidor presumido.

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

### Dados locais para testar o painel

Use somente um banco local descartável ou dedicado à demonstração. Inicie PostgreSQL com
`pnpm db:up`, aplique as migrations com `pnpm api:migrate` e configure:

- `DATABASE_OWNER_URL` em `apps/api/.env.migrate`, usando a role `whiteoven_owner` e host
  `localhost`, `127.0.0.1` ou `::1` (a porta mapeada local pode ser diferente de 5432).
- `WHITEOVEN_DEMO_PASSWORD` em `apps/api/.env`, com senha que passe a política normal de senhas.
- `DATABASE_URL` em `apps/api/.env` para a role runtime `whiteoven_app`, como nos exemplos acima.

Então rode `pnpm api:seed-demo`. Na primeira execução, a seed cria em uma transação a loja ativa
`whiteoven-demo`, cardápio básico, configurações da loja e logins OWNER, MANAGER e STAFF
(`owner@whiteoven.local`, `manager@whiteoven.local` e `staff@whiteoven.local`) com a senha
informada. Só cria a demonstração se o slug e os três e-mails estiverem livres. Um manifesto
protegido por permissões do banco registra quais IDs foram criados pela seed.

Nas execuções seguintes, a seed consulta esse manifesto e valida que os registros continuam
presentes; não faz inserts ou updates. Portanto, IDs e alterações manuais permanecem como estão,
senhas não são trocadas, memberships não são corrigidas automaticamente, e lojas suspensas ou
usuários desativados não são reativados. Se o slug ou algum e-mail já existir sem o manifesto, a
seed encerra com conflito sem alterar dados. Uma falha durante a criação inicial desfaz a
transação inteira. A seed não adota registros antigos e não oferece reset destrutivo; se seu banco
já contém dados demo sem manifesto, mantenha-os e use um banco de demonstração novo para uma seed
limpa. No PostgreSQL local, `whiteoven_owner` pode criar databases descartáveis: crie um database
novo, aponte temporariamente `DATABASE_OWNER_URL` e `DATABASE_URL` para ele, rode
`pnpm api:migrate` e depois `pnpm api:seed-demo`. Não apague volumes nem databases existentes.

Suba API e painel com `pnpm api:dev` e `pnpm admin:dev` (`http://127.0.0.1:3000` e
`http://localhost:4200`). A seed recusa `NODE_ENV=production`, exige `DATABASE_OWNER_URL` local
com `whiteoven_owner` e não é chamada por migrations, inicialização da API ou deploy. Para acessar
a plataforma como OPERATOR, use `pnpm api:create-operator` e complete o cadastro MFA pelo fluxo
normal; a seed não cria operadores nem contorna MFA.

A API conecta apenas como `whiteoven_app` (sem `BYPASSRLS` e sem DDL); as migrations rodam em processo separado como `whiteoven_owner`. Configuração inválida (por exemplo `API_PORT=abc`), credencial de dono no ambiente da API, papel de banco inseguro ou banco inacessível encerram o processo com código 1 antes de abrir a porta. Testes de integração da API usam PostgreSQL real: com `pnpm db:up`, rode `TEST_DATABASE_OWNER_URL=postgres://whiteoven_owner:whiteoven-dev-owner-password@127.0.0.1:5432/whiteoven pnpm test`; sem a variável essas suítes são puladas localmente e falham na CI. Dados de pizzarias ficam isolados por RLS forçado: toda tabela com `tenant_id` segue o padrão do [ADR 0006](docs/adr/0006-tenant-isolation.md) e entra nos testes de isolamento. A equipe autentica em `/v1/admin/auth` ([ADR 0007](docs/adr/0007-staff-authentication.md)); em produção a API exige `AUTH_ACCESS_TOKEN_PRIVATE_KEY` (Ed25519 PKCS#8 DER em base64), `AUTH_MFA_ENCRYPTION_KEY` (32 bytes em base64) e `OWNER_INVITE_SECRET` (32 bytes em base64, exclusivo e persistente; gere com `openssl rand -base64 32`). A chave de convite é independente da assinatura JWT; mantenha o valor estável para que retries idempotentes reproduzam o mesmo link após reinícios. Fora de produção, os segredos ausentes são efêmeros. O primeiro operador é criado com `printf '%s\n' "$SENHA" | pnpm api:create-operator email@exemplo nome` e, no primeiro login, só consegue cadastrar o segundo fator. Antes do piloto e depois de qualquer mudança de operadores, `pnpm api:check-operators-mfa` confirma que todo operador que ainda entra tem MFA ativo (sai com 2 e lista os ids se algum não tiver). Atrás de um proxy reverso, defina `API_TRUSTED_PROXIES` com o IP exato do proxy que a API vê; sem isso, o bloqueio de login e os limites por IP contam todos os clientes como um só. Checklist de segurança e limites: [ADR 0031](docs/adr/0031-security-review.md) e [docs/operations/security-review.md](docs/operations/security-review.md). Imagens do catálogo usam o diretório configurado por `IMAGE_STORAGE_DIRECTORY` (padrão `.data/images`; produção exige caminho absoluto); em Compose de desenvolvimento, ficam no volume `image-data`. Esse volume não é coberto pelo backup operacional da landing: antes de captar imagens reais, defina cópia externa cifrada, retenção/acesso, e ensaie restauração junto dos metadados PostgreSQL. `compose.dev.yaml` e suas senhas são só para desenvolvimento; o `compose.yaml` de produção continua servindo apenas a landing.

Métricas e alertas da API (M7.4, [ADR 0032](docs/adr/0032-observability.md)): com `API_METRICS_TOKEN` definido, `GET /metrics` responde no formato Prometheus (pedidos, transições, requisições por status, latência, erros e falhas de jobs por loja, sem dados pessoais); sem ele, 404. `node ops/api-monitor.mjs check` (a cada minuto, por timer do systemd ou cron) avisa por webhook quando a API cai, quando as métricas param, quando uma loja passa de 5% de erros 5xx ou de 2,5 s de p95 e quando um job falha; `node ops/api-monitor.mjs test-alert` testa o canal. Configuração, alertas e ensaio: [docs/operations/observability.md](docs/operations/observability.md).

### App: conta, carrinho e checkout (M5.3)

O app permite cadastro/login por loja, endereços, exclusão da conta, carrinho com pizzas e produtos,
e cotação/confirmação de pedidos. Consulte o [ADR 0022](docs/adr/0022-mobile-account-checkout.md).
O refresh token e o estado comercial são protegidos por SecureStore, separados por API + loja;
o access token fica só em memória. O cache de marca continua contendo apenas dados públicos.

Em resposta perdida, use **Recuperar resultado do pedido**: o app preserva a mesma chave e corpo
inclusive após reiniciar. Não monte um segundo pedido antes de confirmar o resultado do primeiro.
Mudança de preço exige nova cotação e confirmação. Pagamentos são apenas registrados para entrega/retirada.

Os termos de uso e a política de privacidade de cada loja ficam na API (M7.2, [ADR 0030](docs/adr/0030-legal-documents.md)):
o app lê a versão vigente, o cadastro só aceita essa versão e o aceite fica registrado. Sem os dois documentos
publicados, o cadastro fica fechado. A API também serve as páginas `/lojas/{slug}/privacidade`, `/lojas/{slug}/termos`
e `/lojas/{slug}/excluir-conta` (exclusão da conta pela web, exigida pelo Google Play). Os textos reais vêm do jurídico.

`pnpm test:e2e:mobile`, com `TEST_DATABASE_OWNER_URL`, usa o cliente e controlador do app contra API real
em banco PostgreSQL descartável: inclui resposta perdida, reinício, unicidade do pedido, alteração de preço
e anonimização. A CI executa esse teste; validação visual e do armazenamento nativo em dispositivo continua
sendo necessária antes da publicação. Não há acompanhamento/histórico ou push neste marco.

### App: acompanhamento e histórico (M5.4)

`Meus pedidos` lista os pedidos da conta atual, mais recentes primeiro, com paginação. O detalhe mostra
os itens e valores do snapshot, a linha do tempo e uma estimativa simples da loja; ele atualiza a cada
20 segundos somente enquanto está aberto e o app está em primeiro plano. Não há rastreamento de rota.
O cliente pode cancelar enquanto o pedido ainda está `PLACED`; depois do aceite, deve falar com a
pizzaria. “Pedir novamente” reconstrói somente itens ainda válidos no catálogo atual e passa pelo
checkout/quote para obter preços atuais. A API limita as leituras à conta autenticada e usa
`Cache-Control: no-store`. Push segue fora deste marco.
