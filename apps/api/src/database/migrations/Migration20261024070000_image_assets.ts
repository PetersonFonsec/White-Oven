import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/** M2.5 tenant-scoped image metadata and audit; image bytes live behind the storage interface. */
export class Migration20261024070000_image_assets extends Migration {
  override up(): void {
    this.addSql(`
      create table image_assets (
        id uuid primary key,
        tenant_id uuid not null references tenants(id),
        source_format text not null,
        width integer not null,
        height integer not null,
        created_at timestamptz not null default now(),
        constraint image_assets_tenant_id_id_key unique (tenant_id,id),
        constraint image_assets_format check (source_format in ('jpeg','png','webp')),
        constraint image_assets_dimensions check (width between 1 and 30000 and height between 1 and 30000)
      );
      create index image_assets_tenant_created_idx on image_assets(tenant_id,created_at desc);

      create function whiteoven_image_asset_audit_change() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare p_actor_id uuid; p_session_id uuid; p_role text; p_request_id uuid;
      begin
        if session_user = 'whiteoven_owner' then return new; end if;
        p_actor_id := nullif(current_setting('app.catalog_actor_id',true),'')::uuid;
        p_session_id := nullif(current_setting('app.catalog_session_id',true),'')::uuid;
        p_request_id := nullif(current_setting('app.catalog_request_id',true),'')::uuid;
        select m.role into p_role from public.staff_sessions s
          join public.staff_users u on u.id=s.staff_user_id
          join public.memberships m on m.staff_user_id=u.id
          where s.id=p_session_id and s.staff_user_id=p_actor_id and s.revoked_at is null
            and s.idle_expires_at>now() and u.status='ACTIVE' and m.tenant_id=new.tenant_id
            and m.status='ACTIVE' and m.role in ('OWNER','MANAGER');
        if p_actor_id is null or p_role is null
          or public.whiteoven_current_tenant() is distinct from new.tenant_id then
          raise exception using errcode='42501';
        end if;
        insert into public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,changes,request_id)
          values (new.tenant_id,'STAFF',p_actor_id,'catalog.image.created','image',new.id,
            jsonb_build_object('format',new.source_format,'width',new.width,'height',new.height),p_request_id);
        return new;
      end $$;
      create trigger image_assets_audit after insert on image_assets
        for each row execute function whiteoven_image_asset_audit_change();
      revoke all on function whiteoven_image_asset_audit_change() from public, whiteoven_app;
    `);
    for (const statement of tenantIsolationSql("image_assets"))
      this.addSql(statement);
    this.addSql("grant select,insert on image_assets to whiteoven_app;");
  }
}
