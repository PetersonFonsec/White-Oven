# ADR 0006 — Isolamento de tenants com RLS forçado (M1.3, D-01)

- **Status:** Proposto para M1.3
- **Data:** 2026-10-24

## Contexto

O [roadmap](../architecture/mvp-roadmap.md) define M1.3 como: `Tenant`, `TenantContext`, guard público por slug, transação com `set_config`, RLS forçado, filtro global e testes de isolamento, formalizando a decisão D-01 de [system-overview](../architecture/system-overview.md#decisões-arquiteturais-propostas). Critérios de aceite: os 7 testes obrigatórios de [tenant-isolation](../architecture/tenant-isolation.md#testes-obrigatórios) passam e o teste de cobertura de RLS falha se uma tabela nova não tiver política. M1.2 ([ADR 0005](0005-database-roles-migrations.md)) já garante que a API roda só como `whiteoven_app`, sem `BYPASSRLS` nem DDL.

## Decisão

Banco e schema compartilhados, coluna `tenant_id` em toda tabela de tenant e RLS habilitado e forçado, com o filtro do MikroORM e o guard de superfície como camadas adicionais.

- **Tabela `tenants`** (migration `Migration20261024010000_tenants`): global, sem `tenant_id` e sem RLS, porque o guard público resolve o slug antes de existir contexto. Campos: `id`, `slug` (único, `^[a-z0-9-]{3,40}$`), `display_name`, `status` (`ONBOARDING`, `ACTIVE`, `SUSPENDED`, `CLOSED`, padrão `ONBOARDING`), `timezone` (padrão `America/Sao_Paulo`), `created_at`, `updated_at`. `whiteoven_app` só lê (`INSERT`/`UPDATE`/`DELETE` revogados). Razão social e documento ficam para o onboarding em M1.5, junto da regra para MEI, que é questão aberta.
- **Função `whiteoven_current_tenant()`**: `nullif(current_setting('app.tenant_id', true), '')::uuid`. Sem contexto retorna nulo e a comparação nega tudo. O `nullif` é necessário: depois que uma conexão usa a variável, o PostgreSQL devolve `''` (e não nulo) fora da transação, e `''::uuid` geraria erro em vez de negar.
- **Padrão de tabela de tenant** (`tenantIsolationSql(table)` em `src/database/tenant-isolation-sql.ts`), que toda migration futura executa após o `create table`: `ENABLE` e `FORCE ROW LEVEL SECURITY` e a política `tenant_isolation` com `USING` e `WITH CHECK` `tenant_id = whiteoven_current_tenant()`. A saída do helper faz parte de migrations aplicadas e não pode mudar; outra forma de política exige helper novo. Também são obrigatórios na migration: `tenant_id uuid not null references tenants (id)`, `unique (tenant_id, id)` nas tabelas referenciadas e FKs compostas `(tenant_id, x_id) references x (tenant_id, id)`.
- **Contexto por transação** (`runInTenant(orm, tenantId, work)`): abre transação, executa `select set_config('app.tenant_id', $1, true)` e define o parâmetro do filtro do ORM com o mesmo id. O valor some no commit ou rollback, então a conexão volta ao pool sem tenant. `SET` de sessão é proibido. O id precisa ser UUID antes de chegar ao banco. Jobs chamam `runInTenant` por tenant; código de requisição usa `TenantTransactions.run(work)`, que lê o tenant do `TenantContext` e falha sem contexto.
- **`TenantContext`**: `{ tenantId, actor }` congelado, guardado em `AsyncLocalStorage` por um interceptor. Em M1.3 o único ator é `anonymous` (superfície pública); staff e cliente entram com a autenticação.
- **Guard de superfície** (`@StoreTenant()` = `StoreTenantGuard` + `TenantContextInterceptor`): o tenant vem só do `:storeSlug` da URL. Slug malformado ou inexistente responde 404 `NOT_FOUND`; loja que não está `ACTIVE` responde 403 `TENANT_NOT_ACTIVE` ("Store unavailable."), sem revelar o status. Se um guard de autenticação anterior registrou o tenant do token (`claimTenant(req, tid)`, a ser usado pelo token de cliente), um tenant diferente do slug responde o mesmo 404 (T-03). Em M1.5 a checagem de status passa para `TenantStatusPolicy`. O log de acesso inclui `tenantId`.
- **Filtro global do MikroORM**: cada entidade de tenant declara `filters: tenantFilters` (filtro `tenant`, padrão ligado, exige `tenantId`). Consulta sem parâmetro lança erro em vez de retornar tudo. `createOrm` recusa iniciar se alguma entidade mapear `tenant_id` sem esse filtro. Desligar o filtro numa consulta (`filters: { tenant: false }`) é exceção revisada; o RLS continua valendo por baixo.
- **Testes obrigatórios** (`apps/api/test/tenant-isolation.test.ts`, PostgreSQL real): ainda não existe tabela de tenant de produção (vínculos chegam em M1.4, catálogo em M2.3), então os testes usam tabelas de teste (`isolation_probe_flavors`, `isolation_probe_items`) criadas com o mesmo helper, filtro e guard. Cada tabela real entra na matriz e no teste de cobertura na sua própria PR.

| #   | Teste                | Situação em M1.3                                                                                                                                                                                                             |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Matriz de isolamento | Toda rota com `@StoreTenant()` é descoberta e precisa estar na matriz; A tentando ler/alterar recurso de B recebe 404 sem efeito colateral.                                                                                  |
| 2   | Cobertura de RLS     | `findUnprotectedTenantTables` aponta tabela com `tenant_id` sem RLS habilitado, forçado, política ou com `tenant_id` anulável; teste mostra a tabela nova sinalizada até ficar protegida. Entidade sem filtro impede o boot. |
| 3   | Falha fechada        | Sem contexto, `whiteoven_app` (e o dono, por `FORCE`) lê zero linhas e não insere; contexto A não grava linha de B; ORM sem parâmetro lança erro; `TenantTransactions` fora de requisição falha.                             |
| 4   | Pool                 | Mesmo `pg_backend_pid` para A, B e consulta sem contexto, que vê zero linhas; transação com erro não vaza contexto; requisições HTTP alternadas com pool de 1 conexão.                                                       |
| 5   | FKs compostas        | Item de A com sabor de B falha no banco, inclusive com RLS desligado.                                                                                                                                                        |
| 6   | Token cruzado        | Tenant reivindicado A na rota de B responde 404 (guard de teste no lugar do token de cliente). O token real é testado na PR que o criar.                                                                                     |
| 7   | Revogação            | Pendente (`todo`): depende de `Membership` e tokens de equipe, entregues e testados em M1.4, cujo critério de aceite já inclui "vínculo revogado perde acesso em até 60 s".                                                  |

## Alternativas consideradas

- **Suporte nativo a RLS do MikroORM 7** (`setSessionContext`, filtros com `rls`): aplica variáveis com `set_config(..., false)` na reserva da conexão (estratégia `connection`) e gera políticas pelo schema generator, que não usamos. Preferimos `set_config(..., true)` explícito dentro da transação e políticas versionadas nas migrations.
- **RLS também em `tenants`**, com busca por slug em função `security definer`: com `FORCE`, a função (executada como dono) também seria filtrada; exigiria política especial para o dono. Os dados de `tenants` em M1.3 são públicos por natureza (slug, nome exibido, status), então a tabela fica global e somente leitura para a API.
- **Event trigger que recusa `create table` com `tenant_id` sem RLS**: exige superuser; o teste de cobertura na CI cumpre o papel.
- **503 para loja indisponível**: confundiria indisponibilidade da loja com falha do serviço em monitoramento e retries do app.

## Consequências

- Toda migration que cria tabela de tenant chama `tenantIsolationSql`, cria FKs compostas e acrescenta a tabela aos testes 1 e 2 na mesma PR; sem isso a CI falha.
- Serviços acessam dados de tenant só por `TenantTransactions.run`; o `EntityManager` global continua sem contexto (`allowGlobalContext: false`) e o RLS devolve zero linhas a consultas fora dele.
- `whiteoven_platform` ainda não tem grants nem políticas em tabelas de tenant; chegam com as operações de plataforma (M1.5), exigindo `app.platform_operation`.
- O contrato 403 `TENANT_NOT_ACTIVE` para loja não ativa é proposto aqui e pode ser revisto quando o cardápio público (M2.6) e o app definirem a tela de loja indisponível.
