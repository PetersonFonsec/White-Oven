import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { json, metricValue, startTestServer, type TestServer } from "./helpers";
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
import { type OrderStore, seedOrderStore } from "./order-fixtures";
import { HeldTransactions } from "./concurrency";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import { TenantTransactions } from "../src/tenancy/tenant-transaction";
import { MikroORM } from "@mikro-orm/postgresql";
import { JsonLogger } from "../src/logging/json-logger";
import { ApiMetrics } from "../src/observability/metrics";
import {
  ORDER_TIMEOUT_BATCH_SIZE,
  OrderService,
} from "../src/order/order.service";

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
  /**
   * Places an order as the app does: the customer confirms the total of a quote first. A body
   * that already names `expectedTotalCents` is sent as is; when the quote fails, 0 is sent so the
   * creation answers its own error.
   */
  const place = async (
    slug: string,
    token: string,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) => {
    let confirmed = body;
    if (!("expectedTotalCents" in body)) {
      const quoted = await quote(slug, token, body);
      confirmed = {
        ...body,
        expectedTotalCents:
          quoted.status === 200 ? (await json(quoted)).totalCents : 0,
      };
    }
    return request(slug, "me/orders", token, confirmed, {
      "idempotency-key": key,
    });
  };

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
          termsOfUseVersion: "2026-10",
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

  const admin = async (
    tenantId: string,
    role: "OWNER" | "MANAGER" | "STAFF" = "OWNER",
  ) => {
    const email = `order-admin-${randomUUID()}@teste.invalid`;
    const userId = await insertStaffUser(owner, email, PASSWORD);
    await insertMembership(owner, tenantId, userId, role);
    const loggedIn = await staffLogin(server.baseUrl, email, PASSWORD);
    const selected = await switchTenant(
      server.baseUrl,
      loggedIn.accessToken,
      tenantId,
    );
    assert.equal(selected.status, 200);
    return (await json(selected)).accessToken as string;
  };

  const staffTransition = (
    token: string,
    orderId: string,
    body: Record<string, unknown>,
    key = randomUUID(),
  ) =>
    fetch(`${server.baseUrl}/v1/admin/orders/${orderId}/transitions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(token),
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
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

  it("asks for the confirmed total to place an order, not to quote one", async () => {
    const { token } = await customer(stores.a.slug);
    const c = stores.a.catalog;
    const quoted = await quote(stores.a.slug, token, pickup(c));
    assert.equal(quoted.status, 200);
    assert.equal((await json(quoted)).priceChanged, false);

    const before = await ordersOf(stores.a.id);
    for (const expected of [undefined, null, -1, 1.5, "4000", 10_000_001]) {
      const body: Record<string, unknown> = { ...pickup(c) };
      if (expected !== undefined) body["expectedTotalCents"] = expected;
      const response = await request(stores.a.slug, "me/orders", token, body, {
        "idempotency-key": randomUUID(),
      });
      assert.equal(response.status, 422, String(expected));
      const error = await json(response);
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.deepEqual(error.details.errors, [
        { code: "VALIDATION_FAILED", path: "expectedTotalCents" },
      ]);
    }
    assert.equal(await ordersOf(stores.a.id), before);

    const first = await place(stores.a.slug, token, {
      ...pickup(c),
      expectedTotalCents: 4000,
    });
    assert.equal(first.status, 201);
    const stale = await place(stores.a.slug, token, {
      ...pickup(c),
      expectedTotalCents: 3999,
    });
    assert.equal(stale.status, 409);
    assert.equal((await json(stale)).code, "ORDER_PRICE_CHANGED");
    const next = await place(stores.a.slug, token, {
      ...pickup(c),
      expectedTotalCents: 4000,
    });
    assert.equal(next.status, 201);
    assert.equal(
      (await json(next)).number,
      (await json(first)).number + 1,
      "a refused price consumes no number",
    );
  });

  it("returns the original order to a retry after the catalog price changed", async () => {
    const { token } = await customer(stores.a.slug);
    const c = stores.a.catalog;
    const key = randomUUID();
    const body = { ...pickup(c), expectedTotalCents: 4000 };
    const first = await place(stores.a.slug, token, body, key);
    assert.equal(first.status, 201);
    const order = await json(first);
    await sql(
      stores.a.id,
      "update catalog_flavor_prices set price_cents = 4500 where flavor_id = ? and size_id = ?",
      [c.calabresa, c.size],
    );
    try {
      const retry = await place(stores.a.slug, token, body, key);
      assert.equal(retry.status, 200);
      assert.deepEqual(await json(retry), order);
      const fresh = await place(stores.a.slug, token, body);
      assert.equal(fresh.status, 409);
      const error = await json(fresh);
      assert.equal(error.code, "ORDER_PRICE_CHANGED");
      assert.equal(error.details.totalCents, 4500);
    } finally {
      await sql(
        stores.a.id,
        "update catalog_flavor_prices set price_cents = 4000 where flavor_id = ? and size_id = ?",
        [c.calabresa, c.size],
      );
    }
  });

  it("refuses amounts above R$ 100.000,00 with a domain error and stores nothing", async () => {
    const tenant = `limite-${randomUUID().slice(0, 8)}`;
    const id = await insertTenant(owner, tenant);
    const catalog = await seedOrderStore(owner, id);
    const product = async (name: string, cents: number) => {
      const [row] = await sql<{ id: string }>(
        id,
        `insert into catalog_simple_products (tenant_id, category_id, name, price_cents)
         select ?, category_id, ?, ? from catalog_simple_products where id = ? returning id`,
        [id, name, cents, catalog.soda],
      );
      return row!.id;
    };
    const atLimit = await product("Caro", 500_000);
    const over = await product("Caríssimo", 600_000);
    const largest = await product("Máximo", 2_147_483_647);
    const { token, addressId } = await customer(tenant);
    const line = (productId: string, quantity = 20) => ({
      kind: "PRODUCT",
      productId,
      quantity,
    });

    const exact = await place(tenant, token, {
      ...pickup(catalog),
      items: [line(atLimit)],
    });
    assert.equal(exact.status, 201);
    assert.equal((await json(exact)).totalCents, 10_000_000);

    for (const [body, path] of [
      [{ ...pickup(catalog), items: [line(over)] }, "items[0]"],
      [{ ...pickup(catalog), items: [line(largest)] }, "items[0]"],
      [
        { ...pickup(catalog), items: [line(atLimit), line(catalog.soda, 1)] },
        "items",
      ],
      [
        {
          fulfillment: "DELIVERY",
          addressId,
          paymentMethod: "CASH",
          items: [line(atLimit)],
        },
        "items",
      ],
    ] as const) {
      for (const response of [
        await quote(tenant, token, body),
        await place(tenant, token, { ...body }),
      ]) {
        assert.equal(response.status, 422, path);
        const error = await json(response);
        assert.equal(error.code, "ORDER_INVALID");
        assert.deepEqual(error.details, {
          errors: [{ code: "ORDER_TOTAL_EXCEEDED", path }],
          maxTotalCents: 10_000_000,
        });
      }
    }
    assert.equal(await ordersOf(id), 1);
  });

  it("creates once per key: the same key and body return the same order, another body is a 409", async () => {
    const { token, addressId } = await customer(stores.a.slug);
    const metrics = server.app.get(ApiMetrics);
    const created = () =>
      metricValue(metrics.render(), "whiteoven_orders_created_total", {
        tenant: stores.a.id,
      });
    const createdBefore = created();
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
    // M7.4: the replay and the conflict are not new orders.
    assert.equal(created() - createdBefore, 1);

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
    // A retry resends the very body of the first attempt, confirmed total included.
    const body = { ...pickup(c), expectedTotalCents: 4000 };
    const first = await place(stores.b.slug, token, body, key);
    assert.equal(first.status, 201);
    const order = await json(first);
    await setPause(stores.b.id, true);
    try {
      const retry = await place(stores.b.slug, token, body, key);
      assert.equal(retry.status, 200);
      assert.equal((await json(retry)).id, order.id);
      const closed = await place(stores.b.slug, token, body);
      assert.equal(closed.status, 409);
      const error = await json(closed);
      assert.equal(error.code, "STORE_CLOSED");
      assert.equal(error.details.reason, "PAUSED");
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
    const refused = async (body: Record<string, unknown>) => {
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
      [
        "Idempotency-Key",
        "addressId",
        "changeForCents",
        "expectedTotalCents",
        "items",
      ],
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

  it("lists and reads recent orders for staff in the active store", async () => {
    const { token } = await customer(stores.a.slug);
    const staffToken = await admin(stores.a.id, "STAFF");
    const placed = await json(
      await place(stores.a.slug, token, pickup(stores.a.catalog)),
    );
    const response = await fetch(
      `${server.baseUrl}/v1/admin/orders?section=active`,
      {
        headers: bearer(staffToken),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const list = (
      (await json(response)) as { orders: Record<string, unknown>[] }
    ).orders;
    const listed = list.find((entry) => entry["id"] === placed.id);
    assert.ok(listed);
    assert.equal(listed["customerName"], "Joana Cliente");
    assert.equal(listed["status"], "PLACED");
    assert.ok(Array.isArray(listed["items"]));
    assert.equal((listed["items"] as unknown[]).length, 1);
    assert.ok(Array.isArray(listed["history"]));

    const detail = await fetch(
      `${server.baseUrl}/v1/admin/orders/${placed.id}`,
      { headers: bearer(staffToken) },
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.headers.get("cache-control"), "no-store");
    assert.equal((await json(detail)).id, placed.id);

    const otherStoreStaff = await admin(stores.b.id, "STAFF");
    const otherStoreOrders = await fetch(
      `${server.baseUrl}/v1/admin/orders?section=active&cursor=1`,
      {
        headers: bearer(otherStoreStaff),
      },
    );
    assert.equal(otherStoreOrders.status, 200);
    assert.equal(
      (
        (await json(otherStoreOrders)) as { orders: Record<string, unknown>[] }
      ).orders.some((entry) => entry["id"] === placed.id),
      false,
    );

    const baseNumber = (
      await runInTenant(owner, stores.a.id, (em) =>
        em.execute<{ number: number }[]>(
          "select number from orders where id = ?",
          [placed.id],
        ),
      )
    )[0]!.number;
    await runInTenant(owner, stores.a.id, async (em) => {
      await em.execute(
        `with seed as (select * from orders where id = ?)
         insert into orders (tenant_id, number, customer_id, customer_name, customer_phone,
           fulfillment, delivery_address, payment_method, change_for_cents, notes,
           items_subtotal_cents, delivery_fee_cents, discount_cents, total_cents, status,
           placed_at, updated_at)
         select seed.tenant_id, ? + n, seed.customer_id, seed.customer_name, seed.customer_phone,
           seed.fulfillment, seed.delivery_address, seed.payment_method, seed.change_for_cents,
           seed.notes, seed.items_subtotal_cents, seed.delivery_fee_cents, seed.discount_cents,
           seed.total_cents, 'PLACED', seed.placed_at + n * interval '1 second', now()
           from seed cross join generate_series(1, 205) n`,
        [placed.id, baseNumber],
      );
      await em.execute(
        `insert into order_items (tenant_id, order_id, position, kind, quantity,
           unit_price_cents, total_cents, snapshot)
         select copy.tenant_id, copy.id, item.position, item.kind, item.quantity,
           item.unit_price_cents, item.total_cents, item.snapshot
           from orders source join order_items item on item.order_id = source.id
           join orders copy on copy.tenant_id = source.tenant_id
             and copy.number between ? + 1 and ? + 205
          where source.id = ?`,
        [baseNumber, baseNumber, placed.id],
      );
      await em.execute(
        "update orders set status = 'COMPLETED' where number between ? and ? and tenant_id = ?",
        [baseNumber + 201, baseNumber + 205, stores.a.id],
      );
      await em.execute(
        "update tenant_order_counters set last_number = ? where tenant_id = ?",
        [baseNumber + 205, stores.a.id],
      );
    });

    const visited = new Set<string>();
    const numbers: number[] = [];
    let cursor: number | undefined;
    let pages = 0;
    do {
      const params = new URLSearchParams({ section: "active" });
      if (cursor !== undefined) params.set("cursor", String(cursor));
      const pageResponse = await fetch(
        `${server.baseUrl}/v1/admin/orders?${params}`,
        {
          headers: bearer(staffToken),
        },
      );
      assert.equal(pageResponse.status, 200);
      assert.equal(pageResponse.headers.get("cache-control"), "no-store");
      const page = (await json(pageResponse)) as {
        orders: Record<string, unknown>[];
        nextCursor: number | null;
      };
      assert.ok(page.orders.length <= 100);
      for (const entry of page.orders) {
        assert.equal(
          visited.has(String(entry["id"])),
          false,
          "no order appears on two pages",
        );
        visited.add(String(entry["id"]));
        numbers.push(Number(entry["number"]));
      }
      pages++;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    assert.ok(pages >= 3);
    assert.ok(
      numbers.every(
        (number, index) => index === 0 || numbers[index - 1]! < number,
      ),
      "active cursor pages prioritize oldest orders in stable ascending number order",
    );
    const closed = await fetch(
      `${server.baseUrl}/v1/admin/orders?section=closed`,
      {
        headers: bearer(staffToken),
      },
    );
    const closedPage = (await json(closed)) as {
      orders: Record<string, unknown>[];
    };
    assert.ok(
      closedPage.orders.length >= 5,
      "closed history has its own page independent of active orders",
    );
    assert.ok(
      visited.has(placed.id),
      "the original active order remains reachable after older pages are loaded",
    );
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
      // A confirmed total goes straight to the creation, which waits on the tenant row.
      const pending = place(tenant, token, {
        ...pickup(catalog),
        expectedTotalCents: 4000,
      });
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
        "update order_status_changes set reason_text = 'hijacked' where order_id = ?",
        "delete from order_status_changes where order_id = ?",
        "update billing_entries set total_cents = 1 where order_id = ?",
        "delete from billing_entries where order_id = ?",
        `insert into billing_entries (tenant_id, order_id, type, items_subtotal_cents, delivery_fee_cents,
           total_cents, payment_method, paid_online, period)
         values (current_setting('app.tenant_id')::uuid, ?, 'ORDER_COMPLETED', 1, 0, 1, 'CASH', false, '2026-10')`,
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

  it("enforces transition idempotency and conflicts through I1–I8", async () => {
    const { token } = await customer(stores.a.slug);
    const staffToken = await admin(stores.a.id);
    const order = async () =>
      json(await place(stores.a.slug, token, pickup(stores.a.catalog)));
    const historyCount = async (orderId: string) => {
      const [row] = await sql<{ count: number }>(
        stores.a.id,
        "select count(*)::int as count from order_status_changes where order_id = ?",
        [orderId],
      );
      return row!.count;
    };

    // I1: the first action moves the order to PREPARING.
    const firstOrder = await order();
    const k1 = randomUUID();
    const accept = { from: "PLACED", to: "PREPARING" };
    const accepted = await staffTransition(
      staffToken,
      firstOrder.id,
      accept,
      k1,
    );
    assert.equal(accepted.status, 200);
    const acceptedBody = await json(accepted);
    assert.equal(acceptedBody.order.status, "PREPARING");

    // M7.4: one committed change counts once, whatever the retries.
    const preparing = () =>
      metricValue(
        server.app.get(ApiMetrics).render(),
        "whiteoven_order_transitions_total",
        { tenant: stores.a.id, to: "PREPARING", actor: "STAFF" },
      );
    const preparingAfterAccept = preparing();
    assert.ok(preparingAfterAccept >= 1);

    // I2: retry returns the original transition without appending history.
    const retry = await staffTransition(staffToken, firstOrder.id, accept, k1);
    assert.equal(retry.status, 200);
    const immediateRetry = await json(retry);
    assert.deepEqual(immediateRetry.change, acceptedBody.change);
    assert.deepEqual(immediateRetry.order, acceptedBody.order);
    assert.equal(await historyCount(firstOrder.id), 2); // initial PLACED + I1
    assert.equal(preparing(), preparingAfterAccept);

    // I3: an old successful retry returns its original change and current order state.
    const advanced = await staffTransition(staffToken, firstOrder.id, {
      from: "PREPARING",
      to: "READY",
    });
    assert.equal(advanced.status, 200);
    const oldRetry = await json(
      await staffTransition(staffToken, firstOrder.id, accept, k1),
    );
    assert.equal(oldRetry.order.status, "READY");
    assert.deepEqual(oldRetry.change, acceptedBody.change);

    // I4: a key cannot be reused for another command.
    const reused = await staffTransition(
      staffToken,
      firstOrder.id,
      { from: "PLACED", to: "REJECTED", reasonCode: "ITEM_UNAVAILABLE" },
      k1,
    );
    assert.equal(reused.status, 409);
    assert.equal((await json(reused)).code, "IDEMPOTENCY_KEY_REUSED");

    // I5: a new command using an old `from` state receives the current state.
    const stale = await staffTransition(staffToken, firstOrder.id, {
      from: "PLACED",
      to: "REJECTED",
      reasonCode: "ITEM_UNAVAILABLE",
    });
    assert.equal(stale.status, 409);
    const staleError = await json(stale);
    assert.equal(staleError.code, "ORDER_STATE_CONFLICT");
    assert.equal(staleError.details.currentStatus, "READY");

    // I6: accepting and refusing concurrently allows exactly one command.
    const competingOrder = await order();
    const [acceptRace, rejectRace] = await Promise.all([
      staffTransition(staffToken, competingOrder.id, accept),
      staffTransition(staffToken, competingOrder.id, {
        from: "PLACED",
        to: "REJECTED",
        reasonCode: "ITEM_UNAVAILABLE",
      }),
    ]);
    assert.deepEqual([acceptRace.status, rejectRace.status].sort(), [200, 409]);
    const conflict = acceptRace.status === 409 ? acceptRace : rejectRace;
    assert.equal((await json(conflict)).code, "ORDER_STATE_CONFLICT");

    // I7: concurrent retries with the same key produce one history row.
    const retryOrder = await order();
    const retryKey = randomUUID();
    const duplicateResponses = await Promise.all(
      Array.from({ length: 2 }, () =>
        staffTransition(staffToken, retryOrder.id, accept, retryKey),
      ),
    );
    assert.deepEqual(
      duplicateResponses.map((response) => response.status),
      [200, 200],
    );
    const duplicateBodies = await Promise.all(
      duplicateResponses.map((response) => json(response)),
    );
    assert.deepEqual(duplicateBodies[0].change, duplicateBodies[1].change);
    assert.deepEqual(duplicateBodies[0].order, duplicateBodies[1].order);
    assert.equal(await historyCount(retryOrder.id), 2);

    // I8: running the tenant job twice records one timeout rejection.
    const timedOutOrder = await order();
    await sql(
      stores.a.id,
      "update orders set placed_at = now() - interval '2 hours' where id = ?",
      [timedOutOrder.id],
    );
    const service = server.app.get(OrderService) as unknown as {
      rejectExpiredOrders(): Promise<void>;
    };
    await service.rejectExpiredOrders();
    await service.rejectExpiredOrders();
    const timedOut = await runInTenant(owner, stores.a.id, (em) =>
      em.execute<{ status: string; rejection_reason: string }[]>(
        "select status,rejection_reason from orders where id = ?",
        [timedOutOrder.id],
      ),
    );
    assert.deepEqual(timedOut[0], {
      status: "REJECTED",
      rejection_reason: "ACCEPT_TIMEOUT",
    });
    assert.equal(await historyCount(timedOutOrder.id), 2);
  });

  it("rejects overdue orders in bounded batches across concurrent job instances", async () => {
    const tenant = `lotes-${randomUUID().slice(0, 8)}`;
    const tenantId = await insertTenant(owner, tenant);
    const catalog = await seedOrderStore(owner, tenantId);
    const { token } = await customer(tenant);
    const count = ORDER_TIMEOUT_BATCH_SIZE + 2;
    const responses = await Promise.all(
      Array.from({ length: count }, () =>
        place(tenant, token, {
          ...pickup(catalog),
          expectedTotalCents: 4000,
        }),
      ),
    );
    assert.ok(responses.every((response) => response.status === 201));
    await sql(
      tenantId,
      "update orders set placed_at = now() - interval '2 hours'",
    );

    const serviceA = server.app.get(OrderService) as unknown as {
      rejectExpiredOrders(): Promise<void>;
    };
    const serviceB = new OrderService(
      server.app.get(TenantTransactions),
      server.app.get(MikroORM),
      server.app.get(JsonLogger),
      server.app.get(ApiMetrics),
    ) as unknown as { rejectExpiredOrders(): Promise<void> };
    await Promise.all([
      serviceA.rejectExpiredOrders(),
      serviceB.rejectExpiredOrders(),
    ]);

    const [states] = await sql<{ pending: number; rejected: number }>(
      tenantId,
      `select count(*) filter (where status='PLACED')::int as pending,
              count(*) filter (where status='REJECTED' and rejection_reason='ACCEPT_TIMEOUT')::int as rejected
         from orders`,
    );
    assert.deepEqual(states, { pending: 0, rejected: count });
    const [history] = await sql<{ timeouts: number; duplicates: number }>(
      tenantId,
      `select count(*) filter (where reason_code='ACCEPT_TIMEOUT')::int as timeouts,
              count(*) filter (where reason_code='ACCEPT_TIMEOUT')::int - count(distinct order_id)
                filter (where reason_code='ACCEPT_TIMEOUT')::int as duplicates
         from order_status_changes`,
    );
    assert.deepEqual(history, { timeouts: count, duplicates: 0 });
    // M7.4: two instances share one registry here; only committed rejections count.
    const text = server.app.get(ApiMetrics).render();
    assert.equal(
      metricValue(text, "whiteoven_order_transitions_total", {
        tenant: tenantId,
        to: "REJECTED",
        actor: "SYSTEM",
      }),
      count,
    );
    assert.equal(
      metricValue(text, "whiteoven_orders_created_total", { tenant: tenantId }),
      count,
    );
  });

  it("skips an order being accepted while the timeout batch runs", async () => {
    const tenant = `aceite-job-${randomUUID().slice(0, 8)}`;
    const tenantId = await insertTenant(owner, tenant);
    const catalog = await seedOrderStore(owner, tenantId);
    const { token } = await customer(tenant);
    const staffToken = await admin(tenantId);
    const order = await json(
      await place(tenant, token, {
        ...pickup(catalog),
        expectedTotalCents: 4000,
      }),
    );
    await sql(
      tenantId,
      "update orders set placed_at = now() - interval '2 hours' where id = ?",
      [order.id],
    );
    const held = new HeldTransactions(owner);
    try {
      const lock = await held.hold(
        (em) =>
          em.execute("select id from orders where id = ? for update", [
            order.id,
          ]),
        tenantId,
      );
      const accepting = staffTransition(staffToken, order.id, {
        from: "PLACED",
        to: "PREPARING",
      });
      await held.lockWaiters(1);
      const service = server.app.get(OrderService) as unknown as {
        rejectExpiredOrders(): Promise<void>;
      };
      await service.rejectExpiredOrders();
      lock.commit();
      await lock.done;
      const accepted = await accepting;
      assert.equal(accepted.status, 200);
      const [row] = await sql<{ status: string; reason: string | null }>(
        tenantId,
        `select o.status, c.reason_code as reason from orders o
           left join order_status_changes c on c.order_id=o.id and c.reason_code='ACCEPT_TIMEOUT'
          where o.id=?`,
        [order.id],
      );
      assert.deepEqual(row, { status: "PREPARING", reason: null });
    } finally {
      held.releaseAll();
    }
  });

  it("continues processing other tenants when one timeout batch fails", async () => {
    const failedTenant = `falha-job-${randomUUID().slice(0, 8)}`;
    const healthyTenant = `saudavel-job-${randomUUID().slice(0, 8)}`;
    const failedId = await insertTenant(owner, failedTenant);
    const healthyId = await insertTenant(owner, healthyTenant);
    const failedCatalog = await seedOrderStore(owner, failedId);
    const healthyCatalog = await seedOrderStore(owner, healthyId);
    const failedCustomer = await customer(failedTenant);
    const healthyCustomer = await customer(healthyTenant);
    const failedOrder = await json(
      await place(failedTenant, failedCustomer.token, {
        ...pickup(failedCatalog),
        expectedTotalCents: 4000,
      }),
    );
    const healthyOrder = await json(
      await place(healthyTenant, healthyCustomer.token, {
        ...pickup(healthyCatalog),
        expectedTotalCents: 4000,
      }),
    );
    await sql(
      failedId,
      "update orders set placed_at = now() - interval '2 hours' where id = ?",
      [failedOrder.id],
    );
    await sql(
      healthyId,
      "update orders set placed_at = now() - interval '2 hours' where id = ?",
      [healthyOrder.id],
    );

    const functionName = `test_timeout_failure_${randomUUID().replaceAll("-", "")}`;
    const triggerName = `${functionName}_trigger`;
    const connection = owner.em.getConnection();
    await connection.execute(`
      create function public.${functionName}() returns trigger language plpgsql as $$
      begin
        if new.tenant_id = '${failedId}'::uuid and new.rejection_reason = 'ACCEPT_TIMEOUT' then
          raise exception 'synthetic timeout batch failure';
        end if;
        return new;
      end $$;
      create trigger ${triggerName} before update of status on public.orders
      for each row execute function public.${functionName}();
    `);
    try {
      const service = server.app.get(OrderService) as unknown as {
        rejectExpiredOrders(): Promise<void>;
      };
      await service.rejectExpiredOrders();
      const [failed] = await sql<{ status: string }>(
        failedId,
        "select status from orders where id = ?",
        [failedOrder.id],
      );
      const [healthy] = await sql<{ status: string }>(
        healthyId,
        "select status from orders where id = ?",
        [healthyOrder.id],
      );
      assert.equal(failed!.status, "PLACED");
      assert.equal(healthy!.status, "REJECTED");
    } finally {
      await connection.execute(
        `drop trigger ${triggerName} on public.orders; drop function public.${functionName}();`,
      );
    }
  });

  it("blocks completion and billing while suspended, allowing only OWNER closures", async () => {
    const tenant = `suspensa-transicao-${randomUUID().slice(0, 8)}`;
    const tenantId = await insertTenant(owner, tenant);
    const catalog = await seedOrderStore(owner, tenantId);
    const { token } = await customer(tenant);
    const ownerToken = await admin(tenantId);
    const managerToken = await admin(tenantId, "MANAGER");
    const staffToken = await admin(tenantId, "STAFF");
    const advance = async (
      orderId: string,
      tokenValue: string,
      from: string,
      to: string,
      reasonCode?: string,
    ) =>
      staffTransition(tokenValue, orderId, {
        from,
        to,
        ...(reasonCode ? { reasonCode } : {}),
      });
    const completionOrder = await json(
      await place(tenant, token, {
        ...pickup(catalog),
        expectedTotalCents: 4000,
      }),
    );
    assert.equal(
      (await advance(completionOrder.id, ownerToken, "PLACED", "PREPARING"))
        .status,
      200,
    );
    assert.equal(
      (await advance(completionOrder.id, ownerToken, "PREPARING", "READY"))
        .status,
      200,
    );
    const managerOrder = await json(
      await place(tenant, token, {
        ...pickup(catalog),
        expectedTotalCents: 4000,
      }),
    );
    assert.equal(
      (await advance(managerOrder.id, ownerToken, "PLACED", "PREPARING"))
        .status,
      200,
    );
    const staffOrder = await json(
      await place(tenant, token, {
        ...pickup(catalog),
        expectedTotalCents: 4000,
      }),
    );
    assert.equal(
      (await advance(staffOrder.id, ownerToken, "PLACED", "PREPARING")).status,
      200,
    );
    const rejectableOrder = await json(
      await place(tenant, token, {
        ...pickup(catalog),
        expectedTotalCents: 4000,
      }),
    );

    await owner.em
      .getConnection()
      .execute("update tenants set status='SUSPENDED' where id=?", [tenantId]);

    const blockedCompletion = await advance(
      completionOrder.id,
      ownerToken,
      "READY",
      "COMPLETED",
    );
    assert.equal(blockedCompletion.status, 403);
    assert.equal((await json(blockedCompletion)).code, "TENANT_NOT_ACTIVE");
    const ownerCancel = await advance(
      completionOrder.id,
      ownerToken,
      "READY",
      "CANCELED",
      "STORE_TOO_BUSY",
    );
    assert.equal(ownerCancel.status, 200);
    const ownerReject = await staffTransition(ownerToken, rejectableOrder.id, {
      from: "PLACED",
      to: "REJECTED",
      reasonCode: "ITEM_UNAVAILABLE",
    });
    assert.equal(ownerReject.status, 200);
    for (const [tokenValue, orderId] of [
      [managerToken, managerOrder.id],
      [staffToken, staffOrder.id],
    ]) {
      const response = await advance(
        orderId!,
        tokenValue!,
        "PREPARING",
        "CANCELED",
        "STORE_TOO_BUSY",
      );
      assert.equal(response.status, 403);
      const [blocked] = await sql<{ status: string; canceled: number }>(
        tenantId,
        `select o.status,
                (select count(*)::int from order_status_changes c
                  where c.order_id=o.id and c.to_status='CANCELED') as canceled
           from orders o where o.id=?`,
        [orderId],
      );
      assert.deepEqual(blocked, { status: "PREPARING", canceled: 0 });
    }
    const [billing] = await sql<{ count: number }>(
      tenantId,
      "select count(*)::int as count from billing_entries",
    );
    assert.equal(billing!.count, 0);
    const [blockedHistory] = await sql<{ count: number }>(
      tenantId,
      `select count(*)::int as count from order_status_changes
        where order_id=? and to_status='COMPLETED'`,
      [completionOrder.id],
    );
    assert.equal(blockedHistory!.count, 0);
  });

  it("lets a customer cancel only a placed order with an idempotent command", async () => {
    const { token } = await customer(stores.a.slug);
    const order = await json(
      await place(stores.a.slug, token, pickup(stores.a.catalog)),
    );
    const key = randomUUID();
    const cancel = () =>
      fetch(
        `${server.baseUrl}/v1/customer/stores/${stores.a.slug}/me/orders/${order.id}/transitions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...bearer(token),
            "idempotency-key": key,
          },
          body: JSON.stringify({
            from: "PLACED",
            to: "CANCELED",
            reasonCode: "CUSTOMER_REQUEST",
          }),
        },
      );
    const first = await cancel();
    assert.equal(first.status, 200);
    assert.equal((await json(first)).order.status, "CANCELED");
    const retry = await cancel();
    assert.equal(retry.status, 200);
    assert.equal((await json(retry)).order.status, "CANCELED");
    await sql(
      stores.a.id,
      "update orders set placed_at = now() - interval '2 hours' where id = ?",
      [order.id],
    );
    const service = server.app.get(OrderService) as unknown as {
      rejectExpiredOrders(): Promise<void>;
    };
    await service.rejectExpiredOrders();
    const [afterJob] = await sql<{ status: string; timeouts: number }>(
      stores.a.id,
      `select o.status,
              (select count(*)::int from order_status_changes c
                where c.order_id=o.id and c.reason_code='ACCEPT_TIMEOUT') as timeouts
         from orders o where o.id=?`,
      [order.id],
    );
    assert.deepEqual(afterJob, { status: "CANCELED", timeouts: 0 });
    const invalid = await fetch(
      `${server.baseUrl}/v1/customer/stores/${stores.a.slug}/me/orders/${order.id}/transitions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...bearer(token),
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ from: "CANCELED", to: "PLACED" }),
      },
    );
    assert.equal(invalid.status, 422);
  });

  it("records one append-only billing event when a pickup order completes", async () => {
    const { token } = await customer(stores.a.slug);
    const staffToken = await admin(stores.a.id);
    const order = await json(
      await place(stores.a.slug, token, pickup(stores.a.catalog)),
    );
    const advance = async (from: string, to: string, key = randomUUID()) =>
      staffTransition(staffToken, order.id, { from, to }, key);
    assert.equal((await advance("PLACED", "PREPARING")).status, 200);
    assert.equal((await advance("PREPARING", "READY")).status, 200);
    const completeKey = randomUUID();
    assert.equal(
      (await advance("READY", "COMPLETED", completeKey)).status,
      200,
    );
    assert.equal(
      (await advance("READY", "COMPLETED", completeKey)).status,
      200,
      "same completion retry returns the original command",
    );
    const [entry] = await sql<{
      count: number;
      type: string;
      totalCents: number;
      plan: string;
      feeBasisPoints: number;
      currentPlan: boolean;
    }>(
      stores.a.id,
      `select count(*)::int as count, min(b.type) as type, min(b.total_cents) as "totalCents",
              min(b.plan) as plan, min(b.fee_basis_points) as "feeBasisPoints",
              bool_and(s.valid_to is null) as "currentPlan"
       from billing_entries b join plan_subscriptions s on s.id = b.subscription_id
       where b.order_id = ?`,
      [order.id],
    );
    assert.deepEqual(entry, {
      count: 1,
      type: "ORDER_COMPLETED",
      totalCents: order.totalCents,
      plan: "FLEX",
      feeBasisPoints: 300,
      currentPlan: true,
    });
  });

  it("rolls the completion back when the store has no plan at that instant", async () => {
    const { token } = await customer(stores.b.slug);
    const staffToken = await admin(stores.b.id);
    const order = await json(
      await place(stores.b.slug, token, pickup(stores.b.catalog)),
    );
    for (const [from, to] of [
      ["PLACED", "PREPARING"],
      ["PREPARING", "READY"],
    ])
      assert.equal(
        (await staffTransition(staffToken, order.id, { from, to })).status,
        200,
      );
    const setPlanEnd = (end: "now()" | "null") =>
      sql(
        stores.b.id,
        `update plan_subscriptions set valid_to = ${end} where valid_to is null or valid_to > now() - interval '1 minute'`,
      );
    await setPlanEnd("now()");
    try {
      const refused = await staffTransition(staffToken, order.id, {
        from: "READY",
        to: "COMPLETED",
      });
      assert.equal(refused.status, 409);
      assert.equal((await json(refused)).code, "PLAN_REQUIRED");
    } finally {
      await setPlanEnd("null");
    }
    const [state] = await sql<{
      status: string;
      completions: number;
      entries: number;
    }>(
      stores.b.id,
      `select o.status,
              (select count(*)::int from order_status_changes c
                where c.order_id = o.id and c.to_status = 'COMPLETED') as completions,
              (select count(*)::int from billing_entries b where b.order_id = o.id) as entries
         from orders o where o.id = ?`,
      [order.id],
    );
    assert.deepEqual(state, { status: "READY", completions: 0, entries: 0 });
  });
});
