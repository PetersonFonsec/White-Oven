import { Migration } from "@mikro-orm/migrations";

/**
 * M6.2 billing ledger (ADR 0025): every `billing_entries` row carries the plan snapshot and the
 * tenant-local month it belongs to, rows are written only by SECURITY DEFINER functions and are
 * never updated or deleted, and an operator reverses a completed order with an `ORDER_REVERSED`
 * entry instead of touching the original.
 */
export class Migration20261103000000_billing_ledger extends Migration {
  override up(): void {
    this.addSql(`
      alter table billing_entries
        add column plan text references plans (code),
        add column fee_basis_points integer,
        add column subscription_id uuid,
        add column period text,
        add column reverses_entry_id uuid,
        add column reason_code text,
        add column created_by uuid references staff_users (id);
    `);

    // Development rows written by M4.4: snapshot the period that was current when they occurred
    // (M6.1 gave live tenants Flex from their creation) and their tenant-local month.
    this.addSql(`
      do $$
      declare t record; prior_context text := current_setting('app.tenant_id', true);
      begin
        for t in select id, timezone from public.tenants loop
          perform set_config('app.tenant_id', t.id::text, true);
          update public.billing_entries b
             set period = to_char(b.occurred_at at time zone t.timezone, 'YYYY-MM'),
                 plan = s.plan, fee_basis_points = s.fee_basis_points, subscription_id = s.id
            from public.plan_subscriptions s
           where b.tenant_id = t.id and s.tenant_id = t.id
             and s.valid_from <= b.occurred_at and (s.valid_to is null or s.valid_to > b.occurred_at);
          update public.billing_entries b
             set period = to_char(b.occurred_at at time zone t.timezone, 'YYYY-MM')
           where b.tenant_id = t.id and b.period is null;
        end loop;
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
      end $$;
    `);

    // NOT VALID: enforced for every new row; a development row without a covering plan period
    // keeps existing rather than blocking the migration.
    this.addSql(`
      alter table billing_entries
        alter column period set not null,
        add constraint billing_entries_period_format check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        add constraint billing_entries_subscription_fk foreign key (tenant_id, subscription_id)
          references plan_subscriptions (tenant_id, id),
        add constraint billing_entries_reverses_fk foreign key (tenant_id, reverses_entry_id)
          references billing_entries (tenant_id, id),
        add constraint billing_entries_plan_snapshot check (
          type not in ('ORDER_COMPLETED', 'ORDER_REVERSED') or
          (plan is not null and fee_basis_points is not null and subscription_id is not null)) not valid,
        add constraint billing_entries_fee_basis_points_range check (
          fee_basis_points is null or fee_basis_points between 0 and 10000),
        add constraint billing_entries_reversal_shape check (
          (type = 'ORDER_REVERSED') = (reverses_entry_id is not null and reason_code is not null and created_by is not null)) not valid,
        add constraint billing_entries_reason_code_valid check (
          reason_code is null or reason_code in ('COMPLETED_BY_MISTAKE', 'SALE_UNDONE'));
      create index billing_entries_tenant_period_idx on billing_entries (tenant_id, period, occurred_at);

      -- Writes only through the functions below: the app role keeps reading its own tenant.
      revoke insert, update, delete, truncate on billing_entries from whiteoven_app;
      grant select on billing_entries to whiteoven_app;

      -- The COMPLETED history row dates the ledger entry, so its time always comes from the
      -- database: the app role may insert every column except \`at\` (default now()).
      revoke insert on order_status_changes from whiteoven_app;
      grant insert (tenant_id, order_id, from_status, to_status, actor_type, actor_id, reason_code,
        reason_text, command_key_hash, command_hash) on order_status_changes to whiteoven_app;

      create function whiteoven_billing_entries_append_only() returns trigger
      language plpgsql set search_path = pg_catalog, public as $$
      begin
        raise exception 'billing_entries is append-only' using errcode = '42501';
      end $$;
      create trigger billing_entries_append_only before update or delete on billing_entries
        for each row execute function whiteoven_billing_entries_append_only();
      create trigger billing_entries_no_truncate before truncate on billing_entries
        for each statement execute function whiteoven_billing_entries_append_only();

      -- A CHECK cannot read the reversed row: every ORDER_REVERSED must mirror an ORDER_COMPLETED of
      -- the same tenant and order, with exactly negated components and the same plan snapshot.
      -- Entries never change once written, so reading the original needs no lock. Together with the
      -- unique (tenant_id, order_id, type) key this also means one reversal per entry.
      create function whiteoven_billing_entries_reversal_check() returns trigger
      language plpgsql set search_path = pg_catalog, public as $$
      declare v_original public.billing_entries%rowtype;
      begin
        if new.type <> 'ORDER_REVERSED' then return new; end if;
        select * into v_original from public.billing_entries b
         where b.tenant_id = new.tenant_id and b.id = new.reverses_entry_id;
        if not found or v_original.type <> 'ORDER_COMPLETED'
           or v_original.order_id is distinct from new.order_id
           or new.items_subtotal_cents <> -v_original.items_subtotal_cents
           or new.delivery_fee_cents <> -v_original.delivery_fee_cents
           or new.total_cents <> -v_original.total_cents
           or new.payment_method <> v_original.payment_method
           or new.paid_online <> v_original.paid_online
           or v_original.plan is null or v_original.fee_basis_points is null or v_original.subscription_id is null
           or new.plan is distinct from v_original.plan
           or new.fee_basis_points is distinct from v_original.fee_basis_points
           or new.subscription_id is distinct from v_original.subscription_id then
          raise exception 'reversal does not mirror its entry' using errcode = '23514';
        end if;
        return new;
      end $$;
      create trigger billing_entries_reversal_check before insert on billing_entries
        for each row execute function whiteoven_billing_entries_reversal_check();
    `);

    this.addSql(`
      -- Called by the order service in the transaction that moves the order to COMPLETED. Every
      -- value comes from the database and is dated by the completion itself: the order's totals,
      -- the instant of its immutable COMPLETED history row, the plan period current at that
      -- instant and the tenant-local month of it. A retry, a concurrent call or a late call for an
      -- old order therefore computes the same entry, and an existing entry is never touched.
      create function whiteoven_record_order_completion(p_order_id uuid) returns void
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare v_tenant uuid := public.whiteoven_current_tenant(); v_order public.orders%rowtype;
        v_zone text; v_period public.plan_subscriptions%rowtype; v_at timestamptz;
      begin
        if v_tenant is null then raise exception using errcode = '42501'; end if;
        select * into v_order from public.orders o
         where o.id = p_order_id and o.tenant_id = v_tenant and o.status = 'COMPLETED';
        if not found then raise exception 'order is not completed' using errcode = '22023'; end if;
        select min(c.at) into v_at from public.order_status_changes c
         where c.tenant_id = v_tenant and c.order_id = v_order.id and c.to_status = 'COMPLETED';
        if v_at is null then raise exception 'order has no completion' using errcode = '22023'; end if;
        select t.timezone into v_zone from public.tenants t where t.id = v_tenant;
        select * into v_period from public.plan_subscriptions s
         where s.tenant_id = v_tenant and s.valid_from <= v_at and (s.valid_to is null or s.valid_to > v_at);
        if not found then raise exception using errcode = 'P0005'; end if;
        insert into public.billing_entries (tenant_id, order_id, type, items_subtotal_cents, delivery_fee_cents,
            total_cents, payment_method, paid_online, occurred_at, plan, fee_basis_points, subscription_id, period)
          values (v_tenant, v_order.id, 'ORDER_COMPLETED', v_order.items_subtotal_cents, v_order.delivery_fee_cents,
            v_order.total_cents, v_order.payment_method, false, v_at, v_period.plan, v_period.fee_basis_points,
            v_period.id, to_char(v_at at time zone v_zone, 'YYYY-MM'))
          on conflict (tenant_id, order_id, type) do nothing;
      end $$;
      revoke all on function whiteoven_record_order_completion(uuid) from public;
      grant execute on function whiteoven_record_order_completion(uuid) to whiteoven_app;

      -- One month of a tenant's ledger for platform operators (current month when p_period is null).
      create function whiteoven_platform_billing_entries(p_tenant_id uuid, p_period text, p_actor_id uuid, p_session_id uuid)
      returns table (id uuid, type text, order_id uuid, order_number integer, plan text, fee_basis_points integer,
        items_subtotal_cents integer, delivery_fee_cents integer, total_cents integer, payment_method text,
        paid_online boolean, occurred_at timestamptz, period text, reverses_entry_id uuid, reason_code text,
        reversed_by_entry_id uuid)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_context text := current_setting('app.tenant_id', true); v_zone text; v_period text;
      begin
        if not public.whiteoven_assert_platform_actor(p_actor_id, p_session_id) then raise exception using errcode = '42501'; end if;
        if p_period is not null and p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception using errcode = '22023'; end if;
        select t.timezone into v_zone from public.tenants t where t.id = p_tenant_id;
        if v_zone is null then raise exception using errcode = 'P0002'; end if;
        v_period := coalesce(p_period, to_char(clock_timestamp() at time zone v_zone, 'YYYY-MM'));
        perform set_config('app.tenant_id', p_tenant_id::text, true);
        return query
          select b.id, b.type, b.order_id, o.number, b.plan, b.fee_basis_points, b.items_subtotal_cents,
                 b.delivery_fee_cents, b.total_cents, b.payment_method, b.paid_online, b.occurred_at, b.period,
                 b.reverses_entry_id, b.reason_code, r.id
            from public.billing_entries b
            left join public.orders o on o.tenant_id = b.tenant_id and o.id = b.order_id
            left join public.billing_entries r on r.tenant_id = b.tenant_id and r.reverses_entry_id = b.id
           where b.tenant_id = p_tenant_id and b.period = v_period
           order by b.occurred_at, b.id;
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
      end $$;
      revoke all on function whiteoven_platform_billing_entries(uuid,text,uuid,uuid) from public;
      grant execute on function whiteoven_platform_billing_entries(uuid,text,uuid,uuid) to whiteoven_app;

      -- Reverses a completed order's entry with negated components and the original plan snapshot,
      -- in the month the reversal happens (the insert trigger checks the mirror again). The original row never changes; a second request for
      -- the same entry returns the existing reversal (changed = false) and writes no audit event.
      create function whiteoven_reverse_billing_entry(
        p_tenant_id uuid, p_entry_id uuid, p_reason_code text,
        p_actor_id uuid, p_session_id uuid, p_ip_hash bytea, p_request_id uuid
      ) returns table (id uuid, changed boolean)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_context text := current_setting('app.tenant_id', true); v_zone text;
        v_entry public.billing_entries%rowtype; v_existing uuid; v_new uuid; v_at timestamptz;
      begin
        if not public.whiteoven_assert_platform_actor(p_actor_id, p_session_id) then raise exception using errcode = '42501'; end if;
        if p_reason_code is null or p_reason_code not in ('COMPLETED_BY_MISTAKE', 'SALE_UNDONE') then
          raise exception using errcode = '22023';
        end if;
        select t.timezone into v_zone from public.tenants t where t.id = p_tenant_id;
        if v_zone is null then raise exception using errcode = 'P0002'; end if;
        perform set_config('app.tenant_id', p_tenant_id::text, true);
        select * into v_entry from public.billing_entries b
         where b.tenant_id = p_tenant_id and b.id = p_entry_id and b.type = 'ORDER_COMPLETED'
         for update;
        if not found then
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          raise exception using errcode = 'P0008';
        end if;
        -- A development entry older than its plan period has no snapshot to mirror (ADR 0025):
        -- refuse it instead of inventing one.
        if v_entry.plan is null or v_entry.fee_basis_points is null or v_entry.subscription_id is null then
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          raise exception using errcode = 'P0009';
        end if;
        select b.id into v_existing from public.billing_entries b
         where b.tenant_id = p_tenant_id and b.order_id = v_entry.order_id and b.type = 'ORDER_REVERSED';
        if v_existing is not null then
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          return query select v_existing, false;
          return;
        end if;
        v_at := clock_timestamp();
        insert into public.billing_entries (tenant_id, order_id, type, items_subtotal_cents, delivery_fee_cents,
            total_cents, payment_method, paid_online, occurred_at, plan, fee_basis_points, subscription_id, period,
            reverses_entry_id, reason_code, created_by)
          values (p_tenant_id, v_entry.order_id, 'ORDER_REVERSED', -v_entry.items_subtotal_cents, -v_entry.delivery_fee_cents,
            -v_entry.total_cents, v_entry.payment_method, v_entry.paid_online, v_at, v_entry.plan, v_entry.fee_basis_points,
            v_entry.subscription_id, to_char(v_at at time zone v_zone, 'YYYY-MM'), v_entry.id, p_reason_code, p_actor_id)
          returning billing_entries.id into v_new;
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
          values (p_tenant_id, 'OPERATOR', p_actor_id, 'billing_entry.reversed', 'billing_entry', v_new,
            jsonb_build_object('reversesEntryId', v_entry.id, 'orderId', v_entry.order_id, 'reasonCode', p_reason_code,
              'totalCents', -v_entry.total_cents, 'period', to_char(v_at at time zone v_zone, 'YYYY-MM')),
            p_ip_hash, p_request_id);
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
        return query select v_new, true;
      end $$;
      revoke all on function whiteoven_reverse_billing_entry(uuid,uuid,text,uuid,uuid,bytea,uuid) from public;
      grant execute on function whiteoven_reverse_billing_entry(uuid,uuid,text,uuid,uuid,bytea,uuid) to whiteoven_app;
    `);
  }

  override down(): void {
    throw new Error("Migration20261103000000_billing_ledger is forward-only");
  }
}
