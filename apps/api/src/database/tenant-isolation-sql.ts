import type { MikroORM } from "@mikro-orm/postgresql";

/** Transaction-local setting read by every tenant policy. Set only through `runInTenant`. */
export const TENANT_SETTING = "app.tenant_id";

/** Name of the policy `tenantIsolationSql` creates. The coverage check inspects every policy. */
export const TENANT_POLICY = "tenant_isolation";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Statements every tenant table's migration must run right after `create table` (M1.3,
 * tenant-isolation.md): RLS enabled and forced (the owner is filtered too) and one policy that
 * reads and writes only rows of `whiteoven_current_tenant()`. Without a context the function
 * returns null and the comparison denies everything (fail closed).
 *
 * The output is part of applied migrations: never change it. A different policy shape needs a
 * new helper and a migration that alters the existing tables.
 */
export function tenantIsolationSql(table: string): string[] {
  if (!IDENTIFIER.test(table)) throw new Error("invalid table name");
  return [
    `alter table ${table} enable row level security;`,
    `alter table ${table} force row level security;`,
    `create policy ${TENANT_POLICY} on ${table}
       using (tenant_id = whiteoven_current_tenant())
       with check (tenant_id = whiteoven_current_tenant());`,
  ];
}

export interface UnprotectedTenantTable {
  table: string;
  /** Stable, human-readable reasons, e.g. `permissive policy "x": USING is not the tenant check`. */
  problems: string[];
}

/** The only expression a permissive tenant policy may use, as `pg_get_expr` prints it. */
export const TENANT_CHECK_EXPRESSION =
  "(tenant_id = public.whiteoven_current_tenant())";

interface TableFacts {
  table: string;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  tenantIdNotNull: boolean;
  appAuditPrivilege: boolean;
}

interface PolicyFacts {
  table: string;
  name: string;
  /** `r` select, `a` insert, `w` update, `d` delete, `*` all. */
  command: "r" | "a" | "w" | "d" | "*";
  permissive: boolean;
  appliesToApp: boolean;
  using: string | null;
  withCheck: string | null;
}

/**
 * Problems of one permissive policy. Permissive policies are OR-combined, so any one of them that
 * is wider than the tenant check opens the table for every role it applies to: its USING (rows
 * read, updated, deleted) and its WITH CHECK (rows written) must be exactly the tenant check. A
 * missing WITH CHECK on ALL/UPDATE falls back to USING in PostgreSQL. Restrictive policies are
 * AND-combined and can only narrow access, so they are not inspected.
 */
function policyProblems(policy: PolicyFacts): string[] {
  const problems: string[] = [];
  const label = `permissive policy "${policy.name}"`;
  const readsRows = policy.command !== "a";
  const writesRows = ["*", "a", "w"].includes(policy.command);
  if (readsRows && policy.using !== TENANT_CHECK_EXPRESSION)
    problems.push(`${label}: USING is not the tenant check`);
  const effectiveCheck =
    policy.withCheck ?? (policy.command === "a" ? null : policy.using);
  if (writesRows && effectiveCheck !== TENANT_CHECK_EXPRESSION)
    problems.push(`${label}: WITH CHECK is not the tenant check`);
  return problems;
}

/**
 * Tables of `public` with a `tenant_id` column that are not fully protected. A table passes only
 * when RLS is enabled and forced, `tenant_id` is `not null`, at least one permissive policy
 * applies to `whiteoven_app` and every permissive policy, for any role, uses exactly the tenant
 * check in USING and WITH CHECK. Having "some policy" is not enough: one extra permissive policy
 * such as `using (true)` would expose every tenant. Without a context the tenant check is null,
 * so access stays fail-closed.
 *
 * Required test 2 of tenant-isolation.md runs it after every migration, so a new tenant table, or
 * a policy wider than the tenant check, fails CI. Expressions are printed with `search_path` set
 * to `pg_catalog`, so the function must be `public.whiteoven_current_tenant()` and not a
 * look-alike from another schema. Platform policies (M1.5) must extend this check explicitly.
 */
export async function findUnprotectedTenantTables(
  orm: MikroORM,
): Promise<UnprotectedTenantTable[]> {
  return orm.em.fork().transactional(async (em) => {
    await em.execute("select set_config('search_path', 'pg_catalog', true)");
    const tables = await em.execute<TableFacts[]>(`
      select c.relname as "table",
             c.relrowsecurity as "rowSecurity",
             c.relforcerowsecurity as "forceRowSecurity",
             a.attnotnull as "tenantIdNotNull",
             (c.relname = 'audit_events' and (
               has_table_privilege('whiteoven_app', c.oid, 'SELECT') or
               has_table_privilege('whiteoven_app', c.oid, 'INSERT') or
               has_table_privilege('whiteoven_app', c.oid, 'UPDATE') or
               has_table_privilege('whiteoven_app', c.oid, 'DELETE')
             )) as "appAuditPrivilege"
        from pg_class c
        join pg_attribute a
          on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
       where c.relnamespace = 'public'::regnamespace
         and c.relkind in ('r', 'p')
       order by c.relname`);
    const policies = await em.execute<PolicyFacts[]>(`
      select c.relname as "table",
             p.polname as name,
             p.polcmd as command,
             p.polpermissive as permissive,
             exists (select 1 from unnest(p.polroles) r(oid)
                      where r.oid = 0
                         or pg_has_role('whiteoven_app', r.oid, 'MEMBER')) as "appliesToApp",
             pg_get_expr(p.polqual, p.polrelid) as using,
             pg_get_expr(p.polwithcheck, p.polrelid) as "withCheck"
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
       where c.relnamespace = 'public'::regnamespace
       order by c.relname, p.polname`);

    const result: UnprotectedTenantTable[] = [];
    for (const table of tables) {
      // Platform AuditEvent uses nullable tenant_id by contract. It is global and intentionally
      // has no direct app-role grants; narrowly scoped SECURITY DEFINER operations append rows.
      if (table.table === "audit_events") {
        if (table.appAuditPrivilege)
          result.push({
            table: table.table,
            problems: [
              "whiteoven_app has direct privileges on global audit table",
            ],
          });
        continue;
      }
      const own = policies.filter(
        (p) => p.table === table.table && p.permissive,
      );
      const problems: string[] = [];
      if (!table.rowSecurity) problems.push("row level security disabled");
      if (!table.forceRowSecurity)
        problems.push("row level security not forced");
      if (!table.tenantIdNotNull) problems.push("tenant_id is nullable");
      if (!own.some((p) => p.appliesToApp))
        problems.push("no permissive policy for whiteoven_app");
      for (const policy of own) problems.push(...policyProblems(policy));
      if (problems.length > 0) result.push({ table: table.table, problems });
    }
    return result;
  });
}
