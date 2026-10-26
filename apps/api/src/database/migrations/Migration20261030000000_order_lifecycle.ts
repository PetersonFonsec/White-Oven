import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/** M4.4 order state, append-only history, billing signal and scheduled rejection support. */
export class Migration20261030000000_order_lifecycle extends Migration {
  override up(): void {
    this.addSql(`
      alter table orders drop constraint orders_status_valid;
      alter table orders add constraint orders_status_valid check (status in
        ('PLACED','PREPARING','READY','OUT_FOR_DELIVERY','COMPLETED','REJECTED','CANCELED'));
      alter table orders drop constraint orders_rejection_reason_valid;
      alter table orders add constraint orders_rejection_reason_valid check (rejection_reason is null or
        rejection_reason in ('ITEM_UNAVAILABLE','STORE_TOO_BUSY','OUT_OF_DELIVERY_AREA','CUSTOMER_UNREACHABLE',
          'NOT_PICKED_UP','SUSPECTED_FRAUD','ACCEPT_TIMEOUT','STORE_SUSPENDED','OTHER'));
      alter table orders drop constraint orders_rejection_consistent;
      alter table orders add constraint orders_rejection_consistent check ((status = 'REJECTED') = (rejection_reason is not null));

      create table order_status_changes (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), order_id uuid,
        from_status text, to_status text not null, actor_type text not null, actor_id uuid,
        reason_code text, reason_text text, command_key_hash bytea, command_hash bytea, at timestamptz not null default now(),
        constraint order_status_changes_tenant_id_id_key unique (tenant_id,id),
        constraint order_status_changes_order_fk foreign key (tenant_id,order_id) references orders(tenant_id,id),
        constraint order_status_changes_from_valid check (from_status is null or from_status in ('PLACED','PREPARING','READY','OUT_FOR_DELIVERY','COMPLETED','REJECTED','CANCELED')),
        constraint order_status_changes_to_valid check (to_status in ('PLACED','PREPARING','READY','OUT_FOR_DELIVERY','COMPLETED','REJECTED','CANCELED')),
        constraint order_status_changes_actor_valid check (actor_type in ('CUSTOMER','STAFF','SYSTEM')),
        constraint order_status_changes_reason_valid check (reason_code is null or reason_code in ('CUSTOMER_REQUEST','ITEM_UNAVAILABLE','STORE_TOO_BUSY','OUT_OF_DELIVERY_AREA','CUSTOMER_UNREACHABLE','NOT_PICKED_UP','SUSPECTED_FRAUD','ACCEPT_TIMEOUT','STORE_SUSPENDED','OTHER')),
        constraint order_status_changes_reason_text check (reason_text is null or char_length(reason_text) between 1 and 280),
        constraint order_status_changes_hashes check ((command_key_hash is null and command_hash is null) or (octet_length(command_key_hash)=32 and octet_length(command_hash)=32)),
        constraint order_status_changes_key unique (tenant_id,order_id,command_key_hash)
      );
      create index order_status_changes_order_at_idx on order_status_changes(tenant_id,order_id,at);

      create table billing_entries (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), order_id uuid not null,
        type text not null, items_subtotal_cents integer not null, delivery_fee_cents integer not null,
        total_cents integer not null, payment_method text not null, paid_online boolean not null default false,
        occurred_at timestamptz not null default now(),
        constraint billing_entries_tenant_id_id_key unique (tenant_id,id),
        constraint billing_entries_order_fk foreign key (tenant_id,order_id) references orders(tenant_id,id),
        constraint billing_entries_type_valid check (type in ('ORDER_COMPLETED','ORDER_REVERSED','SUBSCRIPTION_PERIOD','ADJUSTMENT')),
        constraint billing_entries_order_presence check ((type in ('ORDER_COMPLETED','ORDER_REVERSED')) = (order_id is not null)),
        constraint billing_entries_order_type_key unique (tenant_id,order_id,type),
        constraint billing_entries_amounts check (
          total_cents = items_subtotal_cents + delivery_fee_cents and
          ((type = 'ORDER_REVERSED' and items_subtotal_cents <= 0 and delivery_fee_cents <= 0) or
           type = 'ADJUSTMENT' or
           (type in ('ORDER_COMPLETED','SUBSCRIPTION_PERIOD') and items_subtotal_cents >= 0 and delivery_fee_cents >= 0)))
      );
    `);
    for (const table of ["order_status_changes", "billing_entries"])
      for (const statement of tenantIsolationSql(table)) this.addSql(statement);
    this.addSql(`
      revoke update, delete, truncate on order_status_changes, billing_entries from whiteoven_app;
      grant select, insert on order_status_changes, billing_entries to whiteoven_app;
      create function whiteoven_order_audit(p_actor uuid,p_order uuid,p_from text,p_to text,p_reason text,p_request uuid)
      returns void language sql security definer set search_path=pg_catalog,public as $$
        insert into public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,changes,request_id)
        values(public.whiteoven_current_tenant(),'STAFF',p_actor,'order.transitioned','order',p_order,
          jsonb_build_object('from',p_from,'to',p_to,'reasonCode',p_reason),p_request)
      $$;
      revoke all on function whiteoven_order_audit(uuid,uuid,text,text,text,uuid) from public;
      grant execute on function whiteoven_order_audit(uuid,uuid,text,text,text,uuid) to whiteoven_app;
      create function whiteoven_order_suspension_history() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
      begin
        if old.status='PLACED' and new.status='REJECTED' and new.rejection_reason='STORE_SUSPENDED' then
          insert into public.order_status_changes(tenant_id,order_id,from_status,to_status,actor_type,actor_id,reason_code,command_key_hash,command_hash)
          values(new.tenant_id,new.id,'PLACED','REJECTED','SYSTEM',new.tenant_id,'STORE_SUSPENDED',
            sha256(convert_to('system:tenant-suspended:'||new.id::text,'UTF8')),
            sha256(convert_to('["PLACED","REJECTED","STORE_SUSPENDED",null]','UTF8')))
          on conflict (tenant_id,order_id,command_key_hash) do nothing;
          insert into public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,changes)
          values(new.tenant_id,'SYSTEM',new.tenant_id,'order.transitioned','order',new.id,
            jsonb_build_object('from','PLACED','to','REJECTED','reasonCode','STORE_SUSPENDED'));
        end if;
        return new;
      end $$;
      revoke all on function whiteoven_order_suspension_history() from public;
      create trigger orders_suspension_history after update of status on orders for each row execute function whiteoven_order_suspension_history();
    `);
  }
  override down(): void {
    throw new Error("Migration20261030000000_order_lifecycle is forward-only");
  }
}
