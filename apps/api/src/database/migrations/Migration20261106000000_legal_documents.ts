import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * M7.2 legal documents (ADR 0030). Each store (the data controller) has its own privacy policy
 * and terms of use; WhiteOven (the processor) publishes the text the store's counsel approved.
 *
 * - `legal_documents` keeps every published version, numbered per store and kind (`revision`);
 *   the current one is the highest revision. Rows are never updated or deleted, so the text a
 *   customer accepted can always be shown again. Only `whiteoven_publish_legal_document` writes.
 * - `customer_legal_acceptances` records which document (so which exact text) each customer
 *   accepted and when. It holds no personal data beyond the customer id, so an account deletion
 *   keeps it as the record of the consent given while the account existed.
 *
 * Forward-only (ADR 0005): `down()` refuses.
 */
export class Migration20261106000000_legal_documents extends Migration {
  override up(): void {
    this.addSql(`
      create table legal_documents (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        kind text not null,
        version text not null,
        revision integer not null,
        body text not null,
        body_sha256 bytea not null,
        -- null: written by the demo seed or a test fixture, never by the publication function.
        published_by uuid references staff_users (id),
        published_at timestamptz not null default now(),
        constraint legal_documents_tenant_id_id_key unique (tenant_id, id),
        constraint legal_documents_version_key unique (tenant_id, kind, version),
        constraint legal_documents_revision_key unique (tenant_id, kind, revision),
        constraint legal_documents_kind_valid check (kind in ('PRIVACY_POLICY', 'TERMS_OF_USE')),
        constraint legal_documents_version_format check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
        constraint legal_documents_revision_positive check (revision >= 1),
        constraint legal_documents_body_length check (char_length(body) <= 100000 and btrim(body) <> ''),
        constraint legal_documents_body_hash check (body_sha256 = sha256(convert_to(body, 'UTF8')))
      );

      create table customer_legal_acceptances (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        customer_id uuid not null,
        document_id uuid not null,
        accepted_at timestamptz not null default now(),
        constraint customer_legal_acceptances_tenant_id_id_key unique (tenant_id, id),
        constraint customer_legal_acceptances_once unique (tenant_id, customer_id, document_id),
        constraint customer_legal_acceptances_customer_fk foreign key (tenant_id, customer_id)
          references customers (tenant_id, id),
        constraint customer_legal_acceptances_document_fk foreign key (tenant_id, document_id)
          references legal_documents (tenant_id, id)
      );
    `);
    for (const table of ["legal_documents", "customer_legal_acceptances"])
      for (const statement of tenantIsolationSql(table)) this.addSql(statement);
    this.addSql(`
      revoke insert, update, delete, truncate on legal_documents from whiteoven_app;
      grant select on legal_documents to whiteoven_app;
      revoke update, delete, truncate on customer_legal_acceptances from whiteoven_app;
      grant select, insert on customer_legal_acceptances to whiteoven_app;

      -- Also binds the owner: a published text or a recorded acceptance never changes.
      create function whiteoven_guard_legal_append_only() returns trigger
        language plpgsql as $$
        begin
          raise exception '% is append-only', tg_table_name using errcode = '42501';
        end
        $$;
      create trigger legal_documents_append_only before update or delete on legal_documents
        for each row execute function whiteoven_guard_legal_append_only();
      create trigger customer_legal_acceptances_append_only before update or delete on customer_legal_acceptances
        for each row execute function whiteoven_guard_legal_append_only();
    `);

    this.addSql(`
      create function whiteoven_platform_legal_documents(p_tenant_id uuid, p_actor_id uuid, p_session_id uuid)
      returns table (id uuid, kind text, version text, revision integer, body text, published_at timestamptz)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_context text := current_setting('app.tenant_id', true);
      begin
        if not public.whiteoven_assert_platform_actor(p_actor_id, p_session_id) then raise exception using errcode = '42501'; end if;
        if not exists (select 1 from public.tenants where tenants.id = p_tenant_id) then raise exception using errcode = 'P0002'; end if;
        perform set_config('app.tenant_id', p_tenant_id::text, true);
        return query select d.id, d.kind, d.version, d.revision, d.body, d.published_at
          from public.legal_documents d where d.tenant_id = p_tenant_id
         order by d.kind, d.revision desc;
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
      end $$;
      revoke all on function whiteoven_platform_legal_documents(uuid,uuid,uuid) from public;
      grant execute on function whiteoven_platform_legal_documents(uuid,uuid,uuid) to whiteoven_app;

      -- Publishes a new current version (ADR 0030). Runs under the tenant row lock, so two
      -- publications of the same store never take the same revision. Publishing a version that
      -- already exists with the same text changes nothing (a retry); with another text it is a
      -- conflict (P0010), because a version name always means one text.
      create function whiteoven_publish_legal_document(
        p_tenant_id uuid, p_kind text, p_version text, p_body text,
        p_actor_id uuid, p_session_id uuid, p_ip_hash bytea, p_request_id uuid
      ) returns table (id uuid, kind text, version text, revision integer, published_at timestamptz, changed boolean)
      language plpgsql security definer set search_path = pg_catalog, public as $$
      declare prior_context text := current_setting('app.tenant_id', true);
        tenant_status text; existing public.legal_documents%rowtype; digest bytea; next_revision integer;
        new_id uuid; at_now timestamptz;
      begin
        if not public.whiteoven_assert_platform_actor(p_actor_id, p_session_id) then raise exception using errcode = '42501'; end if;
        if p_kind is null or p_kind not in ('PRIVACY_POLICY', 'TERMS_OF_USE')
           or p_version is null or p_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'
           or p_body is null or char_length(p_body) > 100000 or btrim(p_body) = '' then
          raise exception using errcode = '22023';
        end if;
        select t.status into tenant_status from public.tenants t where t.id = p_tenant_id for update;
        if tenant_status is null then raise exception using errcode = 'P0002'; end if;
        if tenant_status = 'CLOSED' then raise exception using errcode = 'P0004'; end if;
        perform set_config('app.tenant_id', p_tenant_id::text, true);
        digest := sha256(convert_to(p_body, 'UTF8'));
        select * into existing from public.legal_documents d
         where d.tenant_id = p_tenant_id and d.kind = p_kind and d.version = p_version;
        if existing.id is not null then
          perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
          if existing.body_sha256 <> digest then raise exception using errcode = 'P0010'; end if;
          return query select existing.id, existing.kind, existing.version, existing.revision, existing.published_at, false;
          return;
        end if;
        select coalesce(max(d.revision), 0) + 1 into next_revision from public.legal_documents d
         where d.tenant_id = p_tenant_id and d.kind = p_kind;
        at_now := clock_timestamp();
        insert into public.legal_documents (tenant_id, kind, version, revision, body, body_sha256, published_by, published_at)
          values (p_tenant_id, p_kind, p_version, next_revision, p_body, digest, p_actor_id, at_now)
          returning legal_documents.id into new_id;
        insert into public.audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, changes, ip_hash, request_id)
          values (p_tenant_id, 'OPERATOR', p_actor_id, 'legal_document.published', 'legal_document', new_id,
            jsonb_build_object('kind', p_kind, 'version', p_version, 'revision', next_revision,
              'bodySha256', encode(digest, 'hex')), p_ip_hash, p_request_id);
        perform set_config('app.tenant_id', coalesce(prior_context, ''), true);
        return query select new_id, p_kind, p_version, next_revision, at_now, true;
      end $$;
      revoke all on function whiteoven_publish_legal_document(uuid,text,text,text,uuid,uuid,bytea,uuid) from public;
      grant execute on function whiteoven_publish_legal_document(uuid,text,text,text,uuid,uuid,bytea,uuid) to whiteoven_app;
    `);
  }

  override down(): void {
    throw new Error("Migration20261106000000_legal_documents is forward-only");
  }
}
