import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * M3.4 store settings, opening hours and manual pause (ADR 0013). Settings and hours are one row
 * per tenant written by the OWNER; the pause is its own row so any staff member can pause or
 * reopen without touching the owner's settings. Every write is audited by trigger, which also
 * refuses roles the API would refuse.
 */
export class Migration20261025000000_store_settings extends Migration {
  override up(): void {
    this.addSql(`
      create table store_settings (
        tenant_id uuid primary key references tenants(id),
        fulfillment_modes text[] not null,
        delivery_fee_cents integer not null,
        minimum_order_cents integer not null,
        delivery_area_description text,
        estimated_prep_minutes smallint not null,
        estimated_delivery_minutes smallint not null,
        accept_timeout_minutes smallint not null,
        accepted_payment_methods text[] not null,
        contact_phone text,
        pickup_address text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint store_settings_fulfillment_modes check (
          cardinality(fulfillment_modes) between 1 and 2
          and fulfillment_modes <@ array['DELIVERY','PICKUP']::text[]),
        constraint store_settings_payment_methods check (
          cardinality(accepted_payment_methods) between 1 and 3
          and accepted_payment_methods <@ array['CASH','CARD_ON_DELIVERY','PIX_ON_DELIVERY']::text[]),
        constraint store_settings_money check (delivery_fee_cents >= 0 and minimum_order_cents >= 0),
        constraint store_settings_minutes check (
          estimated_prep_minutes between 1 and 240 and estimated_delivery_minutes between 1 and 240
          and accept_timeout_minutes between 1 and 60),
        constraint store_settings_text_length check (
          char_length(coalesce(delivery_area_description,'')) <= 500
          and char_length(coalesce(contact_phone,'')) <= 30
          and char_length(coalesce(pickup_address,'')) <= 300),
        constraint store_settings_pickup_address check (
          not ('PICKUP' = any(fulfillment_modes)) or char_length(btrim(coalesce(pickup_address,''))) > 0)
      );

      create table store_opening_hours (
        tenant_id uuid primary key references tenants(id),
        rules jsonb not null,
        exceptions jsonb not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint store_opening_hours_arrays check (
          jsonb_typeof(rules) = 'array' and jsonb_typeof(exceptions) = 'array')
      );

      create table store_pauses (
        tenant_id uuid primary key references tenants(id),
        paused_until timestamptz,
        created_at timestamptz not null default now()
      );

      create function whiteoven_store_audit_change() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare
        p_tenant_id uuid; p_actor_id uuid; p_session_id uuid; p_request_id uuid;
        p_entity_type text; p_action text; p_role text; p_before jsonb; p_after jsonb;
      begin
        if session_user = 'whiteoven_owner' then
          if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
        end if;
        p_before := case when TG_OP='INSERT' then null else to_jsonb(OLD) end;
        p_after := case when TG_OP='DELETE' then null else to_jsonb(NEW) end;
        p_tenant_id := coalesce((p_after->>'tenant_id')::uuid,(p_before->>'tenant_id')::uuid);
        p_actor_id := nullif(current_setting('app.catalog_actor_id',true),'')::uuid;
        p_session_id := nullif(current_setting('app.catalog_session_id',true),'')::uuid;
        p_request_id := nullif(current_setting('app.catalog_request_id',true),'')::uuid;
        select m.role into p_role from public.staff_sessions s join public.staff_users u on u.id=s.staff_user_id
          join public.memberships m on m.staff_user_id=u.id
          where s.id=p_session_id and s.staff_user_id=p_actor_id and s.revoked_at is null
            and s.idle_expires_at>now() and u.status='ACTIVE' and m.tenant_id=p_tenant_id
            and m.status='ACTIVE' and m.role in ('OWNER','MANAGER','STAFF');
        if p_tenant_id is null or public.whiteoven_current_tenant() is distinct from p_tenant_id
          or p_role is null then raise exception using errcode='42501'; end if;
        if TG_TABLE_NAME in ('store_settings','store_opening_hours') and p_role<>'OWNER' then
          raise exception using errcode='42501';
        end if;
        if TG_TABLE_NAME='store_settings' then
          p_entity_type := 'store_settings'; p_action := 'store.settings.updated';
        elsif TG_TABLE_NAME='store_opening_hours' then
          p_entity_type := 'opening_hours'; p_action := 'store.opening_hours.updated';
        else
          p_entity_type := 'store_pause';
          p_action := case when TG_OP='DELETE' then 'store.pause.ended' else 'store.pause.started' end;
        end if;
        insert into public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,changes,request_id)
        values (p_tenant_id,'STAFF',p_actor_id,p_action,p_entity_type,p_tenant_id,
          jsonb_build_object(
            'before',coalesce(p_before-'tenant_id'-'created_at'-'updated_at','{}'::jsonb),
            'after',coalesce(p_after-'tenant_id'-'created_at'-'updated_at','{}'::jsonb)),
          p_request_id);
        if TG_OP='DELETE' then return OLD; else return NEW; end if;
      end $$;

      create trigger store_settings_audit after insert or update or delete on store_settings
        for each row execute function whiteoven_store_audit_change();
      create trigger store_opening_hours_audit after insert or update or delete on store_opening_hours
        for each row execute function whiteoven_store_audit_change();
      create trigger store_pauses_audit after insert or update or delete on store_pauses
        for each row execute function whiteoven_store_audit_change();
      revoke all on function whiteoven_store_audit_change() from public, whiteoven_app;
    `);
    for (const table of [
      "store_settings",
      "store_opening_hours",
      "store_pauses",
    ])
      for (const statement of tenantIsolationSql(table)) this.addSql(statement);
    this.addSql(`
      grant select, insert, update on store_settings, store_opening_hours, store_pauses to whiteoven_app;
      grant delete on store_pauses to whiteoven_app;
    `);
  }

  override down(): void {
    throw new Error("Migration20261025000000_store_settings is forward-only");
  }
}
