import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261024000000_runtime_roles } from "./Migration20261024000000_runtime_roles";

/**
 * Explicit, ordered list: no folder discovery at runtime. Names are stored in
 * `mikro_orm_migrations` and must never change once merged.
 */
export const MIGRATIONS: MigrationObject[] = [
  {
    name: "Migration20261024000000_runtime_roles",
    class: Migration20261024000000_runtime_roles,
  },
];
