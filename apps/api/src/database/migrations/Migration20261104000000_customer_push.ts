import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * M5.5 push notifications (ADR 0027, Q-11: Expo Push), opt-in per app installation:
 *
 * - `customer_push_devices` is one app installation (a random id the app keeps in its secure
 *   storage) of one store, registered by a signed-in customer session with its current Expo
 *   token. An installation, a token and a session each have at most one row per store, so a new
 *   account or a rotated token replaces the row instead of leaving an older subscription behind.
 *   Ending the session (logout, refresh reuse, account deletion) deletes its row.
 * - `push_deliveries` is an outbox written only by the database, from a store or system
 *   transition in `order_status_changes`, and only when the order's customer has a device with a
 *   live session at that moment. The API reads and settles rows; it cannot insert or delete them,
 *   so it can never notify about something that is not in the order history.
 * - `push_messages` is one delivery to one device. Each is settled on its own, so a retry sends
 *   only messages that Expo did not accept. Deleting a device leaves its messages without one.
 *
 * Forward-only, like every migration here (ADR 0005): `down()` refuses. The tables are additive:
 * the previous API version never reads them, and the trigger only adds outbox rows.
 */
export class Migration20261104000000_customer_push extends Migration {
  override up(): void {
    this.addSql(`
      create table customer_push_devices (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        customer_id uuid not null,
        session_id uuid not null references customer_sessions (id),
        installation_id uuid not null,
        token text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint customer_push_devices_customer_fk foreign key (tenant_id, customer_id)
          references customers (tenant_id, id),
        constraint customer_push_devices_token_key unique (tenant_id, token),
        constraint customer_push_devices_session_key unique (tenant_id, session_id),
        constraint customer_push_devices_installation_key unique (tenant_id, installation_id),
        constraint customer_push_devices_token_format
          check (token ~ '^Expo(nent)?PushToken\\[[A-Za-z0-9_-]{1,200}\\]$')
      );
      create index customer_push_devices_customer_idx on customer_push_devices (tenant_id, customer_id);

      create table push_deliveries (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        status_change_id uuid not null,
        order_id uuid not null,
        customer_id uuid not null,
        to_status text not null,
        state text not null default 'PENDING',
        attempts integer not null default 0,
        next_attempt_at timestamptz not null default now(),
        claim_id uuid,
        claimed_until timestamptz,
        created_at timestamptz not null default now(),
        finished_at timestamptz,
        constraint push_deliveries_tenant_id_id_key unique (tenant_id, id),
        constraint push_deliveries_change_key unique (tenant_id, status_change_id),
        constraint push_deliveries_change_fk foreign key (tenant_id, status_change_id)
          references order_status_changes (tenant_id, id),
        constraint push_deliveries_order_fk foreign key (tenant_id, order_id)
          references orders (tenant_id, id),
        constraint push_deliveries_to_valid check (to_status in
          ('PREPARING','READY','OUT_FOR_DELIVERY','COMPLETED','REJECTED','CANCELED')),
        constraint push_deliveries_state_valid check (state in ('PENDING','SENT','FAILED','EXPIRED','SKIPPED')),
        constraint push_deliveries_finished check ((state = 'PENDING') = (finished_at is null)),
        constraint push_deliveries_attempts check (attempts between 0 and 10),
        constraint push_deliveries_claim check ((claim_id is null) = (claimed_until is null))
      );
      create index push_deliveries_pending_idx on push_deliveries (tenant_id, next_attempt_at)
        where state = 'PENDING';

      create table push_messages (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        delivery_id uuid not null,
        device_id uuid references customer_push_devices (id) on delete set null,
        state text not null default 'PENDING',
        created_at timestamptz not null default now(),
        finished_at timestamptz,
        constraint push_messages_delivery_fk foreign key (tenant_id, delivery_id)
          references push_deliveries (tenant_id, id),
        constraint push_messages_device_key unique (tenant_id, delivery_id, device_id),
        constraint push_messages_state_valid check (state in ('PENDING','SENT','FAILED','SKIPPED')),
        constraint push_messages_finished check ((state = 'PENDING') = (finished_at is null))
      );
      create index push_messages_delivery_idx on push_messages (tenant_id, delivery_id);
      create index push_messages_device_idx on push_messages (device_id) where device_id is not null;
    `);
    for (const table of [
      "customer_push_devices",
      "push_deliveries",
      "push_messages",
    ])
      for (const statement of tenantIsolationSql(table)) this.addSql(statement);
    this.addSql(`
      revoke insert, delete, truncate on push_deliveries from whiteoven_app;
      grant select, update on push_deliveries to whiteoven_app;
      revoke delete, truncate on push_messages from whiteoven_app;
      grant select, insert, update on push_messages to whiteoven_app;

      create function whiteoven_enqueue_push_delivery() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public as $$
      begin
        -- The customer already knows about their own cancellation; PLACED is their own order.
        if new.actor_type = 'CUSTOMER' or new.to_status not in
            ('PREPARING','READY','OUT_FOR_DELIVERY','COMPLETED','REJECTED','CANCELED') then
          return new;
        end if;
        insert into public.push_deliveries (tenant_id, status_change_id, order_id, customer_id, to_status)
        select new.tenant_id, new.id, o.id, o.customer_id, new.to_status
          from public.orders o
         where o.tenant_id = new.tenant_id and o.id = new.order_id
           and exists (
             select 1 from public.customer_push_devices d
               join public.customer_sessions s on s.id = d.session_id
              where d.tenant_id = new.tenant_id and d.customer_id = o.customer_id
                and s.revoked_at is null and s.expires_at > now())
        on conflict (tenant_id, status_change_id) do nothing;
        return new;
      end $$;
      revoke all on function whiteoven_enqueue_push_delivery() from public;
      create trigger order_status_changes_push after insert on order_status_changes
        for each row execute function whiteoven_enqueue_push_delivery();
    `);
  }

  override down(): void {
    throw new Error("Migration20261104000000_customer_push is forward-only");
  }
}
