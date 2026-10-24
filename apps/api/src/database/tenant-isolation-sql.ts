import type { MikroORM } from "@mikro-orm/postgresql";

/** Transaction-local setting read by every tenant policy. Set only through `runInTenant`. */
export const TENANT_SETTING = "app.tenant_id";

/** Name of the policy `tenantIsolationSql` creates; the coverage check looks for any policy. */
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
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  policies: number;
  tenantIdNotNull: boolean;
}

/**
 * Tables of `public` with a `tenant_id` column that are not fully protected: RLS disabled or not
 * forced, no policy, or a nullable `tenant_id`. Required test 2 of tenant-isolation.md runs it
 * after every migration, so a new tenant table without RLS fails CI.
 */
export async function findUnprotectedTenantTables(
  orm: MikroORM,
): Promise<UnprotectedTenantTable[]> {
  return orm.em.getConnection().execute<UnprotectedTenantTable[]>(`
    select c.relname as "table",
           c.relrowsecurity as "rowSecurity",
           c.relforcerowsecurity as "forceRowSecurity",
           (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
           a.attnotnull as "tenantIdNotNull"
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p')
       and not (c.relrowsecurity and c.relforcerowsecurity and a.attnotnull
                and exists (select 1 from pg_policy p where p.polrelid = c.oid))
     order by c.relname`);
}
