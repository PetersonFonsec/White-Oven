import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

const CATALOG_TABLES = [
  "catalog_categories",
  "pizza_sizes",
  "catalog_ingredients",
  "catalog_flavors",
  "catalog_flavor_ingredients",
  "catalog_flavor_prices",
  "catalog_crusts",
  "catalog_crust_prices",
  "catalog_extras",
  "catalog_extra_prices",
  "catalog_simple_products",
  "catalog_pricing_policies",
];

/**
 * M2.6 per-tenant catalog version. Every statement that writes a catalog table bumps it once in
 * the same transaction, so the public menu cache of any API instance can compare one row instead
 * of rebuilding the menu. The app role only reads it; the trigger owns the writes. A tenant
 * without a row has never changed its catalog (version 0).
 *
 * The trigger runs per statement, not per row, so a batch update of prices or availability
 * costs one upsert. It bumps the transaction's tenant: forced RLS lets a statement touch only
 * that tenant's rows, and a BEFORE trigger forbids moving a row to another tenant, so the rows a
 * statement changes always belong to it. Without a tenant context RLS lets no row change, and
 * there is nothing to bump.
 */
export class Migration20261024080000_catalog_versions extends Migration {
  override up(): void {
    this.addSql(`
      create table catalog_versions (
        tenant_id uuid primary key references tenants(id),
        version bigint not null default 1,
        updated_at timestamptz not null default now(),
        constraint catalog_versions_positive check (version >= 1)
      );

      create function whiteoven_bump_catalog_version() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare p_tenant_id uuid := public.whiteoven_current_tenant();
      begin
        if p_tenant_id is null then return null; end if;
        insert into public.catalog_versions (tenant_id) values (p_tenant_id)
          on conflict (tenant_id) do update
          set version = public.catalog_versions.version + 1, updated_at = now();
        return null;
      end $$;
      revoke all on function whiteoven_bump_catalog_version() from public, whiteoven_app;

      create function whiteoven_guard_catalog_tenant() returns trigger language plpgsql as $$
      begin
        if new.tenant_id is distinct from old.tenant_id then
          raise exception using errcode='23514', constraint='catalog_tenant_immutable';
        end if;
        return new;
      end $$;
    `);
    for (const table of CATALOG_TABLES)
      this.addSql(`
        create trigger ${table}_bump_version after insert or update or delete on ${table}
          for each statement execute function whiteoven_bump_catalog_version();
        create trigger ${table}_guard_tenant before update of tenant_id on ${table}
          for each row execute function whiteoven_guard_catalog_tenant();
      `);
    for (const statement of tenantIsolationSql("catalog_versions"))
      this.addSql(statement);
    // Default privileges grant DML on new tables to the app role; only the trigger writes here.
    this.addSql(`
      revoke insert, update, delete, truncate on catalog_versions from whiteoven_app;
      grant select on catalog_versions to whiteoven_app;
    `);
  }
}
