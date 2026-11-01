import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PlatformService } from "../src/platform/platform.service";
import { hashPassword } from "../src/auth/password";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import { ApiError } from "../src/errors/api-error";
import {
  createTestDatabase,
  databaseSuite,
  migrateTestDatabase,
  type TestDatabase,
} from "./postgres";
import { insertTenant } from "./staff-fixtures";
import { insertOrder } from "./order-fixtures";
import type { ApiConfig } from "../src/config/config";

const REQUEST_ID = "0a0b0c0d-2222-4333-8444-555566667777";

const apiCode = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;
const sqlCode = (code: string) => (error: unknown) =>
  (error as { code?: unknown } | null)?.code === code;

/** `YYYY-MM` of now in `timeZone`. */
function monthIn(timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}`;
}

describe("M6.2 billing ledger", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let app: Awaited<ReturnType<TestDatabase["connect"]>>;
  let platform: PlatformService;
  let operatorId: string;
  let sessionId: string;
  let storeA: string;
  let storeB: string;

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
        [operatorId, Buffer.alloc(32, 6)],
      );
    sessionId = session!.id;
    const config: ApiConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "error",
      openApiEnabled: false,
      imageStorageDirectory: ".data/images",
      database: { url: database.appUrl, poolMax: 4 },
      auth: {
        accessTokenPrivateKey: null,
        mfaEncryptionKey: null,
        ownerInviteSecret: Buffer.alloc(32, 9),
        adminOrigins: ["https://admin.example.test"],
      },
      push: { delivery: "disabled", expoAccessToken: null },
      trustedProxies: [],
      metricsToken: null,
    };
    platform = new PlatformService(app, config);
    storeA = await insertTenant(owner, "ledger-a");
    storeB = await insertTenant(owner, "ledger-b");
  });

  after(async () => {
    await app?.close();
    await owner?.close();
    await database?.drop();
  });

  /**
   * A pickup order of R$ 40,00 moved to COMPLETED with its history row, as the order service
   * writes them; `at` backdates the completion (only the owner can set it).
   */
  const completeOrder = async (tenantId: string, at?: string) => {
    const order = await insertOrder(owner, tenantId);
    await runInTenant(owner, tenantId, async (em) => {
      await em.execute(
        `insert into order_status_changes (tenant_id, order_id, from_status, to_status, actor_type, at)
         values (?, ?, 'READY', 'COMPLETED', 'SYSTEM', coalesce(?::timestamptz, now()))`,
        [tenantId, order.id, at ?? null],
      );
      await em.execute("update orders set status = 'COMPLETED' where id = ?", [
        order.id,
      ]);
    });
    return order.id;
  };
  const record = (tenantId: string, orderId: string) =>
    runInTenant(app, tenantId, (em) =>
      em.execute("select whiteoven_record_order_completion(?)", [orderId]),
    );
  /** A completed order recorded in the ledger, as the order service does. */
  const completedOrder = async (tenantId: string) => {
    const orderId = await completeOrder(tenantId);
    await record(tenantId, orderId);
    return orderId;
  };
  const entriesOf = (tenantId: string, orderId: string) =>
    runInTenant(owner, tenantId, (em) =>
      em.execute<
        {
          id: string;
          type: string;
          plan: string;
          feeBasisPoints: number;
          subscriptionId: string;
          period: string;
          totalCents: number;
          itemsSubtotalCents: number;
          reversesEntryId: string | null;
          reasonCode: string | null;
          createdBy: string | null;
        }[]
      >(
        `select id, type, plan, fee_basis_points as "feeBasisPoints", subscription_id as "subscriptionId",
                period, total_cents as "totalCents", items_subtotal_cents as "itemsSubtotalCents",
                reverses_entry_id as "reversesEntryId", reason_code as "reasonCode", created_by as "createdBy"
           from billing_entries where order_id = ? order by occurred_at, type`,
        [orderId],
      ),
    );
  const reverse = (
    tenantId: string,
    entryId: string,
    reason = "COMPLETED_BY_MISTAKE",
    session = sessionId,
  ) =>
    platform.reverseBillingEntry(
      tenantId,
      entryId,
      reason,
      operatorId,
      session,
      REQUEST_ID,
      "127.0.0.1",
    );

  it("snapshots the current plan and the store's month on each completion, once", async () => {
    const orderId = await completedOrder(storeA);
    await runInTenant(app, storeA, (em) =>
      em.execute("select whiteoven_record_order_completion(?)", [orderId]),
    );
    const [subscription] = await runInTenant(owner, storeA, (em) =>
      em.execute<{ id: string }[]>(
        "select id from plan_subscriptions where valid_to is null",
      ),
    );
    const entries = await entriesOf(storeA, orderId);
    assert.equal(entries.length, 1, "a retried completion records nothing");
    assert.deepEqual(
      { ...entries[0], id: undefined },
      {
        id: undefined,
        type: "ORDER_COMPLETED",
        plan: "FLEX",
        feeBasisPoints: 300,
        subscriptionId: subscription!.id,
        period: monthIn("America/Sao_Paulo"),
        totalCents: 4000,
        itemsSubtotalCents: 4000,
        reversesEntryId: null,
        reasonCode: null,
        createdBy: null,
      },
    );
  });

  it("refuses to record an order that is not completed or a store without a plan", async () => {
    const placed = await insertOrder(owner, storeA);
    await assert.rejects(
      runInTenant(app, storeA, (em) =>
        em.execute("select whiteoven_record_order_completion(?)", [placed.id]),
      ),
      sqlCode("22023"),
    );
    const noPlan = await insertTenant(owner, "ledger-no-plan", "ONBOARDING");
    const order = { id: await completeOrder(noPlan) };
    await assert.rejects(record(noPlan, order.id), sqlCode("P0005"));
    assert.deepEqual(await entriesOf(noPlan, order.id), []);
  });

  it("keeps the ledger append-only for the app and for the owner", async () => {
    const orderId = await completedOrder(storeA);
    const asApp = (query: string, params: unknown[] = []) =>
      runInTenant(app, storeA, (em) => em.execute(query, params));
    for (const query of [
      `insert into billing_entries (tenant_id, order_id, type, items_subtotal_cents, delivery_fee_cents,
         total_cents, payment_method, paid_online, period)
       values (current_setting('app.tenant_id')::uuid, ?, 'ORDER_REVERSED', -1, 0, -1, 'CASH', false, '2026-10')`,
      "update billing_entries set total_cents = 1 where order_id = ?",
      "delete from billing_entries where order_id = ?",
    ])
      await assert.rejects(asApp(query, [orderId]), sqlCode("42501"), query);
    const asOwner = (query: string) =>
      runInTenant(owner, storeA, (em) => em.execute(query, [orderId]));
    await assert.rejects(
      asOwner("update billing_entries set total_cents = 1 where order_id = ?"),
      sqlCode("42501"),
    );
    await assert.rejects(
      asOwner("delete from billing_entries where order_id = ?"),
      sqlCode("42501"),
    );
    await assert.rejects(
      owner.em.getConnection().execute("truncate billing_entries cascade"),
      sqlCode("42501"),
    );
    assert.equal((await entriesOf(storeA, orderId)).length, 1);
  });

  it("dates the entry by the completion: its plan and store month, even when recorded late", async () => {
    // Flex until 1 Oct 2026 00:00 in São Paulo, Pro since: Pro is the current plan now.
    const store = await insertTenant(owner, "ledger-history", "ONBOARDING");
    await runInTenant(owner, store, (em) =>
      em.execute(
        `insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from, valid_to)
         values (?, 'FLEX', 300, 0, '2025-01-01T03:00:00Z', '2026-10-01T03:00:00Z'),
                (?, 'PRO', 0, 19900, '2026-10-01T03:00:00Z', null)`,
        [store, store],
      ),
    );
    const cases = [
      // 31 Dec 2025 23:30 and 1 Jan 2026 00:30 in São Paulo: the year turns in the store's zone.
      { at: "2026-01-01T02:30:00Z", plan: "FLEX", period: "2025-12" },
      { at: "2026-01-01T03:30:00Z", plan: "FLEX", period: "2026-01" },
      // The last Flex second and the first Pro instant, at the store's month turn.
      { at: "2026-10-01T02:59:59Z", plan: "FLEX", period: "2026-09" },
      { at: "2026-10-01T03:00:00Z", plan: "PRO", period: "2026-10" },
    ];
    for (const expected of cases) {
      const orderId = await completeOrder(store, expected.at);
      // Recorded now, under Pro: the entry still follows the completion.
      await record(store, orderId);
      const [entry] = await runInTenant(owner, store, (em) =>
        em.execute<
          {
            plan: string;
            feeBasisPoints: number;
            period: string;
            atCompletion: boolean;
          }[]
        >(
          `select plan, fee_basis_points as "feeBasisPoints", period, occurred_at = ?::timestamptz as "atCompletion"
             from billing_entries where order_id = ?`,
          [expected.at, orderId],
        ),
      );
      assert.deepEqual(
        entry,
        {
          plan: expected.plan,
          feeBasisPoints: expected.plan === "FLEX" ? 300 : 0,
          period: expected.period,
          atCompletion: true,
        },
        expected.at,
      );
    }

    // Completed before any plan period: refused, not given today's Pro.
    const beforePlans = await completeOrder(store, "2024-12-31T12:00:00Z");
    await assert.rejects(record(store, beforePlans), sqlCode("P0005"));
    assert.deepEqual(await entriesOf(store, beforePlans), []);
  });

  it("never changes an entry: retries, later plan changes and concurrent calls record it once", async () => {
    const store = await insertTenant(owner, "ledger-retry", "ONBOARDING");
    const flex = await runInTenant(owner, store, (em) =>
      em.execute<{ id: string }[]>(
        `insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from, valid_to)
         values (?, 'FLEX', 300, 0, now() - interval '2 days', now() - interval '1 day') returning id`,
        [store],
      ),
    );
    const orderId = await completeOrder(
      store,
      new Date(Date.now() - 36 * 3600_000).toISOString(),
    );
    await record(store, orderId);
    const [first] = await entriesOf(store, orderId);
    assert.equal(first!.subscriptionId, flex[0]!.id);
    // The store moves to Pro afterwards; the completion is recorded again, twice at once.
    await runInTenant(owner, store, (em) =>
      em.execute(
        `insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from)
         values (?, 'PRO', 0, 19900, now() - interval '1 day')`,
        [store],
      ),
    );
    await record(store, orderId);
    await Promise.all([record(store, orderId), record(store, orderId)]);
    assert.deepEqual(await entriesOf(store, orderId), [first]);

    // Another completed order recorded by two transactions at once: one entry.
    const concurrent = await completeOrder(store);
    await Promise.all([record(store, concurrent), record(store, concurrent)]);
    const entries = await entriesOf(store, concurrent);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.plan, "PRO");
  });

  it("records only the store's own completed orders and dates them by the database", async () => {
    const other = await completeOrder(storeB);
    await assert.rejects(record(storeA, other), sqlCode("22023"));
    assert.deepEqual(await entriesOf(storeB, other), []);

    const order = await insertOrder(owner, storeA);
    await assert.rejects(
      runInTenant(app, storeA, (em) =>
        em.execute(
          `insert into order_status_changes (tenant_id, order_id, from_status, to_status, actor_type, at)
           values (current_setting('app.tenant_id')::uuid, ?, 'READY', 'COMPLETED', 'SYSTEM', '2020-01-01')`,
          [order.id],
        ),
      ),
      sqlCode("42501"),
      "the app role cannot choose the completion time",
    );
    // A completed order without its COMPLETED history row has no completion instant.
    await runInTenant(owner, storeA, (em) =>
      em.execute("update orders set status = 'COMPLETED' where id = ?", [
        order.id,
      ]),
    );
    await assert.rejects(record(storeA, order.id), sqlCode("22023"));
  });

  it("reverses a completed order with negated values and the original plan, once, with an audit", async () => {
    const orderId = await completedOrder(storeA);
    const [original] = await entriesOf(storeA, orderId);
    const reversal = await reverse(storeA, original!.id, "SALE_UNDONE");
    assert.equal(reversal.changed, true);
    const again = await reverse(storeA, original!.id, "COMPLETED_BY_MISTAKE");
    assert.deepEqual(again, { entryId: reversal.entryId, changed: false });

    const entries = await entriesOf(storeA, orderId);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], original, "the original entry never changes");
    assert.deepEqual(
      { ...entries[1] },
      {
        id: reversal.entryId,
        type: "ORDER_REVERSED",
        plan: "FLEX",
        feeBasisPoints: 300,
        subscriptionId: original!.subscriptionId,
        period: monthIn("America/Sao_Paulo"),
        totalCents: -4000,
        itemsSubtotalCents: -4000,
        reversesEntryId: original!.id,
        reasonCode: "SALE_UNDONE",
        createdBy: operatorId,
      },
    );
    const [order] = await runInTenant(owner, storeA, (em) =>
      em.execute<{ status: string }[]>(
        "select status from orders where id = ?",
        [orderId],
      ),
    );
    assert.equal(order!.status, "COMPLETED", "the order itself is untouched");
    const audits = await owner.em
      .getConnection()
      .execute<{ actorType: string; actorId: string; changes: unknown }[]>(
        `select actor_type as "actorType", actor_id as "actorId", changes from audit_events
          where tenant_id = ? and action = 'billing_entry.reversed' and entity_id = ?`,
        [storeA, reversal.entryId],
      );
    assert.deepEqual(audits, [
      {
        actorType: "OPERATOR",
        actorId: operatorId,
        changes: {
          reversesEntryId: original!.id,
          orderId,
          reasonCode: "SALE_UNDONE",
          totalCents: -4000,
          period: monthIn("America/Sao_Paulo"),
        },
      },
    ]);
  });

  it("serializes concurrent reversals of the same entry", async () => {
    const orderId = await completedOrder(storeA);
    const [original] = await entriesOf(storeA, orderId);
    const results = await Promise.all([
      reverse(storeA, original!.id),
      reverse(storeA, original!.id),
      reverse(storeA, original!.id),
    ]);
    assert.deepEqual(results.map((result) => result.changed).sort(), [
      false,
      false,
      true,
    ]);
    assert.equal(new Set(results.map((result) => result.entryId)).size, 1);
    assert.equal((await entriesOf(storeA, orderId)).length, 2);
  });

  it("only reverses a completed order's entry of the named store, for MFA operators", async () => {
    const orderId = await completedOrder(storeA);
    const [original] = await entriesOf(storeA, orderId);
    const reversal = await reverse(storeA, original!.id);
    await assert.rejects(
      reverse(storeA, reversal.entryId),
      apiCode("BILLING_ENTRY_NOT_FOUND"),
      "a reversal is not reversed",
    );
    const other = await completedOrder(storeB);
    const [otherEntry] = await entriesOf(storeB, other);
    await assert.rejects(
      reverse(storeA, otherEntry!.id),
      apiCode("BILLING_ENTRY_NOT_FOUND"),
      "another store's entry",
    );
    await assert.rejects(
      reverse(storeA, "00000000-0000-4000-8000-000000000000"),
      apiCode("BILLING_ENTRY_NOT_FOUND"),
    );
    await assert.rejects(
      reverse("00000000-0000-4000-8000-000000000000", otherEntry!.id),
      apiCode("TENANT_NOT_FOUND"),
    );
    for (const reason of ["", "OTHER", "completed_by_mistake"])
      await assert.rejects(
        reverse(storeB, otherEntry!.id, reason),
        apiCode("VALIDATION_FAILED"),
        reason,
      );
    await assert.rejects(
      runInTenant(app, storeB, (em) =>
        em.execute(
          "select * from whiteoven_reverse_billing_entry(?, ?, 'OTHER', ?, ?, null, null)",
          [storeB, otherEntry!.id, operatorId, sessionId],
        ),
      ),
      sqlCode("22023"),
      "the database refuses an unknown reason too",
    );
    const [plainSession] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_sessions (staff_user_id, mfa, refresh_token_hash, idle_expires_at) values (?, false, ?, now() + interval '1 hour') returning id",
        [operatorId, Buffer.alloc(32, 7)],
      );
    await assert.rejects(
      reverse(storeB, otherEntry!.id, "SALE_UNDONE", plainSession!.id),
      apiCode("MFA_REQUIRED"),
    );
    await assert.rejects(
      platform.listBillingEntries(
        storeB,
        undefined,
        operatorId,
        plainSession!.id,
      ),
      apiCode("MFA_REQUIRED"),
    );
    assert.equal((await entriesOf(storeB, other)).length, 1);
  });

  it("refuses in the database a reversal that does not mirror a completed entry", async () => {
    const orderId = await completedOrder(storeA);
    const [original] = await entriesOf(storeA, orderId);
    const otherOrder = await completedOrder(storeA);
    /** A direct reversal insert by the owner, mirroring `original` unless overridden. */
    const insertReversal = (
      overrides: Record<string, unknown> = {},
      tenantId = storeA,
    ) => {
      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        order_id: orderId,
        type: "ORDER_REVERSED",
        items_subtotal_cents: -4000,
        delivery_fee_cents: 0,
        total_cents: -4000,
        payment_method: "CASH",
        paid_online: false,
        period: original!.period,
        plan: original!.plan,
        fee_basis_points: original!.feeBasisPoints,
        subscription_id: original!.subscriptionId,
        reverses_entry_id: original!.id,
        reason_code: "SALE_UNDONE",
        created_by: operatorId,
        ...overrides,
      };
      const columns = Object.keys(row);
      return runInTenant(owner, tenantId, (em) =>
        em.execute(
          `insert into billing_entries (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
          Object.values(row),
        ),
      );
    };
    for (const [label, overrides] of [
      ["another order", { order_id: otherOrder }],
      [
        "different components",
        {
          items_subtotal_cents: -3999,
          total_cents: -3999,
        },
      ],
      ["another payment method", { payment_method: "PIX_ON_DELIVERY" }],
      ["another plan", { plan: "PRO", fee_basis_points: 0 }],
      ["another fee", { fee_basis_points: 299 }],
    ] as const)
      await assert.rejects(insertReversal(overrides), sqlCode("23514"), label);
    // The store has a single plan period, so the other subscription comes from another store.
    const [foreignEntry] = await entriesOf(
      storeB,
      await completedOrder(storeB),
    );
    await assert.rejects(
      insertReversal({ subscription_id: foreignEntry!.subscriptionId }),
      sqlCode("23514"),
      "another subscription",
    );

    const reversal = await reverse(storeA, original!.id);
    await assert.rejects(
      insertReversal({ reverses_entry_id: reversal.entryId }),
      sqlCode("23514"),
      "a reversal of a reversal",
    );
    await assert.rejects(
      insertReversal(),
      sqlCode("23505"),
      "a second reversal of the same entry",
    );
    const foreign = await completedOrder(storeB);
    await assert.rejects(
      insertReversal({ order_id: foreign }, storeB),
      sqlCode("23514"),
      "a reversal pointing at another store's entry",
    );
    assert.equal((await entriesOf(storeA, orderId)).length, 2);
  });

  it("lists one month of a store's ledger with the reversal linked to its entry", async () => {
    const store = await insertTenant(owner, "ledger-list");
    const orderId = await completedOrder(store);
    const [original] = await entriesOf(store, orderId);
    const reversal = await reverse(store, original!.id, "SALE_UNDONE");
    await completedOrder(storeB);

    const month = monthIn("America/Sao_Paulo");
    const entries = await platform.listBillingEntries(
      store,
      undefined,
      operatorId,
      sessionId,
    );
    assert.deepEqual(
      entries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        orderId: entry.orderId,
        orderNumber: entry.orderNumber,
        plan: entry.plan,
        feeBasisPoints: entry.feeBasisPoints,
        totalCents: entry.totalCents,
        period: entry.period,
        reversesEntryId: entry.reversesEntryId,
        reasonCode: entry.reasonCode,
        reversedByEntryId: entry.reversedByEntryId,
      })),
      [
        {
          id: original!.id,
          type: "ORDER_COMPLETED",
          orderId,
          orderNumber: 1,
          plan: "FLEX",
          feeBasisPoints: 300,
          totalCents: 4000,
          period: month,
          reversesEntryId: null,
          reasonCode: null,
          reversedByEntryId: reversal.entryId,
        },
        {
          id: reversal.entryId,
          type: "ORDER_REVERSED",
          orderId,
          orderNumber: 1,
          plan: "FLEX",
          feeBasisPoints: 300,
          totalCents: -4000,
          period: month,
          reversesEntryId: original!.id,
          reasonCode: "SALE_UNDONE",
          reversedByEntryId: null,
        },
      ],
    );
    assert.deepEqual(
      await platform.listBillingEntries(store, month, operatorId, sessionId),
      entries,
    );
    assert.deepEqual(
      await platform.listBillingEntries(
        store,
        "2020-01",
        operatorId,
        sessionId,
      ),
      [],
    );
    for (const period of ["2026-13", "2026-1", "26-10", "2026-10-01"])
      await assert.rejects(
        platform.listBillingEntries(store, period, operatorId, sessionId),
        apiCode("VALIDATION_FAILED"),
        period,
      );
    await assert.rejects(
      platform.listBillingEntries(
        "00000000-0000-4000-8000-000000000000",
        undefined,
        operatorId,
        sessionId,
      ),
      apiCode("TENANT_NOT_FOUND"),
    );
  });
});

describe("M6.2 billing ledger over development entries", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let platform: PlatformService;
  let operatorId: string;
  let sessionId: string;
  let store: string;
  const entries: Record<"covered" | "beforePlan", string> = {
    covered: "",
    beforePlan: "",
  };

  /** A completed order and its M4.4 entry (no snapshot columns yet), `daysAgo` days old. */
  const legacyEntry = (tenantId: string, daysAgo: number) =>
    insertOrder(owner, tenantId).then(({ id }) =>
      runInTenant(owner, tenantId, async (em) => {
        await em.execute(
          "update orders set status = 'COMPLETED' where id = ?",
          [id],
        );
        const [row] = await em.execute<{ id: string }[]>(
          `insert into billing_entries (tenant_id, order_id, type, items_subtotal_cents, delivery_fee_cents,
             total_cents, payment_method, occurred_at)
           values (?, ?, 'ORDER_COMPLETED', 4000, 0, 4000, 'CASH', now() - make_interval(days => ?))
           returning id`,
          [tenantId, id, daysAgo],
        );
        return row!.id;
      }),
    );

  before(async () => {
    database = await createTestDatabase({ migrate: false });
    await migrateTestDatabase(
      database,
      "Migration20261102000000_plan_subscriptions",
    );
    owner = await database.connect(database.ownerUrl);
    // A live store whose plan period starts after one of its development entries.
    store = await insertTenant(owner, "ledger-legacy");
    await runInTenant(owner, store, (em) =>
      em.execute(
        "update plan_subscriptions set valid_from = now() - interval '2 days' where tenant_id = ?",
        [store],
      ),
    );
    entries.covered = await legacyEntry(store, 1);
    entries.beforePlan = await legacyEntry(store, 3);
    await migrateTestDatabase(database);

    const hash = await hashPassword("correct horse battery staple 2026");
    const [operator] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_users (email, name, password_hash, platform_role, mfa_secret, mfa_enabled_at) values (?, ?, ?, 'OPERATOR', 'v1.operator', now()) returning id",
        [`operator-legacy-${Date.now()}@example.test`, "Operator", hash],
      );
    operatorId = operator!.id;
    const [session] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_sessions (staff_user_id, mfa, refresh_token_hash, idle_expires_at) values (?, true, ?, now() + interval '1 hour') returning id",
        [operatorId, Buffer.alloc(32, 8)],
      );
    sessionId = session!.id;
    platform = new PlatformService(await database.connect(database.appUrl), {
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
      metricsToken: null,
    });
  });

  after(async () => {
    await database?.drop();
  });

  const snapshotOf = (id: string) =>
    runInTenant(owner, store, (em) =>
      em.execute<
        {
          plan: string | null;
          feeBasisPoints: number | null;
          subscriptionId: string | null;
          period: string;
        }[]
      >(
        `select plan, fee_basis_points as "feeBasisPoints", subscription_id as "subscriptionId", period
           from billing_entries where id = ?`,
        [id],
      ),
    ).then(([row]) => row);
  const reversalsOf = () =>
    runInTenant(owner, store, (em) =>
      em.execute<{ count: number }[]>(
        "select count(*)::int as count from billing_entries where type = 'ORDER_REVERSED'",
      ),
    ).then(([row]) => row!.count);
  const reversalAudits = () =>
    owner.em
      .getConnection()
      .execute<{ count: number }[]>(
        "select count(*)::int as count from audit_events where tenant_id = ? and action = 'billing_entry.reversed'",
        [store],
      )
      .then(([row]) => row!.count);

  it("snapshots only the entries a plan period covered and leaves the rest without one", async () => {
    const [period] = await runInTenant(owner, store, (em) =>
      em.execute<{ id: string }[]>("select id from plan_subscriptions"),
    );
    const covered = await snapshotOf(entries.covered);
    assert.deepEqual(
      {
        plan: covered!.plan,
        feeBasisPoints: covered!.feeBasisPoints,
        subscriptionId: covered!.subscriptionId,
      },
      { plan: "FLEX", feeBasisPoints: 300, subscriptionId: period!.id },
    );
    const beforePlan = await snapshotOf(entries.beforePlan);
    assert.deepEqual(
      {
        plan: beforePlan!.plan,
        feeBasisPoints: beforePlan!.feeBasisPoints,
        subscriptionId: beforePlan!.subscriptionId,
      },
      { plan: null, feeBasisPoints: null, subscriptionId: null },
      "no snapshot is invented for an entry older than the store's plan",
    );
    assert.match(beforePlan!.period, /^\d{4}-\d{2}$/);
  });

  it("refuses to reverse an entry without a snapshot, writing nothing", async () => {
    await assert.rejects(
      platform.reverseBillingEntry(
        store,
        entries.beforePlan,
        "SALE_UNDONE",
        operatorId,
        sessionId,
        "",
        "",
      ),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "BILLING_ENTRY_SNAPSHOT_INCOMPLETE" &&
        error.getStatus() === 409,
    );
    assert.equal(await reversalsOf(), 0);
    assert.equal(await reversalAudits(), 0);
    assert.equal((await snapshotOf(entries.beforePlan))!.plan, null);

    // A snapshot cannot be partial: the database refuses new entries missing any of its fields.
    for (const missing of ["plan", "fee_basis_points", "subscription_id"]) {
      const [subscription] = await runInTenant(owner, store, (em) =>
        em.execute<{ id: string }[]>("select id from plan_subscriptions"),
      );
      const { id: orderId } = await insertOrder(owner, store);
      const row: Record<string, unknown> = {
        plan: "FLEX",
        fee_basis_points: 300,
        subscription_id: subscription!.id,
        [missing]: null,
      };
      await assert.rejects(
        runInTenant(owner, store, (em) =>
          em.execute(
            `insert into billing_entries (tenant_id, order_id, type, items_subtotal_cents, delivery_fee_cents,
               total_cents, payment_method, period, plan, fee_basis_points, subscription_id)
             values (?, ?, 'ORDER_COMPLETED', 4000, 0, 4000, 'CASH', '2026-10', ?, ?, ?)`,
            [
              store,
              orderId,
              row.plan,
              row.fee_basis_points,
              row.subscription_id,
            ],
          ),
        ),
        sqlCode("23514"),
        missing,
      );
    }

    const reversal = await platform.reverseBillingEntry(
      store,
      entries.covered,
      "SALE_UNDONE",
      operatorId,
      sessionId,
      "",
      "",
    );
    assert.equal(reversal.changed, true);
    assert.equal(await reversalsOf(), 1);
    assert.equal(await reversalAudits(), 1);
  });
});
