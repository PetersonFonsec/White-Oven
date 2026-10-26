import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { runInTenant } from "../src/tenancy/tenant-transaction";
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

const PASSWORD = "historico-senha-forte";
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";

type Status =
  | "PLACED"
  | "PREPARING"
  | "READY"
  | "OUT_FOR_DELIVERY"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELED";

interface SeededOrder {
  number: number;
  status?: Status;
  fulfillment?: "DELIVERY" | "PICKUP";
  paymentMethod?: "CASH" | "CARD_ON_DELIVERY" | "PIX_ON_DELIVERY";
  totalCents?: number;
  /** ISO instant. */
  placedAt: string;
  /** ISO instant of the move to the terminal status, for ended orders. */
  endedAt?: string;
}

describe(
  "M4.6 order history, daily report and incidents",
  databaseSuite,
  () => {
    let database: TestDatabase;
    let owner: MikroORM;
    let app: MikroORM;
    let server: TestServer;
    const store = { id: "", slug: `historico-a-${randomUUID().slice(0, 8)}` };
    const other = { id: "", slug: `historico-b-${randomUUID().slice(0, 8)}` };
    const customers: Record<string, string> = {};

    const sql = <T>(tenantId: string, query: string, params: unknown[] = []) =>
      runInTenant(owner, tenantId, (em) => em.execute<T[]>(query, params));

    /** A staff member of `tenantId` with `role`, signed in on it; `name` names the person. */
    const staff = async (
      tenantId: string,
      role: "OWNER" | "MANAGER" | "STAFF",
      name = "Pessoa Teste",
    ) => {
      const email = `historico-${randomUUID()}@teste.invalid`;
      const userId = await insertStaffUser(owner, email, PASSWORD);
      await owner.em
        .getConnection()
        .execute("update staff_users set name = ? where id = ?", [
          name,
          userId,
        ]);
      await insertMembership(owner, tenantId, userId, role);
      const login = await staffLogin(server.baseUrl, email, PASSWORD);
      const switched = await switchTenant(
        server.baseUrl,
        login.accessToken,
        tenantId,
      );
      assert.equal(switched.status, 200);
      return { token: (await json(switched)).accessToken as string, userId };
    };

    /** An order written as the owner, with its terminal transition when it ended. */
    const seed = async (tenantId: string, order: SeededOrder) => {
      const status = order.status ?? "PLACED";
      const fulfillment = order.fulfillment ?? "PICKUP";
      const total = order.totalCents ?? 4000;
      const fee = fulfillment === "DELIVERY" ? 700 : 0;
      const [row] = await sql<{ id: string }>(
        tenantId,
        `insert into orders (tenant_id, number, customer_id, customer_name, fulfillment,
         delivery_address, payment_method, items_subtotal_cents, delivery_fee_cents,
         total_cents, status, rejection_reason, placed_at, updated_at)
       values (?, ?, ?, 'Cliente Histórico', ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?)
       returning id`,
        [
          tenantId,
          order.number,
          customers[tenantId],
          fulfillment,
          fulfillment === "DELIVERY"
            ? JSON.stringify({ street: "Rua A" })
            : null,
          order.paymentMethod ?? "CASH",
          total - fee,
          fee,
          total,
          status,
          status === "REJECTED" ? "STORE_TOO_BUSY" : null,
          order.placedAt,
          order.endedAt ?? order.placedAt,
        ],
      );
      if (order.endedAt)
        await sql(
          tenantId,
          `insert into order_status_changes (tenant_id, order_id, from_status, to_status,
           actor_type, actor_id, reason_code, at)
         values (?, ?, 'READY', ?, 'SYSTEM', ?, ?, ?)`,
          [
            tenantId,
            row!.id,
            status,
            tenantId,
            status === "COMPLETED" ? null : "STORE_TOO_BUSY",
            order.endedAt,
          ],
        );
      return row!.id;
    };

    const get = (token: string, path: string) =>
      fetch(`${server.baseUrl}/v1/admin/${path}`, { headers: bearer(token) });
    const post = (token: string, path: string, body: unknown) =>
      fetch(`${server.baseUrl}/v1/admin/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify(body),
      });
    const numbers = async (token: string, query: string) => {
      const response = await get(token, `orders/history?${query}`);
      assert.equal(response.status, 200, query);
      const page = (await json(response)) as {
        orders: { number: number }[];
        nextCursor: number | null;
      };
      return {
        numbers: page.orders.map((order) => order.number),
        nextCursor: page.nextCursor,
      };
    };
    const orderRow = (tenantId: string, id: string) =>
      sql<Record<string, unknown>>(
        tenantId,
        `select status, total_cents, items_subtotal_cents, delivery_fee_cents, payment_method,
              rejection_reason, updated_at from orders where id = ?`,
        [id],
      ).then(([row]) => row!);
    const sqlState = async (work: () => Promise<unknown>) => {
      try {
        await work();
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };

    before(async () => {
      database = await createTestDatabase();
      owner = await database.connect(database.ownerUrl);
      app = await database.connect(database.appUrl);
      for (const tenant of [store, other]) {
        tenant.id = await insertTenant(owner, tenant.slug);
        const [customer] = await sql<{ id: string }>(
          tenant.id,
          `insert into customers (tenant_id, name, email, password_hash, privacy_policy_version, accepted_at)
         values (?, 'Cliente Histórico', ?, '$argon2id$fixture', '2026-10', now()) returning id`,
          [tenant.id, `historico-${randomUUID()}@teste.invalid`],
        );
        customers[tenant.id] = customer!.id;
      }
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

    it("pages and filters the history by the store's local day, status, mode and number", async () => {
      // 120 orders of 2026-09-01 (São Paulo), newest number first; then orders near local midnight.
      for (let number = 1; number <= 120; number++)
        await seed(store.id, {
          number,
          placedAt: `2026-09-01T15:${String(number % 60).padStart(2, "0")}:00Z`,
          status: number % 3 === 0 ? "COMPLETED" : "PLACED",
          endedAt:
            number % 3 === 0
              ? `2026-09-01T18:${String(number % 60).padStart(2, "0")}:00Z`
              : undefined,
          fulfillment: number % 2 === 0 ? "DELIVERY" : "PICKUP",
        });
      // 23:30 on 2026-09-01 in São Paulo is 02:30 UTC of the 2nd; 00:30 on the 2nd is 03:30 UTC.
      await seed(store.id, { number: 121, placedAt: "2026-09-02T02:30:00Z" });
      await seed(store.id, { number: 122, placedAt: "2026-09-02T03:30:00Z" });
      await seed(other.id, { number: 1, placedAt: "2026-09-01T15:00:00Z" });
      const { token } = await staff(store.id, "STAFF");

      const first = await get(token, "orders/history");
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("cache-control"), "no-store");
      const firstPage = (await json(first)) as {
        orders: Record<string, unknown>[];
        nextCursor: number;
      };
      assert.equal(firstPage.orders.length, 50);
      assert.equal(firstPage.orders[0]!["number"], 122);
      assert.equal(firstPage.nextCursor, 73);
      assert.deepEqual(Object.keys(firstPage.orders[0]!).sort(), [
        "customerName",
        "fulfillment",
        "id",
        "number",
        "openIncidents",
        "paymentMethod",
        "placedAt",
        "status",
        "totalCents",
      ]);
      const second = await numbers(token, "cursor=73");
      assert.equal(second.numbers[0], 72);
      assert.equal(second.nextCursor, 23);
      const third = await numbers(token, "cursor=23");
      assert.equal(third.numbers.length, 22);
      assert.equal(third.nextCursor, null);

      const day = await numbers(
        token,
        "from=2026-09-01&to=2026-09-01&cursor=200",
      );
      assert.equal(day.numbers[0], 121, "23:30 local belongs to the 1st");
      assert.ok(!day.numbers.includes(122));
      assert.deepEqual(
        (await numbers(token, "from=2026-09-02")).numbers,
        [122],
        "00:30 local belongs to the 2nd",
      );
      assert.deepEqual((await numbers(token, "to=2026-08-31")).numbers, []);
      assert.deepEqual(
        (await numbers(token, "number=7")).numbers,
        [7],
        "the number finds one order",
      );
      const completedDelivery = await numbers(
        token,
        "status=COMPLETED&fulfillment=DELIVERY",
      );
      assert.deepEqual(
        completedDelivery.numbers,
        Array.from({ length: 20 }, (_, index) => 120 - index * 6),
      );

      for (const query of [
        "section=closed",
        "from=2026-02-30",
        "from=01-09-2026",
        "from=2026-09-02&to=2026-09-01",
        "status=DONE",
        "fulfillment=DRIVE",
        "number=0",
        "number=-1",
        "cursor=1.5",
        "from=",
        "status=PLACED&status=READY",
      ]) {
        const refused = await get(token, `orders/history?${query}`);
        assert.equal(refused.status, 422, query);
        assert.equal((await json(refused)).code, "VALIDATION_FAILED");
      }

      const { token: otherToken } = await staff(other.id, "STAFF");
      assert.deepEqual((await numbers(otherToken, "")).numbers, [1]);
    });

    it("sums only COMPLETED orders per local day of completion, by mode and payment, for the OWNER", async () => {
      // Placed on the 9th, completed at 23:50 local of the 9th (02:50 UTC of the 10th).
      await seed(store.id, {
        number: 1001,
        status: "COMPLETED",
        fulfillment: "DELIVERY",
        paymentMethod: "CASH",
        totalCents: 5700,
        placedAt: "2026-10-09T22:00:00Z",
        endedAt: "2026-10-10T02:50:00Z",
      });
      // Placed on the 9th, completed at 00:10 local of the 10th.
      await seed(store.id, {
        number: 1002,
        status: "COMPLETED",
        fulfillment: "PICKUP",
        paymentMethod: "PIX_ON_DELIVERY",
        totalCents: 4000,
        placedAt: "2026-10-10T02:40:00Z",
        endedAt: "2026-10-10T03:10:00Z",
      });
      await seed(store.id, {
        number: 1003,
        status: "COMPLETED",
        fulfillment: "PICKUP",
        paymentMethod: "CARD_ON_DELIVERY",
        totalCents: 3000,
        placedAt: "2026-10-10T20:00:00Z",
        endedAt: "2026-10-10T21:00:00Z",
      });
      // Never counted: rejected, canceled and still open orders of the same days.
      for (const [number, status] of [
        [1004, "REJECTED"],
        [1005, "CANCELED"],
      ] as const)
        await seed(store.id, {
          number,
          status,
          placedAt: "2026-10-10T20:00:00Z",
          endedAt: "2026-10-10T20:30:00Z",
        });
      await seed(store.id, { number: 1006, placedAt: "2026-10-10T20:00:00Z" });
      await seed(other.id, {
        number: 1001,
        status: "COMPLETED",
        placedAt: "2026-10-10T20:00:00Z",
        endedAt: "2026-10-10T21:00:00Z",
      });

      const { token } = await staff(store.id, "OWNER");
      const response = await get(
        token,
        "reports/daily?from=2026-10-09&to=2026-10-11",
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const report = await json(response);
      assert.equal(report.timezone, "America/Sao_Paulo");
      const sales = (
        count: number,
        totalCents: number,
        fees: number,
        byFulfillment: [number, number, number, number],
        byPayment: [number, number, number, number, number, number],
      ) => ({
        count,
        totalCents,
        itemsSubtotalCents: totalCents - fees,
        deliveryFeeCents: fees,
        byFulfillment: {
          DELIVERY: { count: byFulfillment[0], totalCents: byFulfillment[1] },
          PICKUP: { count: byFulfillment[2], totalCents: byFulfillment[3] },
        },
        byPaymentMethod: {
          CASH: { count: byPayment[0], totalCents: byPayment[1] },
          CARD_ON_DELIVERY: { count: byPayment[2], totalCents: byPayment[3] },
          PIX_ON_DELIVERY: { count: byPayment[4], totalCents: byPayment[5] },
        },
      });
      assert.deepEqual(report.days, [
        {
          date: "2026-10-09",
          ...sales(1, 5700, 700, [1, 5700, 0, 0], [1, 5700, 0, 0, 0, 0]),
        },
        {
          date: "2026-10-10",
          ...sales(2, 7000, 0, [0, 0, 2, 7000], [0, 0, 1, 3000, 1, 4000]),
        },
        {
          date: "2026-10-11",
          ...sales(0, 0, 0, [0, 0, 0, 0], [0, 0, 0, 0, 0, 0]),
        },
      ]);
      assert.deepEqual(
        report.totals,
        sales(3, 12700, 700, [1, 5700, 2, 7000], [1, 5700, 1, 3000, 1, 4000]),
      );

      for (const role of ["MANAGER", "STAFF"] as const) {
        const { token: roleToken } = await staff(store.id, role);
        const refused = await get(
          roleToken,
          "reports/daily?from=2026-10-09&to=2026-10-11",
        );
        assert.equal(refused.status, 403, role);
        assert.equal((await json(refused)).code, "ROLE_FORBIDDEN");
      }
      for (const query of [
        "",
        "from=2026-10-09",
        "from=2026-10-01&to=2026-11-01",
        "from=2026-10-11&to=2026-10-09",
        "from=2026-10-09&to=2026-10-11&mode=PICKUP",
      ]) {
        const refused = await get(token, `reports/daily?${query}`);
        assert.equal(refused.status, 422, query);
      }
      assert.equal(
        (await get(token, "reports/daily?from=2026-10-01&to=2026-10-31"))
          .status,
        200,
        "31 days is the limit",
      );
    });

    it("records and resolves incidents without touching the order, with authors and audit", async () => {
      const orderId = await seed(store.id, {
        number: 2001,
        status: "COMPLETED",
        fulfillment: "DELIVERY",
        placedAt: new Date(Date.now() - 3_600_000).toISOString(),
        endedAt: new Date(Date.now() - 1_800_000).toISOString(),
      });
      const before = await orderRow(store.id, orderId);
      const { token, userId } = await staff(
        store.id,
        "STAFF",
        "Bruna Atendente",
      );
      const manager = await staff(store.id, "MANAGER", "Marcos Gerente");

      const created = await post(token, `orders/${orderId}/incidents`, {
        type: "LATE_DELIVERY",
        description: "  Cliente ligou: chegou frio.  ",
        reportedBy: "CUSTOMER",
      });
      assert.equal(created.status, 201);
      const incident = await json(created);
      assert.equal(incident.description, "Cliente ligou: chegou frio.");
      assert.equal(incident.status, "OPEN");
      assert.equal(incident.createdByName, "Bruna Atendente");
      assert.equal(incident.resolvedAt, null);

      const listed = (
        (await json(await get(token, "orders/history?number=2001"))) as {
          orders: { openIncidents: number }[];
        }
      ).orders[0]!;
      assert.equal(listed.openIncidents, 1);

      const resolved = await post(
        manager.token,
        `orders/${orderId}/incidents/${incident.id}/resolve`,
        {
          resolutionNote: "Desconto na próxima compra combinado por telefone.",
        },
      );
      assert.equal(resolved.status, 200);
      const resolvedBody = await json(resolved);
      assert.equal(resolvedBody.status, "RESOLVED");
      assert.equal(resolvedBody.resolvedByName, "Marcos Gerente");
      assert.equal(
        resolvedBody.resolutionNote,
        "Desconto na próxima compra combinado por telefone.",
      );
      const again = await post(
        token,
        `orders/${orderId}/incidents/${incident.id}/resolve`,
        { resolutionNote: "outra" },
      );
      assert.equal(again.status, 409);
      assert.equal((await json(again)).code, "INCIDENT_ALREADY_RESOLVED");

      // Neither the state nor the values of the order changed.
      assert.deepEqual(await orderRow(store.id, orderId), before);

      const detail = await json(await get(token, `orders/${orderId}`));
      assert.equal(detail.incidents.length, 1);
      assert.equal(detail.incidents[0].resolvedByName, "Marcos Gerente");
      assert.equal(detail.status, "COMPLETED");

      const audit = await owner.em
        .getConnection()
        .execute<{ action: string; actor: string; changes: object }[]>(
          `select action, actor_id as actor, changes from audit_events
          where entity_id = ? order by at`,
          [incident.id],
        );
      assert.deepEqual(audit, [
        {
          action: "order.incident_reported",
          actor: userId,
          changes: { orderId, type: "LATE_DELIVERY" },
        },
        {
          action: "order.incident_resolved",
          actor: manager.userId,
          changes: { orderId, type: "LATE_DELIVERY" },
        },
      ]);

      const missing = await post(
        token,
        `orders/${orderId}/incidents/${randomUUID()}/resolve`,
        {},
      );
      assert.equal(missing.status, 404);
      const noOrder = await post(token, `orders/${randomUUID()}/incidents`, {
        type: "OTHER",
        description: "x",
        reportedBy: "STAFF",
      });
      assert.equal(noOrder.status, 404);
      for (const body of [
        {},
        { type: "LOST", description: "x", reportedBy: "STAFF" },
        { type: "OTHER", description: "   ", reportedBy: "STAFF" },
        { type: "OTHER", description: "x".repeat(1001), reportedBy: "STAFF" },
        { type: "OTHER", description: "x", reportedBy: "SYSTEM" },
        {
          type: "OTHER",
          description: "x",
          reportedBy: "STAFF",
          status: "OPEN",
        },
      ]) {
        const refused = await post(token, `orders/${orderId}/incidents`, body);
        assert.equal(refused.status, 422, JSON.stringify(body));
      }
      const badNote = await post(
        token,
        `orders/${orderId}/incidents/${incident.id}/resolve`,
        { resolutionNote: 3 },
      );
      assert.equal(badNote.status, 422);
    });

    it("shows who made each staff transition in the order detail", async () => {
      const orderId = await seed(store.id, {
        number: 2101,
        placedAt: new Date().toISOString(),
      });
      const { token } = await staff(store.id, "STAFF", "Carla Forno");
      const accepted = await fetch(
        `${server.baseUrl}/v1/admin/orders/${orderId}/transitions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": randomUUID(),
            ...bearer(token),
          },
          body: JSON.stringify({ from: "PLACED", to: "PREPARING" }),
        },
      );
      assert.equal(accepted.status, 200);
      const detail = await json(await get(token, `orders/${orderId}`));
      assert.deepEqual(
        detail.history.map((change: Record<string, unknown>) => [
          change["to"],
          change["actorType"],
          change["actorName"],
        ]),
        [["PREPARING", "STAFF", "Carla Forno"]],
      );
      assert.deepEqual(detail.incidents, []);
    });

    it("takes incidents up to 30 days after an order ended, and on open orders of any age", async () => {
      const day = 86_400_000;
      const ended = (number: number, endedDaysAgo: number) =>
        seed(store.id, {
          number,
          status: "CANCELED",
          placedAt: new Date(
            Date.now() - (endedDaysAgo + 1) * day,
          ).toISOString(),
          endedAt: new Date(Date.now() - endedDaysAgo * day).toISOString(),
        });
      const recent = await ended(2201, 29);
      const old = await ended(2202, 31);
      const open = await seed(store.id, {
        number: 2203,
        status: "PREPARING",
        placedAt: new Date(Date.now() - 90 * day).toISOString(),
      });
      const { token } = await staff(store.id, "STAFF");
      const report = (orderId: string) =>
        post(token, `orders/${orderId}/incidents`, {
          type: "QUALITY",
          description: "Massa crua",
          reportedBy: "CUSTOMER",
        });
      assert.equal((await report(recent)).status, 201);
      assert.equal((await report(open)).status, 201);
      const closed = await report(old);
      assert.equal(closed.status, 422);
      const body = await json(closed);
      assert.equal(body.code, "INCIDENT_WINDOW_CLOSED");
      assert.equal(body.details.windowDays, 30);
      const [{ count }] = (await sql<{ count: number }>(
        store.id,
        "select count(*)::int as count from order_incidents where order_id = ?",
        [old],
      )) as [{ count: number }];
      assert.equal(count, 0);
    });

    it("resolves an incident once when two people resolve it at the same time", async () => {
      const orderId = await seed(store.id, {
        number: 2301,
        placedAt: new Date().toISOString(),
      });
      const { token } = await staff(store.id, "STAFF");
      const incident = await json(
        await post(token, `orders/${orderId}/incidents`, {
          type: "WRONG_ITEM",
          description: "Sabor trocado",
          reportedBy: "STAFF",
        }),
      );
      const responses = await Promise.all(
        ["primeira", "segunda"].map((note) =>
          post(token, `orders/${orderId}/incidents/${incident.id}/resolve`, {
            resolutionNote: note,
          }),
        ),
      );
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      const audit = await owner.em.getConnection().execute<{ count: number }[]>(
        `select count(*)::int as count from audit_events
          where entity_id = ? and action = 'order.incident_resolved'`,
        [incident.id],
      );
      assert.equal(audit[0]!.count, 1);
    });

    it("lets the OWNER of a suspended store read and record incidents", async () => {
      const tenantId = await insertTenant(
        owner,
        `historico-s-${randomUUID().slice(0, 8)}`,
      );
      const [customer] = await sql<{ id: string }>(
        tenantId,
        `insert into customers (tenant_id, name, email, password_hash, privacy_policy_version, accepted_at)
       values (?, 'Cliente', ?, 'x', '2026-10', now()) returning id`,
        [tenantId, `historico-${randomUUID()}@teste.invalid`],
      );
      customers[tenantId] = customer!.id;
      const orderId = await seed(tenantId, {
        number: 1,
        status: "PREPARING",
        placedAt: new Date().toISOString(),
      });
      const { token } = await staff(tenantId, "OWNER");
      await owner.em
        .getConnection()
        .execute("update tenants set status = 'SUSPENDED' where id = ?", [
          tenantId,
        ]);
      assert.equal((await get(token, "orders/history")).status, 200);
      assert.equal(
        (await get(token, "reports/daily?from=2026-10-01&to=2026-10-02"))
          .status,
        200,
      );
      const created = await post(token, `orders/${orderId}/incidents`, {
        type: "OTHER",
        description: "Loja suspensa, cliente avisado",
        reportedBy: "STAFF",
      });
      assert.equal(created.status, 201);
    });

    it("keeps incidents append-only for the app: no delete, no edits, no reopening", async () => {
      const orderId = await seed(store.id, {
        number: 2401,
        placedAt: new Date().toISOString(),
      });
      const { token } = await staff(store.id, "STAFF");
      const incident = await json(
        await post(token, `orders/${orderId}/incidents`, {
          type: "MISSING_ITEM",
          description: "Faltou o refrigerante",
          reportedBy: "CUSTOMER",
        }),
      );
      const asApp = (query: string) =>
        sqlState(() =>
          runInTenant(app, store.id, (em) => em.execute(query, [incident.id])),
        );
      assert.equal(
        await asApp("delete from order_incidents where id = ?"),
        INSUFFICIENT_PRIVILEGE,
      );
      assert.equal(
        await asApp(
          "update order_incidents set description = 'outra' where id = ?",
        ),
        INSUFFICIENT_PRIVILEGE,
      );
      assert.equal(
        await asApp("update order_incidents set order_id = id where id = ?"),
        INSUFFICIENT_PRIVILEGE,
      );
      // Resolving needs the author and the time; reopening is refused by the trigger.
      assert.equal(
        await asApp(
          "update order_incidents set status = 'RESOLVED' where id = ?",
        ),
        CHECK_VIOLATION,
      );
      assert.equal(
        (
          await post(
            token,
            `orders/${orderId}/incidents/${incident.id}/resolve`,
            {},
          )
        ).status,
        200,
      );
      assert.equal(
        await asApp(
          "update order_incidents set status = 'OPEN', resolved_by = null, resolved_at = null where id = ?",
        ),
        CHECK_VIOLATION,
      );
      assert.equal(
        await asApp(
          "update order_incidents set resolution_note = 'reescrita' where id = ?",
        ),
        CHECK_VIOLATION,
      );
    });
  },
);
