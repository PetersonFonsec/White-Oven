import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/** M1.5 platform primitives: auditable tenant lifecycle, OWNER invite and minimum order state. */
export class Migration20261024040000_platform extends Migration {
  override up(): void {
    this.addSql(`
      alter table staff_sessions drop constraint staff_sessions_revoked_reason_valid;
      alter table staff_sessions add constraint staff_sessions_revoked_reason_valid
        check (revoked_reason in ('LOGOUT', 'REFRESH_REUSE', 'USER_DISABLED', 'MFA_RESET', 'TENANT_SUSPENDED'));
    `);
    this.addSql(`
      create table audit_events (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid references tenants (id),
        actor_type text not null,
        actor_id uuid not null,
        action text not null,
        entity_type text not null,
        entity_id uuid not null,
        changes jsonb not null default '{}'::jsonb,
        ip_hash bytea,
        request_id uuid,
        at timestamptz not null default now(),
        constraint audit_events_actor_type check (actor_type in ('OPERATOR', 'STAFF', 'SYSTEM')),
        constraint audit_events_action_length check (char_length(action) between 1 and 100),
        constraint audit_events_entity_type_length check (char_length(entity_type) between 1 and 80),
        constraint audit_events_ip_hash_length check (ip_hash is null or octet_length(ip_hash) = 32)
      );
      create index audit_events_tenant_at_idx on audit_events (tenant_id, at desc);
      revoke all on audit_events from public, whiteoven_app, whiteoven_platform;

      create table orders (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        status text not null default 'PLACED',
        rejection_reason text,
        placed_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint orders_tenant_id_id_key unique (tenant_id, id),
        constraint orders_status_valid check (status in ('PLACED', 'REJECTED')),
        constraint orders_rejection_consistent check ((status = 'REJECTED') = (rejection_reason is not null)),
        constraint orders_rejection_reason_valid check (rejection_reason is null or rejection_reason = 'STORE_SUSPENDED')
      );
    `);
    for (const statement of tenantIsolationSql("orders"))
      this.addSql(statement);
    this.addSql(`revoke delete on orders from whiteoven_app;`);

    this.addSql(`
      create table owner_invites (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        email text not null,
        token_hash bytea not null,
        expires_at timestamptz not null,
        accepted_at timestamptz,
        created_by uuid not null references staff_users (id),
        created_at timestamptz not null default now(),
        constraint owner_invites_tenant_id_id_key unique (tenant_id, id),
        constraint owner_invites_tenant_email_key unique (tenant_id, email),
        constraint owner_invites_email_normalized check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
        constraint owner_invites_token_hash_length check (octet_length(token_hash) = 32),
        constraint owner_invites_token_hash_key unique (token_hash),
        constraint owner_invites_expiry check (expires_at <= created_at + interval '72 hours')
      );
    `);
    for (const statement of tenantIsolationSql("owner_invites"))
      this.addSql(statement);
    this.addSql(`revoke delete on owner_invites from whiteoven_app;`);

    this.addSql(`
      create table platform_idempotency (
        key_hash bytea primary key,
        request_hash bytea not null,
        result_tenant_id uuid not null references tenants (id),
        invite_id uuid not null,
        created_at timestamptz not null default now(),
        constraint platform_idempotency_key_hash_length check (octet_length(key_hash) = 32),
        constraint platform_idempotency_request_hash_length check (octet_length(request_hash) = 32),
        constraint platform_idempotency_tenant_invite_fk foreign key (result_tenant_id, invite_id)
          references owner_invites (tenant_id, id)
      );
      revoke all on platform_idempotency from public, whiteoven_app, whiteoven_platform;
    `);

    // The app role receives only these narrowly scoped cross-tenant operations, not DML on tenants.
    this.addSql(`
      create function whiteoven_assert_platform_actor(p_actor_id uuid, p_session_id uuid)
      returns boolean language sql stable security definer
      set search_path = pg_catalog, public as $$
        select exists (
          select 1 from public.staff_users u
          join public.staff_sessions s on s.staff_user_id = u.id
          where u.id = p_actor_id and u.platform_role = 'OPERATOR' and u.status = 'ACTIVE'
            and u.mfa_enabled_at is not null and s.id = p_session_id and s.mfa = true
            and s.revoked_at is null and s.idle_expires_at > now()
        )
      $$;
      revoke all on function whiteoven_assert_platform_actor(uuid,uuid) from public;

      create function whiteoven_create_tenant(
        p_slug text, p_display_name text, p_email text, p_token_hash bytea,
        p_actor_id uuid, p_session_id uuid, p_ip_hash bytea, p_request_id uuid,
        p_key_hash bytea, p_request_hash bytea
      ) returns table (tenant_id uuid, invite_id uuid)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare new_tenant uuid; new_invite uuid; prior_context text := current_setting('app.tenant_id', true);
        prior_operation public.platform_idempotency%rowtype; existing_token_hash bytea;
      begin
        if not public.whiteoven_assert_platform_actor(p_actor_id, p_session_id) then raise exception using errcode = '42501'; end if;
        if octet_length(p_key_hash) <> 32 or octet_length(p_request_hash) <> 32 then raise exception 'invalid idempotency data'; end if;
        perform pg_advisory_xact_lock(hashtextextended(encode(p_key_hash, 'hex'), 0));
        select * into prior_operation from public.platform_idempotency where key_hash = p_key_hash;
        if found then
          if prior_operation.request_hash <> p_request_hash then raise exception using errcode = 'P0003'; end if;
          perform set_config('app.tenant_id', prior_operation.result_tenant_id::text, true);
          select token_hash into existing_token_hash from public.owner_invites where id = prior_operation.invite_id;
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          if existing_token_hash <> p_token_hash then raise exception using errcode = 'P0003'; end if;
          return query select prior_operation.result_tenant_id, prior_operation.invite_id;
          return;
        end if;
        insert into public.tenants (slug, display_name) values (p_slug, p_display_name)
          returning id into new_tenant;
        perform set_config('app.tenant_id', new_tenant::text, true);
        insert into public.owner_invites (tenant_id, email, token_hash, expires_at, created_by)
          values (new_tenant, lower(btrim(p_email)), p_token_hash, now() + interval '72 hours', p_actor_id)
          returning id into new_invite;
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
          values (new_tenant, 'OPERATOR', p_actor_id, 'tenant.created', 'tenant', new_tenant,
            jsonb_build_object('status', 'ONBOARDING'), p_ip_hash, p_request_id);
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
          values (new_tenant, 'OPERATOR', p_actor_id, 'owner_invite.created', 'owner_invite', new_invite,
            jsonb_build_object('role', 'OWNER', 'expiresInHours', 72), p_ip_hash, p_request_id);
        insert into public.platform_idempotency (key_hash, request_hash, result_tenant_id, invite_id)
          values (p_key_hash, p_request_hash, new_tenant, new_invite);
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
        return query select new_tenant, new_invite;
      end $$;
      revoke all on function whiteoven_create_tenant(text,text,text,bytea,uuid,uuid,bytea,uuid,bytea,bytea) from public;
      grant execute on function whiteoven_create_tenant(text,text,text,bytea,uuid,uuid,bytea,uuid,bytea,bytea) to whiteoven_app;

      create function whiteoven_change_tenant_status(
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
        if p_status = 'SUSPENDED' then
          update public.orders set status = 'REJECTED', rejection_reason = 'STORE_SUSPENDED', updated_at = now()
           where tenant_id = p_tenant_id and status = 'PLACED';
          update public.staff_sessions s set revoked_at = now(), revoked_reason = 'TENANT_SUSPENDED'
            from public.memberships m
           where m.tenant_id = p_tenant_id and m.staff_user_id = s.staff_user_id
             and m.status = 'ACTIVE' and m.role in ('MANAGER', 'STAFF') and s.revoked_at is null;
        end if;
        update public.tenants set status = p_status, updated_at = now() where id = p_tenant_id;
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
          values (p_tenant_id, 'OPERATOR', p_actor_id, 'tenant.status_changed', 'tenant', p_tenant_id,
            jsonb_build_object('status', jsonb_build_object('from', prior_status, 'to', p_status)), p_ip_hash, p_request_id);
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
      end $$;
      revoke all on function whiteoven_change_tenant_status(uuid,text,uuid,uuid,bytea,uuid) from public;
      grant execute on function whiteoven_change_tenant_status(uuid,text,uuid,uuid,bytea,uuid) to whiteoven_app;

      create function whiteoven_platform_tenants(p_actor_id uuid, p_session_id uuid)
      returns table (id uuid, slug text, display_name text, status text, created_at timestamptz)
      language sql stable security definer set search_path = pg_catalog, public as $$
        select t.id, t.slug, t.display_name, t.status, t.created_at from public.tenants t
         where public.whiteoven_assert_platform_actor(p_actor_id, p_session_id)
         order by t.created_at desc
      $$;
      revoke all on function whiteoven_platform_tenants(uuid,uuid) from public;
      grant execute on function whiteoven_platform_tenants(uuid,uuid) to whiteoven_app;

      create function whiteoven_lock_tenant_status(p_tenant_id uuid)
      returns text language plpgsql volatile security definer
      set search_path = pg_catalog, public as $$
      declare current_status text;
      begin
        select status into current_status from public.tenants where id = p_tenant_id for share;
        return current_status;
      end $$;
      revoke all on function whiteoven_lock_tenant_status(uuid) from public;
      grant execute on function whiteoven_lock_tenant_status(uuid) to whiteoven_app;

      create function whiteoven_redeem_owner_invite(
        p_token_hash bytea, p_name text, p_password_hash text, p_request_id uuid
      ) returns table (staff_user_id uuid, tenant_id uuid)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_context text := current_setting('app.tenant_id', true);
        candidate record; invite public.owner_invites%rowtype; new_user uuid;
      begin
        if octet_length(p_token_hash) <> 32 or p_name is null or char_length(btrim(p_name)) not between 1 and 120
          or p_password_hash not like '$argon2id$%' then raise exception 'invalid invite data'; end if;
        for candidate in select id from public.tenants where status = 'ONBOARDING' order by id loop
          perform set_config('app.tenant_id', candidate.id::text, true);
          select * into invite from public.owner_invites
            where token_hash = p_token_hash and accepted_at is null and expires_at > now()
            for update;
          if found then
            insert into public.staff_users (email, name, password_hash, status)
              values (invite.email, btrim(p_name), p_password_hash, 'ACTIVE') returning id into new_user;
            update public.owner_invites set accepted_at = now() where id = invite.id;
            insert into public.memberships (tenant_id, staff_user_id, role, status)
              values (invite.tenant_id, new_user, 'OWNER', 'ACTIVE');
            insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, request_id)
              values (invite.tenant_id, 'SYSTEM', new_user, 'owner_invite.redeemed', 'membership', new_user,
                jsonb_build_object('role', 'OWNER'), p_request_id);
            perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
            return query select new_user, invite.tenant_id;
            return;
          end if;
        end loop;
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
      end $$;
      revoke all on function whiteoven_redeem_owner_invite(bytea,text,text,uuid) from public;
      grant execute on function whiteoven_redeem_owner_invite(bytea,text,text,uuid) to whiteoven_app;

      create function whiteoven_reset_operator_mfa(
        p_target_id uuid, p_actor_id uuid, p_session_id uuid, p_ip_hash bytea, p_request_id uuid
      ) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare affected integer;
      begin
        if not public.whiteoven_assert_platform_actor(p_actor_id, p_session_id) then raise exception using errcode = '42501'; end if;
        if p_target_id = p_actor_id then return false; end if;
        update public.staff_users
           set mfa_secret = null, mfa_pending_secret = null, mfa_enabled_at = null,
               mfa_last_used_step = null, mfa_recovery_code_hashes = '{}', updated_at = now()
         where id = p_target_id and platform_role = 'OPERATOR' and status = 'ACTIVE';
        get diagnostics affected = row_count;
        if affected <> 1 then return false; end if;
        update public.staff_sessions
           set revoked_at = now(), revoked_reason = 'MFA_RESET'
         where staff_user_id = p_target_id and revoked_at is null;
        insert into public.audit_events (actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
          values ('OPERATOR', p_actor_id, 'operator.mfa_reset', 'staff_user', p_target_id,
            jsonb_build_object('mfa', 'reset'), p_ip_hash, p_request_id);
        return true;
      end $$;
      revoke all on function whiteoven_reset_operator_mfa(uuid,uuid,uuid,bytea,uuid) from public;
      grant execute on function whiteoven_reset_operator_mfa(uuid,uuid,uuid,bytea,uuid) to whiteoven_app;
    `);
  }

  override down(): void {
    throw new Error("Migration20261024040000_platform is forward-only");
  }
}
