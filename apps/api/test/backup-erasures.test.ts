import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import { json, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import { bearer, insertTenant } from "./staff-fixtures";

/**
 * M7.1 (ADR 0029): a restore reapplies customer deletions with
 * `ops/postgres/reapply-customer-erasures.sql`. These tests hold that file to what
 * `DELETE me` does, so a backup restored after a deletion never brings the customer's personal
 * data back.
 */
const REAPPLY_FILE = "ops/postgres/reapply-customer-erasures.sql";
// The compiled test runs from dist/tests/test, the source tree from test.
const REAPPLY_SQL = readFileSync(
  [join(__dirname, "../../../../.."), join(__dirname, "../../..")]
    .map((root) => join(root, REAPPLY_FILE))
    .find((path) => existsSync(path))!,
  "utf8",
);
const PASSWORD = "backup-senha-forte-2026";

/**
 * Every table that points at a customer. A new one needs a line in the reapply file, except the
 * erasure registry itself, which holds only ids and the deletion time.
 */
const CUSTOMER_TABLES = [
  "customer_addresses",
  "customer_erasures",
  "customer_push_devices",
  "customer_sessions",
  "orders",
];

describe(
  "M7.1 customer deletions reapplied after a restore",
  databaseSuite,
  () => {
    let database: TestDatabase;
    let owner: MikroORM;
    let server: TestServer;
    const store = { id: "", slug: `backup-${randomUUID().slice(0, 8)}` };

    const sql = <T>(query: string, params: unknown[] = []) =>
      runInTenant(owner, store.id, (em) => em.execute<T[]>(query, params));

    const request = (
      path: string,
      accessToken: string | null,
      method = "GET",
      body?: unknown,
    ) =>
      fetch(`${server.baseUrl}/v1/customer/stores/${store.slug}/${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(accessToken ? bearer(accessToken) : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const login = (email: string) =>
      request("auth/login", null, "POST", { email, password: PASSWORD });

    /**
     * A customer with everything an account can hold: an address, a push device, two sessions and
     * an order with the name, phone and notes it copied.
     */
    const fullCustomer = async () => {
      const email = `backup-${randomUUID()}@teste.invalid`;
      const register = await request("auth/register", null, "POST", {
        name: "Cliente Backup",
        email,
        phone: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
        password: PASSWORD,
        privacyPolicyVersion: "2026-10",
      });
      assert.equal(register.status, 201, await register.clone().text());
      const { accessToken } = await json(register);
      const me = await json(await request("me", accessToken));
      const address = await request("me/addresses", accessToken, "POST", {
        label: "Casa",
        postalCode: "01310100",
        street: "Avenida Paulista",
        number: "1000",
        district: "Bela Vista",
        city: "São Paulo",
        state: "SP",
      });
      assert.equal(address.status, 201, await address.clone().text());
      const device = await request("me/push-device", accessToken, "PUT", {
        token: `ExponentPushToken[backup-${randomUUID().slice(0, 8)}]`,
        installationId: randomUUID(),
      });
      assert.equal(device.status, 200, await device.clone().text());
      assert.equal((await login(email)).status, 200);
      await sql(
        `insert into orders (tenant_id, number, customer_id, customer_name, customer_phone,
         fulfillment, payment_method, items_subtotal_cents, delivery_fee_cents, total_cents, notes)
       select tenant_id, coalesce((select max(number) from orders), 0) + 1, id, name, phone,
              'PICKUP', 'CASH', 4000, 0, 4000, 'Portão azul'
         from customers where id = ?`,
        [me.id],
      );
      return { id: me.id as string, email, accessToken: accessToken as string };
    };

    /** What is left of a customer, without ids or times, to compare two deletions. */
    const remains = async (customerId: string) => {
      const [customer] = await sql<Record<string, unknown>>(
        `select status, name, email, phone, password_hash, deleted_at is not null as deleted
         from customers where id = ?`,
        [customerId],
      );
      const [counts] = await sql<Record<string, unknown>>(
        `select
         (select count(*)::int from customer_addresses where customer_id = ?) as addresses,
         (select count(*)::int from customer_push_devices where customer_id = ?) as devices,
         (select count(*)::int from customer_sessions where customer_id = ?) as sessions,
         (select count(*)::int from customer_sessions
           where customer_id = ? and revoked_reason = 'ACCOUNT_DELETED') as revoked_by_deletion,
         (select count(*)::int from customer_sessions
           where customer_id = ? and revoked_at is null) as open_sessions`,
        [customerId, customerId, customerId, customerId, customerId],
      );
      const orders = await sql<Record<string, unknown>>(
        `select customer_name, customer_phone, delivery_address, notes, total_cents,
              anonymized_at is not null as anonymized
         from orders where customer_id = ?`,
        [customerId],
      );
      return { customer, counts, orders };
    };

    /** True when the customer's deletion time is `when`. */
    const deletedAt = async (customerId: string, when: Date) => {
      const [row] = await sql<{ same: boolean }>(
        "select deleted_at = ?::timestamptz as same from customers where id = ?",
        [when.toISOString(), customerId],
      );
      return row?.same === true;
    };

    /** Runs the reapply file as the restore does: one transaction, deletions in a temp table. */
    const reapply = (
      erasures: { tenantId: string; customerId: string; deletedAt: Date }[],
    ) =>
      owner.em.fork().transactional(async (em) => {
        await em.execute(
          `create temp table restore_erasures (tenant_id uuid not null, customer_id uuid not null,
           deleted_at timestamptz not null) on commit drop`,
        );
        for (const erasure of erasures)
          await em.execute("insert into restore_erasures values (?, ?, ?)", [
            erasure.tenantId,
            erasure.customerId,
            erasure.deletedAt,
          ]);
        await em.execute(REAPPLY_SQL);
      });

    before(async () => {
      database = await createTestDatabase();
      owner = await database.connect(database.ownerUrl);
      store.id = await insertTenant(owner, store.slug);
      server = await startTestServer({
        DATABASE_URL: database.appUrl,
        DATABASE_POOL_MAX: "4",
      });
    });
    after(async () => {
      await server?.close();
      await owner?.close();
      await database?.drop();
    });

    it("erases a restored account exactly as DELETE me does", async () => {
      const deleted = await fullCustomer();
      const restored = await fullCustomer();
      const untouched = await fullCustomer();

      const response = await request("me", deleted.accessToken, "DELETE", {
        password: PASSWORD,
      });
      assert.equal(response.status, 204);
      const when = new Date("2026-10-30T12:00:00.000Z");
      await reapply([
        { tenantId: store.id, customerId: restored.id, deletedAt: when },
      ]);

      const expected = await remains(deleted.id);
      assert.equal(expected.customer!.status, "DELETED");
      assert.equal(expected.counts!.open_sessions, 0);
      assert.equal(expected.orders[0]!.anonymized, true);
      assert.deepEqual(await remains(restored.id), expected);
      assert.ok(
        await deletedAt(restored.id, when),
        "the restored account keeps the time the customer deleted it",
      );

      assert.equal((await login(restored.email)).status, 401);
      assert.equal(
        (await request("me", restored.accessToken)).status,
        401,
        "a token issued before the backup stops working",
      );
      assert.equal((await login(untouched.email)).status, 200);
      assert.equal((await remains(untouched.id)).customer!.status, "ACTIVE");
    });

    it("can run twice and skips accounts the backup does not have", async () => {
      const customer = await fullCustomer();
      const first = new Date("2026-10-29T08:00:00.000Z");
      const erasures = [
        { tenantId: store.id, customerId: customer.id, deletedAt: first },
        { tenantId: store.id, customerId: randomUUID(), deletedAt: first },
      ];
      await reapply(erasures);
      const once = await remains(customer.id);
      await reapply([
        ...erasures,
        {
          tenantId: store.id,
          customerId: customer.id,
          deletedAt: new Date("2026-10-31T08:00:00.000Z"),
        },
      ]);
      assert.deepEqual(await remains(customer.id), once);
      assert.ok(
        await deletedAt(customer.id, first),
        "a second run keeps the first time",
      );
    });

    /** The registry as the restore checks it. */
    const chain = async (source = "customer_erasures") => {
      const [row] = await owner.em
        .getConnection()
        .execute<{ rows: string; head: string; broken: string }[]>(
          `select row_count as rows, head_seq as head, broken
           from whiteoven_verify_erasure_chain(?::regclass)`,
          [source],
        );
      return {
        rows: Number(row!.rows),
        head: Number(row!.head),
        broken: Number(row!.broken),
      };
    };
    const registered = async (customerId: string) =>
      (
        await owner.em
          .getConnection()
          .execute<{ seq: string }[]>(
            "select seq from customer_erasures where customer_id = ?",
            [customerId],
          )
      ).length;

    it("records every deletion in a gap-free hash chain, also for a reapplied one", async () => {
      const before = await chain();
      const deleted = await fullCustomer();
      const response = await request("me", deleted.accessToken, "DELETE", {
        password: PASSWORD,
      });
      assert.equal(response.status, 204);
      assert.equal(await registered(deleted.id), 1);
      const restored = await fullCustomer();
      await reapply([
        {
          tenantId: store.id,
          customerId: restored.id,
          deletedAt: new Date("2026-10-30T09:00:00.000Z"),
        },
      ]);
      assert.equal(await registered(restored.id), 1);
      await reapply([
        {
          tenantId: store.id,
          customerId: restored.id,
          deletedAt: new Date("2026-10-30T09:00:00.000Z"),
        },
      ]);
      assert.equal(
        await registered(restored.id),
        1,
        "a second run adds nothing",
      );
      const after = await chain();
      assert.equal(after.broken, 0);
      assert.equal(after.rows, after.head);
      assert.equal(after.head, before.head + 2);
    });

    it("detects a broken, truncated in the middle or edited copy of the chain", async () => {
      for (const label of ["a", "b", "c"]) {
        const customer = await fullCustomer();
        assert.equal(
          (
            await request("me", customer.accessToken, "DELETE", {
              password: PASSWORD,
            })
          ).status,
          204,
          label,
        );
      }
      await owner.em.fork().transactional(async (em) => {
        const check = async () => {
          const [row] = await em.execute<{ broken: string }[]>(
            "select broken from whiteoven_verify_erasure_chain('pg_temp.ledger')",
          );
          return Number(row!.broken);
        };
        await em.execute(
          "create temp table ledger on commit drop as select * from customer_erasures",
        );
        assert.equal(await check(), 0);
        await em.execute(
          "update ledger set deleted_at = deleted_at + interval '1 second' where seq = 2",
        );
        assert.ok((await check()) > 0, "an edited row breaks the chain");
        await em.execute("delete from ledger");
        await em.execute(
          "insert into ledger select * from customer_erasures where seq <> 2",
        );
        assert.ok((await check()) > 0, "a missing row breaks the chain");
      });
    });

    it("keeps the registry append-only and the lineage single", async () => {
      await assert.rejects(
        owner.em
          .getConnection()
          .execute("update customer_erasures set deleted_at = now()"),
        /append-only/,
      );
      await assert.rejects(
        owner.em.getConnection().execute("delete from customer_erasures"),
        /append-only/,
      );
      const lineage = await owner.em
        .getConnection()
        .execute<{ id: string }[]>("select id from database_lineage");
      assert.equal(lineage.length, 1);
      await assert.rejects(
        owner.em
          .getConnection()
          .execute("insert into database_lineage (singleton) values (false)"),
      );
    });

    it("knows every table that points at a customer", async () => {
      const tables = await owner.em
        .getConnection()
        .execute<{ table: string }[]>(
          `select distinct c.relname as "table"
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid
         join pg_class r on r.oid = k.confrelid
        where k.contype = 'f' and r.relname = 'customers'
          and c.relnamespace = 'public'::regnamespace
        order by 1`,
        );
      assert.deepEqual(
        tables.map((row) => row.table),
        CUSTOMER_TABLES,
        "a table that references customers must be erased in reapply-customer-erasures.sql and here",
      );
    });
  },
);
