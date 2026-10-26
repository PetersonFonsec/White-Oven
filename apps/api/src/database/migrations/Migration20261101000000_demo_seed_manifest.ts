import { Migration } from "@mikro-orm/migrations";

/**
 * Ownership record for the local demo seed. The seed refuses matching tenant/user names unless
 * they were created in the same transaction as this manifest; runtime roles cannot inspect or
 * alter its provenance records.
 */
export class Migration20261101000000_demo_seed_manifest extends Migration {
  override up(): void {
    this.addSql(`
      create table demo_seed_manifest (
        seed_key text primary key,
        demo_tenant_id uuid not null unique references tenants(id),
        records jsonb not null,
        created_at timestamptz not null default now(),
        constraint demo_seed_manifest_key check (seed_key = 'whiteoven-admin-demo-v1'),
        constraint demo_seed_manifest_records check (jsonb_typeof(records) = 'object')
      );
      revoke all on demo_seed_manifest from public, whiteoven_app, whiteoven_platform;
    `);
  }

  override down(): void {
    throw new Error(
      "Migration20261101000000_demo_seed_manifest is forward-only",
    );
  }
}
