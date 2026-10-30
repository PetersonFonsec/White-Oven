import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { API_CONFIG } from "../src/config/config";
import { JsonLogger } from "../src/logging/json-logger";
import {
  runInTenant,
  TenantTransactions,
} from "../src/tenancy/tenant-transaction";
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

type Answer = (
  messages: readonly PushMessage[],
) => PushTicket[] | Promise<PushTicket[]>;
const allOk: Answer = (messages) => messages.map(() => ({ ok: true }));

/**
 * Records each request the job makes and answers it with the next scripted answer (then
 * `answer`): tickets, or a thrown `PushRequestError` for a request that failed as a whole.
 */
class FakeSender implements PushSender {
  sent: PushMessage[][] = [];
  constructor(
    private readonly script: Answer[] = [],
    public answer: Answer = allOk,
  ) {}
  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    this.sent.push([...messages]);
    return (this.script.shift() ?? this.answer)(messages);
  }
  get tokens() {
    return this.sent.flat().map((message) => message.to);
  }
}

/** A promise the test resolves by hand, to stop a worker at a known point. */
function barrier() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
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
      email: me.email as string,
    };
  };
  /** Another session of the same account, as a second phone would have. */
  const signInAgain = async (email: string, slug = store.slug) => {
    const login = await customerRequest(slug, "auth/login", null, "POST", {
      email,
      password: PASSWORD,
    });
    assert.equal(login.status, 200);
    const tokens = await json(login);
    return {
      access: tokens.accessToken as string,
      refresh: tokens.refreshToken as string,
    };
  };
  const logout = async (refresh: string, slug = store.slug) => {
    const response = await customerRequest(slug, "auth/logout", null, "POST", {
      refreshToken: refresh,
    });
    assert.equal(response.status, 204);
  };

  const optIn = (slug: string, access: string, body: unknown) =>
    customerRequest(slug, "me/push-device", access, "PUT", body);
  /** Opts in as the app does; returns the installation id used. */
  const subscribe = async (
    access: string,
    label: string,
    installationId: string = randomUUID(),
    slug = store.slug,
  ) => {
    const response = await optIn(slug, access, {
      token: token(label),
      installationId,
    });
    assert.equal(response.status, 200, await response.text());
    return installationId;
  };

  /**
   * `count` more devices of `customerId`, each on its own live session, written as the owner:
   * enough devices for one delivery to need several Expo requests.
   */
  const manyDevices = async (customerId: string, count: number) => {
    const tokens: string[] = [];
    for (let index = 0; index < count; index++) {
      const sessionId = randomUUID();
      await sql(
        store.id,
        `insert into customer_sessions (id, tenant_id, customer_id, refresh_token_hash, expires_at)
         values (?, ?, ?, ?, now() + interval '1 day')`,
        [sessionId, store.id, customerId, Buffer.alloc(32, index % 250)],
      );
      tokens.push(token(`bulk-${customerId.slice(0, 8)}-${index}`));
      await sql(
        store.id,
        `insert into customer_push_devices (tenant_id, customer_id, session_id, installation_id, token)
         values (?, ?, ?, ?, ?)`,
        [store.id, customerId, sessionId, randomUUID(), tokens.at(-1)],
      );
    }
    return tokens;
  };

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
  const messages = (orderId: string) =>
    sql<{ state: string; token: string | null }>(
      store.id,
      `select m.state, v.token
         from push_messages m
         join push_deliveries d on d.id = m.delivery_id
         left join customer_push_devices v on v.id = m.device_id
        where d.order_id = ?`,
      [orderId],
    );
  const countBy = (rows: { state: string }[]) =>
    rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.state] = (counts[row.state] ?? 0) + 1;
      return counts;
    }, {});
  /** Makes the order's pending deliveries due now, as if their backoff had passed. */
  const due = (orderId: string) =>
    sql(
      store.id,
      "update push_deliveries set next_attempt_at = now() where order_id = ? and state = 'PENDING'",
      [orderId],
    );
  /** A placed order of a customer with devices, moved to PREPARING by the store. */
  const queued = async (customerId: string) => {
    const placed = await order(customerId);
    await staffMove(placed.id, "PLACED", "PREPARING");
    return placed;
  };
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
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: "8",
    });
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
    for (const tenantId of [store.id, other.id]) {
      await sql(
        tenantId,
        "update push_messages set state = 'SKIPPED', finished_at = now() where state = 'PENDING'",
      );
      await sql(
        tenantId,
        `update push_deliveries set state = 'SKIPPED', finished_at = now(), claim_id = null,
                claimed_until = null
          where state = 'PENDING'`,
      );
    }
  });

  describe("subscriptions", () => {
    it("registers, reads and removes the opt-in of the signed-in installation", async () => {
      const buyer = await customer();
      const initial = await customerRequest(
        store.slug,
        "me/push-device",
        buyer.access,
      );
      assert.equal(initial.status, 200);
      assert.equal(initial.headers.get("cache-control"), "no-store");
      assert.deepEqual(await json(initial), { enabled: false });

      const installationId = randomUUID();
      for (const [body, paths] of [
        [{}, ["token", "installationId"]],
        [{ token: "abc", installationId }, ["token"]],
        [{ token: "ExponentPushToken[]", installationId }, ["token"]],
        [{ token: "ExponentPushToken[a b]", installationId }, ["token"]],
        [{ token: token("ok") }, ["installationId"]],
        [
          { token: token("ok"), installationId: "device-serial" },
          ["installationId"],
        ],
        [{ token: token("ok"), installationId, platform: "ios" }, ["platform"]],
        [[token("ok")], [""]],
      ] as const) {
        const refused = await optIn(store.slug, buyer.access, body);
        assert.equal(refused.status, 422, JSON.stringify(body));
        assert.deepEqual(
          (await json(refused)).details.errors.map(
            (error: { path: string }) => error.path,
          ),
          paths,
        );
      }
      const anonymous = await optIn(store.slug, "", {
        token: token("x"),
        installationId,
      });
      assert.equal(anonymous.status, 401);

      const accepted = await optIn(store.slug, buyer.access, {
        token: token("first"),
        installationId,
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual(await json(accepted), { enabled: true });
      assert.deepEqual(await devices(buyer.id), [token("first")]);
      assert.deepEqual(
        await json(
          await customerRequest(store.slug, "me/push-device", buyer.access),
        ),
        { enabled: true },
      );

      const badQuery = await customerRequest(
        store.slug,
        "me/push-device?installationId=x",
        buyer.access,
        "DELETE",
      );
      assert.equal(badQuery.status, 422);
      for (let round = 0; round < 2; round++) {
        const removed = await customerRequest(
          store.slug,
          "me/push-device",
          buyer.access,
          "DELETE",
        );
        assert.equal(removed.status, 204, "opting out twice is fine");
      }
      assert.deepEqual(await devices(buyer.id), []);
    });

    it("keeps one row per installation when the Expo token rotates", async () => {
      const buyer = await customer();
      const installation = await subscribe(buyer.access, "rotate-1");
      await subscribe(buyer.access, "rotate-2", installation);
      assert.deepEqual(await devices(buyer.id), [token("rotate-2")]);
    });

    it("moves an installation or a token to the account that subscribed it last", async () => {
      // Same token, another account of the same store.
      const first = await customer();
      const second = await customer();
      await subscribe(first.access, "shared");
      await subscribe(second.access, "shared");
      assert.deepEqual(await devices(first.id), []);
      assert.deepEqual(await devices(second.id), [token("shared")]);

      // The token rotated for A, then B signed in on that installation and opted in.
      const a = await customer();
      const b = await customer();
      const installation = await subscribe(a.access, "switch-old");
      await subscribe(a.access, "switch-new", installation);
      await subscribe(b.access, "switch-new", installation);
      assert.deepEqual(await devices(a.id), []);
      assert.deepEqual(await devices(b.id), [token("switch-new")]);

      // Even a token Expo rotated before the switch, still under A's installation row, goes.
      const c = await customer();
      const d = await customer();
      const reused = await subscribe(c.access, "c-token");
      await subscribe(d.access, "d-token", reused);
      assert.deepEqual(await devices(c.id), []);
      assert.deepEqual(await devices(d.id), [token("d-token")]);
    });

    it("keeps separate installations of one customer and stores apart", async () => {
      const buyer = await customer();
      const phone = await signInAgain(buyer.email);
      await subscribe(buyer.access, "tablet");
      await subscribe(phone.access, "phone");
      assert.deepEqual(await devices(buyer.id), [
        token("phone"),
        token("tablet"),
      ]);

      // Another store's binary is another app: the same text is a separate row there.
      const installation = randomUUID();
      const here = await customer();
      const elsewhere = await customer(other.slug);
      await subscribe(here.access, "two-stores", installation);
      await subscribe(elsewhere.access, "two-stores", installation, other.slug);
      assert.deepEqual(await devices(here.id), [token("two-stores")]);
      assert.deepEqual(await devices(elsewhere.id, other.id), [
        token("two-stores"),
      ]);
      // A token of store A on store B's routes is a 404, as every customer route.
      const crossed = await optIn(other.slug, here.access, {
        token: token("cross"),
        installationId: randomUUID(),
      });
      assert.equal(crossed.status, 404);
    });

    it("ends an installation's subscription at logout and lets the next account release it", async () => {
      const leaving = await customer();
      const installation = await subscribe(leaving.access, "logout");
      await logout(leaving.refresh);
      assert.deepEqual(await devices(leaving.id), []);

      // A previous account whose logout never reached the API still owns the installation; the
      // next account signed in there releases it without opting in itself.
      const stale = await customer();
      await subscribe(stale.access, "stale", installation);
      const next = await customer();
      const status = await json(
        await customerRequest(store.slug, "me/push-device", next.access),
      );
      assert.deepEqual(status, { enabled: false });
      const released = await customerRequest(
        store.slug,
        `me/push-device?installationId=${installation}`,
        next.access,
        "DELETE",
      );
      assert.equal(released.status, 204);
      assert.deepEqual(await devices(stale.id), []);
    });

    it("deletes every device of a deleted account", async () => {
      const deleting = await customer();
      const tablet = await signInAgain(deleting.email);
      await subscribe(deleting.access, "delete-phone");
      await subscribe(tablet.access, "delete-tablet");
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

    it("serializes concurrent registrations of one installation", async () => {
      const installation = randomUUID();
      const accounts = await Promise.all([customer(), customer(), customer()]);
      const responses = await Promise.all(
        accounts.map((account, index) =>
          optIn(store.slug, account.access, {
            token: token(`race-${index}`),
            installationId: installation,
          }),
        ),
      );
      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200, 200],
      );
      const [{ count }] = (await sql<{ count: number }>(
        store.id,
        "select count(*)::int as count from customer_push_devices where installation_id = ?",
        [installation],
      )) as [{ count: number }];
      assert.equal(count, 1);
    });
  });

  it("queues store and system transitions only for customers with a live device", async () => {
    const opted = await customer();
    const silent = await customer();
    await subscribe(opted.access, "queue");
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
    await subscribe(buyer.access, "content");
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
    const sent = sender.sent.flat();
    const message = (body: string) => ({
      to: token("content"),
      title: `Pizzaria ${store.slug}`,
      body,
      data: { type: "order-status", orderId: placed.id },
    });
    assert.deepEqual(sent, [
      message(`Pedido #${placed.number} aceito e em preparo.`),
      message(`Pedido #${placed.number} pronto. Logo sai para entrega.`),
      message(`Pedido #${placed.number} saiu para entrega.`),
      message(`Pedido #${placed.number} entregue. Bom apetite!`),
    ]);
    const text = JSON.stringify(sent);
    for (const personal of ["Cliente Push", "Rua Privada", "4700", "CASH"])
      assert.ok(!text.includes(personal), personal);
    assert.deepEqual(
      (await deliveries(placed.id)).map((row) => row.state),
      ["SENT", "SENT", "SENT", "SENT"],
    );

    const nothing = new FakeSender();
    await push.deliverPending(nothing);
    assert.deepEqual(
      nothing.sent,
      [],
      "settled deliveries are never sent twice",
    );
  });

  describe("partial results of Expo requests", () => {
    it("sends 50 messages in one request", async () => {
      const buyer = await customer();
      const tokens = await manyDevices(buyer.id, 50);
      const placed = await queued(buyer.id);
      const sender = new FakeSender();
      await push.deliverPending(sender);
      assert.deepEqual(
        sender.sent.map((request) => request.length),
        [50],
      );
      assert.deepEqual(sender.tokens.sort(), tokens.sort());
      assert.deepEqual(countBy(await messages(placed.id)), { SENT: 50 });
      assert.equal((await deliveries(placed.id))[0]!.state, "SENT");
    });

    it("sends 150 messages in requests of 100 and 50", async () => {
      const buyer = await customer();
      await manyDevices(buyer.id, 150);
      const placed = await queued(buyer.id);
      const sender = new FakeSender();
      await push.deliverPending(sender);
      assert.deepEqual(
        sender.sent.map((request) => request.length),
        [100, 50],
      );
      assert.equal(new Set(sender.tokens).size, 150);
      assert.deepEqual(countBy(await messages(placed.id)), { SENT: 150 });
    });

    for (const [failure, error] of [
      ["HTTP 429", new PushRequestError("Expo answered 429")],
      ["a timeout", new PushRequestError("Expo request failed")],
    ] as const)
      it(`keeps the accepted first request and retries only the second after ${failure}`, async () => {
        const buyer = await customer();
        await manyDevices(buyer.id, 150);
        const placed = await queued(buyer.id);
        const sender = new FakeSender([
          allOk,
          () => {
            throw error;
          },
        ]);
        await push.deliverPending(sender);
        assert.deepEqual(
          sender.sent.map((request) => request.length),
          [100, 50],
        );
        const accepted = new Set(sender.sent[0]!.map((message) => message.to));
        assert.deepEqual(countBy(await messages(placed.id)), {
          SENT: 100,
          PENDING: 50,
        });
        const [row] = await deliveries(placed.id);
        assert.deepEqual([row!.state, row!.attempts], ["PENDING", 1]);

        // Not due yet: the next pass leaves it alone.
        const early = new FakeSender();
        await push.deliverPending(early);
        assert.deepEqual(early.sent, []);

        await due(placed.id);
        const retry = new FakeSender();
        await push.deliverPending(retry);
        assert.deepEqual(
          retry.sent.map((request) => request.length),
          [50],
        );
        assert.ok(retry.tokens.every((to) => !accepted.has(to)));
        assert.deepEqual(countBy(await messages(placed.id)), { SENT: 150 });
        assert.equal((await deliveries(placed.id))[0]!.state, "SENT");

        const after = new FakeSender();
        await due(placed.id);
        await push.deliverPending(after);
        assert.deepEqual(after.sent, [], "nothing accepted is sent again");
      });

    it("settles mixed tickets one by one and deletes a device Expo no longer knows", async () => {
      const buyer = await customer();
      const tokens = await manyDevices(buyer.id, 4);
      const placed = await queued(buyer.id);
      const outcome = new Map<string, PushTicket>([
        [tokens[0]!, { ok: true }],
        [tokens[1]!, { ok: false, deviceGone: true, retry: false }],
        [tokens[2]!, { ok: false, deviceGone: false, retry: false }],
        [tokens[3]!, { ok: false, deviceGone: false, retry: true }],
      ]);
      const sender = new FakeSender([
        (sent) => sent.map((message) => outcome.get(message.to)!),
      ]);
      await push.deliverPending(sender);
      assert.deepEqual(countBy(await messages(placed.id)), {
        SENT: 1,
        FAILED: 2,
        PENDING: 1,
      });
      assert.deepEqual(
        (await devices(buyer.id)).sort(),
        [tokens[0], tokens[2], tokens[3]].sort(),
      );
      await due(placed.id);
      const retry = new FakeSender();
      await push.deliverPending(retry);
      assert.deepEqual(retry.tokens, [tokens[3]], "only the rate-limited one");
      assert.deepEqual(countBy(await messages(placed.id)), {
        SENT: 2,
        FAILED: 2,
      });
      assert.equal((await deliveries(placed.id))[0]!.state, "SENT");
    });

    it("deletes an unknown device of the first request and still sends the rest", async () => {
      const buyer = await customer();
      await manyDevices(buyer.id, 120);
      const placed = await queued(buyer.id);
      let gone = "";
      const sender = new FakeSender([
        (sent) => {
          gone = sent[0]!.to;
          return sent.map((_, index) =>
            index === 0
              ? { ok: false, deviceGone: true, retry: false }
              : { ok: true },
          );
        },
      ]);
      await push.deliverPending(sender);
      assert.deepEqual(
        sender.sent.map((request) => request.length),
        [100, 20],
      );
      assert.ok(!(await devices(buyer.id)).includes(gone));
      assert.deepEqual(countBy(await messages(placed.id)), {
        SENT: 119,
        FAILED: 1,
      });
    });

    it("gives up after five attempts and expires old deliveries", async () => {
      const buyer = await customer();
      await subscribe(buyer.access, "give-up");
      const placed = await queued(buyer.id);
      const failing = new FakeSender([], () => {
        throw new PushRequestError("Expo answered 503");
      });
      await push.deliverPending(failing);
      const [{ wait }] = (await sql<{ wait: number }>(
        store.id,
        `select extract(epoch from next_attempt_at - now())::int as wait
           from push_deliveries where order_id = ?`,
        [placed.id],
      )) as [{ wait: number }];
      assert.ok(wait > 20 && wait <= 30, `next attempt in ${wait}s`);
      await sql(
        store.id,
        "update push_deliveries set attempts = 4, next_attempt_at = now() where order_id = ?",
        [placed.id],
      );
      await push.deliverPending(failing);
      const [row] = await deliveries(placed.id);
      assert.deepEqual([row!.state, row!.attempts], ["FAILED", 5]);
      assert.deepEqual(countBy(await messages(placed.id)), { FAILED: 1 });

      const late = await queued(buyer.id);
      await sql(
        store.id,
        "update push_deliveries set created_at = now() - interval '31 minutes' where order_id = ?",
        [late.id],
      );
      const sender = new FakeSender();
      await push.deliverPending(sender);
      assert.deepEqual(sender.sent, []);
      assert.equal((await deliveries(late.id))[0]!.state, "EXPIRED");
    });
  });

  describe("session revocation while sending", () => {
    it("sends nothing to a device logged out before the pass", async () => {
      const buyer = await customer();
      await subscribe(buyer.access, "before");
      const placed = await queued(buyer.id);
      await logout(buyer.refresh);
      const sender = new FakeSender();
      await push.deliverPending(sender);
      assert.deepEqual(sender.sent, []);
      assert.equal((await deliveries(placed.id))[0]!.state, "SKIPPED");
    });

    it("sends nothing when the logout commits after the claim and before the request", async () => {
      const buyer = await customer();
      await subscribe(buyer.access, "during");
      const placed = await queued(buyer.id);
      const sender = new FakeSender();
      await push.deliverPending(sender, {
        afterClaim: () => logout(buyer.refresh),
      });
      assert.deepEqual(sender.sent, []);
      assert.deepEqual(countBy(await messages(placed.id)), { SKIPPED: 1 });
      assert.equal((await deliveries(placed.id))[0]!.state, "SKIPPED");
    });

    it("counts a request already made as sent when the logout comes during it", async () => {
      const buyer = await customer();
      await subscribe(buyer.access, "in-flight");
      const placed = await queued(buyer.id);
      const sender = new FakeSender([
        async (sent) => {
          await logout(buyer.refresh);
          return allOk(sent);
        },
      ]);
      await push.deliverPending(sender);
      assert.deepEqual(sender.tokens, [token("in-flight")]);
      assert.equal((await deliveries(placed.id))[0]!.state, "SENT");
      assert.deepEqual(await devices(buyer.id), []);
      await staffMove(placed.id, "PREPARING", "READY");
      assert.equal(
        (await deliveries(placed.id)).length,
        1,
        "nothing new is queued",
      );
    });

    it("stops at a refresh token reuse, which revokes the session", async () => {
      const buyer = await customer();
      await subscribe(buyer.access, "reuse");
      const placed = await queued(buyer.id);
      const rotated = await customerRequest(
        store.slug,
        "auth/refresh",
        null,
        "POST",
        { refreshToken: buyer.refresh },
      );
      assert.equal(rotated.status, 200);
      const reused = await customerRequest(
        store.slug,
        "auth/refresh",
        null,
        "POST",
        { refreshToken: buyer.refresh },
      );
      assert.equal(reused.status, 401);
      const sender = new FakeSender();
      await push.deliverPending(sender);
      assert.deepEqual(sender.sent, []);
      assert.equal((await deliveries(placed.id))[0]!.state, "SKIPPED");
    });

    it("stops when the account is deleted while the delivery is claimed", async () => {
      const buyer = await customer();
      await subscribe(buyer.access, "deleted");
      const placed = await queued(buyer.id);
      const sender = new FakeSender();
      await push.deliverPending(sender, {
        afterClaim: async () => {
          const deleted = await customerRequest(
            store.slug,
            "me",
            buyer.access,
            "DELETE",
            { password: PASSWORD },
          );
          assert.equal(deleted.status, 204);
        },
      });
      assert.deepEqual(sender.sent, []);
      assert.equal((await deliveries(placed.id))[0]!.state, "SKIPPED");
    });

    it("lets one of two workers send a claimed delivery, once", async () => {
      const buyer = await customer();
      await subscribe(buyer.access, "two-workers");
      const placed = await queued(buyer.id);
      const second = new PushService(
        server.app.get(TenantTransactions),
        server.app.get(MikroORM),
        server.app.get(JsonLogger),
        server.app.get(API_CONFIG),
      );
      const claimed = barrier();
      const release = barrier();
      const first = new FakeSender();
      const running = push.deliverPending(first, {
        afterClaim: async () => {
          claimed.open();
          await release.opened;
        },
      });
      await claimed.opened;
      const other = new FakeSender();
      await second.deliverPending(other);
      assert.deepEqual(other.sent, [], "the claim keeps the second worker out");
      release.open();
      await running;
      assert.deepEqual(first.tokens, [token("two-workers")]);
      assert.equal((await deliveries(placed.id))[0]!.state, "SENT");
    });

    it("runs logouts and passes concurrently without deadlocks or duplicates", async () => {
      const buyers = await Promise.all(
        Array.from({ length: 6 }, () => customer()),
      );
      for (const [index, buyer] of buyers.entries())
        await subscribe(buyer.access, `race-${index}`);
      const orders = [];
      for (const buyer of buyers) orders.push(await queued(buyer.id));
      const sender = new FakeSender();
      const errorsBefore = server.logs.filter(
        (line) => line.level === "error",
      ).length;
      await Promise.all([
        push.deliverPending(sender),
        ...buyers.map((buyer) => logout(buyer.refresh)),
      ]);
      assert.equal(
        server.logs.filter((line) => line.level === "error").length,
        errorsBefore,
      );
      assert.equal(new Set(sender.tokens).size, sender.tokens.length);
      for (const placed of orders) {
        const [row] = await deliveries(placed.id);
        assert.ok(["SENT", "SKIPPED"].includes(row!.state), row!.state);
      }
      const all = await devices(buyers[0]!.id);
      assert.deepEqual(all, []);
    });
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
    for (const table of ["push_deliveries", "push_messages"])
      await assert.rejects(
        runInTenant(app, store.id, (em) => em.execute(`delete from ${table}`)),
        { code: INSUFFICIENT_PRIVILEGE },
        table,
      );
    // Without a tenant context nothing is visible (forced RLS), and another store's rows neither.
    for (const table of [
      "customer_push_devices",
      "push_deliveries",
      "push_messages",
    ]) {
      const leaked = await app.em
        .fork()
        .getConnection()
        .execute(`select 1 from ${table}`);
      assert.equal(leaked.length, 0, table);
    }
    const elsewhere = await customer(other.slug);
    await subscribe(elsewhere.access, "rls", randomUUID(), other.slug);
    const visible = await runInTenant(app, store.id, (em) =>
      em.execute("select 1 from customer_push_devices where customer_id = ?", [
        elsewhere.id,
      ]),
    );
    assert.equal(visible.length, 0);
  });
});
