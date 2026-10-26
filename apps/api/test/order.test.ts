import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { json, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import { bearer, insertTenant } from "./staff-fixtures";
import { type OrderStore, seedOrderStore } from "./order-fixtures";
import { HeldTransactions } from "./concurrency";
import { runInTenant } from "../src/tenancy/tenant-transaction";

const PASSWORD = "cliente-senha-forte";
const ADDRESS = {
  label: "Casa",
  postalCode: "01310-100",
  street: "Avenida Paulista",
  number: "1000",
  complement: null,
  district: "Bela Vista",
  city: "São Paulo",
  state: "SP",
  reference: null,
};

describe("M4.3 order quote and creation", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let server: TestServer;
  const stores: Record<
    "a" | "b",
    { id: string; slug: string; catalog: OrderStore }
  > = {
    a: {
      id: "",
      slug: `pedido-a-${randomUUID().slice(0, 8)}`,
      catalog: {} as OrderStore,
    },
    b: {
      id: "",
      slug: `pedido-b-${randomUUID().slice(0, 8)}`,
      catalog: {} as OrderStore,
    },
  };

  const request = (
    slug: string,
    path: string,
    token: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${server.baseUrl}/v1/customer/stores/${slug}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(token),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const quote = (slug: string, token: string, body: unknown) =>
    request(slug, "me/orders/quote", token, body);
  const place = (
    slug: string,
    token: string,
    body: unknown,
    key: string = randomUUID(),
  ) => request(slug, "me/orders", token, body, { "idempotency-key": key });

  /** A new customer of the store, with one saved address. */
  const customer = async (slug: string) => {
    const register = await fetch(
      `${server.baseUrl}/v1/customer/stores/${slug}/auth/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Joana Cliente",
          email: `pedido-${randomUUID()}@teste.invalid`,
          password: PASSWORD,
          phone: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
          privacyPolicyVersion: "2026-10",
        }),
      },
    );
    assert.equal(register.status, 201);
    const { accessToken } = await json(register);
    const saved = await request(slug, "me/addresses", accessToken, ADDRESS);
    assert.equal(saved.status, 201);
    return {
      token: accessToken as string,
      addressId: (await json(saved)).id as string,
    };
  };

  const pizza = (
    catalog: OrderStore,
    overrides: Record<string, unknown> = {},
  ) => ({
    kind: "PIZZA",
    pizza: {
      sizeId: catalog.size,
      mode: "WHOLE",
      flavors: { LEFT: catalog.calabresa },
      crustId: null,
      extras: [],
      removals: [],
      quantity: 1,
      ...overrides,
    },
  });
  const pickup = (
    catalog: OrderStore,
    extra: Record<string, unknown> = {},
  ) => ({
    fulfillment: "PICKUP",
    paymentMethod: "PIX_ON_DELIVERY",
    items: [pizza(catalog)],
    ...extra,
  });

  const sql = <T>(tenantId: string, query: string, params: unknown[] = []) =>
    runInTenant(owner, tenantId, (em) => em.execute<T[]>(query, params));
  const ordersOf = (tenantId: string) =>
    sql<{ count: number }>(
      tenantId,
      "select count(*)::int as count from orders",
    ).then(([row]) => row!.count);
  const setPause = (tenantId: string, paused: boolean) =>
    sql(
      tenantId,
      paused
        ? "insert into store_pauses (tenant_id, paused_until) values (?, null) on conflict (tenant_id) do update set paused_until = null"
        : "delete from store_pauses where tenant_id = ?",
      [tenantId],
    );

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    for (const store of Object.values(stores)) {
      store.id = await insertTenant(owner, store.slug);
      store.catalog = await seedOrderStore(owner, store.id);
    }
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      // Concurrency tests run several requests at once, each with its own transaction.
      DATABASE_POOL_MAX: "8",
    });
  });
  after(async () => {
    await server?.close();
    await owner?.close();
    await database?.drop();
  });

  it("prices a half-and-half pizza with crust, extras and a removal, plus a product and the fee", async () => {
    const { token, addressId } = await customer(stores.a.slug);
    const c = stores.a.catalog;
    const body = {
      fulfillment: "DELIVERY",
      addressId,
      paymentMethod: "CASH",
      changeForCents: 20000,
      items: [
        pizza(c, {
          mode: "HALVES",
          flavors: { LEFT: c.calabresa, RIGHT: c.marguerita },
          crustId: c.crust,
          extras: [{ extraId: c.extra, placement: "LEFT" }],
          removals: [{ ingredientId: c.tomato, placement: "RIGHT" }],
          quantity: 2,
        }),
        { kind: "PRODUCT", productId: c.soda, quantity: 3 },
      ],
      expectedTotalCents: 1,
    };
    const response = await quote(stores.a.slug, token, body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await json(response);
    // HIGHEST 5000 + surcharge 200 + crust 800 + half extra 300 = 6300, twice.
    assert.equal(result.items[0].unitPriceCents, 6300);
    assert.equal(result.items[0].totalCents, 12600);
    assert.equal(result.items[0].snapshot.strategy, "HIGHEST");
    assert.deepEqual(result.items[0].snapshot.flavors, {
      LEFT: { id: c.calabresa, name: "Calabresa", priceCents: 4000 },
      RIGHT: { id: c.marguerita, name: "Marguerita", priceCents: 5000 },
    });
    assert.deepEqual(result.items[0].snapshot.removals, [
      { id: c.tomato, name: "Tomate", placement: "RIGHT" },
    ]);
    assert.deepEqual(result.items[1], {
      kind: "PRODUCT",
      quantity: 3,
      unitPriceCents: 800,
      totalCents: 2400,
      snapshot: {
        product: { id: c.soda, name: "Refrigerante", priceCents: 800 },
      },
    });
    assert.equal(result.itemsSubtotalCents, 15000);
    assert.equal(result.deliveryFeeCents, 700);
    assert.equal(result.discountCents, 0);
    assert.equal(result.totalCents, 15700);
    assert.equal(result.priceChanged, true);
    assert.equal(await ordersOf(stores.a.id), 0, "a quote writes nothing");

    const pickupQuote = await json(
      await quote(stores.a.slug, token, {
        ...pickup(c),
        expectedTotalCents: 4000,
      }),
    );
    assert.equal(pickupQuote.deliveryFeeCents, 0);
    assert.equal(pickupQuote.totalCents, 4000);
    assert.equal(pickupQuote.priceChanged, false);
  });

  it("never takes a price from the app: price fields are refused and a stale total is not placed", async () => {
    const { token } = await customer(stores.a.slug);
    const c = stores.a.catalog;
    const withPrice = await quote(stores.a.slug, token, {
      ...pickup(c),
      items: [{ ...pizza(c), unitPriceCents: 1 }],
    });
    assert.equal(withPrice.status, 422);
    assert.deepEqual((await json(withPrice)).details.errors, [
      { code: "VALIDATION_FAILED", path: "items[0].unitPriceCents" },
    ]);

    const before = await ordersOf(stores.a.id);
    const stale = await place(stores.a.slug, token, {
      ...pickup(c),
      expectedTotalCents: 100,
    });
    assert.equal(stale.status, 409);
    const body = await json(stale);
    assert.equal(body.code, "ORDER_PRICE_CHANGED");
    assert.equal(body.details.totalCents, 4000);
    assert.equal(await ordersOf(stores.a.id), before);

    const placed = await place(stores.a.slug, token, {
      ...pickup(c),
      expectedTotalCents: 4000,
    });
    assert.equal(placed.status, 201);
    assert.equal((await json(placed)).totalCents, 4000);
  });

  it("creates once per key: the same key and body return the same order, another body is a 409", async () => {
    const { token, addressId } = await customer(stores.a.slug);
    const c = stores.a.catalog;
    const key = randomUUID();
    const body = {
      fulfillment: "DELIVERY",
      addressId,
      paymentMethod: "PIX_ON_DELIVERY",
      notes: "  Interfone quebrado  ",
      items: [pizza(c)],
    };
    const first = await place(stores.a.slug, token, body, key);
    assert.equal(first.status, 201);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const order = await json(first);
    assert.equal(order.status, "PLACED");
    assert.equal(order.notes, "Interfone quebrado");
    assert.deepEqual(order.deliveryAddress, {
      ...ADDRESS,
      postalCode: "01310100",
    });
    assert.equal(order.totalCents, 4700);
    assert.ok(Number.isInteger(order.number) && order.number > 0);

    const again = await place(stores.a.slug, token, body, key.toUpperCase());
    assert.equal(again.status, 200);
    assert.deepEqual(await json(again), order);

    const changed = await place(
      stores.a.slug,
      token,
      { ...body, items: [pizza(c, { quantity: 2 })] },
      key,
    );
    assert.equal(changed.status, 409);
    assert.equal((await json(changed)).code, "IDEMPOTENCY_CONFLICT");

    const [keys] = await sql<{ count: number }>(
      stores.a.id,
      "select count(*)::int as count from order_creation_keys where order_id = ?",
      [order.id],
    );
    assert.equal(keys!.count, 1);
  });

  it("returns the order of a repeated key even after the store closed, and refuses new ones", async () => {
    const { token } = await customer(stores.b.slug);
    const c = stores.b.catalog;
    const key = randomUUID();
    const first = await place(stores.b.slug, token, pickup(c), key);
    assert.equal(first.status, 201);
    const order = await json(first);
    await setPause(stores.b.id, true);
    try {
      const retry = await place(stores.b.slug, token, pickup(c), key);
      assert.equal(retry.status, 200);
      assert.equal((await json(retry)).id, order.id);
      const closed = await place(stores.b.slug, token, pickup(c));
      assert.equal(closed.status, 409);
      const body = await json(closed);
      assert.equal(body.code, "STORE_CLOSED");
      assert.equal(body.details.reason, "PAUSED");
      assert.equal((await quote(stores.b.slug, token, pickup(c))).status, 409);
    } finally {
      await setPause(stores.b.id, false);
    }
  });

  it("creates one order when the same key arrives several times at once", async () => {
    const { token } = await customer(stores.a.slug);
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        place(stores.a.slug, token, pickup(stores.a.catalog), key),
      ),
    );
    const statuses = responses.map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 201]);
    const ids = new Set(
      await Promise.all(responses.map(async (r) => (await json(r)).id)),
    );
    assert.equal(ids.size, 1);
    const [row] = await sql<{ count: number }>(
      stores.a.id,
      `select count(*)::int as count from orders o
         join order_creation_keys k on k.order_id = o.id where o.id = ?`,
      [[...ids][0]],
    );
    assert.equal(row!.count, 1);
  });

  it("numbers orders per store without gaps, also under concurrency", async () => {
    const tenant = `numeros-${randomUUID().slice(0, 8)}`;
    const id = await insertTenant(owner, tenant);
    const catalog = await seedOrderStore(owner, id);
    const buyers = await Promise.all(
      Array.from({ length: 4 }, () => customer(tenant)),
    );
    const responses = await Promise.all(
      buyers.flatMap(({ token }) =>
        [1, 2].map(() => place(tenant, token, pickup(catalog))),
      ),
    );
    assert.deepEqual(
      responses.map((response) => response.status),
      Array(8).fill(201),
    );
    const numbers = (
      await Promise.all(responses.map(async (r) => (await json(r)).number))
    ).sort((a, b) => a - b);
    assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("explains every refused order without writing it", async () => {
    const { token, addressId } = await customer(stores.a.slug);
    const other = await customer(stores.a.slug);
    const c = stores.a.catalog;
    const before = await ordersOf(stores.a.id);
    const refused = async (body: unknown) => {
      const response = await place(stores.a.slug, token, body);
      assert.equal(response.status, 422);
      const error = await json(response);
      assert.equal(error.code, "ORDER_INVALID");
      return error.details;
    };

    assert.deepEqual(
      (
        await refused({
          ...pickup(c),
          paymentMethod: "CARD_ON_DELIVERY",
          items: [
            pizza(c, { flavors: { LEFT: c.paused } }),
            { kind: "PRODUCT", productId: c.juice, quantity: 1 },
            pizza(c, { sizeId: c.smallSize, crustId: c.crust }),
          ],
        })
      ).errors,
      [
        { code: "PAYMENT_METHOD_UNAVAILABLE", path: "paymentMethod" },
        {
          code: "PIZZA_FLAVOR_UNAVAILABLE",
          path: "items[0].pizza.flavors.LEFT",
        },
        { code: "PRODUCT_UNAVAILABLE", path: "items[1].productId" },
        { code: "PIZZA_CRUST_UNAVAILABLE", path: "items[2].pizza.crustId" },
      ],
    );
    const minimum = await refused({
      ...pickup(c),
      items: [{ kind: "PRODUCT", productId: c.soda, quantity: 1 }],
    });
    assert.deepEqual(minimum, {
      errors: [{ code: "MINIMUM_ORDER_NOT_REACHED", path: "items" }],
      minimumOrderCents: 3000,
    });
    assert.deepEqual(
      (
        await refused({
          fulfillment: "DELIVERY",
          addressId: other.addressId,
          paymentMethod: "CASH",
          items: [pizza(c)],
        })
      ).errors,
      [{ code: "ADDRESS_NOT_FOUND", path: "addressId" }],
    );
    assert.deepEqual(
      (
        await refused({
          ...pickup(c),
          paymentMethod: "CASH",
          changeForCents: 3999,
        })
      ).errors,
      [{ code: "CHANGE_FOR_TOO_LOW", path: "changeForCents" }],
    );

    const malformed = await request(stores.a.slug, "me/orders", token, {
      fulfillment: "DELIVERY",
      paymentMethod: "PIX_ON_DELIVERY",
      changeForCents: 5000,
      items: [],
    });
    assert.equal(malformed.status, 422);
    assert.deepEqual(
      (await json(malformed)).details.errors.map(
        (e: { path: string }) => e.path,
      ),
      ["Idempotency-Key", "addressId", "changeForCents", "items"],
    );
    assert.equal(
      (await place(stores.a.slug, token, { ...pickup(c), addressId })).status,
      422,
    );
    assert.equal(await ordersOf(stores.a.id), before);
  });

  it("keeps the snapshot when the catalog and the address change afterwards", async () => {
    const { token, addressId } = await customer(stores.a.slug);
    const c = stores.a.catalog;
    const placed = await json(
      await place(stores.a.slug, token, {
        fulfillment: "DELIVERY",
        addressId,
        paymentMethod: "CASH",
        items: [pizza(c, { crustId: c.crust })],
      }),
    );
    await sql(
      stores.a.id,
      "update catalog_flavors set name = 'Calabresa Nova' where id = ?",
      [c.calabresa],
    );
    await sql(
      stores.a.id,
      "update catalog_flavor_prices set price_cents = 9900 where flavor_id = ? and size_id = ?",
      [c.calabresa, c.size],
    );
    const moved = await fetch(
      `${server.baseUrl}/v1/customer/stores/${stores.a.slug}/me/addresses/${addressId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify({ ...ADDRESS, street: "Rua Nova" }),
      },
    );
    assert.equal(moved.status, 200);
    try {
      const [row] = await sql<{
        address: { street: string };
        snapshot: { flavors: { LEFT: { name: string; priceCents: number } } };
        total: number;
      }>(
        stores.a.id,
        `select o.delivery_address as address, i.snapshot, o.total_cents as total
           from orders o join order_items i on i.order_id = o.id where o.id = ?`,
        [placed.id],
      );
      assert.equal(row!.address.street, "Avenida Paulista");
      assert.deepEqual(row!.snapshot.flavors.LEFT, {
        id: c.calabresa,
        name: "Calabresa",
        priceCents: 4000,
      });
      assert.equal(row!.total, 5500);
    } finally {
      await sql(
        stores.a.id,
        "update catalog_flavors set name = 'Calabresa' where id = ?",
        [c.calabresa],
      );
      await sql(
        stores.a.id,
        "update catalog_flavor_prices set price_cents = 4000 where flavor_id = ? and size_id = ?",
        [c.calabresa, c.size],
      );
    }
  });

  it("anonymizes the customer's orders when the account is deleted, keeping items and totals", async () => {
    const { token, addressId } = await customer(stores.a.slug);
    const c = stores.a.catalog;
    const placed = await json(
      await place(stores.a.slug, token, {
        fulfillment: "DELIVERY",
        addressId,
        paymentMethod: "CASH",
        notes: "Portão azul",
        items: [pizza(c)],
      }),
    );
    const deleted = await fetch(
      `${server.baseUrl}/v1/customer/stores/${stores.a.slug}/me`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify({ password: PASSWORD }),
      },
    );
    assert.equal(deleted.status, 204);
    const [row] = await sql<Record<string, unknown>>(
      stores.a.id,
      `select customer_name, customer_phone, delivery_address, notes, total_cents,
              anonymized_at is not null as anonymized,
              (select count(*)::int from order_items i where i.order_id = o.id) as items
         from orders o where id = ?`,
      [placed.id],
    );
    assert.deepEqual(row, {
      customer_name: null,
      customer_phone: null,
      delivery_address: null,
      notes: null,
      total_cents: 4700,
      anonymized: true,
      items: 1,
    });
  });

  it("refuses orders in a suspended store", async () => {
    const tenant = `suspensa-${randomUUID().slice(0, 8)}`;
    const id = await insertTenant(owner, tenant);
    const catalog = await seedOrderStore(owner, id);
    const { token } = await customer(tenant);
    await owner.em
      .getConnection()
      .execute("update tenants set status = 'SUSPENDED' where id = ?", [id]);
    const response = await place(tenant, token, pickup(catalog));
    assert.equal(response.status, 403);
    assert.equal((await json(response)).code, "TENANT_NOT_ACTIVE");
  });

  it("never leaves a placed order behind a suspension that was in progress", async () => {
    const tenant = `corrida-${randomUUID().slice(0, 8)}`;
    const id = await insertTenant(owner, tenant);
    const catalog = await seedOrderStore(owner, id);
    const { token } = await customer(tenant);
    const held = new HeldTransactions(owner);
    try {
      // The suspension holds the tenant row, as whiteoven_change_tenant_status does.
      const suspension = await held.hold((em) =>
        em.execute(
          "update tenants set status = 'SUSPENDED' where id = ? returning id",
          [id],
        ),
      );
      const pending = place(tenant, token, pickup(catalog));
      await held.lockWaiters(1);
      suspension.commit();
      await suspension.done;
      const response = await pending;
      assert.equal(response.status, 403);
      assert.equal((await json(response)).code, "TENANT_NOT_ACTIVE");
      assert.equal(await ordersOf(id), 0);
    } finally {
      held.releaseAll();
    }
  });

  it("keeps each store's catalog, addresses and orders to itself", async () => {
    const a = await customer(stores.a.slug);
    const b = await customer(stores.b.slug);
    const crossed = await place(stores.a.slug, a.token, {
      fulfillment: "DELIVERY",
      addressId: b.addressId,
      paymentMethod: "CASH",
      items: [
        pizza(stores.b.catalog),
        { kind: "PRODUCT", productId: stores.b.catalog.soda, quantity: 1 },
      ],
    });
    assert.equal(crossed.status, 422);
    assert.deepEqual((await json(crossed)).details.errors, [
      { code: "ADDRESS_NOT_FOUND", path: "addressId" },
      { code: "PIZZA_SIZE_UNAVAILABLE", path: "items[0].pizza.sizeId" },
      { code: "PIZZA_FLAVOR_UNAVAILABLE", path: "items[0].pizza.flavors.LEFT" },
      { code: "PRODUCT_UNAVAILABLE", path: "items[1].productId" },
    ]);
    for (const response of [
      await place(stores.b.slug, a.token, pickup(stores.b.catalog)),
      await quote(stores.b.slug, a.token, pickup(stores.b.catalog)),
    ])
      assert.equal(response.status, 404);
  });

  it("keeps values immutable and keys complete in the database", async () => {
    const { token } = await customer(stores.a.slug);
    const order = await json(
      await place(stores.a.slug, token, pickup(stores.a.catalog)),
    );
    const app = await database.connect(database.appUrl);
    try {
      const asApp = (query: string, params: unknown[]) =>
        runInTenant(app, stores.a.id, (em) => em.execute(query, params));
      for (const query of [
        "update orders set total_cents = 1 where id = ?",
        "update order_items set unit_price_cents = 1 where order_id = ?",
        "delete from order_items where order_id = ?",
        "delete from orders where id = ?",
        "delete from order_creation_keys where order_id = ?",
      ])
        await assert.rejects(
          asApp(query, [order.id]),
          (error: { code?: string }) => error.code === "42501",
          query,
        );
      await assert.rejects(
        asApp(
          `insert into order_creation_keys (tenant_id, scope, key_hash, request_hash, order_id, expires_at)
           values (current_setting('app.tenant_id')::uuid, null, ?, ?, ?, now() + interval '1 day')`,
          [Buffer.alloc(32, 1), Buffer.alloc(32, 2), order.id],
        ),
        (error: { code?: string }) => error.code === "23502",
      );
    } finally {
      await app.close();
    }
  });
});
