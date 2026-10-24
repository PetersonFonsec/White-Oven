import { Inject, Injectable } from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { TENANT_SETTING } from "../database/tenant-isolation-sql";
import { TENANT_FILTER } from "./tenant-filter";
import { currentTenantContext } from "./tenant-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Runs `work` in one transaction scoped to `tenantId` (layers 4 and 5 of tenant-isolation.md):
 * `set_config('app.tenant_id', id, true)` lasts only until commit or rollback, so a pooled
 * connection never carries a tenant into the next transaction, and the ORM filter gets the same
 * id. Session-level `SET` of the tenant is forbidden.
 *
 * Takes `tenantId` explicitly so jobs can iterate tenants one transaction at a time; request code
 * uses `TenantTransactions`, which reads it from the `TenantContext`.
 */
export async function runInTenant<T>(
  orm: MikroORM,
  tenantId: string,
  work: (em: EntityManager) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId))
    throw new Error("tenantId must be a lowercase UUID");
  const em = orm.em.fork({ clear: true });
  return em.transactional(async (tx) => {
    await tx.execute("select set_config(?, ?, true)", [
      TENANT_SETTING,
      tenantId,
    ]);
    tx.setFilterParams(TENANT_FILTER, { tenantId });
    return work(tx);
  });
}

/** Request-scoped entry point to tenant data: the only way services should reach it. */
@Injectable()
export class TenantTransactions {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async run<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return runInTenant(this.orm, currentTenantContext().tenantId, work);
  }
}
