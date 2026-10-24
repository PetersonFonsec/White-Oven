# ADR 0005 — PostgreSQL, MikroORM, migrations e papéis do banco (M1.2)

- **Status:** Proposto para M1.2
- **Data:** 2026-10-24

## Contexto

O [roadmap](../architecture/mvp-roadmap.md) define M1.2 como: PostgreSQL no Compose de desenvolvimento, MikroORM, migrations, papéis `owner`/`app`/`platform` e testes de integração com banco real. Critérios de aceite: a migration cria papéis sem `BYPASSRLS` para a aplicação, os testes rodam contra PostgreSQL em container na CI e a aplicação não executa DDL. O desenho dos papéis vem de [tenant-isolation](../architecture/tenant-isolation.md) e de [system-overview](../architecture/system-overview.md#segurança-e-autenticação). Tenants, `TenantContext`, RLS e filtros globais são M1.3 e ficam fora desta entrega.

## Decisão

- **PostgreSQL 17** (`postgres:17.11-bookworm`, fixado por digest) no `compose.dev.yaml`, publicado só em `127.0.0.1`, autenticação `scram-sha-256`. O `compose.yaml` de produção não muda.
- **MikroORM 7** (`@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/migrations`, todos 7.2.x). É a major atual; os pacotes são ESM e a API continua CommonJS, carregando-os por `require(esm)` (Node 22.12+, já exigido pelo monorepo; MikroORM declara 22.17+, e Docker e CI usam 22.23.2). Sem `@mikro-orm/cli` nem `@mikro-orm/nestjs`: a instância é criada em `createOrm` e exposta por um `DatabaseModule` global que fecha o pool no shutdown. Nenhuma entidade ainda (chegam com M1.3).
  - O pool abre na primeira consulta. SQL nunca é registrado (`debug: false`), porque consultas podem carregar dados pessoais.
  - `allowGlobalContext: false`: código de requisição terá de usar um `EntityManager` por contexto (preparação para M1.3).
  - MikroORM lê variáveis `MIKRO_ORM_*` por conta própria; a API e o migrador recusam iniciar se alguma existir, para que a configuração tenha uma única entrada.
- **Três papéis**, como em tenant-isolation:

  | Papel                | Criado por                       | Atributos                                                                       | Uso                                                                                              |
  | -------------------- | -------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
  | `whiteoven_owner`    | Bootstrap do cluster (superuser) | `LOGIN CREATEROLE CREATEDB`, **sem** `SUPERUSER`, `BYPASSRLS` ou `REPLICATION`. | Dono do banco e das tabelas; só migrations. `CREATEDB` serve aos bancos descartáveis dos testes. |
  | `whiteoven_app`      | Migration                        | `LOGIN NOINHERIT`, sem `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `CREATEROLE`.      | Runtime da API. DML nas tabelas futuras de `public` por default privileges.                      |
  | `whiteoven_platform` | Migration                        | Iguais aos de `whiteoven_app`.                                                  | Operações de plataforma entre tenants. Grants e políticas chegam com as tabelas (M1.3+).         |

  Como o dono não tem `BYPASSRLS` nem `SUPERUSER`, o PostgreSQL 16+ o impede de conceder esses atributos: a garantia não depende só do texto da migration.

- **Bootstrap**: `ops/postgres/initdb/10-whiteoven-owner.sh` roda uma vez, como superuser, quando a imagem oficial inicializa um volume vazio. Cria apenas `whiteoven_owner` e o banco `whiteoven`. Em outro ambiente o mesmo SQL é executado manualmente por quem administra o cluster; o superuser não é usado depois disso.
- **Migration inicial** `Migration20261024000000_runtime_roles`:
  - cria os papéis de runtime se não existirem. Papéis são do cluster: se já existirem, a migration só prossegue se continuarem seguros (sem atributos privilegiados e sem pertencer ao dono); caso contrário aborta;
  - `REVOKE ALL ON DATABASE ... FROM PUBLIC` e `GRANT CONNECT` só aos dois papéis;
  - `REVOKE CREATE ON SCHEMA public FROM PUBLIC`, `GRANT USAGE` aos papéis de runtime;
  - default privileges do dono: `SELECT, INSERT, UPDATE, DELETE` em tabelas e `USAGE, SELECT` em sequências para `whiteoven_app` (sem `TRUNCATE`, `REFERENCES` ou `TRIGGER`); `EXECUTE` em funções novas revogado de `PUBLIC` (funções `security definer` de M1.3 serão concedidas uma a uma);
  - é forward-only: `down()` lança erro, porque remover papéis do cluster pode quebrar outros bancos.
- **Migrador separado da API** (`dist/database/migrate.js`, `pnpm api:migrate`, serviço one-shot `migrate` no Compose):
  - lê `DATABASE_OWNER_URL` (precisa ser `whiteoven_owner`) e recusa superuser em tempo de execução;
  - aplica as pendentes em uma transação (`allOrNothing`), com lista explícita de migrations (sem descoberta por pasta) e sem snapshots em disco, para rodar com filesystem somente leitura;
  - `check` sai com código 2 se houver pendentes, sem aplicar;
  - define a senha de `whiteoven_app`/`whiteoven_platform` a partir de `DATABASE_APP_PASSWORD`/`DATABASE_PLATFORM_PASSWORD`, opcionais. O verificador SCRAM-SHA-256 é calculado no processo, então a senha em texto não chega ao servidor nem aos logs do PostgreSQL. Senhas exigem 16–128 caracteres ASCII imprimíveis (equivalência com o SASLprep do servidor). Todas as trocas de senha rodam em uma única transação: se uma falhar, nenhuma é confirmada, e os papéis nunca ficam com credenciais trocadas pela metade.
- **A API não executa DDL**, em três camadas:
  1. `loadConfig` recusa `DATABASE_URL` com o usuário `whiteoven_owner` e recusa iniciar se `DATABASE_OWNER_URL` estiver no ambiente do processo;
  2. antes de abrir a porta, `main.ts` consulta o catálogo e encerra com código 1 se o usuário da sessão ou o efetivo (`session_user`/`current_user`) não for exatamente `whiteoven_app` (inclusive `whiteoven_platform` ou outro papel sem privilégios elevados) ou se o papel conectado for superuser, tiver `BYPASSRLS`, `CREATEROLE`, `CREATEDB` ou `REPLICATION`, for dono do banco ou de relações em `public`, pertencer a `whiteoven_owner` ou puder criar em `public` ou no banco. Banco inacessível na partida também encerra com código 1;
  3. o papel `whiteoven_app` não tem privilégio de DDL, verificado por teste.
- **Configuração nova da API**: `DATABASE_URL` (obrigatória, `postgres://`, com usuário, host e banco; erros citam o nome da variável, nunca o valor) e `DATABASE_POOL_MAX` (1–100, padrão 10).
- **Prontidão**: `GET /health/ready` faz `select 1` com limite de 2 s; responde `200 {"status":"ok"}` ou `503` com `ApiErrorBody` `NOT_READY`, sem detalhe do erro. `/health` continua só liveness e é o que o healthcheck do container usa.
- **Testes de integração** (`apps/api/test/database.test.ts` e a parte com banco de `startup.test.ts`) rodam contra PostgreSQL real: cada arquivo cria um banco descartável `whiteoven_test_*` como `whiteoven_owner`, aplica as migrations e o remove ao final. Sem `TEST_DATABASE_OWNER_URL` as suítes são puladas localmente, mas falham na CI (`CI` definido). Um advisory lock serializa a criação de papéis entre arquivos paralelos.
- **CI**: o job `verify` sobe o PostgreSQL do `compose.dev.yaml` antes de `pnpm test`. O job `api-container` sobe `postgres` → `migrate` → `api`, verifica `/health`, `/health/ready` e que `migrate check` não encontra pendentes.

## Alternativas consideradas

- **MikroORM 6** (CommonJS, Knex): evitaria `require(esm)`, mas começaria a fundação numa major em manutenção.
- **Criar todos os papéis no bootstrap do superuser**: mais simples, mas contraria o critério de M1.2 (migration cria os papéis) e espalha a definição de privilégios fora do versionamento das migrations.
- **API aplicando migrations no boot**: descartado; exigiria credenciais de dono no processo da API.
- **`@mikro-orm/nestjs`**: dependência extra sem ganho enquanto não há entidades nem contexto por requisição; reavaliar em M1.3.

## Consequências

- Toda tabela nova é criada por migration como `whiteoven_owner` e recebe DML para `whiteoven_app` automaticamente; grants a `whiteoven_platform` e políticas RLS são explícitos na migration da tabela (M1.3).
- Migrations novas entram na lista de `src/database/migrations/index.ts`; nomes já aplicados nunca mudam.
- Rodar a API exige o banco migrado e acessível; o Compose garante a ordem `postgres` → `migrate` → `api`.
- As senhas do `compose.dev.yaml` são apenas de desenvolvimento. Deploy da API, gestão de segredos e backup do PostgreSQL continuam fora do escopo (M7.1 e revisão de deploy própria).
