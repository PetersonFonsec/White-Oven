import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { json, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import {
  insertMembership,
  insertStaffUser,
  insertTenant,
  staffLogin,
  switchTenant,
} from "./staff-fixtures";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import { DEFAULT_STORE_SETTINGS } from "../src/store/store-rules";

const PASSWORD = "store-test-password";

describe("M3.4 store settings, opening hours and pause", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let server: TestServer;
  let tenantA: string;
  let tenantB: string;
  const tokens: Record<string, string> = {};

  const member = async (
    key: string,
    tenantId: string,
    role: "OWNER" | "MANAGER" | "STAFF",
  ) => {
    const email = `store-${key.toLowerCase()}-${randomUUID()}@test.invalid`;
    const user = await insertStaffUser(owner, email, PASSWORD);
    await insertMembership(owner, tenantId, user, role);
    const login = await staffLogin(server.baseUrl, email, PASSWORD);
    tokens[key] = (
      await json(
        await switchTenant(server.baseUrl, login.accessToken, tenantId),
      )
    ).accessToken;
  };

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    tenantA = await insertTenant(owner, `store-a-${randomUUID().slice(0, 8)}`);
    tenantB = await insertTenant(owner, `store-b-${randomUUID().slice(0, 8)}`);
    await owner.em
      .getConnection()
      .execute("update tenants set timezone = 'America/Manaus' where id = ?", [
        tenantB,
      ]);
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: "2",
    });
    await member("ownerA", tenantA, "OWNER");
    await member("managerA", tenantA, "MANAGER");
    await member("staffA", tenantA, "STAFF");
    await member("ownerB", tenantB, "OWNER");
  });
  after(async () => {
    await server?.close();
    await owner?.close();
    await database?.drop();
  });

  const call = (who: string, path: string, method = "GET", body?: unknown) =>
    fetch(`${server.baseUrl}/v1/admin/store${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[who]}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const auditActions = async (tenantId: string) =>
    (
      await owner.em
        .getConnection()
        .execute<{ action: string }[]>(
          "select action from audit_events where tenant_id = ? and action like 'store.%' order by at, id",
          [tenantId],
        )
    ).map((row) => row.action);

  const settings = {
    ...DEFAULT_STORE_SETTINGS,
    fulfillmentModes: ["DELIVERY", "PICKUP"],
    deliveryFeeCents: 700,
    minimumOrderCents: 3000,
    deliveryAreaDescription: "Centro e Vila Nova",
    acceptedPaymentMethods: ["CASH", "PIX_ON_DELIVERY"],
    contactPhone: "(11) 99999-0000",
    pickupAddress: "Rua das Pizzas, 10",
  };
  const week = {
    rules: [
      { weekday: 5, opensAt: "18:00", closesAt: "02:00" },
      { weekday: 6, opensAt: "18:00", closesAt: "23:00" },
    ],
    exceptions: [{ date: "2026-12-25", closed: true, shifts: [] }],
  };

  it("starts from the documented defaults with nothing saved", async () => {
    const response = await call("ownerA", "/settings");
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), {
      timezone: "America/Sao_Paulo",
      settingsSaved: false,
      settings: DEFAULT_STORE_SETTINGS,
      openingHours: { rules: [], exceptions: [] },
      pause: {
        paused: false,
        pausedUntil: null,
        timezone: "America/Sao_Paulo",
      },
    });
  });

  it("saves settings for the owner's store only, and audits the change", async () => {
    const saved = await call("ownerA", "/settings", "PUT", settings);
    assert.equal(saved.status, 200);
    const body = await json(await call("ownerA", "/settings"));
    assert.equal(body.settingsSaved, true);
    assert.deepEqual(body.settings, settings);
    const other = await json(await call("ownerB", "/settings"));
    assert.equal(other.settingsSaved, false);
    assert.deepEqual(other.settings, DEFAULT_STORE_SETTINGS);
    assert.deepEqual(await auditActions(tenantA), ["store.settings.updated"]);
    assert.deepEqual(await auditActions(tenantB), []);
  });

  it("refuses invalid settings with the offending fields and keeps the saved ones", async () => {
    const response = await call("ownerA", "/settings", "PUT", {
      ...settings,
      deliveryFeeCents: -1,
      acceptedPaymentMethods: [],
      pickupAddress: " ",
    });
    assert.equal(response.status, 422);
    const body = await json(response);
    assert.equal(body.code, "VALIDATION_FAILED");
    assert.deepEqual(
      body.details.errors.map((error: { path: string }) => error.path),
      ["deliveryFeeCents", "acceptedPaymentMethods", "pickupAddress"],
    );
    assert.equal(
      (await json(await call("ownerA", "/settings"))).settings.deliveryFeeCents,
      700,
    );
  });

  it("saves hours that cross midnight and refuses a shift overlapping the night before", async () => {
    const saved = await call("ownerA", "/opening-hours", "PUT", week);
    assert.equal(saved.status, 200);
    assert.deepEqual(
      (await json(await call("ownerA", "/settings"))).openingHours,
      week,
    );

    const overlapping = await call("ownerA", "/opening-hours", "PUT", {
      ...week,
      rules: [
        ...week.rules,
        { weekday: 6, opensAt: "01:00", closesAt: "03:00" },
      ],
    });
    assert.equal(overlapping.status, 422);
    const body = await json(overlapping);
    assert.equal(body.code, "OPENING_HOURS_INVALID");
    assert.deepEqual(body.details.errors, [
      { code: "OPENING_HOURS_OVERLAP", path: "rules[2]" },
    ]);

    const substitute = await call("ownerA", "/opening-hours", "PUT", {
      ...week,
      exceptions: [
        {
          date: "2026-10-31",
          closed: false,
          shifts: [{ opensAt: "01:30", closesAt: "04:00" }],
        },
      ],
    });
    assert.equal(substitute.status, 422);
    assert.deepEqual((await json(substitute)).details.errors, [
      { code: "OPENING_HOURS_OVERLAP", path: "exceptions[0].shifts[0]" },
    ]);
    assert.deepEqual(
      (await json(await call("ownerA", "/settings"))).openingHours,
      week,
    );
    assert.equal(
      (await json(await call("ownerB", "/settings"))).openingHours.rules.length,
      0,
    );
  });

  it("lets managers read but not change settings, and keeps staff out", async () => {
    assert.equal((await call("managerA", "/settings")).status, 200);
    for (const [path, body] of [
      ["/settings", settings],
      ["/opening-hours", week],
    ] as const) {
      const response = await call("managerA", path, "PUT", body);
      assert.equal(response.status, 403);
      assert.equal((await json(response)).code, "ROLE_FORBIDDEN");
      assert.equal((await call("staffA", path, "PUT", body)).status, 403);
    }
    assert.equal((await call("staffA", "/settings")).status, 403);
  });

  it("lets any staff member pause for a while or until reopened, per store", async () => {
    const paused = await call("staffA", "/pause", "PUT", { minutes: 30 });
    assert.equal(paused.status, 200);
    const pause = await json(paused);
    assert.equal(pause.paused, true);
    const minutesLeft = (Date.parse(pause.pausedUntil) - Date.now()) / 60_000;
    assert.ok(minutesLeft > 29 && minutesLeft <= 30.5, String(minutesLeft));
    assert.equal(pause.timezone, "America/Sao_Paulo");
    // Each store answers with its own time zone, so the panel shows its local time.
    assert.deepEqual(await json(await call("ownerB", "/pause")), {
      paused: false,
      pausedUntil: null,
      timezone: "America/Manaus",
    });

    const indefinite = await json(
      await call("managerA", "/pause", "PUT", { minutes: null }),
    );
    assert.deepEqual(indefinite, {
      paused: true,
      pausedUntil: null,
      timezone: "America/Sao_Paulo",
    });

    assert.equal((await call("staffA", "/pause", "DELETE")).status, 204);
    assert.deepEqual(await json(await call("staffA", "/pause")), {
      paused: false,
      pausedUntil: null,
      timezone: "America/Sao_Paulo",
    });

    for (const body of [{ minutes: 10 }, {}, { minutes: 15, extra: 1 }, []])
      assert.equal(
        (await call("staffA", "/pause", "PUT", body)).status,
        422,
        JSON.stringify(body),
      );
    assert.deepEqual((await auditActions(tenantA)).slice(-3), [
      "store.pause.started",
      "store.pause.started",
      "store.pause.ended",
    ]);
  });

  it("treats an expired pause as reopened", async () => {
    await call("ownerA", "/pause", "PUT", { minutes: 15 });
    await runInTenant(owner, tenantA, (em) =>
      em.execute(
        "update store_pauses set paused_until = now() - interval '1 minute'",
      ),
    );
    assert.deepEqual(await json(await call("ownerA", "/pause")), {
      paused: false,
      pausedUntil: null,
      timezone: "America/Sao_Paulo",
    });
  });

  it("refuses writes in a suspended store", async () => {
    const suspended = await insertTenant(
      owner,
      `store-suspended-${randomUUID().slice(0, 8)}`,
      "SUSPENDED",
    );
    await member("ownerSuspended", suspended, "OWNER");
    for (const [path, body] of [
      ["/settings", settings],
      ["/opening-hours", week],
      ["/pause", { minutes: 15 }],
    ] as const) {
      const response = await call("ownerSuspended", path, "PUT", body);
      assert.equal(response.status, 403, path);
      assert.equal((await json(response)).code, "STORE_WRITE_FORBIDDEN");
    }
    assert.equal((await call("ownerSuspended", "/settings")).status, 200);
  });

  it("refuses the app role writing owner settings with a STAFF session in the database", async () => {
    const app = await database.connect(database.appUrl);
    try {
      const [session] = await runInTenant(owner, tenantA, (em) =>
        em.execute<{ id: string; staffUserId: string }[]>(
          `select s.id, s.staff_user_id as "staffUserId" from staff_sessions s
           join memberships m on m.staff_user_id = s.staff_user_id
           where m.tenant_id = ? and m.role = 'STAFF' and s.revoked_at is null limit 1`,
          [tenantA],
        ),
      );
      assert.ok(session, "a live STAFF session");
      await assert.rejects(
        runInTenant(app, tenantA, async (em) => {
          await em.execute(
            "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true)",
            [session!.staffUserId, session!.id],
          );
          await em.execute("update store_settings set delivery_fee_cents = 0");
        }),
        (error: { code?: string }) => error.code === "42501",
      );
    } finally {
      await app.close();
    }
  });

  it("persists only validated hours: invalid writes change nothing and the database keeps stores apart", async () => {
    const hours = {
      rules: [{ weekday: 1, opensAt: "18:00", closesAt: "23:00" }],
      exceptions: [
        { date: "2026-12-31", closed: true, shifts: [] },
        {
          date: "2026-12-24",
          closed: false,
          shifts: [{ opensAt: "11:00", closesAt: "15:00" }],
        },
      ],
    };
    assert.equal(
      (await call("ownerB", "/opening-hours", "PUT", hours)).status,
      200,
    );
    const savedB = (await json(await call("ownerB", "/settings"))).openingHours;
    // Saved sorted by date, as validated.
    assert.deepEqual(
      savedB.exceptions.map((item: { date: string }) => item.date),
      ["2026-12-24", "2026-12-31"],
    );
    const auditB = (await auditActions(tenantB)).length;
    for (const body of [
      {
        ...hours,
        rules: [{ weekday: 1, opensAt: "18:00", closesAt: "18:00" }],
      },
      { ...hours, rules: "18:00-23:00" },
      {
        rules: [],
        exceptions: [{ date: "2026-12-24", closed: false, shifts: [] }],
      },
    ])
      assert.equal(
        (await call("ownerB", "/opening-hours", "PUT", body)).status,
        422,
        JSON.stringify(body),
      );
    assert.deepEqual(
      (await json(await call("ownerB", "/settings"))).openingHours,
      savedB,
    );
    assert.equal((await auditActions(tenantB)).length, auditB);

    // The app role is the only runtime writer. Without a live OWNER session the trigger refuses
    // it, and with one, RLS keeps it inside its own store.
    const app = await database.connect(database.appUrl);
    try {
      await assert.rejects(
        runInTenant(app, tenantA, (em) =>
          em.execute("update store_opening_hours set rules = '[]'::jsonb"),
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      const [session] = await runInTenant(owner, tenantA, (em) =>
        em.execute<{ id: string; staffUserId: string }[]>(
          `select s.id, s.staff_user_id as "staffUserId" from staff_sessions s
           join memberships m on m.staff_user_id = s.staff_user_id
           where m.tenant_id = ? and m.role = 'OWNER' and s.revoked_at is null limit 1`,
          [tenantA],
        ),
      );
      assert.ok(session, "a live OWNER session");
      const asOwnerA = (sql: string, params: unknown[] = []) =>
        runInTenant(app, tenantA, async (em) => {
          await em.execute(
            "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true)",
            [session!.staffUserId, session!.id],
          );
          return em.execute(sql, params);
        });
      await assert.rejects(
        asOwnerA(
          "insert into store_opening_hours (tenant_id, rules, exceptions) values (?, '[]', '[]')",
          [tenantB],
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      assert.deepEqual(
        await asOwnerA(
          "update store_opening_hours set rules = '[]'::jsonb where tenant_id = ? returning tenant_id",
          [tenantB],
        ),
        [],
      );
    } finally {
      await app.close();
    }
    assert.deepEqual(
      (await json(await call("ownerB", "/settings"))).openingHours,
      savedB,
    );
  });
});
