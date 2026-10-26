import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DemoSeedConflictError, seedDemo } from "../src/database/seed-demo";
import { hashPassword, verifyPassword } from "../src/auth/password";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import type { MikroORM } from "@mikro-orm/postgresql";

const TEST_PASSWORD = "Demo-Seed-Test-Password-2026!";
const environment = (ownerUrl: string, overrides: NodeJS.ProcessEnv = {}) => ({
  NODE_ENV: "test",
  DATABASE_OWNER_URL: ownerUrl,
  WHITEOVEN_DEMO_PASSWORD: TEST_PASSWORD,
  ...overrides,
});

describe("demo seed input validation", () => {
  it("refuses production before reading or connecting to the database", async () => {
    await assert.rejects(
      seedDemo({ NODE_ENV: "production" }),
      /disabled in production/,
    );
  });

  it("refuses DATABASE_OWNER_URL with a role other than whiteoven_owner", async () => {
    await assert.rejects(
      seedDemo(
        environment("postgres://whiteoven_app:secret@127.0.0.1/whiteoven"),
      ),
      /DATABASE_OWNER_URL must use the role whiteoven_owner/,
    );
  });

  it("refuses a remote owner host", async () => {
    await assert.rejects(
      seedDemo(
        environment(
          "postgres://whiteoven_owner:secret@db.example.test/whiteoven",
        ),
      ),
      /requires a local whiteoven_owner DATABASE_OWNER_URL/,
    );
  });

  it("refuses a missing or weak externally supplied password without logging it", async () => {
    const writes: string[] = [];
    const out = process.stdout.write;
    const err = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const ownerUrl = "postgres://whiteoven_owner:secret@127.0.0.1/whiteoven";
      await assert.rejects(
        seedDemo(environment(ownerUrl, { WHITEOVEN_DEMO_PASSWORD: "" })),
        /at least 10/,
      );
      await assert.rejects(
        seedDemo(
          environment(ownerUrl, { WHITEOVEN_DEMO_PASSWORD: "password123" }),
        ),
        /too common/,
      );
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    assert.deepEqual(writes, []);
  });
});

describe("demo seed against PostgreSQL", databaseSuite, () => {
  let database: TestDatabase;
  let owner: MikroORM;

  beforeEach(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
  });
  afterEach(async () => {
    await database?.drop();
  });

  const seed = (overrides: NodeJS.ProcessEnv = {}) =>
    seedDemo(environment(database.ownerUrl, overrides));
  const sql = <T = unknown>(
    statement: string,
    params: unknown[] = [],
  ): Promise<T> =>
    owner.em
      .getConnection()
      .execute(statement, params) as unknown as Promise<T>;
  const tenantQuery = <T = unknown>(
    tenantId: string,
    statement: string,
    params: unknown[] = [],
  ) =>
    owner.em.fork().transactional(async (em) => {
      await em.execute("select set_config('app.tenant_id', ?, true)", [
        tenantId,
      ]);
      return em.execute(statement, params) as unknown as T;
    }) as Promise<T>;

  it("creates a complete store, correct roles, verifiable credentials, and no operator", async () => {
    const result = await seed();
    assert.equal(result.created, true);
    assert.equal(result.tenantStatus, "ACTIVE");
    const users = await tenantQuery<
      { role: string; email: string; status: string; password_hash: string }[]
    >(
      result.tenantId,
      `select m.role,u.email,u.status,u.password_hash
         from memberships m join staff_users u on u.id=m.staff_user_id
        where m.tenant_id=? order by m.role`,
      [result.tenantId],
    );
    assert.deepEqual(
      users.map(({ role, email }) => [role, email]),
      [
        ["MANAGER", "manager@whiteoven.local"],
        ["OWNER", "owner@whiteoven.local"],
        ["STAFF", "staff@whiteoven.local"],
      ],
    );
    for (const user of users) {
      assert.equal(user.status, "ACTIVE");
      assert.equal(
        await verifyPassword(user.password_hash, TEST_PASSWORD),
        true,
      );
    }
    assert.equal(
      (
        await sql<{ count: string }[]>(
          "select count(*)::text as count from staff_users where platform_role='OPERATOR'",
        )
      )[0]!.count,
      "0",
    );
    const [catalog] = await tenantQuery<
      {
        categories: number;
        sizes: number;
        flavors: number;
        prices: number;
        policies: number;
      }[]
    >(
      result.tenantId,
      `select (select count(*)::int from catalog_categories where tenant_id=?) categories,
              (select count(*)::int from pizza_sizes where tenant_id=?) sizes,
              (select count(*)::int from catalog_flavors where tenant_id=?) flavors,
              (select count(*)::int from catalog_flavor_prices where tenant_id=?) prices,
              (select count(*)::int from catalog_pricing_policies where tenant_id=?) policies`,
      Array(5).fill(result.tenantId),
    );
    assert.deepEqual(catalog, {
      categories: 1,
      sizes: 1,
      flavors: 1,
      prices: 1,
      policies: 1,
    });
  });

  it("is repeatable without duplicate rows or changing IDs, passwords, or manual edits", async () => {
    const first = await seed();
    const before = await sql<{ records: Record<string, string> }[]>(
      "select records from demo_seed_manifest where demo_tenant_id=?",
      [first.tenantId],
    );
    const userId = before[0]!.records["user:STAFF"];
    const changedHash = await sql<{ password_hash: string }[]>(
      "select password_hash from staff_users where id=?",
      [userId],
    );
    const manifest = await sql<{ records: Record<string, string> }[]>(
      "select records from demo_seed_manifest where demo_tenant_id=?",
      [first.tenantId],
    );
    await sql("update tenants set status='SUSPENDED' where id=?", [
      first.tenantId,
    ]);
    await sql("update staff_users set status='DISABLED' where id=?", [userId]);
    await tenantQuery(
      first.tenantId,
      "update memberships set role='MANAGER' where id=?",
      [manifest[0]!.records["membership:STAFF"]],
    );
    await tenantQuery(
      first.tenantId,
      "update store_settings set minimum_order_cents=7777 where tenant_id=?",
      [first.tenantId],
    );
    const second = await seed();
    assert.equal(second.created, false);
    assert.equal(second.tenantStatus, "SUSPENDED");
    assert.equal(second.tenantId, first.tenantId);
    const after = await sql<{ records: Record<string, string> }[]>(
      "select records from demo_seed_manifest where demo_tenant_id=?",
      [first.tenantId],
    );
    assert.deepEqual(after[0]!.records, before[0]!.records);
    assert.deepEqual(
      await sql("select status from tenants where id=?", [first.tenantId]),
      [{ status: "SUSPENDED" }],
    );
    assert.deepEqual(
      await sql("select status,password_hash from staff_users where id=?", [
        userId,
      ]),
      [{ status: "DISABLED", password_hash: changedHash[0]!.password_hash }],
    );
    assert.deepEqual(
      await tenantQuery(
        first.tenantId,
        "select minimum_order_cents from store_settings where tenant_id=?",
        [first.tenantId],
      ),
      [{ minimum_order_cents: 7777 }],
    );
    assert.equal(
      (
        await sql<{ count: string }[]>(
          "select count(*)::text as count from tenants where slug='whiteoven-demo'",
        )
      )[0]!.count,
      "1",
    );
  });

  it("fails safely on a preexisting tenant without provenance and leaves it untouched", async () => {
    await sql(
      "insert into tenants (slug,display_name,status) values ('whiteoven-demo','Existing Store','SUSPENDED')",
    );
    await assert.rejects(seed(), DemoSeedConflictError);
    assert.deepEqual(
      await sql(
        "select display_name,status from tenants where slug='whiteoven-demo'",
      ),
      [{ display_name: "Existing Store", status: "SUSPENDED" }],
    );
    assert.equal(
      (
        await sql<{ count: string }[]>(
          "select count(*)::text as count from demo_seed_manifest",
        )
      )[0]!.count,
      "0",
    );
  });

  it("fails safely on a preexisting demo email and preserves its account", async () => {
    const hash = await hashPassword("Existing-User-Password-2026!");
    await sql(
      `insert into staff_users (email,name,password_hash,status)
       values ('owner@whiteoven.local','Unrelated User',?,'DISABLED')`,
      [hash],
    );
    await assert.rejects(seed(), DemoSeedConflictError);
    assert.deepEqual(
      await sql(
        "select name,status,password_hash from staff_users where email='owner@whiteoven.local'",
      ),
      [{ name: "Unrelated User", status: "DISABLED", password_hash: hash }],
    );
    assert.equal(
      (
        await sql<{ count: string }[]>(
          "select count(*)::text as count from tenants where slug='whiteoven-demo'",
        )
      )[0]!.count,
      "0",
    );
  });

  it("rolls back every inserted row if a later seed step fails", async () => {
    await sql(`create function fail_demo_flavor_insert() returns trigger language plpgsql as $$
      begin raise exception 'synthetic seed failure'; end $$`);
    await sql(
      "create trigger fail_demo_flavor before insert on catalog_flavors for each row execute function fail_demo_flavor_insert()",
    );
    await assert.rejects(seed(), /synthetic seed failure/);
    assert.equal(
      (
        await sql<{ count: string }[]>(
          "select count(*)::text as count from tenants where slug='whiteoven-demo'",
        )
      )[0]!.count,
      "0",
    );
    assert.equal(
      (
        await sql<{ count: string }[]>(
          "select count(*)::text as count from staff_users where email like '%@whiteoven.local'",
        )
      )[0]!.count,
      "0",
    );
    assert.equal(
      (
        await sql<{ count: string }[]>(
          "select count(*)::text as count from demo_seed_manifest",
        )
      )[0]!.count,
      "0",
    );
  });

  it("keeps demo memberships and catalog tenant-scoped and leaves another tenant untouched", async () => {
    const demo = await seed();
    const [other] = await sql<{ id: string }[]>(
      "insert into tenants (slug,display_name,status) values ('other-pizzeria','Another Store','ACTIVE') returning id",
    );
    const [otherCategory] = await tenantQuery<{ id: string }[]>(
      other!.id,
      "insert into catalog_categories (tenant_id,name,kind) values (?, 'Other Menu', 'PIZZA') returning id",
      [other!.id],
    );
    await seed();
    assert.equal(
      (
        await tenantQuery<{ count: string }[]>(
          demo.tenantId,
          "select count(*)::text as count from memberships where tenant_id=?",
          [demo.tenantId],
        )
      )[0]!.count,
      "3",
    );
    assert.deepEqual(
      await tenantQuery(
        "00000000-0000-4000-8000-000000000000",
        "select id from catalog_categories where id=?",
        [otherCategory!.id],
      ),
      [],
    );
    assert.deepEqual(
      await tenantQuery(
        other!.id,
        "select id,name from catalog_categories where id=?",
        [otherCategory!.id],
      ),
      [{ id: otherCategory!.id, name: "Other Menu" }],
    );
    const app = await database.connect(database.appUrl);
    assert.deepEqual(
      await app.em.getConnection().execute("select id from catalog_categories"),
      [],
    );
    await assert.rejects(
      app.em
        .getConnection()
        .execute(
          "insert into catalog_categories (tenant_id,name,kind) values (?, 'No Context', 'PIZZA')",
          [demo.tenantId],
        ),
      (error: unknown) => (error as { code?: string }).code === "42501",
    );
  });
});
