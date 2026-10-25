import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/** M2.4 crusts, extras, simple products, pricing policy and rapid availability. */
export class Migration20261024060000_catalog_addons extends Migration {
  override up(): void {
    this.addSql(`
      create table catalog_crusts (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
        name text not null, available boolean not null default true, archived_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint catalog_crusts_tenant_id_id_key unique (tenant_id,id),
        constraint catalog_crusts_name_length check (char_length(btrim(name)) between 1 and 120)
      );
      create unique index catalog_crusts_active_name_key on catalog_crusts(tenant_id,lower(name)) where archived_at is null;

      create table catalog_crust_prices (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
        crust_id uuid not null, size_id uuid not null, price_cents integer not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint catalog_crust_prices_tenant_id_id_key unique (tenant_id,id),
        constraint catalog_crust_prices_pair_key unique (tenant_id,crust_id,size_id),
        constraint catalog_crust_prices_crust_fk foreign key (tenant_id,crust_id) references catalog_crusts(tenant_id,id),
        constraint catalog_crust_prices_size_fk foreign key (tenant_id,size_id) references pizza_sizes(tenant_id,id),
        constraint catalog_crust_prices_nonnegative check (price_cents >= 0)
      );

      create table catalog_extras (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
        name text not null, available boolean not null default true, archived_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint catalog_extras_tenant_id_id_key unique (tenant_id,id),
        constraint catalog_extras_name_length check (char_length(btrim(name)) between 1 and 120)
      );
      create unique index catalog_extras_active_name_key on catalog_extras(tenant_id,lower(name)) where archived_at is null;

      create table catalog_extra_prices (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
        extra_id uuid not null, size_id uuid not null, whole_price_cents integer not null, half_price_cents integer not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint catalog_extra_prices_tenant_id_id_key unique (tenant_id,id),
        constraint catalog_extra_prices_pair_key unique (tenant_id,extra_id,size_id),
        constraint catalog_extra_prices_extra_fk foreign key (tenant_id,extra_id) references catalog_extras(tenant_id,id),
        constraint catalog_extra_prices_size_fk foreign key (tenant_id,size_id) references pizza_sizes(tenant_id,id),
        constraint catalog_extra_prices_nonnegative check (half_price_cents >= 0 and whole_price_cents >= 0),
        constraint catalog_extra_prices_ratio check (half_price_cents <= whole_price_cents and whole_price_cents::bigint <= 2::bigint * half_price_cents)
      );

      create table catalog_simple_products (
        id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
        category_id uuid not null, name text not null, price_cents integer not null, available boolean not null default true,
        archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint catalog_simple_products_tenant_id_id_key unique (tenant_id,id),
        constraint catalog_simple_products_category_fk foreign key (tenant_id,category_id) references catalog_categories(tenant_id,id),
        constraint catalog_simple_products_name_length check (char_length(btrim(name)) between 1 and 120),
        constraint catalog_simple_products_nonnegative check (price_cents >= 0)
      );
      create unique index catalog_simple_products_active_name_key on catalog_simple_products(tenant_id,category_id,lower(name)) where archived_at is null;

      create function whiteoven_validate_product_category() returns trigger language plpgsql as $$
      begin
        if not exists (select 1 from catalog_categories c where c.tenant_id=new.tenant_id
          and c.id=new.category_id and c.kind='PRODUCT' and c.archived_at is null) then
          raise exception using errcode='23514', constraint='catalog_simple_products_product_category';
        end if;
        return new;
      end $$;
      create trigger catalog_simple_products_validate_category before insert or update of category_id,tenant_id
        on catalog_simple_products for each row execute function whiteoven_validate_product_category();

      create or replace function whiteoven_catalog_audit_change() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare
        p_tenant_id uuid; p_actor_id uuid; p_session_id uuid; p_request_id uuid;
        p_entity_type text; p_entity_id uuid; p_action text; p_changes jsonb;
        p_before jsonb; p_after jsonb; p_role text;
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
        select m.role into p_role from public.staff_sessions s
          join public.staff_users u on u.id=s.staff_user_id
          join public.memberships m on m.staff_user_id=u.id
          where s.id=p_session_id and s.staff_user_id=p_actor_id and s.revoked_at is null
            and s.idle_expires_at>now() and u.status='ACTIVE' and m.tenant_id=p_tenant_id
            and m.status='ACTIVE' and m.role in ('OWNER','MANAGER','STAFF');
        if p_tenant_id is null or public.whiteoven_current_tenant() is distinct from p_tenant_id
          or p_role is null then raise exception using errcode='42501'; end if;
        if p_role='STAFF' and not (
          TG_OP='UPDATE' and TG_TABLE_NAME='catalog_flavors'
          and p_after->>'available'='false'
          and (p_before-'available'-'updated_at')=(p_after-'available'-'updated_at')
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

      create table catalog_pricing_policies (
        tenant_id uuid primary key references tenants(id), half_and_half_strategy text not null,
        half_and_half_surcharge_cents integer not null, max_extras_per_half smallint not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        constraint catalog_pricing_policies_strategy check (half_and_half_strategy in ('HIGHEST','AVERAGE')),
        constraint catalog_pricing_policies_surcharge check (half_and_half_surcharge_cents >= 0),
        constraint catalog_pricing_policies_max_extras check (max_extras_per_half between 0 and 10)
      );

      create function whiteoven_catalog_addons_audit_change() returns trigger
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare
        p_tenant_id uuid; p_actor_id uuid; p_session_id uuid; p_request_id uuid;
        p_entity_type text; p_entity_id uuid; p_action text; p_changes jsonb; p_from jsonb; p_to jsonb; p_role text;
        p_before jsonb; p_after jsonb;
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
        if p_role='STAFF' and not (
          TG_OP='UPDATE' and TG_TABLE_NAME in ('catalog_crusts','catalog_extras','catalog_simple_products')
          and p_after->>'available'='false'
          and (p_before-'available'-'updated_at')=(p_after-'available'-'updated_at')
        ) then raise exception using errcode='42501'; end if;
        if TG_TABLE_NAME='catalog_pricing_policies' and p_role<>'OWNER' then
          raise exception using errcode='42501';
        end if;

        if TG_TABLE_NAME in ('catalog_crust_prices','catalog_extra_prices') then
          if TG_TABLE_NAME='catalog_crust_prices' then
            p_entity_type := 'crust_price'; p_entity_id := coalesce((p_after->>'crust_id')::uuid,(p_before->>'crust_id')::uuid);
            p_action := 'catalog.crust.price_';
          else
            p_entity_type := 'extra_price'; p_entity_id := coalesce((p_after->>'extra_id')::uuid,(p_before->>'extra_id')::uuid);
            p_action := 'catalog.extra.price_';
          end if;
          if TG_TABLE_NAME='catalog_crust_prices' then
            if TG_OP<>'INSERT' then p_from := to_jsonb((p_before->>'price_cents')::integer); end if;
            if TG_OP<>'DELETE' then p_to := to_jsonb((p_after->>'price_cents')::integer); end if;
          else
            if TG_OP<>'INSERT' then p_from := jsonb_build_object('whole',(p_before->>'whole_price_cents')::integer,'half',(p_before->>'half_price_cents')::integer); end if;
            if TG_OP<>'DELETE' then p_to := jsonb_build_object('whole',(p_after->>'whole_price_cents')::integer,'half',(p_after->>'half_price_cents')::integer); end if;
          end if;
          if TG_OP='INSERT' then
            p_action := p_action||'created';
            p_changes := jsonb_build_object('sizeId',p_after->>'size_id','from',null,'to',p_to);
          elsif TG_OP='DELETE' then
            p_action := p_action||'removed';
            p_changes := jsonb_build_object('sizeId',p_before->>'size_id','from',p_from,'to',null);
          else
            p_action := p_action||'changed';
            p_changes := jsonb_build_object('sizeId',p_after->>'size_id','from',p_from,'to',p_to);
          end if;
        else
          p_entity_type := case TG_TABLE_NAME when 'catalog_crusts' then 'crust'
            when 'catalog_extras' then 'extra' when 'catalog_simple_products' then 'product'
            else 'pricing_policy' end;
          p_entity_id := coalesce((p_after->>'id')::uuid,(p_before->>'id')::uuid,p_tenant_id);
          if TG_OP='INSERT' then p_action := 'catalog.'||p_entity_type||'.created';
          elsif TG_OP='DELETE' then p_action := 'catalog.'||p_entity_type||'.deleted';
          elsif p_before->>'archived_at' is null and p_after->>'archived_at' is not null then p_action := 'catalog.'||p_entity_type||'.archived';
          elsif p_entity_type='pricing_policy' then p_action := 'catalog.pricing_policy.updated';
          else p_action := 'catalog.'||p_entity_type||'.updated'; end if;
          p_changes := jsonb_build_object(
            'before',coalesce(p_before-'id'-'tenant_id'-'created_at'-'updated_at','{}'::jsonb),
            'after',coalesce(p_after-'id'-'tenant_id'-'created_at'-'updated_at','{}'::jsonb));
        end if;
        insert into public.audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,changes,request_id)
        values (p_tenant_id,'STAFF',p_actor_id,p_action,p_entity_type,p_entity_id,p_changes,p_request_id);
        if TG_OP='DELETE' then return OLD; else return NEW; end if;
      end $$;

      create trigger catalog_crusts_audit after insert or update or delete on catalog_crusts for each row execute function whiteoven_catalog_addons_audit_change();
      create trigger catalog_crust_prices_audit after insert or update or delete on catalog_crust_prices for each row execute function whiteoven_catalog_addons_audit_change();
      create trigger catalog_extras_audit after insert or update or delete on catalog_extras for each row execute function whiteoven_catalog_addons_audit_change();
      create trigger catalog_extra_prices_audit after insert or update or delete on catalog_extra_prices for each row execute function whiteoven_catalog_addons_audit_change();
      create trigger catalog_simple_products_audit after insert or update or delete on catalog_simple_products for each row execute function whiteoven_catalog_addons_audit_change();
      create trigger catalog_pricing_policies_audit after insert or update or delete on catalog_pricing_policies for each row execute function whiteoven_catalog_addons_audit_change();
      revoke all on function whiteoven_catalog_addons_audit_change() from public, whiteoven_app;
    `);
    for (const table of [
      "catalog_crusts",
      "catalog_crust_prices",
      "catalog_extras",
      "catalog_extra_prices",
      "catalog_simple_products",
      "catalog_pricing_policies",
    ])
      for (const statement of tenantIsolationSql(table)) this.addSql(statement);
    this.addSql(`
      grant select, insert, update on catalog_crusts, catalog_crust_prices, catalog_extras,
        catalog_extra_prices, catalog_simple_products, catalog_pricing_policies to whiteoven_app;
      grant delete on catalog_crust_prices, catalog_extra_prices to whiteoven_app;
    `);
  }

  override down(): void {
    throw new Error("Migration20261024060000_catalog_addons is forward-only");
  }
}
