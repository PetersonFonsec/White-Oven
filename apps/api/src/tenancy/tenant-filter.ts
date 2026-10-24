import type { FilterDef, MikroORM } from "@mikro-orm/core";

/** Name of the MikroORM filter every tenant entity declares (layer 4 of tenant-isolation.md). */
export const TENANT_FILTER = "tenant";

/**
 * Per-entity filter for tenant entities: `filters: tenantFilters`. Enabled by default and
 * requires the `tenantId` parameter, so a query on a tenant entity without context throws
 * instead of returning every tenant's rows. Disabling it on a query (`filters: { tenant: false }`)
 * must be an explicit, reviewed exception; RLS still applies underneath.
 */
export const tenantFilters: Record<string, FilterDef> = {
  [TENANT_FILTER]: {
    name: TENANT_FILTER,
    cond: (args: { tenantId: string }) => ({ tenantId: args.tenantId }),
    default: true,
  },
};

/**
 * Refuses an ORM whose entities map a `tenant_id` column without the default tenant filter.
 * Runs in `createOrm`, so such an entity stops the API at startup and fails every test.
 */
export function assertTenantFilters(orm: MikroORM): void {
  const missing = [...orm.getMetadata().getAll().values()]
    .filter((meta) =>
      Object.values(meta.properties).some((prop) =>
        prop.fieldNames?.includes("tenant_id"),
      ),
    )
    .filter((meta) => meta.filters?.[TENANT_FILTER]?.default !== true)
    .map((meta) => meta.className)
    .filter((name, index, names) => names.indexOf(name) === index);
  if (missing.length > 0)
    throw new Error(
      `tenant entities without the default "${TENANT_FILTER}" filter: ${missing.join(", ")}`,
    );
}
