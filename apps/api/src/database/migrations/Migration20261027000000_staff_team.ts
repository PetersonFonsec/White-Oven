import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * M3.6 team management (ADR 0015). The OWNER invites, changes roles and revokes through narrow
 * SECURITY DEFINER functions that check the actor's live OWNER session, write the audit event and
 * revoke sessions in the same transaction, as the platform operations do (ADR 0008).
 *
 * - `staff_invites` is a tenant table the app may only read; `staff_invite_lookup` is the global
 *   hash index the public redemption uses, readable by no runtime role.
 * - A trigger on `memberships` keeps at least one ACTIVE OWNER per tenant. A per-tenant advisory
 *   lock serializes owner changes, so two owners demoting each other at once cannot both win.
 * - Revoking a membership revokes the person's sessions whose active store is this one
 *   (`MEMBERSHIP_REVOKED`); sessions in other stores keep working.
 * - A new person redeems an invite with a name and password; a person who already has an account
 *   accepts it from their authenticated session, so the database checks the identity itself.
 */
export class Migration20261027000000_staff_team extends Migration {
  override up(): void {
    this.addSql(`
      alter table staff_sessions drop constraint staff_sessions_revoked_reason_valid;
      alter table staff_sessions add constraint staff_sessions_revoked_reason_valid
        check (revoked_reason in ('LOGOUT', 'REFRESH_REUSE', 'USER_DISABLED', 'MFA_RESET',
          'TENANT_SUSPENDED', 'MEMBERSHIP_REVOKED'));

      create table staff_invites (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        email text not null,
        role text not null,
        token_hash bytea not null,
        expires_at timestamptz not null,
        created_by uuid not null references staff_users (id),
        created_at timestamptz not null default now(),
        accepted_at timestamptz,
        accepted_by uuid references staff_users (id),
        revoked_at timestamptz,
        idempotency_key_hash bytea not null,
        request_hash bytea not null,
        constraint staff_invites_tenant_id_id_key unique (tenant_id, id),
        constraint staff_invites_idempotency_key unique (tenant_id, idempotency_key_hash),
        constraint staff_invites_idempotency_length
          check (octet_length(idempotency_key_hash) = 32 and octet_length(request_hash) = 32),
        constraint staff_invites_token_hash_key unique (token_hash),
        constraint staff_invites_token_hash_length check (octet_length(token_hash) = 32),
        constraint staff_invites_email_normalized
          check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
        constraint staff_invites_role_valid check (role in ('OWNER', 'MANAGER', 'STAFF')),
        constraint staff_invites_expiry check (expires_at <= created_at + interval '72 hours'),
        constraint staff_invites_accepted_consistent check ((accepted_at is null) = (accepted_by is null)),
        constraint staff_invites_single_outcome check (accepted_at is null or revoked_at is null)
      );
      create unique index staff_invites_pending_email_key on staff_invites (tenant_id, email)
        where accepted_at is null and revoked_at is null;

      create table staff_invite_lookup (
        token_hash bytea primary key,
        store_id uuid not null references tenants (id),
        invite_id uuid not null unique,
        constraint staff_invite_lookup_token_hash_length check (octet_length(token_hash) = 32),
        constraint staff_invite_lookup_invite_fk foreign key (store_id, invite_id)
          references staff_invites (tenant_id, id)
      );
      revoke all on staff_invite_lookup from public, whiteoven_app, whiteoven_platform;
    `);
    for (const statement of tenantIsolationSql("staff_invites"))
      this.addSql(statement);
    this.addSql(
      `revoke insert, update, delete on staff_invites from whiteoven_app;`,
    );

    this.addSql(`
      create function whiteoven_guard_last_owner() returns trigger
      language plpgsql set search_path = pg_catalog, public as $$
      begin
        if OLD.role = 'OWNER' and OLD.status = 'ACTIVE'
           and (NEW.role <> 'OWNER' or NEW.status <> 'ACTIVE') then
          perform pg_advisory_xact_lock(hashtextextended('whiteoven-owners:' || OLD.tenant_id::text, 0));
          if not exists (
            select 1 from public.memberships m
             where m.tenant_id = OLD.tenant_id and m.id <> OLD.id
               and m.role = 'OWNER' and m.status = 'ACTIVE'
          ) then
            raise exception 'LAST_OWNER' using errcode = 'P0011';
          end if;
        end if;
        return NEW;
      end $$;
      create trigger memberships_last_owner before update on memberships
        for each row execute function whiteoven_guard_last_owner();

      -- The actor is the live OWNER of the transaction's tenant, which still admits team changes.
      create function whiteoven_team_actor(p_actor_id uuid, p_session_id uuid)
      returns boolean language sql stable security definer
      set search_path = pg_catalog, public as $$
        select exists (
          select 1 from public.staff_sessions s
            join public.staff_users u on u.id = s.staff_user_id
            join public.memberships m on m.staff_user_id = u.id
            join public.tenants t on t.id = m.tenant_id
           where s.id = p_session_id and s.staff_user_id = p_actor_id
             and s.revoked_at is null and s.idle_expires_at > now()
             and s.active_tenant_id = public.whiteoven_current_tenant()
             and u.status = 'ACTIVE'
             and m.tenant_id = public.whiteoven_current_tenant()
             and m.status = 'ACTIVE' and m.role = 'OWNER'
             and t.status in ('ONBOARDING', 'ACTIVE')
        )
      $$;
      revoke all on function whiteoven_team_actor(uuid, uuid) from public;

      create function whiteoven_team_audit(
        p_actor_id uuid, p_action text, p_entity_type text, p_entity_id uuid, p_changes jsonb, p_request_id uuid
      ) returns void language sql security definer set search_path = pg_catalog, public as $$
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, request_id)
        values (public.whiteoven_current_tenant(), 'STAFF', p_actor_id, p_action, p_entity_type, p_entity_id, p_changes, p_request_id)
      $$;
      revoke all on function whiteoven_team_audit(uuid, text, text, uuid, jsonb, uuid) from public;

      -- Idempotent per (store, Idempotency-Key): a retry with the same key and body gets the same
      -- invite back (the API derives the same token), a different body is a P0003 conflict.
      create function whiteoven_team_invite(
        p_email text, p_role text, p_token_hash bytea, p_actor_id uuid, p_session_id uuid, p_request_id uuid,
        p_key_hash bytea, p_request_hash bytea
      ) returns table (invite_id uuid, expires_at timestamptz)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare v_email text := lower(btrim(p_email)); v_tenant uuid := public.whiteoven_current_tenant();
        v_invite uuid; v_expires timestamptz := now() + interval '72 hours';
        v_prior public.staff_invites%rowtype;
      begin
        if not public.whiteoven_team_actor(p_actor_id, p_session_id) then
          raise exception using errcode = '42501';
        end if;
        if p_role not in ('OWNER', 'MANAGER', 'STAFF') or octet_length(p_token_hash) <> 32
           or octet_length(p_key_hash) <> 32 or octet_length(p_request_hash) <> 32 then
          raise exception 'invalid invite data';
        end if;
        perform pg_advisory_xact_lock(hashtextextended('whiteoven-team-invite:' || encode(p_key_hash, 'hex'), 0));
        select * into v_prior from public.staff_invites i
         where i.tenant_id = v_tenant and i.idempotency_key_hash = p_key_hash;
        if v_prior.id is not null then
          if v_prior.request_hash <> p_request_hash or v_prior.token_hash <> p_token_hash then
            raise exception using errcode = 'P0003';
          end if;
          return query select v_prior.id, v_prior.expires_at;
          return;
        end if;
        if exists (
          select 1 from public.memberships m join public.staff_users u on u.id = m.staff_user_id
           where m.tenant_id = v_tenant and m.status = 'ACTIVE' and u.email = v_email
        ) then
          raise exception 'ALREADY_MEMBER' using errcode = 'P0010';
        end if;
        -- A new invite replaces the pending one for the same address: the old link stops working.
        delete from public.staff_invite_lookup l using public.staff_invites i
         where l.invite_id = i.id and i.tenant_id = v_tenant and i.email = v_email
           and i.accepted_at is null and i.revoked_at is null;
        update public.staff_invites set revoked_at = now()
         where tenant_id = v_tenant and email = v_email and accepted_at is null and revoked_at is null;
        insert into public.staff_invites (tenant_id, email, role, token_hash, expires_at, created_by,
            idempotency_key_hash, request_hash)
          values (v_tenant, v_email, p_role, p_token_hash, v_expires, p_actor_id, p_key_hash, p_request_hash)
          returning id into v_invite;
        insert into public.staff_invite_lookup (token_hash, store_id, invite_id)
          values (p_token_hash, v_tenant, v_invite);
        perform public.whiteoven_team_audit(p_actor_id, 'team.invite_created', 'staff_invite', v_invite,
          jsonb_build_object('role', p_role, 'expiresInHours', 72), p_request_id);
        return query select v_invite, v_expires;
      end $$;
      revoke all on function whiteoven_team_invite(text, text, bytea, uuid, uuid, uuid, bytea, bytea) from public;
      grant execute on function whiteoven_team_invite(text, text, bytea, uuid, uuid, uuid, bytea, bytea) to whiteoven_app;

      create function whiteoven_team_cancel_invite(
        p_invite_id uuid, p_actor_id uuid, p_session_id uuid, p_request_id uuid
      ) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare v_found uuid;
      begin
        if not public.whiteoven_team_actor(p_actor_id, p_session_id) then
          raise exception using errcode = '42501';
        end if;
        update public.staff_invites set revoked_at = now()
         where id = p_invite_id and tenant_id = public.whiteoven_current_tenant()
           and accepted_at is null and revoked_at is null
         returning id into v_found;
        if v_found is null then return false; end if;
        delete from public.staff_invite_lookup where invite_id = v_found;
        perform public.whiteoven_team_audit(p_actor_id, 'team.invite_canceled', 'staff_invite', v_found,
          '{}'::jsonb, p_request_id);
        return true;
      end $$;
      revoke all on function whiteoven_team_cancel_invite(uuid, uuid, uuid, uuid) from public;
      grant execute on function whiteoven_team_cancel_invite(uuid, uuid, uuid, uuid) to whiteoven_app;

      create function whiteoven_team_change_role(
        p_membership_id uuid, p_role text, p_actor_id uuid, p_session_id uuid, p_request_id uuid
      ) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare v_prior text;
      begin
        if not public.whiteoven_team_actor(p_actor_id, p_session_id) then
          raise exception using errcode = '42501';
        end if;
        if p_role not in ('OWNER', 'MANAGER', 'STAFF') then raise exception 'invalid role'; end if;
        select role into v_prior from public.memberships
         where id = p_membership_id and tenant_id = public.whiteoven_current_tenant() and status = 'ACTIVE'
         for update;
        if v_prior is null then return false; end if;
        if v_prior = p_role then return true; end if;
        update public.memberships set role = p_role, updated_at = now() where id = p_membership_id;
        perform public.whiteoven_team_audit(p_actor_id, 'team.role_changed', 'membership', p_membership_id,
          jsonb_build_object('role', jsonb_build_object('from', v_prior, 'to', p_role)), p_request_id);
        return true;
      end $$;
      revoke all on function whiteoven_team_change_role(uuid, text, uuid, uuid, uuid) from public;
      grant execute on function whiteoven_team_change_role(uuid, text, uuid, uuid, uuid) to whiteoven_app;

      create function whiteoven_team_revoke_member(
        p_membership_id uuid, p_actor_id uuid, p_session_id uuid, p_request_id uuid
      ) returns boolean
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare v_member public.memberships%rowtype; v_tenant uuid := public.whiteoven_current_tenant();
        v_sessions integer;
      begin
        if not public.whiteoven_team_actor(p_actor_id, p_session_id) then
          raise exception using errcode = '42501';
        end if;
        select * into v_member from public.memberships
         where id = p_membership_id and tenant_id = v_tenant and status = 'ACTIVE'
         for update;
        if v_member.id is null then return false; end if;
        update public.memberships set status = 'REVOKED', updated_at = now() where id = p_membership_id;
        update public.staff_sessions set revoked_at = now(), revoked_reason = 'MEMBERSHIP_REVOKED'
         where staff_user_id = v_member.staff_user_id and active_tenant_id = v_tenant and revoked_at is null;
        get diagnostics v_sessions = row_count;
        perform public.whiteoven_team_audit(p_actor_id, 'team.member_revoked', 'membership', p_membership_id,
          jsonb_build_object('role', v_member.role, 'sessionsRevoked', v_sessions), p_request_id);
        return true;
      end $$;
      revoke all on function whiteoven_team_revoke_member(uuid, uuid, uuid, uuid) from public;
      grant execute on function whiteoven_team_revoke_member(uuid, uuid, uuid, uuid) to whiteoven_app;

      -- Public: what a pending invite is for, so the invitee knows the store and whether to create
      -- an account or confirm an existing one. Nothing for an unknown, used or expired token.
      create function whiteoven_peek_staff_invite(p_token_hash bytea)
      returns table (store_name text, role text, email text, account_exists boolean, expires_at timestamptz)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_context text := current_setting('app.tenant_id', true);
        v_store uuid; v_invite uuid;
      begin
        select l.store_id, l.invite_id into v_store, v_invite from public.staff_invite_lookup l
         where l.token_hash = p_token_hash;
        if v_store is null then return; end if;
        perform set_config('app.tenant_id', v_store::text, true);
        return query
          select t.display_name, i.role, i.email,
                 exists (select 1 from public.staff_users u where u.email = i.email), i.expires_at
            from public.staff_invites i join public.tenants t on t.id = i.tenant_id
           where i.id = v_invite and i.token_hash = p_token_hash
             and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
             and t.status in ('ONBOARDING', 'ACTIVE');
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
      end $$;
      revoke all on function whiteoven_peek_staff_invite(bytea) from public;
      grant execute on function whiteoven_peek_staff_invite(bytea) to whiteoven_app;

      -- Shared by both ways of accepting: locks the invite, checks it is still pending in a store
      -- that admits staff, and leaves the store's tenant context set. Returns null otherwise.
      create function whiteoven_lock_staff_invite(p_token_hash bytea)
      returns public.staff_invites
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare v_store uuid; v_invite_id uuid; v_invite public.staff_invites%rowtype;
      begin
        if octet_length(p_token_hash) <> 32 then raise exception 'invalid invite data'; end if;
        select l.store_id, l.invite_id into v_store, v_invite_id from public.staff_invite_lookup l
         where l.token_hash = p_token_hash for update;
        if v_store is null then return null; end if;
        perform set_config('app.tenant_id', v_store::text, true);
        select i.* into v_invite from public.staff_invites i join public.tenants t on t.id = i.tenant_id
         where i.id = v_invite_id and i.token_hash = p_token_hash
           and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
           and t.status in ('ONBOARDING', 'ACTIVE')
         for update of i;
        return v_invite;
      end $$;
      revoke all on function whiteoven_lock_staff_invite(bytea) from public;

      -- Shared tail: the membership (a REVOKED one comes back), the invite consumed, the audit.
      create function whiteoven_join_staff_invite(
        p_invite public.staff_invites, p_user uuid, p_new_account boolean, p_token_hash bytea, p_request_id uuid
      ) returns void
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare v_membership uuid;
      begin
        insert into public.memberships (tenant_id, staff_user_id, role, status)
          values (p_invite.tenant_id, p_user, p_invite.role, 'ACTIVE')
          on conflict on constraint memberships_tenant_id_staff_user_id_key
          do update set role = excluded.role, status = 'ACTIVE', updated_at = now()
            where memberships.status <> 'ACTIVE'
          returning id into v_membership;
        -- Joined the store another way since the invite: never change an active member's role here.
        if v_membership is null then
          raise exception 'ALREADY_MEMBER' using errcode = 'P0010';
        end if;
        update public.staff_invites set accepted_at = now(), accepted_by = p_user where id = p_invite.id;
        delete from public.staff_invite_lookup where token_hash = p_token_hash;
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, request_id)
          values (p_invite.tenant_id, 'STAFF', p_user, 'team.invite_redeemed', 'membership', v_membership,
            jsonb_build_object('role', p_invite.role, 'newAccount', p_new_account), p_request_id);
      end $$;
      revoke all on function whiteoven_join_staff_invite(public.staff_invites, uuid, boolean, bytea, uuid) from public;

      -- Public: a new person creates the account the invite is for. An e-mail that already has an
      -- account is refused (P0013): that person accepts signed in, below.
      create function whiteoven_redeem_staff_invite(
        p_token_hash bytea, p_name text, p_password_hash text, p_request_id uuid
      ) returns table (staff_user_id uuid, tenant_id uuid)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_context text := current_setting('app.tenant_id', true);
        v_invite public.staff_invites; v_user uuid;
      begin
        if p_name is null or char_length(btrim(p_name)) not between 1 and 120
           or p_password_hash is null or p_password_hash not like '$argon2id$%' then
          raise exception 'invalid invite data';
        end if;
        v_invite := public.whiteoven_lock_staff_invite(p_token_hash);
        if v_invite.id is null then
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          return;
        end if;
        if exists (select 1 from public.staff_users u where u.email = v_invite.email) then
          raise exception 'ACCOUNT_EXISTS' using errcode = 'P0013';
        end if;
        insert into public.staff_users (email, name, password_hash, status)
          values (v_invite.email, btrim(p_name), p_password_hash, 'ACTIVE') returning id into v_user;
        perform public.whiteoven_join_staff_invite(v_invite, v_user, true, p_token_hash, p_request_id);
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
        return query select v_user, v_invite.tenant_id;
      end $$;
      revoke all on function whiteoven_redeem_staff_invite(bytea, text, text, uuid) from public;
      grant execute on function whiteoven_redeem_staff_invite(bytea, text, text, uuid) to whiteoven_app;

      -- A person with an account accepts while signed in. The identity is the live session the API
      -- authenticated (full login, second factor included when enrolled), not a user id from the
      -- caller: the session must be live and belong to an ACTIVE user whose e-mail is the invite's.
      create function whiteoven_accept_staff_invite(
        p_token_hash bytea, p_actor_id uuid, p_session_id uuid, p_request_id uuid
      ) returns table (staff_user_id uuid, tenant_id uuid)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_context text := current_setting('app.tenant_id', true);
        v_invite public.staff_invites; v_user uuid; v_email text;
      begin
        select u.id, u.email into v_user, v_email from public.staff_sessions s
          join public.staff_users u on u.id = s.staff_user_id
         where s.id = p_session_id and s.staff_user_id = p_actor_id
           and s.revoked_at is null and s.idle_expires_at > now()
           and u.status = 'ACTIVE' and (u.mfa_enabled_at is null or s.mfa);
        if v_user is null then raise exception using errcode = '42501'; end if;
        v_invite := public.whiteoven_lock_staff_invite(p_token_hash);
        if v_invite.id is null then
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          return;
        end if;
        if v_invite.email <> v_email then
          raise exception 'INVITE_EMAIL_MISMATCH' using errcode = 'P0012';
        end if;
        perform public.whiteoven_join_staff_invite(v_invite, v_user, false, p_token_hash, p_request_id);
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
        return query select v_user, v_invite.tenant_id;
      end $$;
      revoke all on function whiteoven_accept_staff_invite(bytea, uuid, uuid, uuid) from public;
      grant execute on function whiteoven_accept_staff_invite(bytea, uuid, uuid, uuid) to whiteoven_app;

      -- Memberships are created only by the audited functions (invites, owner invites); the app
      -- keeps update for the row locks of the request guard (select ... for share).
      revoke insert on memberships from whiteoven_app;
    `);
  }

  override down(): void {
    throw new Error("Migration20261027000000_staff_team is forward-only");
  }
}
