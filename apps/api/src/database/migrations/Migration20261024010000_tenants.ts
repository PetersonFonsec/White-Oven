import { Migration } from "@mikro-orm/migrations";

/**
 * Tenants and the tenant context function (M1.3, ADR 0006).
 *
 * - `tenants` is global (no `tenant_id`, no RLS): the public guard resolves a store by slug
 *   before any tenant context exists. `whiteoven_app` only reads it; creating, suspending and
 *   closing tenants are platform operations (M1.5), with their own grants.
 * - `whiteoven_current_tenant()` reads the transaction-local `app.tenant_id`. `nullif` matters:
 *   once a connection has used the setting, PostgreSQL returns '' (not null) after the
 *   transaction ends, and ''::uuid would raise instead of denying. Every tenant policy uses it
 *   through `tenantIsolationSql`. No `set search_path`, so the planner can inline it; it only
 *   calls pg_catalog functions, which are always resolved first.
 *
 * Commercial fields of the tenant (legal name, CNPJ/CPF) arrive with onboarding in M1.5.
 */
export class Migration20261024010000_tenants extends Migration {
  override up(): void {
    this.addSql(`
      create table tenants (
        id uuid primary key default gen_random_uuid(),
        slug text not null,
        display_name text not null,
        status text not null default 'ONBOARDING',
        timezone text not null default 'America/Sao_Paulo',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint tenants_slug_key unique (slug),
        constraint tenants_slug_format check (slug ~ '^[a-z0-9-]{3,40}$'),
        constraint tenants_display_name_length check (char_length(display_name) between 1 and 80),
        constraint tenants_status_valid
          check (status in ('ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CLOSED')),
        constraint tenants_timezone_length check (char_length(timezone) between 1 and 64)
      );
    `);
    // Default privileges gave whiteoven_app full DML; the API only reads tenants.
    this.addSql(`revoke insert, update, delete on tenants from whiteoven_app;`);

    this.addSql(`
      create function whiteoven_current_tenant() returns uuid
        language sql stable parallel safe
        as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;
    `);
    this.addSql(
      `grant execute on function whiteoven_current_tenant() to whiteoven_app, whiteoven_platform;`,
    );
  }

  override down(): void {
    throw new Error("Migration20261024010000_tenants is forward-only");
  }
}
