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

      create function whiteoven_catalog_audit_change() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare
        p_tenant_id uuid;
        p_actor_id uuid;
        p_session_id uuid;
        p_request_id uuid;
        p_entity_type text;
        p_entity_id uuid;
        p_action text;
        p_changes jsonb;
        p_before jsonb;
        p_after jsonb;
      begin
        -- The schema owner seeds fixtures and migrations; runtime writes always use whiteoven_app.
        if session_user = 'whiteoven_owner' then
          if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
        end if;
        p_before := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
        p_after := case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end;
        p_tenant_id := coalesce((p_after->>'tenant_id')::uuid,(p_before->>'tenant_id')::uuid);
        p_actor_id := nullif(current_setting('app.catalog_actor_id',true),'')::uuid;
        p_session_id := nullif(current_setting('app.catalog_session_id',true),'')::uuid;
        p_request_id := nullif(current_setting('app.catalog_request_id',true),'')::uuid;
        if p_tenant_id is null or public.whiteoven_current_tenant() is distinct from p_tenant_id
          or not exists (
            select 1 from public.staff_sessions s
            join public.staff_users u on u.id=s.staff_user_id
            join public.memberships m on m.staff_user_id=u.id
            where s.id=p_session_id and s.staff_user_id=p_actor_id and s.revoked_at is null
              and s.idle_expires_at>now() and u.status='ACTIVE' and m.tenant_id=p_tenant_id
              and m.status='ACTIVE' and m.role in ('OWNER','MANAGER')
          ) then raise exception using errcode='42501'; end if;

        if TG_TABLE_NAME = 'catalog_flavor_prices' then
          p_entity_type := 'flavor_price';
          p_entity_id := coalesce((p_after->>'flavor_id')::uuid,(p_before->>'flavor_id')::uuid);
          if TG_OP = 'INSERT' then
            p_action := 'catalog.flavor.price_created';
            p_changes := jsonb_build_object('sizeId',p_after->>'size_id','from',null,'to',(p_after->>'price_cents')::integer);
          elsif TG_OP = 'DELETE' then
            p_action := 'catalog.flavor.price_removed';
            p_changes := jsonb_build_object('sizeId',p_before->>'size_id','from',(p_before->>'price_cents')::integer,'to',null);
          else
            p_action := 'catalog.flavor.price_changed';
            p_changes := jsonb_build_object('sizeId',p_after->>'size_id','from',(p_before->>'price_cents')::integer,'to',(p_after->>'price_cents')::integer);
          end if;
        elsif TG_TABLE_NAME = 'catalog_flavor_ingredients' then
          p_entity_type := 'flavor';
          p_entity_id := coalesce((p_after->>'flavor_id')::uuid,(p_before->>'flavor_id')::uuid);
          if TG_OP = 'INSERT' then p_action := 'catalog.flavor.ingredient_added';
          else p_action := 'catalog.flavor.ingredient_removed'; end if;
          p_changes := jsonb_build_object('ingredientId',coalesce(p_after->>'ingredient_id',p_before->>'ingredient_id'));
        else
          p_entity_type := case TG_TABLE_NAME
            when 'catalog_categories' then 'category' when 'pizza_sizes' then 'size'
            when 'catalog_ingredients' then 'ingredient' else 'flavor' end;
          p_entity_id := coalesce((p_after->>'id')::uuid,(p_before->>'id')::uuid);
          if TG_OP = 'INSERT' then p_action := 'catalog.'||p_entity_type||'.created';
          elsif TG_OP = 'DELETE' then p_action := 'catalog.'||p_entity_type||'.deleted';
          elsif p_before->>'archived_at' is null and p_after->>'archived_at' is not null then
            p_action := 'catalog.'||p_entity_type||'.archived';
          else p_action := 'catalog.'||p_entity_type||'.updated'; end if;
          p_changes := jsonb_build_object(
            'before',coalesce(p_before - 'id' - 'tenant_id' - 'created_at' - 'updated_at','{}'::jsonb),
            'after',coalesce(p_after - 'id' - 'tenant_id' - 'created_at' - 'updated_at','{}'::jsonb));
        end if;
        insert into public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,changes,request_id)
        values (p_tenant_id,'STAFF',p_actor_id,p_action,p_entity_type,p_entity_id,p_changes,p_request_id);
        if TG_OP = 'DELETE' then return OLD; else return NEW; end if;
      end $$;

      create trigger catalog_categories_audit after insert or update or delete on catalog_categories
        for each row execute function whiteoven_catalog_audit_change();
      create trigger pizza_sizes_audit after insert or update or delete on pizza_sizes
        for each row execute function whiteoven_catalog_audit_change();
      create trigger catalog_ingredients_audit after insert or update or delete on catalog_ingredients
        for each row execute function whiteoven_catalog_audit_change();
      create trigger catalog_flavors_audit after insert or update or delete on catalog_flavors
        for each row execute function whiteoven_catalog_audit_change();
      create trigger catalog_flavor_ingredients_audit after insert or delete on catalog_flavor_ingredients
        for each row execute function whiteoven_catalog_audit_change();
      create trigger catalog_flavor_prices_audit after insert or update or delete on catalog_flavor_prices
        for each row execute function whiteoven_catalog_audit_change();
      revoke all on function whiteoven_catalog_audit_change() from public, whiteoven_app;

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
