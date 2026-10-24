import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { defineEntity, p } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  findUnprotectedTenantTables,
  tenantIsolationSql,
} from "../src/database/tenant-isolation-sql";
import { loadConfig } from "../src/config/config";
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
import {
  insertMembership,
  insertStaffUser,
  setMembershipStatus,
  staffLogin,
  switchTenant,
} from "./staff-fixtures";

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

/** Staff membership cache TTL of this suite's server; production allows at most 60 s. */
const MEMBERSHIP_CACHE_SECONDS = 1;
const STAFF_PASSWORD = "isolamento-2026";

/**
 * Required tests of docs/architecture/tenant-isolation.md, against a real PostgreSQL. Tables
 * are the test-only probes of `tenant-probes.ts` plus `memberships` (M1.4), the first real one.
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
      {
        DATABASE_URL: database.appUrl,
        DATABASE_POOL_MAX: "1",
        AUTH_MEMBERSHIP_CACHE_SECONDS: String(MEMBERSHIP_CACHE_SECONDS),
      },
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
      // `GET /admin/me` reads only the token's own membership; covered by test 7.
      const listings = [
        "GET /public/stores/:storeSlug/isolation-probe",
        "GET /admin/me",
      ];
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
    it("every table with tenant_id has RLS enabled, forced and only tenant-check policies", async () => {
      assert.deepEqual(await findUnprotectedTenantTables(owner), []);
    });

    it("covers the production tenant tables (memberships, M1.4)", async () => {
      const rows = await owner.em
        .getConnection()
        .execute<{ table: string; forced: boolean }[]>(
          `select c.relname as "table", c.relforcerowsecurity as forced
           from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
            and c.relname not like 'isolation_probe_%'
          order by 1`,
        );
      assert.deepEqual(rows, [{ table: "memberships", forced: true }]);
    });

    /** Problems reported for `table`, or [] when it is considered protected. */
    const problemsOf = async (table: string) =>
      (await findUnprotectedTenantTables(owner)).find((t) => t.table === table)
        ?.problems ?? [];

    /** Creates a protected tenant table, runs `extra` statements on it, then `check`, then drops it. */
    const withCoverageTable = async (
      extra: string[],
      check: (table: string) => Promise<void>,
    ) => {
      const table = "coverage_probe";
      const sql = owner.em.getConnection();
      await sql.execute(
        `create table ${table} (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants (id))`,
      );
      try {
        for (const statement of [...tenantIsolationSql(table), ...extra])
          await sql.execute(statement);
        await check(table);
      } finally {
        await sql.execute(`drop table ${table}`);
      }
    };

    it("flags a new tenant table until it is fully protected", async () => {
      const sql = owner.em.getConnection();
      await sql.execute(
        "create table coverage_probe (id uuid primary key, tenant_id uuid not null references tenants (id))",
      );
      try {
        assert.deepEqual(await problemsOf("coverage_probe"), [
          "row level security disabled",
          "row level security not forced",
          "no permissive policy for whiteoven_app",
        ]);
        await sql.execute(
          "alter table coverage_probe enable row level security",
        );
        await sql.execute(
          "alter table coverage_probe force row level security",
        );
        // RLS without a policy denies everything, but is still flagged: the table is unusable.
        assert.deepEqual(await problemsOf("coverage_probe"), [
          "no permissive policy for whiteoven_app",
        ]);
        await sql.execute(
          "alter table coverage_probe no force row level security",
        );
        await sql.execute(
          "alter table coverage_probe disable row level security",
        );
        for (const statement of tenantIsolationSql("coverage_probe"))
          await sql.execute(statement);
        assert.deepEqual(await problemsOf("coverage_probe"), []);
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
        assert.deepEqual(await problemsOf("nullable_probe"), [
          "tenant_id is nullable",
        ]);
      } finally {
        await sql.execute("drop table nullable_probe");
      }
    });

    it("flags an extra permissive policy that exposes every tenant without context", async () => {
      await withCoverageTable(
        [
          "create policy open_all on coverage_probe using (true) with check (true)",
        ],
        async (table) => {
          await runInTenant(owner, b.id, (em) =>
            em.execute(`insert into ${table} (tenant_id) values (?)`, [b.id]),
          );
          // The leak is real: whiteoven_app reads tenant B's row with no context at all.
          assert.equal(
            await appCount(`select count(*)::int as count from ${table}`),
            1,
          );
          assert.deepEqual(await problemsOf(table), [
            'permissive policy "open_all": USING is not the tenant check',
            'permissive policy "open_all": WITH CHECK is not the tenant check',
          ]);
        },
      );
    });

    const UNSAFE_POLICIES: [string, string, string[]][] = [
      [
        "a SELECT-only policy for whiteoven_app",
        "create policy app_reads on coverage_probe for select to whiteoven_app using (true)",
        ['permissive policy "app_reads": USING is not the tenant check'],
      ],
      [
        "an INSERT policy with an open WITH CHECK",
        "create policy app_inserts on coverage_probe for insert with check (true)",
        ['permissive policy "app_inserts": WITH CHECK is not the tenant check'],
      ],
      [
        "an UPDATE policy that lets rows move to another tenant",
        "create policy app_moves on coverage_probe for update using (tenant_id = whiteoven_current_tenant()) with check (tenant_id is not null)",
        ['permissive policy "app_moves": WITH CHECK is not the tenant check'],
      ],
      [
        "a DELETE policy wider than the tenant check",
        "create policy app_deletes on coverage_probe for delete using (tenant_id = whiteoven_current_tenant() or tenant_id is not null)",
        ['permissive policy "app_deletes": USING is not the tenant check'],
      ],
      [
        "a policy for whiteoven_platform reading without context",
        "create policy platform_reads on coverage_probe for select to whiteoven_platform using (true)",
        ['permissive policy "platform_reads": USING is not the tenant check'],
      ],
      [
        "a policy reading the setting without nullif (fails with an error, not closed)",
        "create policy raw_setting on coverage_probe using (tenant_id = current_setting('app.tenant_id', true)::uuid)",
        [
          'permissive policy "raw_setting": USING is not the tenant check',
          'permissive policy "raw_setting": WITH CHECK is not the tenant check',
        ],
      ],
    ];

    for (const [name, statement, expected] of UNSAFE_POLICIES) {
      it(`flags ${name}`, async () => {
        await withCoverageTable([statement], async (table) => {
          assert.deepEqual(await problemsOf(table), expected);
        });
      });
    }

    it("flags the tenant policy rewritten with an open WITH CHECK", async () => {
      await withCoverageTable(
        ["alter policy tenant_isolation on coverage_probe with check (true)"],
        async (table) => {
          assert.deepEqual(await problemsOf(table), [
            'permissive policy "tenant_isolation": WITH CHECK is not the tenant check',
          ]);
        },
      );
    });

    it("flags a look-alike tenant function from another schema", async () => {
      const sql = owner.em.getConnection();
      await sql.execute("create schema coverage_lookalike");
      try {
        await withCoverageTable(
          [
            "create function coverage_lookalike.whiteoven_current_tenant() returns uuid language sql stable as $$ select tenant_id from public.coverage_probe limit 1 $$",
            "alter policy tenant_isolation on coverage_probe using (tenant_id = coverage_lookalike.whiteoven_current_tenant()) with check (tenant_id = coverage_lookalike.whiteoven_current_tenant())",
          ],
          async (table) => {
            assert.deepEqual(await problemsOf(table), [
              'permissive policy "tenant_isolation": USING is not the tenant check',
              'permissive policy "tenant_isolation": WITH CHECK is not the tenant check',
            ]);
          },
        );
      } finally {
        await sql.execute("drop schema coverage_lookalike cascade");
      }
    });

    it("flags a table whose only permissive policy excludes whiteoven_app", async () => {
      await withCoverageTable(
        [
          "drop policy tenant_isolation on coverage_probe",
          "create policy platform_only on coverage_probe to whiteoven_platform using (tenant_id = whiteoven_current_tenant()) with check (tenant_id = whiteoven_current_tenant())",
        ],
        async (table) => {
          assert.deepEqual(await problemsOf(table), [
            "no permissive policy for whiteoven_app",
          ]);
        },
      );
    });

    it("accepts the tenant check without explicit WITH CHECK and extra restrictive policies, still failing closed", async () => {
      await withCoverageTable(
        [
          "drop policy tenant_isolation on coverage_probe",
          "create policy tenant_isolation on coverage_probe using (tenant_id = whiteoven_current_tenant())",
          "create policy only_named on coverage_probe as restrictive using (id is not null)",
        ],
        async (table) => {
          assert.deepEqual(await problemsOf(table), []);
          await runInTenant(owner, a.id, (em) =>
            em.execute(`insert into ${table} (tenant_id) values (?)`, [a.id]),
          );
          assert.equal(
            await appCount(`select count(*)::int as count from ${table}`),
            0,
          );
          assert.equal(
            await sqlState(() =>
              runInTenant(app, a.id, (em) =>
                em.execute(`insert into ${table} (tenant_id) values (?)`, [
                  b.id,
                ]),
              ),
            ),
            INSUFFICIENT_PRIVILEGE,
          );
        },
      );
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

    it("closes the ORM it built when the tenant filter check fails", async () => {
      const Unfiltered = defineEntity({
        name: "UnfilteredProbe",
        tableName: "isolation_probe_flavors",
        properties: { id: p.uuid().primary(), tenantId: p.uuid() },
      });
      const closed: MikroORM[] = [];
      const close = MikroORM.prototype.close;
      MikroORM.prototype.close = function (this: MikroORM, ...args) {
        closed.push(this);
        return close.apply(this, args);
      };
      try {
        await assert.rejects(
          createOrm(
            { url: database.appUrl, poolMax: 1 },
            { entities: [Tenant, Unfiltered] },
          ),
          /UnfilteredProbe/,
        );
      } finally {
        MikroORM.prototype.close = close;
      }
      assert.equal(closed.length, 1);
      assert.equal(await closed[0]!.isConnected(), false);
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
    it("a revoked member loses access within the membership cache TTL (≤ 60 s)", async () => {
      const email = "revogada@isolamento.test";
      const userId = await insertStaffUser(owner, email, STAFF_PASSWORD);
      await insertMembership(owner, a.id, userId, "MANAGER");
      const login = await staffLogin(server.baseUrl, email, STAFF_PASSWORD);
      const switched = await switchTenant(
        server.baseUrl,
        login.accessToken,
        a.id,
      );
      const { accessToken } = await json(switched);
      const me = () =>
        call("/admin/me", {
          headers: { authorization: `Bearer ${accessToken}` },
        });
      assert.equal((await me()).status, 200);

      await setMembershipStatus(owner, a.id, userId, "REVOKED");
      const revokedAt = Date.now();
      let denied: Response | undefined;
      while (Date.now() - revokedAt < (MEMBERSHIP_CACHE_SECONDS + 2) * 1000) {
        const response = await me();
        if (response.status !== 200) {
          denied = response;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(denied, "access survived the cache TTL");
      assert.ok(
        Date.now() - revokedAt <= (MEMBERSHIP_CACHE_SECONDS + 1) * 1000,
      );
      assert.equal(denied.status, 403);
      assert.equal((await json(denied)).code, "TENANT_ACCESS_DENIED");

      // The same token cannot pick the tenant again, and other stores stay invisible.
      for (const tenantId of [a.id, b.id]) {
        const retry = await switchTenant(server.baseUrl, accessToken, tenantId);
        assert.equal(retry.status, 404);
      }
    });

    it("a staff token of tenant A cannot act on tenant B", async () => {
      const email = "so-a@isolamento.test";
      const userId = await insertStaffUser(owner, email, STAFF_PASSWORD);
      await insertMembership(owner, a.id, userId, "OWNER");
      const login = await staffLogin(server.baseUrl, email, STAFF_PASSWORD);
      const response = await switchTenant(
        server.baseUrl,
        login.accessToken,
        b.id,
      );
      assert.equal(response.status, 404);
      assert.equal((await json(response)).code, "NOT_FOUND");
    });

    it("the membership cache TTL is capped at 60 s by configuration", () => {
      assert.throws(() =>
        loadConfig({
          DATABASE_URL: database.appUrl,
          AUTH_MEMBERSHIP_CACHE_SECONDS: "61",
        }),
      );
    });
  });
});
