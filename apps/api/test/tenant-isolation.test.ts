import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { defineEntity, p } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import {
  findUnprotectedTenantTables,
  tenantIsolationSql,
} from "../src/database/tenant-isolation-sql";
import { createOrm } from "../src/database/orm";
import { TENANT_SURFACE } from "../src/tenancy/store-tenant.guard";
import { Tenant } from "../src/tenancy/tenant.entity";
import { assertTenantFilters } from "../src/tenancy/tenant-filter";
import {
  TenantTransactions,
  runInTenant,
} from "../src/tenancy/tenant-transaction";
import { json, nextTick, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import {
  ProbeFlavor,
  TenantProbeModule,
  createProbeTables,
} from "./tenant-probes";

const INSUFFICIENT_PRIVILEGE = "42501";
const FOREIGN_KEY_VIOLATION = "23503";

async function sqlState(
  work: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

interface Fixture {
  id: string;
  slug: string;
  flavorId: string;
}

/**
 * Required tests of docs/architecture/tenant-isolation.md, against a real PostgreSQL. Tables
 * are the test-only probes of `tenant-probes.ts` until the first real tenant table (M1.4).
 */
describe("tenant isolation", databaseSuite, () => {
  let database: TestDatabase;
  let owner: MikroORM;
  let app: MikroORM;
  let server: TestServer;
  let a: Fixture;
  let b: Fixture;

  const tenantRow = async (slug: string, status = "ACTIVE") => {
    const [row] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into tenants (slug, display_name, status) values (?, ?, ?) returning id",
        [slug, `Pizzaria ${slug}`, status],
      );
    return row!.id;
  };

  const fixture = async (slug: string, flavor: string): Promise<Fixture> => {
    const id = await tenantRow(slug);
    // FORCE RLS applies to the table owner too: even fixtures need the tenant context.
    const [row] = await runInTenant(owner, id, (em) =>
      em.execute<{ id: string }[]>(
        "insert into isolation_probe_flavors (tenant_id, name) values (?, ?) returning id",
        [id, flavor],
      ),
    );
    return { id, slug, flavorId: row!.id };
  };

  const appCount = async (sql: string, params: unknown[] = []) => {
    const [row] = await app.em
      .getConnection()
      .execute<{ count: number }[]>(sql, params);
    return row!.count;
  };

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    await createProbeTables(owner);
    a = await fixture("pizzaria-a", "Margherita A");
    b = await fixture("pizzaria-b", "Calabresa B");
    await tenantRow("pizzaria-suspensa", "SUSPENDED");
    app = await createOrm(
      { url: database.appUrl, poolMax: 1 },
      { entities: [Tenant, ProbeFlavor] },
    );
    server = await startTestServer(
      { DATABASE_URL: database.appUrl, DATABASE_POOL_MAX: "1" },
      { imports: [TenantProbeModule], entities: [ProbeFlavor] },
    );
  });
  after(async () => {
    await server?.close();
    await app?.close();
    await database?.drop();
  });

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.baseUrl}/v1${path}`, init);

  describe("1. isolation matrix", () => {
    /** Every tenant route, with how tenant A attacks tenant B's resource through it. */
    const MATRIX: Record<
      string,
      (attacker: Fixture, victim: Fixture) => Promise<Response>
    > = {
      "GET /public/stores/:storeSlug/isolation-probe/:id": (attacker, victim) =>
        call(
          `/public/stores/${attacker.slug}/isolation-probe/${victim.flavorId}`,
        ),
      "PATCH /public/stores/:storeSlug/isolation-probe/:id": (
        attacker,
        victim,
      ) =>
        call(
          `/public/stores/${attacker.slug}/isolation-probe/${victim.flavorId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "hijacked" }),
          },
        ),
      "GET /customer/stores/:storeSlug/isolation-probe/:id": (
        attacker,
        victim,
      ) =>
        call(
          `/customer/stores/${attacker.slug}/isolation-probe/${victim.flavorId}`,
          {
            headers: { "x-test-token-tid": attacker.id },
          },
        ),
    };

    it("lists every tenant route of the API (new routes must join the matrix)", () => {
      const discovery = server.app.get(DiscoveryService);
      const scanner = server.app.get(MetadataScanner);
      const routes: string[] = [];
      for (const wrapper of discovery.getControllers()) {
        const { instance, metatype } = wrapper;
        if (!instance || !metatype) continue;
        const prefix = Reflect.getMetadata(PATH_METADATA, metatype) as string;
        const prototype = Object.getPrototypeOf(instance) as object;
        for (const name of scanner.getAllMethodNames(prototype)) {
          const handler = (prototype as Record<string, object>)[name]!;
          if (!Reflect.getMetadata(TENANT_SURFACE, handler)) continue;
          const method =
            RequestMethod[
              Reflect.getMetadata(METHOD_METADATA, handler) as number
            ];
          const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
          routes.push(
            `${method} /${[prefix, path].filter((part) => part && part !== "/").join("/")}`,
          );
        }
      }
      // Read-only listings have no victim id; they are covered by the "own rows only" test.
      const listings = ["GET /public/stores/:storeSlug/isolation-probe"];
      assert.deepEqual(
        routes.filter((route) => !listings.includes(route)).sort(),
        Object.keys(MATRIX).sort(),
      );
    });

    for (const [route, attack] of Object.entries(MATRIX)) {
      it(`${route}: tenant A gets 404 on tenant B's resource, without side effects`, async () => {
        for (const [attacker, victim] of [
          [a, b],
          [b, a],
        ] as const) {
          const response = await attack(attacker, victim);
          assert.equal(response.status, 404);
          assert.equal((await json(response)).code, "NOT_FOUND");
          const [row] = await runInTenant(owner, victim.id, (em) =>
            em.execute<{ name: string }[]>(
              "select name from isolation_probe_flavors where id = ?",
              [victim.flavorId],
            ),
          );
          assert.notEqual(row!.name, "hijacked");
        }
      });
    }

    it("the same routes serve the tenant's own resource", async () => {
      const response = await call(
        `/public/stores/${a.slug}/isolation-probe/${a.flavorId}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await json(response), {
        id: a.flavorId,
        name: "Margherita A",
      });
    });

    it("a listing only returns the store's own rows", async () => {
      const response = await call(`/public/stores/${b.slug}/isolation-probe`);
      assert.deepEqual(await json(response), ["Calabresa B"]);
    });

    it("unknown or malformed slugs answer 404 and a store that is not ACTIVE answers 403 without its status", async () => {
      for (const slug of ["nao-existe", "UPPER", "a", "pizzaria-a%20"]) {
        const response = await call(`/public/stores/${slug}/isolation-probe`);
        assert.equal(response.status, 404, slug);
        assert.equal((await json(response)).code, "NOT_FOUND");
      }
      const suspended = await call(
        "/public/stores/pizzaria-suspensa/isolation-probe",
      );
      assert.equal(suspended.status, 403);
      const body = await json(suspended);
      assert.equal(body.code, "TENANT_NOT_ACTIVE");
      assert.doesNotMatch(JSON.stringify(body), /SUSPENDED/);
    });

    it("ignores tenant hints in headers, query and body", async () => {
      const response = await call(
        `/public/stores/${a.slug}/isolation-probe?tenantId=${b.id}&tenant_id=${b.id}`,
        { headers: { "x-tenant-id": b.id } },
      );
      assert.deepEqual(await json(response), ["Margherita A"]);
    });

    it("logs the resolved tenantId with the request", async () => {
      await call(`/public/stores/${a.slug}/isolation-probe`);
      await nextTick();
      const line = server.logs.findLast(
        (log) => log.msg === "request completed",
      );
      assert.equal(line?.tenantId, a.id);
    });
  });

  describe("2. RLS coverage", () => {
    it("every table with tenant_id has RLS enabled, forced and a policy", async () => {
      assert.deepEqual(await findUnprotectedTenantTables(owner), []);
    });

    it("flags a new tenant table until it is fully protected", async () => {
      const sql = owner.em.getConnection();
      await sql.execute(
        "create table coverage_probe (id uuid primary key, tenant_id uuid not null references tenants (id))",
      );
      try {
        const flagged = async () =>
          (await findUnprotectedTenantTables(owner)).map((t) => t.table);
        assert.deepEqual(await flagged(), ["coverage_probe"]);
        await sql.execute(
          "alter table coverage_probe enable row level security",
        );
        assert.deepEqual(await flagged(), ["coverage_probe"]);
        await sql.execute(
          "alter table coverage_probe force row level security",
        );
        // RLS without a policy denies everything, but is still flagged: the table is unusable.
        assert.deepEqual(await flagged(), ["coverage_probe"]);
        await sql.execute(
          "alter table coverage_probe no force row level security",
        );
        await sql.execute(
          "alter table coverage_probe disable row level security",
        );
        for (const statement of tenantIsolationSql("coverage_probe"))
          await sql.execute(statement);
        assert.deepEqual(await flagged(), []);
      } finally {
        await sql.execute("drop table coverage_probe");
      }
    });

    it("flags a nullable tenant_id", async () => {
      const sql = owner.em.getConnection();
      await sql.execute(
        "create table nullable_probe (id uuid primary key, tenant_id uuid)",
      );
      try {
        for (const statement of tenantIsolationSql("nullable_probe"))
          await sql.execute(statement);
        assert.deepEqual(
          (await findUnprotectedTenantTables(owner)).map((t) => t.table),
          ["nullable_probe"],
        );
      } finally {
        await sql.execute("drop table nullable_probe");
      }
    });

    it("refuses an ORM entity mapping tenant_id without the default tenant filter", async () => {
      const Unfiltered = defineEntity({
        name: "UnfilteredProbe",
        tableName: "isolation_probe_flavors",
        properties: { id: p.uuid().primary(), tenantId: p.uuid() },
      });
      await assert.rejects(
        createOrm(
          { url: database.appUrl, poolMax: 1 },
          { entities: [Tenant, Unfiltered] },
        ),
        /UnfilteredProbe/,
      );
      // `app` above was created with the probe entity and passed the same check.
      assert.doesNotThrow(() => assertTenantFilters(app));
    });
  });

  describe("3. fail closed without context", () => {
    it("whiteoven_app reads zero rows and cannot insert", async () => {
      assert.equal(
        await appCount(
          "select count(*)::int as count from isolation_probe_flavors",
        ),
        0,
      );
      assert.equal(
        await sqlState(() =>
          app.em
            .getConnection()
            .execute(
              "insert into isolation_probe_flavors (tenant_id, name) values (?, 'x')",
              [a.id],
            ),
        ),
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it("the owner is subject to the policies too (FORCE)", async () => {
      const [row] = await owner.em
        .getConnection()
        .execute<{ count: number }[]>(
          "select count(*)::int as count from isolation_probe_flavors",
        );
      assert.equal(row!.count, 0);
    });

    it("a context cannot write rows of another tenant", async () => {
      assert.equal(
        await sqlState(() =>
          runInTenant(app, a.id, (em) =>
            em.execute(
              "insert into isolation_probe_flavors (tenant_id, name) values (?, 'x')",
              [b.id],
            ),
          ),
        ),
        INSUFFICIENT_PRIVILEGE,
      );
      assert.equal(
        await runInTenant(app, a.id, async (em) => {
          const result = await em.execute<{ affectedRows: number }>(
            "update isolation_probe_flavors set tenant_id = ? where id = ?",
            [b.id, a.flavorId],
            "run",
          );
          return result.affectedRows;
        }).catch((error: { code?: string }) => error.code),
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it("the ORM refuses a tenant entity query without tenant parameters", async () => {
      await assert.rejects(
        app.em.fork().find(ProbeFlavor, {}),
        /No arguments provided for filter 'tenant'/,
      );
    });

    it("with the ORM filter explicitly disabled, RLS still returns only the context's rows", async () => {
      const names = await runInTenant(app, a.id, async (em) =>
        (await em.find(ProbeFlavor, {}, { filters: { tenant: false } })).map(
          (row) => row.name,
        ),
      );
      assert.deepEqual(names, ["Margherita A"]);
    });

    it("TenantTransactions refuses to run outside a request context", async () => {
      await assert.rejects(
        new TenantTransactions(app).run(async () => "unreachable"),
        /no tenant context/,
      );
    });

    it("whiteoven_app only reads tenants", async () => {
      assert.equal(
        await appCount("select count(*)::int as count from tenants"),
        3,
      );
      for (const statement of [
        "insert into tenants (slug, display_name) values ('intrusa', 'x')",
        "update tenants set status = 'ACTIVE'",
        "delete from tenants",
      ])
        assert.equal(
          await sqlState(() => app.em.getConnection().execute(statement)),
          INSUFFICIENT_PRIVILEGE,
          statement,
        );
    });
  });

  describe("4. pooled connection reuse", () => {
    const backend = (em: { execute: MikroORM["em"]["execute"] }) =>
      em.execute<{ pid: number; names: string[] }[]>(
        `select pg_backend_pid() as pid,
                coalesce(array_agg(name order by name) filter (where name is not null), '{}') as names
           from (select name from isolation_probe_flavors) f`,
      );

    it("sequential tenants on the same connection never share context", async () => {
      const [first] = await runInTenant(app, a.id, backend);
      const [second] = await runInTenant(app, b.id, backend);
      const [after] = await backend(app.em.fork());
      const [setting] = await app.em
        .getConnection()
        .execute<{ value: string | null }[]>(
          "select current_setting('app.tenant_id', true) as value",
        );
      assert.equal(first!.pid, second!.pid);
      assert.equal(second!.pid, after!.pid);
      assert.deepEqual(first!.names, ["Margherita A"]);
      assert.deepEqual(second!.names, ["Calabresa B"]);
      assert.deepEqual(after!.names, []);
      // The variable is defined but empty after the transaction; the policy treats it as no tenant.
      assert.ok(setting!.value === "" || setting!.value === null);
    });

    it("a failed tenant transaction does not leak its context either", async () => {
      await assert.rejects(
        runInTenant(app, a.id, async (em) => {
          await em.execute("select 1");
          throw new Error("boom");
        }),
        /boom/,
      );
      assert.equal(
        await appCount(
          "select count(*)::int as count from isolation_probe_flavors",
        ),
        0,
      );
    });

    it("sequential HTTP requests for different stores on a one-connection pool", async () => {
      for (const [store, expected] of [
        [a, ["Margherita A"]],
        [b, ["Calabresa B"]],
        [a, ["Margherita A"]],
      ] as const) {
        const response = await call(
          `/public/stores/${store.slug}/isolation-probe`,
        );
        assert.deepEqual(await json(response), expected);
      }
    });

    it("rejects a tenant id that is not a UUID before touching the database", async () => {
      await assert.rejects(
        runInTenant(app, "' or true --", async () => 1),
        /UUID/,
      );
    });
  });

  describe("5. composite foreign keys", () => {
    it("an item of tenant A cannot reference a flavor of tenant B", async () => {
      assert.equal(
        await sqlState(() =>
          runInTenant(owner, a.id, (em) =>
            em.execute(
              "insert into isolation_probe_items (tenant_id, flavor_id) values (?, ?)",
              [a.id, b.flavorId],
            ),
          ),
        ),
        FOREIGN_KEY_VIOLATION,
      );
      await runInTenant(owner, a.id, (em) =>
        em.execute(
          "insert into isolation_probe_items (tenant_id, flavor_id) values (?, ?)",
          [a.id, a.flavorId],
        ),
      );
    });

    it("holds even with RLS disabled (e.g. inside a migration)", async () => {
      const sql = owner.em.getConnection();
      await sql
        .transactional(async (trx) => {
          await sql.execute(
            "alter table isolation_probe_items no force row level security",
            [],
            "run",
            trx,
          );
          await sql.execute(
            "alter table isolation_probe_items disable row level security",
            [],
            "run",
            trx,
          );
          await sql.execute(
            "alter table isolation_probe_flavors no force row level security",
            [],
            "run",
            trx,
          );
          await sql.execute(
            "alter table isolation_probe_flavors disable row level security",
            [],
            "run",
            trx,
          );
          const error = await sql
            .execute(
              "insert into isolation_probe_items (tenant_id, flavor_id) values (?, ?)",
              [a.id, b.flavorId],
              "run",
              trx,
            )
            .then(
              () => undefined,
              (e: { code?: string }) => e.code,
            );
          assert.equal(error, FOREIGN_KEY_VIOLATION);
          throw new Error("rollback");
        })
        .catch((error: Error) => assert.equal(error.message, "rollback"));
      assert.deepEqual(await findUnprotectedTenantTables(owner), []);
    });
  });

  describe("6. cross-store token", () => {
    it("a token of tenant A on tenant B's store answers 404", async () => {
      const response = await call(
        `/customer/stores/${b.slug}/isolation-probe/${b.flavorId}`,
        {
          headers: { "x-test-token-tid": a.id },
        },
      );
      assert.equal(response.status, 404);
      assert.equal((await json(response)).code, "NOT_FOUND");
    });

    it("the same token works on its own store", async () => {
      const response = await call(
        `/customer/stores/${a.slug}/isolation-probe/${a.flavorId}`,
        {
          headers: { "x-test-token-tid": a.id },
        },
      );
      assert.equal(response.status, 200);
    });
  });

  describe("7. membership revocation", () => {
    it.todo(
      "a revoked member loses access within the membership cache TTL (≤ 60 s): needs Membership and staff tokens, delivered and tested in M1.4",
    );
  });
});
