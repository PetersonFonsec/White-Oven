import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PlatformService } from "../src/platform/platform.service";
import { hashPassword } from "../src/auth/password";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import { ApiError } from "../src/errors/api-error";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import { insertTenant } from "./staff-fixtures";
import type { ApiConfig } from "../src/config/config";

const REQUEST_ID = "0a0b0c0d-1111-4222-8333-444455556666";

const apiCode = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;

/** Calendar parts of `date` as seen in `timeZone`. */
function zoned(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

describe("M6.1 plan subscriptions", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let app: Awaited<ReturnType<TestDatabase["connect"]>>;
  let platform: PlatformService;
  let operatorId: string;
  let sessionId: string;

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    app = await database.connect(database.appUrl);
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
        [operatorId, Buffer.alloc(32, 4)],
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
    };
    platform = new PlatformService(app, config);
  });

  after(async () => {
    await app?.close();
    await owner?.close();
    await database?.drop();
  });

  const changePlan = (tenantId: string, plan: string) =>
    platform.changeTenantPlan(
      tenantId,
      plan,
      operatorId,
      sessionId,
      REQUEST_ID,
      "127.0.0.1",
    );
  const history = (tenantId: string) =>
    platform.listPlanSubscriptions(tenantId, operatorId, sessionId);
  const auditActions = (tenantId: string) =>
    owner.em
      .getConnection()
      .execute<{ action: string }[]>(
        "select action from audit_events where tenant_id = ? and entity_type = 'plan_subscription' order by at, action",
        [tenantId],
      )
      .then((rows) => rows.map((row) => row.action));

  it("lists the plan catalog only to MFA operators", async () => {
    assert.deepEqual(await platform.listPlans(operatorId, sessionId), [
      { code: "FLEX", feeBasisPoints: 300, monthlyFeeCents: 0 },
      { code: "PRO", feeBasisPoints: 0, monthlyFeeCents: 19900 },
    ]);
    const [plainSession] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_sessions (staff_user_id, mfa, refresh_token_hash, idle_expires_at) values (?, false, ?, now() + interval '1 hour') returning id",
        [operatorId, Buffer.alloc(32, 5)],
      );
    assert.deepEqual(
      await platform.listPlans(operatorId, plainSession!.id),
      [],
    );
    await assert.rejects(
      platform.changeTenantPlan(
        await insertTenant(owner, "plan-no-mfa", "ONBOARDING"),
        "FLEX",
        operatorId,
        plainSession!.id,
        REQUEST_ID,
        "",
      ),
      apiCode("MFA_REQUIRED"),
    );
  });

  it("requires a current plan to activate and starts the first plan immediately", async () => {
    const tenantId = await insertTenant(owner, "plan-onboarding", "ONBOARDING");
    await assert.rejects(
      platform.changeTenantStatus(
        tenantId,
        "ACTIVE",
        operatorId,
        sessionId,
        REQUEST_ID,
        "",
      ),
      apiCode("PLAN_REQUIRED"),
    );
    const before = Date.now();
    const started = await changePlan(tenantId, "FLEX");
    assert.equal(started.plan, "FLEX");
    assert.equal(started.changed, true);
    assert.ok(
      Math.abs(new Date(started.validFrom).getTime() - before) < 10_000,
    );
    await platform.changeTenantStatus(
      tenantId,
      "ACTIVE",
      operatorId,
      sessionId,
      REQUEST_ID,
      "",
    );
    const [row] = await history(tenantId);
    assert.equal(row!.id, started.subscriptionId);
    assert.equal(row!.validTo, null);
    assert.deepEqual(await auditActions(tenantId), [
      "plan_subscription.started",
    ]);
  });

  it("schedules a change for the next month in the tenant's time zone with a value snapshot", async () => {
    const tenantId = await insertTenant(owner, "plan-change", "ONBOARDING");
    await owner.em
      .getConnection()
      .execute("update tenants set timezone = 'Asia/Tokyo' where id = ?", [
        tenantId,
      ]);
    const flex = await changePlan(tenantId, "FLEX");
    const pro = await changePlan(tenantId, "PRO");
    assert.equal(pro.changed, true);
    const startsAt = new Date(pro.validFrom);
    assert.ok(startsAt.getTime() > Date.now());
    const local = zoned(startsAt, "Asia/Tokyo");
    const today = zoned(new Date(), "Asia/Tokyo");
    assert.equal(local.day, 1);
    assert.equal(local.time, "00:00:00");
    assert.equal(local.month, (today.month % 12) + 1);
    assert.equal(local.year, today.month === 12 ? today.year + 1 : today.year);

    const periods = await history(tenantId);
    assert.deepEqual(
      periods.map((p) => [p.code, p.feeBasisPoints, p.monthlyFeeCents]),
      [
        ["PRO", 0, 19900],
        ["FLEX", 300, 0],
      ],
    );
    assert.equal(
      new Date(periods[1]!.validTo!).getTime(),
      new Date(periods[0]!.validFrom).getTime(),
    );
    const listed = (await platform.listTenants(operatorId, sessionId)).find(
      (t) => t.id === tenantId,
    )!;
    assert.equal(listed.plan?.code, "FLEX");
    assert.equal(listed.scheduledPlan?.code, "PRO");

    // The catalog changes later; recorded periods keep the values they were created with.
    await owner.em
      .getConnection()
      .execute("update plans set monthly_fee_cents = 24900 where code = 'PRO'");
    try {
      const again = await changePlan(tenantId, "PRO");
      assert.deepEqual(again, { ...pro, changed: false });
      assert.equal((await history(tenantId))[0]!.monthlyFeeCents, 19900);
    } finally {
      await owner.em
        .getConnection()
        .execute(
          "update plans set monthly_fee_cents = 19900 where code = 'PRO'",
        );
    }
    assert.equal(flex.plan, "FLEX");
  });

  it("cancels or replaces a scheduled change without touching effective periods", async () => {
    const tenantId = await insertTenant(owner, "plan-cancel", "ONBOARDING");
    const flex = await changePlan(tenantId, "FLEX");
    const pro = await changePlan(tenantId, "PRO");
    const back = await changePlan(tenantId, "FLEX");
    assert.deepEqual(back, { ...flex, changed: true });
    const periods = await history(tenantId);
    assert.equal(periods.length, 1);
    assert.equal(periods[0]!.validTo, null);
    const unchanged = await changePlan(tenantId, "FLEX");
    assert.equal(unchanged.changed, false);
    assert.deepEqual(await auditActions(tenantId), [
      "plan_subscription.started",
      "plan_subscription.change_scheduled",
      "plan_subscription.change_cancelled",
    ]);
    const [cancelled] = await owner.em
      .getConnection()
      .execute<{ entityId: string }[]>(
        "select entity_id as \"entityId\" from audit_events where tenant_id = ? and action = 'plan_subscription.change_cancelled'",
        [tenantId],
      );
    assert.equal(cancelled!.entityId, pro.subscriptionId);
  });

  it("never lets periods of a tenant overlap and keeps writes behind the operator functions", async () => {
    const tenantId = await insertTenant(owner, "plan-overlap", "ONBOARDING");
    await changePlan(tenantId, "FLEX");
    await assert.rejects(
      runInTenant(owner, tenantId, (em) =>
        em.execute(
          "insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from, valid_to) values (?, 'PRO', 0, 19900, now() - interval '1 day', now() + interval '1 day')",
          [tenantId],
        ),
      ),
      (error: { code?: string }) => error.code === "23P01",
    );
    await assert.rejects(
      runInTenant(owner, tenantId, (em) =>
        em.execute(
          "insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from, valid_to) values (?, 'PRO', 0, 19900, now(), now())",
          [tenantId],
        ),
      ),
      (error: { code?: string }) => error.code === "23514",
    );
    for (const statement of [
      "insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from) values (?, 'PRO', 0, 0, now() + interval '1 year')",
      "update plan_subscriptions set fee_basis_points = 0 where tenant_id = ?",
      "delete from plan_subscriptions where tenant_id = ?",
    ])
      await assert.rejects(
        runInTenant(app, tenantId, (em) => em.execute(statement, [tenantId])),
        (error: { code?: string }) => error.code === "42501",
        statement,
      );
    await assert.rejects(
      app.em.getConnection().execute("select * from plans"),
      (error: { code?: string }) => error.code === "42501",
    );
    const visible = await runInTenant(app, tenantId, (em) =>
      em.execute<{ plan: string }[]>("select plan from plan_subscriptions"),
    );
    assert.deepEqual(visible, [{ plan: "FLEX" }]);
  });

  it("rejects unknown plans, malformed ids, missing and closed tenants", async () => {
    const tenantId = await insertTenant(owner, "plan-invalid", "ONBOARDING");
    await assert.rejects(
      changePlan(tenantId, "GOLD"),
      apiCode("VALIDATION_FAILED"),
    );
    await assert.rejects(
      changePlan("not-a-uuid", "FLEX"),
      apiCode("VALIDATION_FAILED"),
    );
    await assert.rejects(
      changePlan("00000000-0000-4000-8000-000000000000", "FLEX"),
      apiCode("TENANT_NOT_FOUND"),
    );
    await assert.rejects(
      history("00000000-0000-4000-8000-000000000000"),
      apiCode("TENANT_NOT_FOUND"),
    );
    const closed = await insertTenant(owner, "plan-closed", "CLOSED");
    await assert.rejects(
      changePlan(closed, "PRO"),
      apiCode("TENANT_STATUS_CONFLICT"),
    );
  });

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  /** Periods of a tenant, oldest first, read as the owner under the tenant context. */
  const periodsOf = (tenantId: string) =>
    runInTenant(owner, tenantId, (em) =>
      em.execute<
        { id: string; plan: string; validFrom: Date; validTo: Date | null }[]
      >(
        'select id, plan, valid_from as "validFrom", valid_to as "validTo" from plan_subscriptions order by valid_from',
      ),
    );
  const assertContiguous = (
    periods: { validFrom: Date; validTo: Date | null }[],
  ) => {
    for (let index = 1; index < periods.length; index++)
      assert.ok(
        periods[index - 1]!.validTo !== null &&
          new Date(periods[index - 1]!.validTo!).getTime() <=
            new Date(periods[index]!.validFrom).getTime(),
        "periods overlap",
      );
  };
  const auditChanges = (tenantId: string, action: string) =>
    owner.em
      .getConnection()
      .execute<{ entityId: string; changes: Record<string, unknown> }[]>(
        'select entity_id as "entityId", changes from audit_events where tenant_id = ? and action = ? order by at',
        [tenantId, action],
      );
  /** Calls the database function directly, for plans outside the API's fixed list. */
  const changePlanSql = (tenantId: string, plan: string) =>
    app.em
      .fork()
      .transactional((em) =>
        em.execute<{ id: string; changed: boolean }[]>(
          "select id, changed from whiteoven_change_tenant_plan(?, ?, ?, ?, null, ?::uuid)",
          [tenantId, plan, operatorId, sessionId, REQUEST_ID],
        ),
      )
      .then(([row]) => row!);

  it("fills the gap before a scheduled period when no plan is current, without overlapping it", async () => {
    const tenantId = await insertTenant(owner, "plan-gap", "ONBOARDING");
    const [future] = await runInTenant(owner, tenantId, (em) =>
      em.execute<{ id: string; validFrom: Date }[]>(
        `insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from)
         values (?, 'PRO', 0, 19900, date_trunc('month', now()) + interval '1 month')
         returning id, valid_from as "validFrom"`,
        [tenantId],
      ),
    );
    const started = await changePlan(tenantId, "FLEX");
    assert.equal(started.changed, true);
    assert.ok(
      Math.abs(new Date(started.validFrom).getTime() - Date.now()) < 10_000,
    );
    const periods = await periodsOf(tenantId);
    assert.deepEqual(
      periods.map((p) => p.plan),
      ["FLEX", "PRO"],
    );
    assert.equal(
      new Date(periods[0]!.validTo!).getTime(),
      new Date(future!.validFrom).getTime(),
    );
    assert.equal(periods[1]!.id, future!.id);
    const [audit] = await auditChanges(tenantId, "plan_subscription.started");
    assert.equal(
      new Date(audit!.changes.validTo as string).getTime(),
      new Date(future!.validFrom).getTime(),
    );
    const listed = (await platform.listTenants(operatorId, sessionId)).find(
      (t) => t.id === tenantId,
    )!;
    assert.equal(listed.plan?.code, "FLEX");
    assert.equal(listed.scheduledPlan?.code, "PRO");
    assert.equal(listed.timeZone, "America/Sao_Paulo");
    // Asking for the scheduled plan again is a no-op.
    const again = await changePlan(tenantId, "PRO");
    assert.deepEqual(
      { id: again.subscriptionId, changed: again.changed },
      { id: future!.id, changed: false },
    );
    await platform.changeTenantStatus(
      tenantId,
      "ACTIVE",
      operatorId,
      sessionId,
      REQUEST_ID,
      "",
    );
  });

  it("refuses with a domain error when more than one period is scheduled", async () => {
    const tenantId = await insertTenant(owner, "plan-two-future", "ONBOARDING");
    await runInTenant(owner, tenantId, (em) =>
      em.execute(
        `insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from, valid_to) values
           (?, 'PRO', 0, 19900, now() + interval '10 days', now() + interval '20 days'),
           (?, 'FLEX', 300, 0, now() + interval '20 days', null)`,
        [tenantId, tenantId],
      ),
    );
    await assert.rejects(
      changePlan(tenantId, "FLEX"),
      apiCode("PLAN_SCHEDULE_CONFLICT"),
    );
    assert.equal((await periodsOf(tenantId)).length, 2);
    assert.deepEqual(await auditActions(tenantId), []);
  });

  it("treats a scheduled period that has just started as the current plan", async () => {
    const tenantId = await insertTenant(owner, "plan-started", "ONBOARDING");
    await changePlan(tenantId, "FLEX");
    const pro = await changePlan(tenantId, "PRO");
    // Move the month boundary into the past: shrink the current period, then extend the next.
    await runInTenant(owner, tenantId, (em) =>
      em.execute(
        `update plan_subscriptions set valid_from = now() - interval '1 day', valid_to = now() - interval '1 second' where plan = 'FLEX';
         update plan_subscriptions set valid_from = now() - interval '1 second' where plan = 'PRO';`,
      ),
    );
    const listed = (await platform.listTenants(operatorId, sessionId)).find(
      (t) => t.id === tenantId,
    )!;
    assert.equal(listed.plan?.code, "PRO");
    assert.equal(listed.scheduledPlan, null);
    const same = await changePlan(tenantId, "PRO");
    assert.deepEqual(
      { id: same.subscriptionId, changed: same.changed },
      { id: pro.subscriptionId, changed: false },
    );
    const flex = await changePlan(tenantId, "FLEX");
    assert.equal(flex.changed, true);
    assert.ok(new Date(flex.validFrom).getTime() > Date.now());
    const periods = await periodsOf(tenantId);
    assert.deepEqual(
      periods.map((p) => p.plan),
      ["FLEX", "PRO", "FLEX"],
    );
    assertContiguous(periods);
  });

  it("serializes concurrent changes: a call that waited for the lock sees the period started meanwhile", async () => {
    const tenantId = await insertTenant(owner, "plan-concurrent", "ONBOARDING");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // B's transaction (and its now()) starts first; A takes the tenant lock and starts FLEX
    // while B waits for it. B must then schedule PRO instead of starting an overlapping period.
    const late = app.em.fork().transactional(async (em) => {
      await em.execute("select 1");
      await sleep(100);
      return em.execute<{ plan: string; changed: boolean }[]>(
        "select plan, changed from whiteoven_change_tenant_plan(?, 'PRO', ?, ?, null, null)",
        [tenantId, operatorId, sessionId],
      );
    });
    const early = sleep(30).then(() =>
      app.em.fork().transactional(async (em) => {
        await em.execute(
          "select * from whiteoven_change_tenant_plan(?, 'FLEX', ?, ?, null, null)",
          [tenantId, operatorId, sessionId],
        );
        await sleep(250);
        release();
      }),
    );
    await Promise.all([early, late, held]);
    const periods = await periodsOf(tenantId);
    assert.deepEqual(
      periods.map((p) => p.plan),
      ["FLEX", "PRO"],
    );
    assertContiguous(periods);

    // Many concurrent requests in both directions leave one current period and no overlap.
    await Promise.all(
      ["FLEX", "PRO", "FLEX", "PRO", "PRO", "FLEX"].map((plan) =>
        changePlan(tenantId, plan),
      ),
    );
    const after = await periodsOf(tenantId);
    assertContiguous(after);
    assert.equal(
      after.filter(
        (p) =>
          new Date(p.validFrom).getTime() <= Date.now() &&
          (p.validTo === null || new Date(p.validTo).getTime() > Date.now()),
      ).length,
      1,
    );
  });

  it("keeps an ACTIVE tenant with a current plan through every change", async () => {
    const tenantId = await insertTenant(owner, "plan-active", "ONBOARDING");
    await changePlan(tenantId, "FLEX");
    await platform.changeTenantStatus(
      tenantId,
      "ACTIVE",
      operatorId,
      sessionId,
      REQUEST_ID,
      "",
    );
    for (const plan of ["PRO", "FLEX", "PRO", "PRO", "FLEX", "FLEX"]) {
      await changePlan(tenantId, plan);
      const [current] = await runInTenant(owner, tenantId, (em) =>
        em.execute<{ count: number }[]>(
          "select count(*)::int as count from plan_subscriptions where valid_from <= now() and (valid_to is null or valid_to > now())",
        ),
      );
      assert.equal(current!.count, 1, plan);
    }
  });

  it("links a replaced schedule to its replacement in the audit trail and writes nothing on no-ops", async () => {
    const tenantId = await insertTenant(owner, "plan-replace", "ONBOARDING");
    // A third plan exists only in this test, so a schedule can be replaced by a different plan
    // than the current one (with FLEX and PRO only, the alternative is always a revert).
    await owner.em.getConnection().execute(`
      alter table plans drop constraint plans_code_valid;
      insert into plans (code, fee_basis_points, monthly_fee_cents) values ('TEST', 150, 9900);
    `);
    try {
      await changePlan(tenantId, "FLEX");
      const pro = await changePlan(tenantId, "PRO");
      const proAgain = await changePlan(tenantId, "PRO");
      assert.equal(proAgain.changed, false);
      const replacement = await changePlanSql(tenantId, "TEST");
      assert.equal(replacement.changed, true);
      assert.equal(
        (await changePlanSql(tenantId, "TEST")).changed,
        false,
        "repeating the replacement is a no-op",
      );
      const scheduled = await auditChanges(
        tenantId,
        "plan_subscription.change_scheduled",
      );
      assert.equal(scheduled.length, 2);
      assert.equal(scheduled[0]!.entityId, pro.subscriptionId);
      assert.equal(scheduled[0]!.changes.replacesSubscriptionId, null);
      assert.equal(scheduled[1]!.entityId, replacement.id);
      assert.equal(
        scheduled[1]!.changes.replacesSubscriptionId,
        pro.subscriptionId,
      );
      assert.deepEqual(scheduled[1]!.changes.plan, {
        from: "FLEX",
        to: "TEST",
      });
      const [cancelled] = await auditChanges(
        tenantId,
        "plan_subscription.change_cancelled",
      );
      assert.equal(cancelled!.entityId, pro.subscriptionId);
      assert.equal(cancelled!.changes.reason, "REPLACED");
      assert.equal(cancelled!.changes.replacedBySubscriptionId, replacement.id);

      // Reverting to the current plan cancels without a replacement.
      await changePlan(tenantId, "FLEX");
      const cancellations = await auditChanges(
        tenantId,
        "plan_subscription.change_cancelled",
      );
      assert.equal(cancellations.length, 2);
      assert.equal(cancellations[1]!.entityId, replacement.id);
      assert.equal(cancellations[1]!.changes.reason, "REVERTED");
      assert.equal(cancellations[1]!.changes.replacedBySubscriptionId, null);
      const before = (await auditActions(tenantId)).length;
      assert.equal((await changePlan(tenantId, "FLEX")).changed, false);
      assert.equal((await auditActions(tenantId)).length, before);
      for (const { changes } of [...scheduled, ...cancellations])
        assert.ok(
          !JSON.stringify(changes).includes("@"),
          "no personal data in audit changes",
        );
    } finally {
      await runInTenant(owner, tenantId, (em) =>
        em.execute("delete from plan_subscriptions where plan = 'TEST'"),
      );
      await owner.em.getConnection().execute(`
        delete from plans where code = 'TEST';
        alter table plans add constraint plans_code_valid check (code in ('FLEX', 'PRO'));
      `);
    }
  });

  it("rolls back the plan change and its audit together when the transaction fails", async () => {
    const tenantId = await insertTenant(owner, "plan-rollback", "ONBOARDING");
    await assert.rejects(
      app.em.fork().transactional(async (em) => {
        await em.execute(
          "select * from whiteoven_change_tenant_plan(?, 'FLEX', ?, ?, null, null)",
          [tenantId, operatorId, sessionId],
        );
        throw new Error("fail after the change");
      }),
      /fail after the change/,
    );
    assert.deepEqual(await periodsOf(tenantId), []);
    assert.deepEqual(await auditActions(tenantId), []);
  });
});
