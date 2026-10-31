import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PlatformService } from "../src/platform/platform.service";
import { hashPassword } from "../src/auth/password";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import { ApiError } from "../src/errors/api-error";
import { json, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import {
  bearer,
  insertMembership,
  insertStaffUser,
  insertTenant,
  staffLogin,
  switchTenant,
} from "./staff-fixtures";
import { insertOrder } from "./order-fixtures";
import type { ApiConfig } from "../src/config/config";

const PASSWORD = "cobranca-senha-forte";

const apiCode = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;

/** `YYYY-MM` of now in São Paulo, the stores' time zone. */
function currentMonth(): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}`;
}

describe("M6.3 monthly billing report", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let app: Awaited<ReturnType<TestDatabase["connect"]>>;
  let server: TestServer;
  let platform: PlatformService;
  let operatorId: string;
  let sessionId: string;
  const store = { id: "", slug: `cobranca-a-${randomUUID().slice(0, 8)}` };
  const other = { id: "", slug: `cobranca-b-${randomUUID().slice(0, 8)}` };
  const august: string[] = [];

  /** A completed order recorded in the ledger, completed at `at`. */
  const completed = async (tenantId: string, at: string) => {
    const order = await insertOrder(owner, tenantId);
    await runInTenant(owner, tenantId, async (em) => {
      await em.execute(
        `insert into order_status_changes (tenant_id, order_id, from_status, to_status, actor_type, at)
         values (?, ?, 'READY', 'COMPLETED', 'SYSTEM', ?)`,
        [tenantId, order.id, at],
      );
      await em.execute("update orders set status = 'COMPLETED' where id = ?", [
        order.id,
      ]);
    });
    await runInTenant(app, tenantId, (em) =>
      em.execute("select whiteoven_record_order_completion(?)", [order.id]),
    );
    return order.id;
  };
  const staff = async (tenantId: string, role: "OWNER" | "MANAGER") => {
    const email = `cobranca-${randomUUID()}@teste.invalid`;
    const userId = await insertStaffUser(owner, email, PASSWORD);
    await insertMembership(owner, tenantId, userId, role);
    const login = await staffLogin(server.baseUrl, email, PASSWORD);
    const switched = await switchTenant(
      server.baseUrl,
      login.accessToken,
      tenantId,
    );
    assert.equal(switched.status, 200);
    return (await json(switched)).accessToken as string;
  };
  const ownerReport = (token: string, query = "") =>
    fetch(`${server.baseUrl}/v1/admin/reports/billing${query}`, {
      headers: bearer(token),
    });

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    app = await database.connect(database.appUrl);
    for (const tenant of [store, other])
      tenant.id = await insertTenant(owner, tenant.slug);
    // Flex in August (São Paulo), Pro since 1 September.
    await runInTenant(owner, store.id, async (em) => {
      await em.execute("delete from plan_subscriptions where tenant_id = ?", [
        store.id,
      ]);
      await em.execute(
        `insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from, valid_to)
         values (?, 'FLEX', 300, 0, '2026-08-01T03:00:00Z', '2026-09-01T03:00:00Z'),
                (?, 'PRO', 0, 19900, '2026-09-01T03:00:00Z', null)`,
        [store.id, store.id],
      );
    });
    august.push(await completed(store.id, "2026-08-10T15:00:00Z"));
    august.push(await completed(store.id, "2026-08-20T15:00:00Z"));
    // 31 August 23:59 in São Paulo: still August, still Flex.
    august.push(await completed(store.id, "2026-09-01T02:59:00Z"));
    await completed(store.id, "2026-09-01T03:00:00Z");
    await runInTenant(owner, other.id, (em) =>
      em.execute(
        "update plan_subscriptions set valid_from = '2026-08-01T03:00:00Z' where tenant_id = ?",
        [other.id],
      ),
    );
    await completed(other.id, "2026-08-15T15:00:00Z");

    const hash = await hashPassword("correct horse battery staple 2026");
    const [operator] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_users (email, name, password_hash, platform_role, mfa_secret, mfa_enabled_at) values (?, ?, ?, 'OPERATOR', 'v1.operator', now()) returning id",
        [`operator-${Date.now()}@example.test`, "Operator", hash],
      );
    operatorId = operator!.id;
    const [session] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_sessions (staff_user_id, mfa, refresh_token_hash, idle_expires_at) values (?, true, ?, now() + interval '1 hour') returning id",
        [operatorId, Buffer.alloc(32, 3)],
      );
    sessionId = session!.id;
    const config: ApiConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "error",
      openApiEnabled: false,
      imageStorageDirectory: ".data/images",
      database: { url: database.appUrl, poolMax: 2 },
      auth: {
        accessTokenPrivateKey: null,
        mfaEncryptionKey: null,
        ownerInviteSecret: Buffer.alloc(32, 9),
        adminOrigins: ["https://admin.example.test"],
      },
      push: { delivery: "disabled", expoAccessToken: null },
      trustedProxies: [],
    };
    platform = new PlatformService(app, config);
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: "4",
    });
  });

  after(async () => {
    await server?.close();
    await app?.close();
    await owner?.close();
    await database?.drop();
  });

  const report = (period?: string) =>
    platform.billingReport(store.id, period, operatorId, sessionId);
  const line = (
    plan: string,
    feeBasisPoints: number,
    completedCount: number,
    reversedCount: number,
    itemsSubtotalCents: number,
    commissionCents: number,
  ) => ({
    plan,
    feeBasisPoints,
    completedCount,
    reversedCount,
    itemsSubtotalCents,
    deliveryFeeCents: 0,
    totalCents: itemsSubtotalCents,
    commissionCents,
  });

  it("estimates each month from its ledger: Flex fee on items, Pro monthly fee, no proration", async () => {
    const aug = await report("2026-08");
    assert.equal(aug.estimate, true);
    assert.equal(aug.timeZone, "America/Sao_Paulo");
    assert.deepEqual(aug.lines, [line("FLEX", 300, 3, 0, 12000, 360)]);
    assert.deepEqual(
      aug.subscriptions.map((period) => [period.plan, period.monthlyFeeCents]),
      [["FLEX", 0]],
    );
    assert.equal(aug.totals.estimatedCents, 360);

    const sep = await report("2026-09");
    assert.deepEqual(sep.lines, [line("PRO", 0, 1, 0, 4000, 0)]);
    assert.deepEqual(
      sep.subscriptions.map((period) => [period.plan, period.monthlyFeeCents]),
      [["PRO", 19900]],
      "Flex ended when September began",
    );
    assert.equal(sep.totals.estimatedCents, 19900);

    const empty = await report("2026-07");
    assert.deepEqual(empty.lines, []);
    assert.deepEqual(empty.subscriptions, []);
    assert.equal(empty.totals.estimatedCents, 0);
  });

  it("subtracts a reversal in the month it was made and is reproducible", async () => {
    const [entry] = await runInTenant(owner, store.id, (em) =>
      em.execute<{ id: string }[]>(
        "select id from billing_entries where order_id = ? and type = 'ORDER_COMPLETED'",
        [august[0]],
      ),
    );
    const before = await report("2026-08");
    await platform.reverseBillingEntry(
      store.id,
      entry!.id,
      "SALE_UNDONE",
      operatorId,
      sessionId,
      "",
      "",
    );
    assert.deepEqual(
      await report("2026-08"),
      before,
      "August keeps its estimate",
    );
    const current = await report();
    assert.equal(current.period, currentMonth());
    assert.deepEqual(await report(currentMonth()), current);
    assert.deepEqual(current.lines, [line("FLEX", 300, 0, 1, -4000, -120)]);
    assert.equal(current.totals.monthlyFeeCents, 19900);
    assert.equal(current.totals.estimatedCents, 19780);
  });

  it("refuses bad months, unknown stores and operators without MFA", async () => {
    for (const period of ["2026-13", "2026-8", "agosto"])
      await assert.rejects(report(period), apiCode("VALIDATION_FAILED"));
    await assert.rejects(
      platform.billingReport(
        "00000000-0000-4000-8000-000000000000",
        undefined,
        operatorId,
        sessionId,
      ),
      apiCode("TENANT_NOT_FOUND"),
    );
    const [plain] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_sessions (staff_user_id, mfa, refresh_token_hash, idle_expires_at) values (?, false, ?, now() + interval '1 hour') returning id",
        [operatorId, Buffer.alloc(32, 2)],
      );
    await assert.rejects(
      platform.billingReport(store.id, "2026-08", operatorId, plain!.id),
      apiCode("MFA_REQUIRED"),
    );
  });

  it("shows the OWNER the same estimate of their own store only", async () => {
    const token = await staff(store.id, "OWNER");
    const response = await ownerReport(token, "?period=2026-08");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(
      await json(response),
      JSON.parse(JSON.stringify(await report("2026-08"))),
    );
    const current = await json(await ownerReport(token));
    assert.equal(current.period, currentMonth());

    const otherToken = await staff(other.id, "OWNER");
    const theirs = await json(await ownerReport(otherToken, "?period=2026-08"));
    assert.deepEqual(theirs.lines, [line("FLEX", 300, 1, 0, 4000, 120)]);

    for (const query of ["?period=2026-13", "?period=2026-08&x=1", "?from=1"]) {
      const refused = await ownerReport(token, query);
      assert.equal(refused.status, 422, query);
    }
    const manager = await staff(store.id, "MANAGER");
    assert.equal((await ownerReport(manager, "?period=2026-08")).status, 403);
  });
});
