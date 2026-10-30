import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * M6.1 plan subscriptions (ADR 0024): a global plan catalog, per-tenant periods that copy the
 * plan values at subscription time and never overlap, and operator-only functions to read and
 * change them. A tenant becomes ACTIVE only with a current subscription.
 */
export class Migration20261102000000_plan_subscriptions extends Migration {
  override up(): void {
    // Trusted extension (PostgreSQL 13+): the database owner can create it. It gives GiST the
    // uuid equality the exclusion constraint below combines with the period overlap.
    this.addSql(`create extension if not exists btree_gist;`);
    this.addSql(`
      create table plans (
        code text primary key,
        fee_basis_points integer not null,
        monthly_fee_cents integer not null,
        updated_at timestamptz not null default now(),
        constraint plans_code_valid check (code in ('FLEX', 'PRO')),
        constraint plans_fee_basis_points_range check (fee_basis_points between 0 and 10000),
        constraint plans_monthly_fee_cents_range check (monthly_fee_cents between 0 and 100000000)
      );
      insert into plans (code, fee_basis_points, monthly_fee_cents) values
        ('FLEX', 300, 0),
        ('PRO', 0, 19900);
      revoke all on plans from public, whiteoven_app, whiteoven_platform;

      create table plan_subscriptions (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        plan text not null references plans (code),
        fee_basis_points integer not null,
        monthly_fee_cents integer not null,
        valid_from timestamptz not null,
        valid_to timestamptz,
        created_by uuid references staff_users (id),
        created_at timestamptz not null default now(),
        constraint plan_subscriptions_tenant_id_id_key unique (tenant_id, id),
        constraint plan_subscriptions_period check (valid_to is null or valid_to > valid_from),
        constraint plan_subscriptions_fee_basis_points_range check (fee_basis_points between 0 and 10000),
        constraint plan_subscriptions_monthly_fee_cents_range check (monthly_fee_cents between 0 and 100000000),
        constraint plan_subscriptions_no_overlap
          exclude using gist (tenant_id with =, tstzrange(valid_from, valid_to, '[)') with &&)
      );
      create index plan_subscriptions_tenant_from_idx on plan_subscriptions (tenant_id, valid_from desc);
    `);
    for (const statement of tenantIsolationSql("plan_subscriptions"))
      this.addSql(statement);
    // Only the SECURITY DEFINER operations below write periods; M6.2 reads the current one.
    this.addSql(`
      revoke insert, update, delete, truncate on plan_subscriptions from whiteoven_app;
      grant select on plan_subscriptions to whiteoven_app;
    `);

    // No production data exists yet (M7). Development tenants that are already live keep working
    // under FLEX, the plan without a monthly fee, from their creation; created_by null = migration.
    this.addSql(`
      do $$
      declare t record; prior_context text := current_setting('app.tenant_id', true);
      begin
        for t in select id, created_at from public.tenants where status in ('ACTIVE', 'SUSPENDED') loop
          perform set_config('app.tenant_id', t.id::text, true);
          insert into public.plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from)
            select t.id, p.code, p.fee_basis_points, p.monthly_fee_cents, t.created_at
              from public.plans p where p.code = 'FLEX';
        end loop;
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
      end $$;
    `);

    this.addSql(`
      -- Same as M1.5 plus the tenant's IANA time zone, which the panel needs to show plan dates as
      -- the store's calendar days. The return type changes, so the function is recreated.
      drop function whiteoven_platform_tenants(uuid, uuid);
      create function whiteoven_platform_tenants(p_actor_id uuid, p_session_id uuid)
      returns table (id uuid, slug text, display_name text, status text, created_at timestamptz, timezone text)
      language sql stable security definer set search_path = pg_catalog, public as $$
        select t.id, t.slug, t.display_name, t.status, t.created_at, t.timezone from public.tenants t
         where public.whiteoven_assert_platform_actor(p_actor_id, p_session_id)
         order by t.created_at desc
      $$;
      revoke all on function whiteoven_platform_tenants(uuid,uuid) from public;
      grant execute on function whiteoven_platform_tenants(uuid,uuid) to whiteoven_app;

      create function whiteoven_platform_plans(p_actor_id uuid, p_session_id uuid)
      returns table (code text, fee_basis_points integer, monthly_fee_cents integer)
      language sql stable security definer set search_path = pg_catalog, public as $$
        select p.code, p.fee_basis_points, p.monthly_fee_cents from public.plans p
         where public.whiteoven_assert_platform_actor(p_actor_id, p_session_id)
         order by p.code
      $$;
      revoke all on function whiteoven_platform_plans(uuid,uuid) from public;
      grant execute on function whiteoven_platform_plans(uuid,uuid) to whiteoven_app;

      -- Current and scheduled periods of every tenant, for the operator's tenant list.
      create function whiteoven_platform_open_plan_subscriptions(p_actor_id uuid, p_session_id uuid)
      returns table (tenant_id uuid, plan text, valid_from timestamptz, valid_to timestamptz)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare t record; prior_context text := current_setting('app.tenant_id', true);
      begin
        if not public.whiteoven_assert_platform_actor(p_actor_id, p_session_id) then raise exception using errcode = '42501'; end if;
        for t in select id from public.tenants loop
          perform set_config('app.tenant_id', t.id::text, true);
          return query select s.tenant_id, s.plan, s.valid_from, s.valid_to
            from public.plan_subscriptions s
           where s.tenant_id = t.id and (s.valid_to is null or s.valid_to > now());
        end loop;
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
      end $$;
      revoke all on function whiteoven_platform_open_plan_subscriptions(uuid,uuid) from public;
      grant execute on function whiteoven_platform_open_plan_subscriptions(uuid,uuid) to whiteoven_app;

      create function whiteoven_platform_plan_subscriptions(p_tenant_id uuid, p_actor_id uuid, p_session_id uuid)
      returns table (id uuid, plan text, fee_basis_points integer, monthly_fee_cents integer,
        valid_from timestamptz, valid_to timestamptz, created_at timestamptz)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_context text := current_setting('app.tenant_id', true);
      begin
        if not public.whiteoven_assert_platform_actor(p_actor_id, p_session_id) then raise exception using errcode = '42501'; end if;
        if not exists (select 1 from public.tenants where tenants.id = p_tenant_id) then raise exception using errcode = 'P0002'; end if;
        perform set_config('app.tenant_id', p_tenant_id::text, true);
        return query select s.id, s.plan, s.fee_basis_points, s.monthly_fee_cents, s.valid_from, s.valid_to, s.created_at
          from public.plan_subscriptions s where s.tenant_id = p_tenant_id
         order by s.valid_from desc;
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
      end $$;
      revoke all on function whiteoven_platform_plan_subscriptions(uuid,uuid,uuid) from public;
      grant execute on function whiteoven_platform_plan_subscriptions(uuid,uuid,uuid) to whiteoven_app;

      -- Sets the plan a tenant should be on (ADR 0024). Runs under the tenant row lock and reads the
      -- clock after taking it, so concurrent calls see each other's periods and never overlap.
      -- * No current period and nothing scheduled: the plan starts now.
      -- * No current period but a scheduled one (only reachable through data written outside this
      --   function): the plan starts now and ends where the scheduled period begins, filling the
      --   gap; the scheduled period is kept.
      -- * A current period: the change takes effect at the start of the next calendar month in the
      --   tenant's time zone (Q-10 recommendation); the current period is closed there and the new
      --   one is scheduled. A scheduled period that never took effect may be replaced or cancelled;
      --   periods that already started are never deleted nor change plan or values.
      -- * Asking for the plan already current (with nothing scheduled) or already scheduled changes
      --   nothing and writes no audit event.
      create function whiteoven_change_tenant_plan(
        p_tenant_id uuid, p_plan text, p_actor_id uuid, p_session_id uuid, p_ip_hash bytea, p_request_id uuid
      ) returns table (id uuid, plan text, valid_from timestamptz, changed boolean)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_context text := current_setting('app.tenant_id', true);
        tenant_status text; tenant_zone text; chosen public.plans%rowtype; at_now timestamptz;
        current_period public.plan_subscriptions%rowtype; scheduled public.plan_subscriptions%rowtype;
        scheduled_count integer; starts_at timestamptz; new_id uuid; cancelled boolean := false;
      begin
        if not public.whiteoven_assert_platform_actor(p_actor_id, p_session_id) then raise exception using errcode = '42501'; end if;
        select * into chosen from public.plans where code = p_plan;
        if not found then raise exception using errcode = '22023'; end if;
        select t.status, t.timezone into tenant_status, tenant_zone from public.tenants t where t.id = p_tenant_id for update;
        if tenant_status is null then raise exception using errcode = 'P0002'; end if;
        if tenant_status = 'CLOSED' then raise exception using errcode = 'P0004'; end if;
        -- now() is the transaction start; a call that waited for the lock must see the present.
        at_now := clock_timestamp();
        perform set_config('app.tenant_id', p_tenant_id::text, true);
        select * into current_period from public.plan_subscriptions s
         where s.tenant_id = p_tenant_id and s.valid_from <= at_now and (s.valid_to is null or s.valid_to > at_now);
        select count(*) into scheduled_count from public.plan_subscriptions s
         where s.tenant_id = p_tenant_id and s.valid_from > at_now;
        if scheduled_count > 1 then
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          raise exception using errcode = 'P0006';
        end if;
        select * into scheduled from public.plan_subscriptions s
         where s.tenant_id = p_tenant_id and s.valid_from > at_now;

        if current_period.id is null then
          insert into public.plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from, valid_to, created_by)
            values (p_tenant_id, chosen.code, chosen.fee_basis_points, chosen.monthly_fee_cents, at_now, scheduled.valid_from, p_actor_id)
            returning plan_subscriptions.id into new_id;
          insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
            values (p_tenant_id, 'OPERATOR', p_actor_id, 'plan_subscription.started', 'plan_subscription', new_id,
              jsonb_build_object('plan', chosen.code, 'feeBasisPoints', chosen.fee_basis_points,
                'monthlyFeeCents', chosen.monthly_fee_cents, 'validFrom', at_now, 'validTo', scheduled.valid_from),
              p_ip_hash, p_request_id);
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          return query select new_id, chosen.code, at_now, true;
          return;
        end if;

        if scheduled.id is not null and scheduled.plan = chosen.code then
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          return query select scheduled.id, scheduled.plan, scheduled.valid_from, false;
          return;
        end if;

        if scheduled.id is not null then
          -- The scheduled period never took effect: drop it and reopen the current one. A
          -- replacement below links both audit events.
          delete from public.plan_subscriptions s where s.id = scheduled.id;
          update public.plan_subscriptions s set valid_to = null where s.id = current_period.id;
          cancelled := true;
        end if;

        if current_period.plan = chosen.code then
          if cancelled then
            insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
              values (p_tenant_id, 'OPERATOR', p_actor_id, 'plan_subscription.change_cancelled', 'plan_subscription', scheduled.id,
                jsonb_build_object('plan', scheduled.plan, 'validFrom', scheduled.valid_from,
                  'reason', 'REVERTED', 'replacedBySubscriptionId', null), p_ip_hash, p_request_id);
          end if;
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          return query select current_period.id, current_period.plan, current_period.valid_from, cancelled;
          return;
        end if;

        starts_at := (date_trunc('month', at_now at time zone tenant_zone) + interval '1 month') at time zone tenant_zone;
        update public.plan_subscriptions s set valid_to = starts_at where s.id = current_period.id;
        insert into public.plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from, created_by)
          values (p_tenant_id, chosen.code, chosen.fee_basis_points, chosen.monthly_fee_cents, starts_at, p_actor_id)
          returning plan_subscriptions.id into new_id;
        if cancelled then
          insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
            values (p_tenant_id, 'OPERATOR', p_actor_id, 'plan_subscription.change_cancelled', 'plan_subscription', scheduled.id,
              jsonb_build_object('plan', scheduled.plan, 'validFrom', scheduled.valid_from,
                'reason', 'REPLACED', 'replacedBySubscriptionId', new_id), p_ip_hash, p_request_id);
        end if;
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
          values (p_tenant_id, 'OPERATOR', p_actor_id, 'plan_subscription.change_scheduled', 'plan_subscription', new_id,
            jsonb_build_object('plan', jsonb_build_object('from', current_period.plan, 'to', chosen.code),
              'feeBasisPoints', chosen.fee_basis_points, 'monthlyFeeCents', chosen.monthly_fee_cents,
              'validFrom', starts_at, 'replacesSubscriptionId', case when cancelled then scheduled.id end),
            p_ip_hash, p_request_id);
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
        return query select new_id, chosen.code, starts_at, true;
      end $$;
      revoke all on function whiteoven_change_tenant_plan(uuid,text,uuid,uuid,bytea,uuid) from public;
      grant execute on function whiteoven_change_tenant_plan(uuid,text,uuid,uuid,bytea,uuid) to whiteoven_app;
    `);

    // Same body as M1.5, plus the domain invariant: an ACTIVE tenant always has a current plan.
    this.addSql(`
      create or replace function whiteoven_change_tenant_status(
        p_tenant_id uuid, p_status text, p_actor_id uuid, p_session_id uuid, p_ip_hash bytea, p_request_id uuid
      ) returns void
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_status text; prior_context text := current_setting('app.tenant_id', true);
      begin
        if not public.whiteoven_assert_platform_actor(p_actor_id, p_session_id) then raise exception using errcode = '42501'; end if;
        if p_status not in ('ACTIVE', 'SUSPENDED') then raise exception 'invalid platform status'; end if;
        select status into prior_status from public.tenants where id = p_tenant_id for update;
        if prior_status is null then raise exception using errcode = 'P0002'; end if;
        if prior_status = 'CLOSED' or prior_status = p_status then raise exception using errcode = 'P0004'; end if;
        perform set_config('app.tenant_id', p_tenant_id::text, true);
        -- clock_timestamp(): a plan started by a call that held the lock before us is current.
        if p_status = 'ACTIVE' and not exists (
          select 1 from public.plan_subscriptions s
           where s.tenant_id = p_tenant_id and s.valid_from <= clock_timestamp()
             and (s.valid_to is null or s.valid_to > clock_timestamp())
        ) then
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          raise exception using errcode = 'P0005';
        end if;
        if p_status = 'SUSPENDED' then
          update public.orders set status = 'REJECTED', rejection_reason = 'STORE_SUSPENDED', updated_at = now()
           where tenant_id = p_tenant_id and status = 'PLACED';
          update public.staff_sessions s set revoked_at = now(), revoked_reason = 'TENANT_SUSPENDED'
            from public.memberships m
           where m.tenant_id = p_tenant_id and m.staff_user_id = s.staff_user_id
             and s.active_tenant_id = p_tenant_id
             and m.status = 'ACTIVE' and m.role in ('MANAGER', 'STAFF') and s.revoked_at is null;
        end if;
        update public.tenants set status = p_status, updated_at = now() where id = p_tenant_id;
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
          values (p_tenant_id, 'OPERATOR', p_actor_id, 'tenant.status_changed', 'tenant', p_tenant_id,
            jsonb_build_object('status', jsonb_build_object('from', prior_status, 'to', p_status)), p_ip_hash, p_request_id);
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
      end $$;
    `);
  }

  override down(): void {
    throw new Error(
      "Migration20261102000000_plan_subscriptions is forward-only",
    );
  }
}
