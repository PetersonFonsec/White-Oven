import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/** M2.3 tenant-owned pizza catalog and per-size flavor pricing. */
export class Migration20261024050000_catalog extends Migration {
  override up(): void {
    this.addSql(`
      create table catalog_categories (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
        name text not null, kind text not null, sort_order integer not null default 0,
        archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint catalog_categories_tenant_id_id_key unique (tenant_id,id),
        constraint catalog_categories_name_length check (char_length(btrim(name)) between 1 and 120),
        constraint catalog_categories_kind check (kind in ('PIZZA','PRODUCT')),
        constraint catalog_categories_sort_order check (sort_order >= 0)
      );
      create unique index catalog_categories_active_name_key on catalog_categories(tenant_id, lower(name)) where archived_at is null;

      create table pizza_sizes (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
        name text not null, slices integer not null, max_flavors smallint not null,
        sort_order integer not null default 0, available boolean not null default true,
        archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint pizza_sizes_tenant_id_id_key unique (tenant_id,id),
        constraint pizza_sizes_name_length check (char_length(btrim(name)) between 1 and 120),
        constraint pizza_sizes_slices check (slices >= 1), constraint pizza_sizes_max_flavors check (max_flavors in (1,2)),
        constraint pizza_sizes_sort_order check (sort_order >= 0)
      );
      create unique index pizza_sizes_active_name_key on pizza_sizes(tenant_id, lower(name)) where archived_at is null;

      create table catalog_ingredients (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
        name text not null, removable boolean not null default true,
        archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint catalog_ingredients_tenant_id_id_key unique (tenant_id,id),
        constraint catalog_ingredients_name_length check (char_length(btrim(name)) between 1 and 120)
      );
      create unique index catalog_ingredients_active_name_key on catalog_ingredients(tenant_id, lower(name)) where archived_at is null;

      create table catalog_flavors (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
        category_id uuid not null, name text not null, description text, available boolean not null default true,
        archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint catalog_flavors_tenant_id_id_key unique (tenant_id,id),
        constraint catalog_flavors_category_fk foreign key (tenant_id,category_id) references catalog_categories(tenant_id,id),
        constraint catalog_flavors_name_length check (char_length(btrim(name)) between 1 and 120),
        constraint catalog_flavors_description_length check (description is null or char_length(description) <= 2000)
      );
      create unique index catalog_flavors_active_name_key on catalog_flavors(tenant_id,category_id,lower(name)) where archived_at is null;

      create function whiteoven_validate_flavor_category() returns trigger language plpgsql as $$
      begin
        if not exists (select 1 from catalog_categories c where c.tenant_id=new.tenant_id
          and c.id=new.category_id and c.kind='PIZZA' and c.archived_at is null) then
          raise exception using errcode='23514', constraint='catalog_flavors_pizza_category';
        end if;
        return new;
      end $$;
      create trigger catalog_flavors_validate_category before insert or update of category_id,tenant_id
        on catalog_flavors for each row execute function whiteoven_validate_flavor_category();

      create function whiteoven_protect_category_kind() returns trigger language plpgsql as $$
      begin
        if new.kind <> old.kind and exists (select 1 from catalog_flavors f where f.tenant_id=old.tenant_id
          and f.category_id=old.id and f.archived_at is null) then
          raise exception using errcode='23514', constraint='catalog_category_kind_in_use';
        end if;
        return new;
      end $$;
      create trigger catalog_categories_protect_kind before update of kind on catalog_categories
        for each row execute function whiteoven_protect_category_kind();

      create table catalog_flavor_ingredients (
        tenant_id uuid not null references tenants(id), flavor_id uuid not null, ingredient_id uuid not null,
        primary key (tenant_id,flavor_id,ingredient_id),
        constraint catalog_flavor_ingredients_flavor_fk foreign key (tenant_id,flavor_id) references catalog_flavors(tenant_id,id),
        constraint catalog_flavor_ingredients_ingredient_fk foreign key (tenant_id,ingredient_id) references catalog_ingredients(tenant_id,id)
      );

      create table catalog_flavor_prices (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
        flavor_id uuid not null, size_id uuid not null, price_cents integer not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint catalog_flavor_prices_tenant_id_id_key unique (tenant_id,id),
        constraint catalog_flavor_prices_pair_key unique (tenant_id,flavor_id,size_id),
        constraint catalog_flavor_prices_flavor_fk foreign key (tenant_id,flavor_id) references catalog_flavors(tenant_id,id),
        constraint catalog_flavor_prices_size_fk foreign key (tenant_id,size_id) references pizza_sizes(tenant_id,id),
        constraint catalog_flavor_prices_positive check (price_cents > 0)
      );

      create function whiteoven_catalog_write_audit(p_actor_id uuid, p_session_id uuid, p_action text, p_entity_type text,
        p_entity_id uuid, p_changes jsonb, p_request_id uuid)
      returns void language plpgsql security definer set search_path = pg_catalog, public as $$
      declare p_tenant_id uuid := public.whiteoven_current_tenant(); begin
        if p_tenant_id is null or not exists (
          select 1 from public.staff_sessions s
          join public.staff_users u on u.id=s.staff_user_id
          join public.memberships m on m.staff_user_id=u.id
          where s.id=p_session_id and s.staff_user_id=p_actor_id and s.revoked_at is null
            and s.idle_expires_at>now() and u.status='ACTIVE' and m.tenant_id=p_tenant_id
            and m.status='ACTIVE' and m.role in ('OWNER','MANAGER')
        ) then raise exception using errcode='42501'; end if;
        insert into public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,changes,request_id)
        values (p_tenant_id,'STAFF',p_actor_id,p_action,p_entity_type,p_entity_id,p_changes,p_request_id);
      end $$;
      revoke all on function whiteoven_catalog_write_audit(uuid,uuid,text,text,uuid,jsonb,uuid) from public;
      grant execute on function whiteoven_catalog_write_audit(uuid,uuid,text,text,uuid,jsonb,uuid) to whiteoven_app;

      create function whiteoven_catalog_read_audit(p_actor_id uuid,p_session_id uuid,p_tenant_id uuid)
      returns setof public.audit_events language sql stable security definer set search_path = pg_catalog, public as $$
        select e.* from public.audit_events e
        where e.tenant_id=p_tenant_id and exists (
          select 1 from public.staff_sessions s join public.staff_users u on u.id=s.staff_user_id
          join public.memberships m on m.staff_user_id=u.id
          where s.id=p_session_id and s.staff_user_id=p_actor_id and s.revoked_at is null
            and s.idle_expires_at>now() and u.status='ACTIVE' and m.tenant_id=p_tenant_id
            and m.status='ACTIVE' and m.role in ('OWNER','MANAGER')
        ) order by e.at desc
      $$;
      revoke all on function whiteoven_catalog_read_audit(uuid,uuid,uuid) from public;
      grant execute on function whiteoven_catalog_read_audit(uuid,uuid,uuid) to whiteoven_app;
    `);
    for (const table of [
      "catalog_categories",
      "pizza_sizes",
      "catalog_ingredients",
      "catalog_flavors",
      "catalog_flavor_ingredients",
      "catalog_flavor_prices",
    ])
      for (const statement of tenantIsolationSql(table)) this.addSql(statement);
    this.addSql(`
      grant select, insert, update on catalog_categories, pizza_sizes, catalog_ingredients, catalog_flavors,
        catalog_flavor_ingredients, catalog_flavor_prices to whiteoven_app;
      revoke delete on catalog_categories, pizza_sizes, catalog_ingredients, catalog_flavors,
        catalog_flavor_ingredients, catalog_flavor_prices from whiteoven_app;
      grant delete on catalog_flavor_ingredients, catalog_flavor_prices to whiteoven_app;
    `);
  }

  override down(): void {
    throw new Error("Migration20261024050000_catalog is forward-only");
  }
}
