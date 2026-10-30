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

  /** A pickup order of R$ 40,00 moved to COMPLETED and recorded as the order service does. */
  const completedOrder = async (tenantId: string) => {
    const order = await insertOrder(owner, tenantId);
    await runInTenant(owner, tenantId, (em) =>
      em.execute("update orders set status = 'COMPLETED' where id = ?", [
        order.id,
      ]),
    );
    await runInTenant(app, tenantId, (em) =>
      em.execute("select whiteoven_record_order_completion(?)", [order.id]),
    );
    return order.id;
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
    const order = await insertOrder(owner, noPlan);
    await runInTenant(owner, noPlan, (em) =>
      em.execute("update orders set status = 'COMPLETED' where id = ?", [
        order.id,
      ]),
    );
    await assert.rejects(
      runInTenant(app, noPlan, (em) =>
        em.execute("select whiteoven_record_order_completion(?)", [order.id]),
      ),
      sqlCode("P0005"),
    );
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
