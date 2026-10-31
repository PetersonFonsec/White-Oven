-- Reapplies customer account deletions to a restored database (M7.1, ADR 0029).
--
-- A backup taken before a customer deleted the account still holds that customer's personal
-- data. Before a restored database replaces the live one, `ops/api-backup.sh restore` loads every
-- known deletion (tenant, customer, original deletion time) into the temporary table
-- `restore_erasures` and runs this file in the same transaction. For each one it does what
-- `CustomerAuth.deleteAccount` does (ADR 0017): personal fields become null, the status becomes
-- DELETED, addresses and push devices are deleted, the customer's orders lose the name, phone,
-- address and notes they copied, and every open session is revoked with ACCOUNT_DELETED.
--
-- `apps/api/test/backup-erasures.test.ts` checks that the result is the same as deleteAccount's.
-- When deleteAccount erases something new, change this file in the same PR.
--
-- It runs as the superuser in a restore (RLS does not apply) and as whiteoven_owner in tests, so
-- it sets the tenant context for each deletion; FORCE RLS would otherwise hide every row from the
-- owner. A customer that is not in the backup (created after it) is skipped; one already DELETED
-- keeps its own deletion time. Running it twice changes nothing.
do $$
declare
  erasure record;
  reapplied integer := 0;
  already integer := 0;
  absent integer := 0;
  current_status text;
begin
  for erasure in
    select tenant_id, customer_id, min(deleted_at) as deleted_at
      from restore_erasures
     group by tenant_id, customer_id
     order by tenant_id, customer_id
  loop
    perform set_config('app.tenant_id', erasure.tenant_id::text, true);
    select status into current_status
      from customers
     where tenant_id = erasure.tenant_id and id = erasure.customer_id
       for update;
    if not found then
      absent := absent + 1;
      continue;
    end if;
    if current_status = 'DELETED' then
      already := already + 1;
    else
      update customers
         set status = 'DELETED', name = null, email = null, phone = null,
             password_hash = null, deleted_at = erasure.deleted_at, updated_at = now()
       where tenant_id = erasure.tenant_id and id = erasure.customer_id;
      reapplied := reapplied + 1;
    end if;
    -- Also for an account already DELETED, in case the backup holds leftovers; each statement
    -- changes nothing when there are none.
    delete from customer_addresses
     where tenant_id = erasure.tenant_id and customer_id = erasure.customer_id;
    delete from customer_push_devices
     where tenant_id = erasure.tenant_id and customer_id = erasure.customer_id;
    update orders
       set customer_name = null, customer_phone = null, delivery_address = null,
           notes = null, anonymized_at = now(), updated_at = now()
     where tenant_id = erasure.tenant_id and customer_id = erasure.customer_id
       and anonymized_at is null;
    update customer_sessions
       set revoked_at = now(), revoked_reason = 'ACCOUNT_DELETED'
     where tenant_id = erasure.tenant_id and customer_id = erasure.customer_id
       and revoked_at is null;
  end loop;
  perform set_config('app.tenant_id', '', true);
  raise notice 'whiteoven_erasures reapplied=% already=% absent=%', reapplied, already, absent;
end
$$;
