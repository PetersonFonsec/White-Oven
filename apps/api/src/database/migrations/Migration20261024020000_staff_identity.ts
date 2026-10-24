import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * Staff identity and sessions (M1.4, ADR 0007).
 *
 * - `staff_users` and `staff_sessions` are global (D-03): one identity per person, linked to
 *   tenants by `memberships`. `whiteoven_app` cannot delete either; users are disabled and
 *   sessions revoked by update, so audit trails keep their references.
 * - `memberships` is a tenant table: forced RLS through `tenantIsolationSql`, `unique (tenant_id,
 *   id)` for future composite FKs and one link per (tenant, staff user). Revocation is a status
 *   change, never a delete.
 * - `whiteoven_staff_memberships(staff_user_id)` lists one user's links across tenants for the
 *   tenant picker after login. FORCE RLS filters the function owner too, so the function does not
 *   bypass the policy: it sets the transaction-local tenant to each non-closed tenant in turn,
 *   reads only that user's rows under the normal tenant check and restores the caller's setting.
 *   No policy wider than the tenant check exists, so the RLS coverage test stays unchanged.
 */
export class Migration20261024020000_staff_identity extends Migration {
  override up(): void {
    this.addSql(`
      create table staff_users (
        id uuid primary key default gen_random_uuid(),
        email text not null,
        name text not null,
        password_hash text not null,
        platform_role text not null default 'NONE',
        status text not null default 'ACTIVE',
        last_login_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint staff_users_email_key unique (email),
        constraint staff_users_email_normalized
          check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
        constraint staff_users_name_length check (char_length(name) between 1 and 120),
        constraint staff_users_password_hash_argon2id check (password_hash like '$argon2id$%'),
        constraint staff_users_platform_role_valid check (platform_role in ('NONE', 'OPERATOR')),
        constraint staff_users_status_valid check (status in ('INVITED', 'ACTIVE', 'DISABLED'))
      );
    `);
    this.addSql(`revoke delete on staff_users from whiteoven_app;`);

    this.addSql(`
      create table staff_sessions (
        id uuid primary key default gen_random_uuid(),
        staff_user_id uuid not null references staff_users (id),
        active_tenant_id uuid references tenants (id),
        mfa boolean not null default false,
        refresh_token_hash bytea not null,
        created_at timestamptz not null default now(),
        refreshed_at timestamptz not null default now(),
        idle_expires_at timestamptz not null,
        revoked_at timestamptz,
        revoked_reason text,
        constraint staff_sessions_refresh_token_hash_length
          check (octet_length(refresh_token_hash) = 32),
        constraint staff_sessions_revoked_consistent
          check ((revoked_at is null) = (revoked_reason is null)),
        constraint staff_sessions_revoked_reason_valid
          check (revoked_reason in ('LOGOUT', 'REFRESH_REUSE', 'USER_DISABLED'))
      );
    `);
    this.addSql(
      `create index staff_sessions_staff_user_id_idx on staff_sessions (staff_user_id) where revoked_at is null;`,
    );
    this.addSql(`revoke delete on staff_sessions from whiteoven_app;`);

    this.addSql(`
      create table memberships (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        staff_user_id uuid not null references staff_users (id),
        role text not null,
        status text not null default 'ACTIVE',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint memberships_tenant_id_id_key unique (tenant_id, id),
        constraint memberships_tenant_id_staff_user_id_key unique (tenant_id, staff_user_id),
        constraint memberships_role_valid check (role in ('OWNER', 'MANAGER', 'STAFF')),
        constraint memberships_status_valid check (status in ('INVITED', 'ACTIVE', 'REVOKED'))
      );
    `);
    for (const statement of tenantIsolationSql("memberships"))
      this.addSql(statement);
    this.addSql(
      `create index memberships_staff_user_id_idx on memberships (staff_user_id);`,
    );
    this.addSql(`revoke delete on memberships from whiteoven_app;`);

    this.addSql(`
      create function whiteoven_staff_memberships(p_staff_user_id uuid)
        returns table (tenant_id uuid, role text, status text)
        language plpgsql volatile security definer
        set search_path = pg_catalog, public
        as $$
        declare
          caller_tenant text := current_setting('app.tenant_id', true);
          tenant record;
        begin
          for tenant in select t.id from public.tenants t where t.status <> 'CLOSED' order by t.id loop
            perform set_config('app.tenant_id', tenant.id::text, true);
            return query
              select m.tenant_id, m.role, m.status
                from public.memberships m
               where m.staff_user_id = p_staff_user_id;
          end loop;
          perform set_config('app.tenant_id', coalesce(caller_tenant, ''), true);
        end
        $$;
    `);
    this.addSql(
      `grant execute on function whiteoven_staff_memberships(uuid) to whiteoven_app;`,
    );
  }

  override down(): void {
    throw new Error("Migration20261024020000_staff_identity is forward-only");
  }
}
