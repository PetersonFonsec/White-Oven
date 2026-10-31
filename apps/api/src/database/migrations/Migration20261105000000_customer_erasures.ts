import { Migration } from "@mikro-orm/migrations";

/**
 * Customer erasure registry (M7.1, ADR 0029). A restore must reapply every account deletion made
 * after the backup, and must be able to prove that the deletions it knows are complete. Two
 * global tables, written only by the database:
 *
 * - `database_lineage`: one random id created with the schema. It travels with the data (dumps
 *   and restores keep it); a database created again from scratch gets a new one, even in the same
 *   PostgreSQL cluster.
 * - `customer_erasures`: one row per deleted account, appended by a trigger when a customer
 *   becomes DELETED, numbered 1..n without gaps and chained with SHA-256 (each hash covers the
 *   previous hash and the row). A copy of the chain proves it continues another one when it holds
 *   that one's last (seq, hash).
 *
 * Neither table has personal data (only ids and the deletion time) nor RLS: like `audit_events`,
 * they are global and the runtime roles have no privilege on them. Rows are never updated or
 * deleted.
 */
export class Migration20261105000000_customer_erasures extends Migration {
  override up(): void {
    this.addSql(`
      create table database_lineage (
        singleton boolean primary key default true,
        id uuid not null default gen_random_uuid(),
        created_at timestamptz not null default now(),
        constraint database_lineage_singleton check (singleton)
      );
      insert into database_lineage default values;

      create table customer_erasures (
        seq bigint primary key,
        tenant_id uuid not null references tenants (id),
        customer_id uuid not null,
        deleted_at timestamptz not null,
        hash bytea not null,
        recorded_at timestamptz not null default now(),
        constraint customer_erasures_seq_positive check (seq > 0),
        constraint customer_erasures_hash_length check (octet_length(hash) = 32),
        constraint customer_erasures_customer_key unique (tenant_id, customer_id),
        constraint customer_erasures_customer_fk foreign key (tenant_id, customer_id)
          references customers (tenant_id, id)
      );
      revoke all on database_lineage, customer_erasures from whiteoven_app, whiteoven_platform;

      -- The canonical text of a row; the backup script and the tests compute nothing else.
      create function whiteoven_erasure_hash(previous bytea, seq bigint, tenant_id uuid,
                                             customer_id uuid, deleted_at timestamptz)
        returns bytea language sql stable set search_path = pg_catalog as $$
          select sha256(coalesce(previous, ''::bytea) || convert_to(
            seq::text || '|' || tenant_id::text || '|' || customer_id::text || '|' ||
            to_char(deleted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8'))
        $$;

      -- Checks any table with the registry's columns (the live registry, or a ledger loaded into
      -- a temporary table): rows must be 1..n without gaps and every hash must chain.
      create function whiteoven_verify_erasure_chain(source regclass)
        returns table (row_count bigint, head_seq bigint, head_hash bytea, broken bigint)
        language plpgsql stable set search_path = pg_catalog, public as $$
        begin
          return query execute format($q$
            with ordered as (
              select seq, hash, row_number() over (order by seq) as position,
                     whiteoven_erasure_hash(lag(hash) over (order by seq), seq, tenant_id,
                                            customer_id, deleted_at) as expected
                from %s)
            select count(*), coalesce(max(seq), 0),
                   (select hash from ordered order by seq desc limit 1),
                   count(*) filter (where seq <> position or hash is distinct from expected)
              from ordered$q$, source);
        end
        $$;

      create function whiteoven_record_customer_erasure() returns trigger
        language plpgsql security definer set search_path = pg_catalog, public as $$
        declare
          head_seq bigint;
          head_hash bytea;
        begin
          -- One writer at a time keeps the numbering gap-free and the chain linear; deletions are
          -- rare, so the wait is short.
          perform pg_advisory_xact_lock(7212029001);
          if exists (select 1 from customer_erasures
                      where tenant_id = new.tenant_id and customer_id = new.id) then
            return null;
          end if;
          select seq, hash into head_seq, head_hash
            from customer_erasures order by seq desc limit 1;
          head_seq := coalesce(head_seq, 0) + 1;
          insert into customer_erasures (seq, tenant_id, customer_id, deleted_at, hash)
          values (head_seq, new.tenant_id, new.id, new.deleted_at,
                  whiteoven_erasure_hash(head_hash, head_seq, new.tenant_id, new.id,
                                         new.deleted_at));
          return null;
        end
        $$;
      revoke all on function whiteoven_erasure_hash(bytea, bigint, uuid, uuid, timestamptz),
        whiteoven_verify_erasure_chain(regclass), whiteoven_record_customer_erasure() from public;

      create trigger customers_record_erasure after update of status on customers
        for each row when (old.status <> 'DELETED' and new.status = 'DELETED')
        execute function whiteoven_record_customer_erasure();

      create function whiteoven_guard_customer_erasures() returns trigger
        language plpgsql as $$
        begin
          raise exception 'customer_erasures is append-only' using errcode = '42501';
        end
        $$;
      create trigger customer_erasures_append_only before update or delete on customer_erasures
        for each row execute function whiteoven_guard_customer_erasures();
    `);
    // Accounts deleted before this migration, in deletion order. FORCE RLS hides customers from
    // the owner without a tenant context, so they are read store by store.
    this.addSql(`
      do $$
      declare
        store uuid;
        erasure record;
        position bigint := 0;
        previous bytea := null;
      begin
        create temp table erasure_backfill (tenant_id uuid, customer_id uuid,
                                            deleted_at timestamptz) on commit drop;
        for store in select id from tenants loop
          perform set_config('app.tenant_id', store::text, true);
          insert into erasure_backfill
            select tenant_id, id, deleted_at from customers where status = 'DELETED';
        end loop;
        perform set_config('app.tenant_id', '', true);
        for erasure in
          select * from erasure_backfill order by deleted_at, tenant_id, customer_id
        loop
          position := position + 1;
          previous := whiteoven_erasure_hash(previous, position, erasure.tenant_id,
                                             erasure.customer_id, erasure.deleted_at);
          insert into customer_erasures (seq, tenant_id, customer_id, deleted_at, hash)
          values (position, erasure.tenant_id, erasure.customer_id, erasure.deleted_at, previous);
        end loop;
      end
      $$;
    `);
  }

  override down(): void {
    throw new Error(
      "Migration20261105000000_customer_erasures is forward-only",
    );
  }
}
