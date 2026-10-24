import { Migration } from "@mikro-orm/migrations";

/**
 * Runtime roles (M1.2). Runs as `whiteoven_owner` (CREATEROLE, never SUPERUSER or BYPASSRLS, so
 * it cannot hand those attributes out). Roles are cluster-wide: a role that already exists is
 * accepted only if it is still safe, otherwise the migration aborts. Login passwords are set by
 * `migrate.ts`, never stored here.
 *
 * - `whiteoven_app`: API runtime. DML on future tables of `public`, no DDL, no RLS bypass.
 * - `whiteoven_platform`: cross-tenant platform operations. Grants and RLS policies arrive with
 *   the tables that need them (M1.3+); until then it can only connect.
 */
export class Migration20261024000000_runtime_roles extends Migration {
  override up(): void {
    this.addSql(`
      do $$
      declare
        runtime_role text;
        unsafe boolean;
      begin
        foreach runtime_role in array array['whiteoven_app', 'whiteoven_platform'] loop
          if not exists (select 1 from pg_roles where rolname = runtime_role) then
            execute format(
              'create role %I login noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication',
              runtime_role);
          else
            select r.rolsuper or r.rolbypassrls or r.rolcreatedb or r.rolcreaterole or r.rolreplication
                   or pg_has_role(r.oid, current_user, 'MEMBER')
              into unsafe
              from pg_roles r where r.rolname = runtime_role;
            if unsafe then
              raise exception 'role % exists with unsafe attributes or membership', runtime_role;
            end if;
          end if;
        end loop;

        execute format('revoke all on database %I from public', current_database());
        execute format('grant connect on database %I to whiteoven_app, whiteoven_platform',
                       current_database());
      end
      $$;
    `);
    this.addSql(`revoke create on schema public from public;`);
    this.addSql(
      `grant usage on schema public to whiteoven_app, whiteoven_platform;`,
    );
    this.addSql(
      `alter default privileges in schema public grant select, insert, update, delete on tables to whiteoven_app;`,
    );
    this.addSql(
      `alter default privileges in schema public grant usage, select on sequences to whiteoven_app;`,
    );
    // security definer functions (M1.3 membership lookup) must be granted one by one.
    this.addSql(
      `alter default privileges revoke execute on functions from public;`,
    );
  }

  override down(): void {
    // Roles are shared by every database in the cluster; dropping them here could break others.
    throw new Error("Migration20261024000000_runtime_roles is forward-only");
  }
}
