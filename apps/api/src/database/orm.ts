import { MikroORM, type Options } from "@mikro-orm/postgresql";
import { assertTenantFilters } from "../tenancy/tenant-filter";
import { Tenant } from "../tenancy/tenant.entity";

/** Every runtime entity. Tenant entities must declare `filters: tenantFilters`. */
export const ENTITIES = [Tenant];

export interface OrmConnection {
  url: string;
  poolMax?: number;
}

/**
 * Builds a MikroORM instance without connecting; the pool opens on first use. SQL is never logged (it can carry personal data). The runtime instance has no
 * migrator or schema generator wired: DDL belongs to `whiteoven_owner` via `migrate.ts`.
 */
export function ormOptions(
  connection: OrmConnection,
  extra: Options = {},
): Options {
  return {
    clientUrl: connection.url,
    pool: { min: 0, max: connection.poolMax ?? 10, idleTimeoutMillis: 30_000 },
    entities: ENTITIES,
    ensureDatabase: false,
    allowGlobalContext: false,
    debug: false,
    ...extra,
  };
}

export async function createOrm(
  connection: OrmConnection,
  extra: Options = {},
): Promise<MikroORM> {
  const orm = await MikroORM.init(ormOptions(connection, extra));
  assertTenantFilters(orm);
  return orm;
}
