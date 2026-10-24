import type { MikroORM } from "@mikro-orm/postgresql";
import { APP_ROLE, OWNER_ROLE } from "../config/config";

/** The connected role could bypass RLS or run DDL. Lists attribute names only. */
export class UnsafeDatabaseRoleError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Unsafe database role for the API: ${reasons.join(", ")}`);
    this.name = "UnsafeDatabaseRoleError";
  }
}

interface RoleFacts {
  /** Session or effective user differs from whiteoven_app (e.g. whiteoven_platform). */
  not_app_role: boolean;
  superuser: boolean;
  bypass_rls: boolean;
  create_role: boolean;
  create_db: boolean;
  replication: boolean;
  owns_database: boolean;
  owns_relations: boolean;
  member_of_owner: boolean;
  create_in_public: boolean;
  create_in_database: boolean;
}

const ROLE_FACTS_SQL = `
  select (session_user <> ? or current_user <> ?) as not_app_role,
         r.rolsuper as superuser,
         r.rolbypassrls as bypass_rls,
         r.rolcreaterole as create_role,
         r.rolcreatedb as create_db,
         r.rolreplication as replication,
         d.datdba = r.oid as owns_database,
         exists (select 1 from pg_class c where c.relowner = r.oid
                   and c.relnamespace = 'public'::regnamespace) as owns_relations,
         exists (select 1 from pg_roles o where o.rolname = ?
                   and pg_has_role(r.oid, o.oid, 'MEMBER')) as member_of_owner,
         has_schema_privilege(r.oid, 'public', 'CREATE') as create_in_public,
         has_database_privilege(r.oid, d.oid, 'CREATE') as create_in_database
    from pg_roles r, pg_database d
   where r.rolname = current_user and d.datname = current_database()`;

/**
 * Refuses to serve unless the connection runs exactly as `whiteoven_app` (session and effective
 * user), and with any role that can bypass RLS or change the schema. A role without elevated
 * attributes is still rejected when it is not `whiteoven_app`: its grants and future RLS
 * policies are not the API's. Migrations run separately as `whiteoven_owner`.
 */
export async function assertSafeRuntimeRole(orm: MikroORM): Promise<void> {
  const [facts] = await orm.em
    .getConnection()
    .execute<RoleFacts[]>(ROLE_FACTS_SQL, [APP_ROLE, APP_ROLE, OWNER_ROLE]);
  if (!facts) throw new UnsafeDatabaseRoleError(["role not found"]);
  const reasons = Object.entries(facts)
    .filter(([, value]) => value === true)
    .map(([name]) => name);
  if (reasons.length > 0) throw new UnsafeDatabaseRoleError(reasons);
}
