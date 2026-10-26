import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * M4.6 order incidents (ADR 0019): a service record on an order that never changes its state or
 * values. The app inserts incidents and may only resolve an open one (status and resolution
 * columns); nothing is deleted. Indexes back the staff history filters and the daily report.
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
        constraint order_incidents_tenant_id_id_key unique (tenant_id, id),
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

      -- Only OPEN -> RESOLVED, once: a resolved incident is history.
      create function whiteoven_guard_order_incident() returns trigger language plpgsql
      set search_path = pg_catalog, public as $$
      begin
        if old.status <> 'OPEN' or new.status <> 'RESOLVED' then
          raise exception 'order incident % is already resolved', old.id using errcode = 'check_violation';
        end if;
        return new;
      end $$;
      create trigger order_incidents_resolve_once before update on order_incidents
        for each row execute function whiteoven_guard_order_incident();

      -- Staff audit without the free text, which may name the customer.
      create function whiteoven_incident_audit(p_actor uuid, p_order uuid, p_incident uuid,
        p_action text, p_type text, p_request uuid)
      returns void language plpgsql security definer set search_path = pg_catalog, public as $$
      begin
        if p_action not in ('order.incident_reported', 'order.incident_resolved') then
          raise exception 'unknown incident audit action' using errcode = 'check_violation';
        end if;
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, request_id)
        values (public.whiteoven_current_tenant(), 'STAFF', p_actor, p_action, 'order_incident', p_incident,
          jsonb_build_object('orderId', p_order, 'type', p_type), p_request);
      end $$;
      revoke all on function whiteoven_incident_audit(uuid, uuid, uuid, text, text, uuid) from public;
      grant execute on function whiteoven_incident_audit(uuid, uuid, uuid, text, text, uuid) to whiteoven_app;
    `);
  }

  override down(): void {
    throw new Error("Migration20261031000000_order_incidents is forward-only");
  }
}
