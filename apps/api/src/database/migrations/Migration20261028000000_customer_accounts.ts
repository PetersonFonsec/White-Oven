import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * M4.2 customer accounts (ADR 0017, Q-05: e-mail and password, account required). Customers
 * belong to one tenant (D-03): the same e-mail in two stores is two customers, and every table
 * is a tenant table under forced RLS, so a session or an address of store A is invisible in B.
 *
 * - `customers` is never deleted: deleting an account anonymizes the row (name, e-mail, phone
 *   and password become null) and keeps the id for future orders.
 * - `customer_sessions` keep only the SHA-256 of the refresh token; they expire 30 days after
 *   sign-in and are revoked, never deleted.
 * - `customer_addresses` are deleted with the account; orders will copy them (snapshot).
 *
 * Forward-only, like every migration here (ADR 0005, AGENTS.md): `down()` refuses. Dropping
 * these tables would destroy customer accounts and personal data with no audit trail, and a
 * rollback is not needed to undo a release: the change is purely additive, so the previous API
 * version runs against this schema unchanged (it never reads these tables). Any later change is
 * a new forward migration; restoring a backup is the last resort (ADR 0017, "Migração").
 */
export class Migration20261028000000_customer_accounts extends Migration {
  override up(): void {
    this.addSql(`
      create table customers (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        status text not null default 'ACTIVE',
        name text,
        email text,
        phone text,
        password_hash text,
        privacy_policy_version text,
        accepted_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_at timestamptz,
        constraint customers_tenant_id_id_key unique (tenant_id, id),
        constraint customers_status_valid check (status in ('ACTIVE', 'DELETED')),
        constraint customers_active_complete check (status <> 'ACTIVE' or (
          name is not null and email is not null and password_hash is not null
          and privacy_policy_version is not null and accepted_at is not null and deleted_at is null)),
        constraint customers_deleted_anonymous check (status <> 'DELETED' or (
          name is null and email is null and phone is null and password_hash is null
          and deleted_at is not null)),
        constraint customers_name_length check (name is null or char_length(btrim(name)) between 1 and 120),
        constraint customers_email_normalized check (email is null or (email = lower(btrim(email)) and char_length(email) <= 254)),
        constraint customers_phone_e164 check (phone is null or phone ~ '^\\+[1-9][0-9]{7,14}$'),
        constraint customers_policy_version_length check (
          privacy_policy_version is null or char_length(privacy_policy_version) between 1 and 40)
      );
      create unique index customers_email_key on customers (tenant_id, email) where email is not null;
      create unique index customers_phone_key on customers (tenant_id, phone) where phone is not null;

      create table customer_sessions (
        id uuid primary key,
        tenant_id uuid not null references tenants (id),
        customer_id uuid not null,
        refresh_token_hash bytea not null,
        created_at timestamptz not null default now(),
        refreshed_at timestamptz not null default now(),
        expires_at timestamptz not null,
        revoked_at timestamptz,
        revoked_reason text,
        constraint customer_sessions_customer_fk foreign key (tenant_id, customer_id)
          references customers (tenant_id, id),
        constraint customer_sessions_revoked_reason_valid check (
          revoked_reason in ('LOGOUT', 'REFRESH_REUSE', 'ACCOUNT_DELETED')),
        constraint customer_sessions_revoked_consistent check ((revoked_at is null) = (revoked_reason is null))
      );
      create index customer_sessions_customer_idx on customer_sessions (tenant_id, customer_id) where revoked_at is null;

      create table customer_addresses (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        customer_id uuid not null,
        label text not null,
        postal_code text not null,
        street text not null,
        number text not null,
        complement text,
        district text not null,
        city text not null,
        state text not null,
        reference text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint customer_addresses_tenant_id_id_key unique (tenant_id, id),
        constraint customer_addresses_customer_fk foreign key (tenant_id, customer_id)
          references customers (tenant_id, id),
        constraint customer_addresses_postal_code check (postal_code ~ '^[0-9]{8}$'),
        constraint customer_addresses_state check (state ~ '^[A-Z]{2}$'),
        constraint customer_addresses_lengths check (
          char_length(btrim(label)) between 1 and 40 and char_length(btrim(street)) between 1 and 120
          and char_length(btrim(number)) between 1 and 20 and char_length(btrim(district)) between 1 and 80
          and char_length(btrim(city)) between 1 and 80
          and (complement is null or char_length(btrim(complement)) between 1 and 60)
          and (reference is null or char_length(btrim(reference)) between 1 and 120))
      );
      create index customer_addresses_customer_idx on customer_addresses (tenant_id, customer_id);
    `);
    for (const table of [
      "customers",
      "customer_sessions",
      "customer_addresses",
    ])
      for (const statement of tenantIsolationSql(table)) this.addSql(statement);
    // Accounts are anonymized and sessions revoked, never deleted: the ids stay for orders.
    this.addSql(
      `revoke delete, truncate on customers, customer_sessions from whiteoven_app;`,
    );
  }

  override down(): void {
    throw new Error(
      "Migration20261028000000_customer_accounts is forward-only",
    );
  }
}
