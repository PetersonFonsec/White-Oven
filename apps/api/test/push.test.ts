import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import {
  type PushMessage,
  PushRequestError,
  type PushTicket,
} from "../src/push/push-rules";
import type { PushSender } from "../src/push/push-sender";
import { PushService } from "../src/push/push.service";
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

const PASSWORD = "push-senha-forte-2026";
const INSUFFICIENT_PRIVILEGE = "42501";
const token = (label: string) => `ExponentPushToken[${label}]`;

/** Records what the job would send and answers with the scripted tickets or failure. */
class FakeSender implements PushSender {
  sent: PushMessage[][] = [];
  answer: (messages: readonly PushMessage[]) => PushTicket[] = (messages) =>
    messages.map(() => ({ ok: true }));
  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    this.sent.push([...messages]);
    return this.answer(messages);
  }
}

describe("M5.5 order push notifications", databaseSuite, () => {
  let database: TestDatabase;
  let owner: MikroORM;
  let app: MikroORM;
  let server: TestServer;
  let push: PushService;
  let staffToken: string;
  const store = { id: "", slug: `push-a-${randomUUID().slice(0, 8)}` };
  const other = { id: "", slug: `push-b-${randomUUID().slice(0, 8)}` };

  const sql = <T>(tenantId: string, query: string, params: unknown[] = []) =>
    runInTenant(owner, tenantId, (em) => em.execute<T[]>(query, params));

  const customerRequest = (
    slug: string,
    path: string,
    accessToken: string | null,
    method = "GET",
    body?: unknown,
  ) =>
    fetch(`${server.baseUrl}/v1/customer/stores/${slug}/${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(accessToken ? bearer(accessToken) : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** A new customer of `slug`, signed in: access and refresh tokens and the customer id. */
  const customer = async (slug = store.slug) => {
    const register = await customerRequest(
      slug,
      "auth/register",
      null,
      "POST",
      {
        name: "Cliente Push",
        email: `push-${randomUUID()}@teste.invalid`,
        password: PASSWORD,
        privacyPolicyVersion: "2026-10",
      },
    );
    assert.equal(register.status, 201);
    const tokens = await json(register);
    const me = await json(
      await customerRequest(slug, "me", tokens.accessToken),
    );
    return {
      access: tokens.accessToken as string,
      refresh: tokens.refreshToken as string,
      id: me.id as string,
    };
  };

  const optIn = (slug: string, access: string, body: unknown) =>
    customerRequest(slug, "me/push-device", access, "PUT", body);

  /** A placed order of `customerId`, written as the owner with its creation history. */
  const order = async (
    customerId: string,
    fulfillment: "DELIVERY" | "PICKUP" = "PICKUP",
    tenantId = store.id,
  ) => {
    const [row] = await sql<{ id: string; number: number }>(
      tenantId,
      `insert into orders (tenant_id, number, customer_id, customer_name, fulfillment,
         delivery_address, payment_method, items_subtotal_cents, delivery_fee_cents, total_cents)
       values (?, coalesce((select max(number) from orders), 0) + 1, ?, 'Cliente Push', ?, ?::jsonb,
               'CASH', 4000, ?, ?)
       returning id, number`,
      [
        tenantId,
        customerId,
        fulfillment,
        fulfillment === "DELIVERY"
          ? JSON.stringify({ street: "Rua Privada", number: "42" })
          : null,
        fulfillment === "DELIVERY" ? 700 : 0,
        fulfillment === "DELIVERY" ? 4700 : 4000,
      ],
    );
    await sql(
      tenantId,
      `insert into order_status_changes (tenant_id, order_id, from_status, to_status, actor_type, actor_id)
       values (?, ?, null, 'PLACED', 'CUSTOMER', ?)`,
      [tenantId, row!.id, customerId],
    );
    return row!;
  };

  const staffMove = async (orderId: string, from: string, to: string) => {
    const response = await fetch(
      `${server.baseUrl}/v1/admin/orders/${orderId}/transitions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...bearer(staffToken),
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({
          from,
          to,
          ...(to === "REJECTED" || to === "CANCELED"
            ? { reasonCode: "STORE_TOO_BUSY" }
            : {}),
        }),
      },
    );
    assert.equal(response.status, 200, await response.text());
  };

  const deliveries = (orderId: string, tenantId = store.id) =>
    sql<{
      toStatus: string;
      state: string;
      attempts: number;
      customerId: string;
    }>(
      tenantId,
      `select to_status as "toStatus", state, attempts, customer_id as "customerId"
         from push_deliveries where order_id = ? order by created_at, id`,
      [orderId],
    );
  const devices = (customerId: string, tenantId = store.id) =>
    sql<{ token: string }>(
      tenantId,
      "select token from customer_push_devices where customer_id = ? order by token",
      [customerId],
    ).then((rows) => rows.map((row) => row.token));

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    app = await database.connect(database.appUrl);
    store.id = await insertTenant(owner, store.slug);
    other.id = await insertTenant(owner, other.slug);
    server = await startTestServer({ DATABASE_URL: database.appUrl });
    push = server.app.get(PushService);
    const email = `push-staff-${randomUUID()}@teste.invalid`;
    const userId = await insertStaffUser(owner, email, PASSWORD);
    await insertMembership(owner, store.id, userId, "MANAGER");
    const login = await staffLogin(server.baseUrl, email, PASSWORD);
    const switched = await switchTenant(
      server.baseUrl,
      login.accessToken,
      store.id,
    );
    staffToken = (await json(switched)).accessToken;
  });
  after(async () => {
    await server?.close();
    await app?.close();
    await owner?.close();
    await database?.drop();
  });
  beforeEach(async () => {
    // Earlier tests' leftovers must not be sent again by the next pass of the job.
    for (const tenantId of [store.id, other.id])
      await sql(
        tenantId,
        "update push_deliveries set state = 'SKIPPED', finished_at = now() where state = 'PENDING'",
      );
  });

  it("registers, reads and removes the opt-in of the signed-in device", async () => {
    const buyer = await customer();
    const initial = await customerRequest(
      store.slug,
      "me/push-device",
      buyer.access,
    );
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get("cache-control"), "no-store");
    assert.deepEqual(await json(initial), { enabled: false });

    for (const body of [
      {},
      { token: "abc" },
      { token: "ExponentPushToken[]" },
      { token: "ExponentPushToken[a b]" },
      { token: token("ok"), platform: "ios" },
      [token("ok")],
    ]) {
      const refused = await optIn(store.slug, buyer.access, body);
      assert.equal(refused.status, 422, JSON.stringify(body));
      assert.equal((await json(refused)).code, "VALIDATION_FAILED");
    }
    const anonymous = await optIn(store.slug, "", { token: token("x") });
    assert.equal(anonymous.status, 401);

    const accepted = await optIn(store.slug, buyer.access, {
      token: token("first"),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await json(accepted), { enabled: true });
    assert.deepEqual(await devices(buyer.id), [token("first")]);

    // A new token of the same session (reinstall, rotated token) replaces the old one.
    await optIn(store.slug, buyer.access, { token: token("second") });
    assert.deepEqual(await devices(buyer.id), [token("second")]);
    assert.deepEqual(
      await json(
        await customerRequest(store.slug, "me/push-device", buyer.access),
      ),
      { enabled: true },
    );

    const removed = await customerRequest(
      store.slug,
      "me/push-device",
      buyer.access,
      "DELETE",
    );
    assert.equal(removed.status, 204);
    assert.deepEqual(await devices(buyer.id), []);
    const again = await customerRequest(
      store.slug,
      "me/push-device",
      buyer.access,
      "DELETE",
    );
    assert.equal(again.status, 204, "opting out twice is fine");
  });

  it("moves a token to the account that signed in on the device, only within its store", async () => {
    const first = await customer();
    const second = await customer();
    await optIn(store.slug, first.access, { token: token("shared") });
    await optIn(store.slug, second.access, { token: token("shared") });
    assert.deepEqual(await devices(first.id), []);
    assert.deepEqual(await devices(second.id), [token("shared")]);

    // Another store's binary is another app: the same text is a separate row there.
    const elsewhere = await customer(other.slug);
    const response = await optIn(other.slug, elsewhere.access, {
      token: token("shared"),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await devices(second.id), [token("shared")]);
    assert.deepEqual(await devices(elsewhere.id, other.id), [token("shared")]);

    // A token of store A presented on store B's routes is a 404, as every customer route.
    const crossed = await optIn(other.slug, first.access, {
      token: token("cross"),
    });
    assert.equal(crossed.status, 404);
  });

  it("queues store and system transitions only for customers with a live device", async () => {
    const opted = await customer();
    const silent = await customer();
    await optIn(store.slug, opted.access, { token: token("queue") });
    const notified = await order(opted.id);
    const quiet = await order(silent.id);
    assert.deepEqual(await deliveries(notified.id), [], "PLACED is not sent");

    await staffMove(notified.id, "PLACED", "PREPARING");
    await staffMove(quiet.id, "PLACED", "PREPARING");
    assert.deepEqual(
      (await deliveries(notified.id)).map((row) => [row.toStatus, row.state]),
      [["PREPARING", "PENDING"]],
    );
    assert.deepEqual(await deliveries(quiet.id), []);

    // The customer's own cancellation is not echoed back to them.
    const own = await order(opted.id);
    const canceled = await fetch(
      `${server.baseUrl}/v1/customer/stores/${store.slug}/me/orders/${own.id}/transitions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...bearer(opted.access),
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({
          from: "PLACED",
          to: "CANCELED",
          reasonCode: "CUSTOMER_REQUEST",
        }),
      },
    );
    assert.equal(canceled.status, 200, await canceled.text());
    assert.deepEqual(await deliveries(own.id), []);

    // A suspension rejects placed orders through the database; the customer hears about it.
    const suspended = await order(opted.id);
    await sql(
      store.id,
      `update orders set status = 'REJECTED', rejection_reason = 'STORE_SUSPENDED', updated_at = now()
        where id = ?`,
      [suspended.id],
    );
    assert.deepEqual(
      (await deliveries(suspended.id)).map((row) => row.toStatus),
      ["REJECTED"],
    );
  });

  it("sends only the store name, the order number and its state", async () => {
    const buyer = await customer();
    await optIn(store.slug, buyer.access, { token: token("content") });
    const placed = await order(buyer.id, "DELIVERY");
    for (const [from, to] of [
      ["PLACED", "PREPARING"],
      ["PREPARING", "READY"],
      ["READY", "OUT_FOR_DELIVERY"],
      ["OUT_FOR_DELIVERY", "COMPLETED"],
    ])
      await staffMove(placed.id, from!, to!);

    const sender = new FakeSender();
    await push.deliverPending(sender);
    const messages = sender.sent.flat();
    assert.deepEqual(messages, [
      {
        to: token("content"),
        title: `Pizzaria ${store.slug}`,
        body: `Pedido #${placed.number} aceito e em preparo.`,
        data: { type: "order-status", orderId: placed.id },
      },
      {
        to: token("content"),
        title: `Pizzaria ${store.slug}`,
        body: `Pedido #${placed.number} pronto. Logo sai para entrega.`,
        data: { type: "order-status", orderId: placed.id },
      },
      {
        to: token("content"),
        title: `Pizzaria ${store.slug}`,
        body: `Pedido #${placed.number} saiu para entrega.`,
        data: { type: "order-status", orderId: placed.id },
      },
      {
        to: token("content"),
        title: `Pizzaria ${store.slug}`,
        body: `Pedido #${placed.number} entregue. Bom apetite!`,
        data: { type: "order-status", orderId: placed.id },
      },
    ]);
    const text = JSON.stringify(messages);
    for (const personal of ["Cliente Push", "Rua Privada", "4700", "CASH"])
      assert.ok(!text.includes(personal), personal);
    assert.deepEqual(
      (await deliveries(placed.id)).map((row) => row.state),
      ["SENT", "SENT", "SENT", "SENT"],
    );

    // Settled deliveries are never sent twice.
    const nothing = new FakeSender();
    await push.deliverPending(nothing);
    assert.deepEqual(nothing.sent, []);
  });

  it("deletes devices Expo no longer knows and gives up on final errors", async () => {
    const buyer = await customer();
    await optIn(store.slug, buyer.access, { token: token("gone") });
    const placed = await order(buyer.id);
    await staffMove(placed.id, "PLACED", "PREPARING");

    const sender = new FakeSender();
    sender.answer = (messages) =>
      messages.map(() => ({ ok: false, deviceGone: true, retry: false }));
    await push.deliverPending(sender);
    assert.equal(sender.sent.length, 1);
    assert.deepEqual(await devices(buyer.id), []);
    assert.deepEqual(
      (await deliveries(placed.id)).map((row) => row.state),
      ["FAILED"],
    );
    // Without a device, the next transition is not even queued.
    await staffMove(placed.id, "PREPARING", "READY");
    assert.equal((await deliveries(placed.id)).length, 1);
  });

  it("retries a failed request with backoff, then gives up", async () => {
    const buyer = await customer();
    await optIn(store.slug, buyer.access, { token: token("retry") });
    const placed = await order(buyer.id);
    await staffMove(placed.id, "PLACED", "PREPARING");

    const failing = new FakeSender();
    failing.answer = () => {
      throw new PushRequestError("Expo answered 503");
    };
    await push.deliverPending(failing);
    let [row] = await deliveries(placed.id);
    assert.deepEqual([row!.state, row!.attempts], ["PENDING", 1]);
    const [{ wait }] = (await sql<{ wait: number }>(
      store.id,
      `select extract(epoch from next_attempt_at - now())::int as wait
         from push_deliveries where order_id = ?`,
      [placed.id],
    )) as [{ wait: number }];
    assert.ok(wait > 20 && wait <= 30, `next attempt in ${wait}s`);

    // Not due yet: the next pass leaves it alone.
    await push.deliverPending(failing);
    assert.equal(failing.sent.length, 1);

    await sql(
      store.id,
      "update push_deliveries set attempts = 4, next_attempt_at = now() where order_id = ?",
      [placed.id],
    );
    await push.deliverPending(failing);
    [row] = await deliveries(placed.id);
    assert.deepEqual([row!.state, row!.attempts], ["FAILED", 5]);

    // A rate-limited ticket is retried too, without deleting the device.
    const limited = await order(buyer.id);
    await staffMove(limited.id, "PLACED", "PREPARING");
    const rateLimited = new FakeSender();
    rateLimited.answer = (messages) =>
      messages.map(() => ({ ok: false, deviceGone: false, retry: true }));
    await push.deliverPending(rateLimited);
    [row] = await deliveries(limited.id);
    assert.deepEqual([row!.state, row!.attempts], ["PENDING", 1]);
    assert.deepEqual(await devices(buyer.id), [token("retry")]);
  });

  it("expires old deliveries and skips customers who opted out meanwhile", async () => {
    const buyer = await customer();
    await optIn(store.slug, buyer.access, { token: token("late") });
    const late = await order(buyer.id);
    await staffMove(late.id, "PLACED", "PREPARING");
    await sql(
      store.id,
      "update push_deliveries set created_at = now() - interval '31 minutes' where order_id = ?",
      [late.id],
    );
    const optedOut = await order(buyer.id);
    await staffMove(optedOut.id, "PLACED", "PREPARING");
    await customerRequest(store.slug, "me/push-device", buyer.access, "DELETE");

    const sender = new FakeSender();
    await push.deliverPending(sender);
    assert.deepEqual(sender.sent, []);
    assert.deepEqual(
      (await deliveries(late.id)).map((row) => row.state),
      ["EXPIRED"],
    );
    assert.deepEqual(
      (await deliveries(optedOut.id)).map((row) => row.state),
      ["SKIPPED"],
    );
  });

  it("ends a device's notifications with its session or the account", async () => {
    const leaving = await customer();
    await optIn(store.slug, leaving.access, { token: token("logout") });
    const logout = await customerRequest(
      store.slug,
      "auth/logout",
      null,
      "POST",
      { refreshToken: leaving.refresh },
    );
    assert.equal(logout.status, 204);
    assert.deepEqual(await devices(leaving.id), []);

    const deleting = await customer();
    await optIn(store.slug, deleting.access, { token: token("delete") });
    // A device row of another session of the account must not outlive the account either.
    const oldSession = randomUUID();
    await sql(
      store.id,
      `insert into customer_sessions (id, tenant_id, customer_id, refresh_token_hash, expires_at)
       values (?, ?, ?, ?, now() + interval '1 minute')`,
      [oldSession, store.id, deleting.id, Buffer.alloc(32, 1)],
    );
    await sql(
      store.id,
      `insert into customer_push_devices (tenant_id, customer_id, session_id, token)
       values (?, ?, ?, ?)`,
      [store.id, deleting.id, oldSession, token("old-session")],
    );
    const deleted = await customerRequest(
      store.slug,
      "me",
      deleting.access,
      "DELETE",
      { password: PASSWORD },
    );
    assert.equal(deleted.status, 204);
    assert.deepEqual(await devices(deleting.id), []);
  });

  it("lets the API settle deliveries but never write or delete them", async () => {
    const buyer = await customer();
    const placed = await order(buyer.id);
    const [change] = await sql<{ id: string }>(
      store.id,
      "select id from order_status_changes where order_id = ?",
      [placed.id],
    );
    await assert.rejects(
      runInTenant(app, store.id, (em) =>
        em.execute(
          `insert into push_deliveries (tenant_id, status_change_id, order_id, customer_id, to_status)
           values (?, ?, ?, ?, 'PREPARING')`,
          [store.id, change!.id, placed.id, buyer.id],
        ),
      ),
      { code: INSUFFICIENT_PRIVILEGE },
    );
    await assert.rejects(
      runInTenant(app, store.id, (em) =>
        em.execute("delete from push_deliveries"),
      ),
      { code: INSUFFICIENT_PRIVILEGE },
    );
    // Without a tenant context nothing is visible (forced RLS).
    const leaked = await app.em
      .fork()
      .getConnection()
      .execute("select 1 from customer_push_devices");
    assert.equal(leaked.length, 0);
  });
});
