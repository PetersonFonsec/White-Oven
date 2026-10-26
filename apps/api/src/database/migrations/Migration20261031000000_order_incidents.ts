import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * M4.6 order incidents (ADR 0019): a service record on an order that never changes its state or
 * values. The app inserts incidents and may only resolve an open one (status and resolution
 * columns); nothing is deleted. Indexes back the staff history filters and the daily report.
 *
 * Each incident keeps the hashes of its `Idempotency-Key` and request, unique per store and
 * order, so a retry finds the incident it created. The audit is written by triggers from the row
 * itself: no function takes audit data from the caller. Before a write, a trigger checks the
 * author against the transaction's staff session (`app.incident_actor_id`/`_session_id`), the
 * same way the catalog audit does.
 */
export class Migration20261031000000_order_incidents extends Migration {
  override up(): void {
    this.addSql(`
      create table order_incidents (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        order_id uuid not null,
        type text not null,
        description text not null,
        reported_by text not null,
        status text not null default 'OPEN',
        resolution_note text,
        created_by uuid not null,
        created_at timestamptz not null default now(),
        resolved_by uuid,
        resolved_at timestamptz,
        key_hash bytea not null,
        request_hash bytea not null,
        constraint order_incidents_tenant_id_id_key unique (tenant_id, id),
        constraint order_incidents_key unique (tenant_id, order_id, key_hash),
        constraint order_incidents_hashes check (octet_length(key_hash) = 32 and octet_length(request_hash) = 32),
        constraint order_incidents_order_fk foreign key (tenant_id, order_id) references orders (tenant_id, id),
        constraint order_incidents_type_valid check (type in
          ('MISSING_ITEM','WRONG_ITEM','LATE_DELIVERY','QUALITY','DELIVERY_PROBLEM','OTHER')),
        constraint order_incidents_reported_by_valid check (reported_by in ('CUSTOMER','STAFF')),
        constraint order_incidents_status_valid check (status in ('OPEN','RESOLVED')),
        constraint order_incidents_description_length check (char_length(description) between 1 and 1000),
        constraint order_incidents_resolution_length check (resolution_note is null or char_length(resolution_note) between 1 and 1000),
        constraint order_incidents_resolution_consistent check (
          (status = 'OPEN' and resolved_by is null and resolved_at is null and resolution_note is null) or
          (status = 'RESOLVED' and resolved_by is not null and resolved_at is not null))
      );
      create index order_incidents_order_idx on order_incidents (tenant_id, order_id, created_at);
      create index orders_placed_at_idx on orders (tenant_id, placed_at);
      create index order_status_changes_completed_idx on order_status_changes (tenant_id, at)
        where to_status = 'COMPLETED';
    `);
    for (const statement of tenantIsolationSql("order_incidents"))
      this.addSql(statement);
    this.addSql(`
      revoke update, delete, truncate on order_incidents from whiteoven_app;
      grant select, insert on order_incidents to whiteoven_app;
      grant update (status, resolution_note, resolved_by, resolved_at) on order_incidents to whiteoven_app;

      -- Who writes: the staff member of this transaction's session, a live session with an ACTIVE
      -- membership in the row's store (any role while ACTIVE, the OWNER while SUSPENDED). The row
      -- names the same person as author or resolver. Updates only go OPEN -> RESOLVED, once.
      create function whiteoven_order_incident_guard() returns trigger language plpgsql
      security definer set search_path = pg_catalog, public as $$
      declare
        v_actor uuid := nullif(current_setting('app.incident_actor_id', true), '')::uuid;
        v_session uuid := nullif(current_setting('app.incident_session_id', true), '')::uuid;
      begin
        if new.tenant_id is distinct from public.whiteoven_current_tenant()
           or v_actor is null or v_session is null
           or v_actor is distinct from (case when tg_op = 'INSERT' then new.created_by else new.resolved_by end)
           or not exists (
             select 1 from public.staff_sessions s
               join public.staff_users u on u.id = s.staff_user_id
               join public.memberships m on m.staff_user_id = u.id and m.tenant_id = new.tenant_id
               join public.tenants t on t.id = new.tenant_id
              where s.id = v_session and s.staff_user_id = v_actor
                and s.revoked_at is null and s.idle_expires_at > now()
                and s.active_tenant_id = new.tenant_id
                and u.status = 'ACTIVE' and m.status = 'ACTIVE'
                and (t.status = 'ACTIVE' or (t.status = 'SUSPENDED' and m.role = 'OWNER')))
        then
          raise exception 'order incident author is not this session''s staff member' using errcode = '42501';
        end if;
        if tg_op = 'UPDATE' and (old.status <> 'OPEN' or new.status <> 'RESOLVED') then
          raise exception 'order incident % is already resolved', old.id using errcode = 'check_violation';
        end if;
        return new;
      end $$;
      revoke all on function whiteoven_order_incident_guard() from public;
      create trigger order_incidents_guard before insert or update on order_incidents
        for each row execute function whiteoven_order_incident_guard();

      -- The audit, in the same transaction, from the row: author, order and type, never the
      -- description or the resolution note, which may name the customer.
      create function whiteoven_order_incident_audit() returns trigger language plpgsql
      security definer set search_path = pg_catalog, public as $$
      declare
        v_request text := nullif(current_setting('app.incident_request_id', true), '');
      begin
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, request_id)
        values (new.tenant_id, 'STAFF',
          case when tg_op = 'INSERT' then new.created_by else new.resolved_by end,
          case when tg_op = 'INSERT' then 'order.incident_reported' else 'order.incident_resolved' end,
          'order_incident', new.id,
          jsonb_build_object('orderId', new.order_id, 'type', new.type),
          case when v_request ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then v_request::uuid end);
        return null;
      end $$;
      revoke all on function whiteoven_order_incident_audit() from public;
      create trigger order_incidents_audit after insert or update of status on order_incidents
        for each row execute function whiteoven_order_incident_audit();
    `);
  }

  override down(): void {
    throw new Error("Migration20261031000000_order_incidents is forward-only");
  }
}
