import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261024000000_runtime_roles } from "./Migration20261024000000_runtime_roles";
import { Migration20261024010000_tenants } from "./Migration20261024010000_tenants";
import { Migration20261024020000_staff_identity } from "./Migration20261024020000_staff_identity";
import { Migration20261024030000_staff_mfa } from "./Migration20261024030000_staff_mfa";

/**
 * Explicit, ordered list: no folder discovery at runtime. Names are stored in
 * `mikro_orm_migrations` and must never change once merged.
 */
export const MIGRATIONS: MigrationObject[] = [
  {
    name: "Migration20261024000000_runtime_roles",
    class: Migration20261024000000_runtime_roles,
  },
  {
    name: "Migration20261024010000_tenants",
    class: Migration20261024010000_tenants,
  },
  {
    name: "Migration20261024020000_staff_identity",
    class: Migration20261024020000_staff_identity,
  },
  {
    name: "Migration20261024030000_staff_mfa",
    class: Migration20261024030000_staff_mfa,
  },
];
