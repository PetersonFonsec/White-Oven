import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * M3.5 brand theme (ADR 0014). One row per tenant written by the OWNER: overrides of the brand
 * color tokens only, plus logo and icon from the tenant's own images. `version` grows on every
 * save so the app can drop its cached theme. The store audit trigger is extended to the table.
 */
export class Migration20261026000000_brand_themes extends Migration {
  override up(): void {
    this.addSql(`
      create table brand_themes (
        tenant_id uuid primary key references tenants(id),
        color_overrides jsonb not null default '{}'::jsonb,
        logo_asset_id uuid,
        icon_asset_id uuid,
        version integer not null default 1,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint brand_themes_logo_fkey foreign key (tenant_id,logo_asset_id)
          references image_assets(tenant_id,id),
        constraint brand_themes_icon_fkey foreign key (tenant_id,icon_asset_id)
          references image_assets(tenant_id,id),
        constraint brand_themes_color_overrides check (
          jsonb_typeof(color_overrides) = 'object'
          and color_overrides - array['primary','primaryHover','primaryPressed','onPrimary','accentText'] = '{}'::jsonb),
        constraint brand_themes_version check (version >= 1)
      );

      create or replace function whiteoven_store_audit_change() returns trigger
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
        if TG_TABLE_NAME in ('store_settings','store_opening_hours','brand_themes') and p_role<>'OWNER' then
          raise exception using errcode='42501';
        end if;
        if TG_TABLE_NAME='store_settings' then
          p_entity_type := 'store_settings'; p_action := 'store.settings.updated';
        elsif TG_TABLE_NAME='store_opening_hours' then
          p_entity_type := 'opening_hours'; p_action := 'store.opening_hours.updated';
        elsif TG_TABLE_NAME='brand_themes' then
          p_entity_type := 'brand_theme'; p_action := 'store.brand.updated';
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

      create trigger brand_themes_audit after insert or update or delete on brand_themes
        for each row execute function whiteoven_store_audit_change();
      revoke all on function whiteoven_store_audit_change() from public, whiteoven_app;
    `);
    for (const statement of tenantIsolationSql("brand_themes"))
      this.addSql(statement);
    this.addSql(
      "grant select, insert, update on brand_themes to whiteoven_app;",
    );
  }

  override down(): void {
    throw new Error("Migration20261026000000_brand_themes is forward-only");
  }
}
