import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { operatorMfaReport } from "../src/auth/check-operators-mfa";
import {
  API_SECURITY_HEADERS,
  normalizeIp,
  resolveClientIp,
} from "../src/security/http-security";
import {
  LIMIT_POLICIES,
  type LimitPolicy,
  RequestLimits,
} from "../src/security/request-limits";
import { json, startTestServer, type TestServer } from "./helpers";
import { type OrderStore, seedOrderStore } from "./order-fixtures";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import { bearer, insertStaffUser, insertTenant } from "./staff-fixtures";

const ADMIN_ORIGIN = "https://painel.whiteoven.test";
const MINUTE = 60_000;

describe("request limits (M7.3, ADR 0031)", () => {
  const policies: Record<string, LimitPolicy> = {
    probe: {
      ip: { max: 2, windowMs: MINUTE },
      account: { max: 3, windowMs: 10 * MINUTE },
    },
  };

  it("counts every request per scope and answers the wait of the scope that is exhausted", () => {
    let now = 1_000_000;
    const limits = new RequestLimits(() => now, policies);
    const keys = { ip: "10.0.0.1", account: "ana" };
    assert.equal(limits.consume("probe", keys), 0);
    assert.equal(limits.consume("probe", keys), 0);
    // Third request: the IP (2 per minute) is exhausted, the account (3 per 10 min) is not.
    assert.equal(limits.consume("probe", keys), 60);
    now += 30_000;
    // Fourth: both exhausted; the account's window is the longer wait.
    assert.equal(limits.consume("probe", keys), 570);
    // Another IP of the same account still waits for the account; another account is free.
    assert.equal(
      limits.consume("probe", { ip: "10.0.0.2", account: "ana" }),
      570,
    );
    assert.equal(
      limits.consume("probe", { ip: "10.0.0.3", account: "bia" }),
      0,
    );
    now += 570_000;
    assert.equal(limits.consume("probe", keys), 0);
  });

  it("a refused request counts, so hammering never shortens the wait", () => {
    let now = 0;
    const limits = new RequestLimits(() => now, {
      probe: { ip: { max: 1, windowMs: MINUTE } },
    });
    assert.equal(limits.consume("probe", { ip: "x" }), 0);
    for (let i = 0; i < 50; i++) {
      now += 1000;
      assert.ok(limits.consume("probe", { ip: "x" }) > 0);
    }
    now = MINUTE;
    assert.equal(limits.consume("probe", { ip: "x" }), 0);
  });

  it("refuses an unknown limit or a missing key instead of letting the request through", () => {
    const limits = new RequestLimits(Date.now, policies);
    assert.throws(() => limits.consume("nope", {}), /Unknown request limit/);
    assert.throws(
      () => limits.consume("probe", { ip: "10.0.0.1" }),
      /needs the account key/,
    );
  });

  it("covers refresh, sign-up and order creation per IP and per account", () => {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(LIMIT_POLICIES).map(([name, policy]) => [
          name,
          Object.keys(policy).sort(),
        ]),
      ),
      {
        staffRefresh: ["ip"],
        customerRefresh: ["ip", "storeIp"],
        customerSignup: ["ip", "storeIp"],
        orderQuote: ["account", "storeIp"],
        orderCreate: ["account", "storeIp"],
      },
    );
  });
});

describe("client IP (ADR 0031)", () => {
  const request = (
    peer: string | undefined,
    forwarded?: string | string[],
  ) => ({
    socket: { remoteAddress: peer } as never,
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  });
  const trusted = new Set(["172.30.87.3"]);

  it("is the TCP peer unless the peer is a trusted proxy", () => {
    assert.equal(
      resolveClientIp(request("::ffff:203.0.113.9", "198.51.100.1"), trusted),
      "203.0.113.9",
    );
    assert.equal(
      resolveClientIp(
        request("172.30.87.3", "198.51.100.1, 203.0.113.7"),
        trusted,
      ),
      "203.0.113.7",
    );
    assert.equal(
      resolveClientIp(
        request("172.30.87.3", ["10.0.0.1", "2001:DB8::1"]),
        trusted,
      ),
      "2001:db8::1",
    );
  });

  it("falls back to the peer when the proxy sent no valid address", () => {
    for (const header of [undefined, "", "not-an-ip", "1.2.3.4, evil"])
      assert.equal(
        resolveClientIp(request("172.30.87.3", header), trusted),
        "172.30.87.3",
      );
    assert.equal(resolveClientIp(request(undefined), trusted), "unknown");
    assert.equal(normalizeIp("::ffff:10.1.2.3"), "10.1.2.3");
    assert.equal(normalizeIp("10.1.2.3/8"), "");
  });
});

describe("HTTP security headers and staff refresh limit", () => {
  const limits = () =>
    new RequestLimits(Date.now, {
      ...LIMIT_POLICIES,
      staffRefresh: { ip: { max: 2, windowMs: MINUTE } },
    });
  const refresh = (server: TestServer, forwarded?: string) =>
    fetch(`${server.baseUrl}/v1/admin/auth/refresh`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
      },
    });
  let direct: TestServer;
  let proxied: TestServer;
  before(async () => {
    direct = await startTestServer(
      { API_ADMIN_ORIGINS: ADMIN_ORIGIN },
      { requestLimits: limits() },
    );
    proxied = await startTestServer(
      { API_ADMIN_ORIGINS: ADMIN_ORIGIN, API_TRUSTED_PROXIES: "127.0.0.1" },
      { requestLimits: limits() },
    );
  });
  after(async () => {
    await direct?.close();
    await proxied?.close();
  });

  it("sets the security headers on answers, errors and unknown routes", async () => {
    for (const path of ["/health", "/v1/nao-existe", "/v1/openapi.json"]) {
      const response = await fetch(`${direct.baseUrl}${path}`);
      await response.arrayBuffer();
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS))
        assert.equal(response.headers.get(name), value, `${path} ${name}`);
      assert.equal(response.headers.get("x-powered-by"), null);
    }
  });

  it("limits staff refresh per IP with 429 and Retry-After, keeping the cookie", async () => {
    assert.equal((await refresh(direct)).status, 401);
    assert.equal((await refresh(direct)).status, 401);
    const limited = await refresh(direct);
    assert.equal(limited.status, 429);
    assert.equal((await json(limited)).code, "RATE_LIMITED");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal(limited.headers.get("set-cookie"), null);
  });

  it("ignores X-Forwarded-For from a client that is not a trusted proxy", async () => {
    // `direct` is already exhausted for 127.0.0.1: a forged header does not open a new bucket.
    assert.equal((await refresh(direct, "198.51.100.77")).status, 429);
  });

  it("counts each client behind a trusted proxy separately", async () => {
    for (const client of ["198.51.100.1", "198.51.100.2"]) {
      assert.equal((await refresh(proxied, client)).status, 401);
      assert.equal((await refresh(proxied, client)).status, 401);
    }
    assert.equal((await refresh(proxied, "198.51.100.1")).status, 429);
    assert.equal((await refresh(proxied, "198.51.100.3")).status, 401);
  });
});

describe("customer and order limits against PostgreSQL", databaseSuite, () => {
  let database: TestDatabase;
  let owner: MikroORM;
  let server: TestServer;
  let now = Date.now();
  const stores = {
    a: { id: "", slug: `limite-a-${randomUUID().slice(0, 8)}` },
    b: { id: "", slug: `limite-b-${randomUUID().slice(0, 8)}` },
  };
  let catalog: OrderStore;

  const post = (
    slug: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${server.baseUrl}/v1/customer/stores/${slug}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const register = (slug: string) =>
    post(slug, "auth/register", {
      name: "Cliente Limite",
      email: `limite-${randomUUID()}@teste.invalid`,
      password: "cliente-senha-forte",
      privacyPolicyVersion: "2026-10",
      termsOfUseVersion: "2026-10",
    });
  const order = {
    fulfillment: "PICKUP",
    paymentMethod: "PIX_ON_DELIVERY",
    items: [
      {
        kind: "PIZZA",
        pizza: {
          sizeId: "",
          mode: "WHOLE",
          flavors: { LEFT: "" },
          crustId: null,
          extras: [],
          removals: [],
          quantity: 1,
        },
      },
    ],
  };
  const orderBody = () => ({
    ...order,
    items: [
      {
        ...order.items[0]!,
        pizza: {
          ...order.items[0]!.pizza,
          sizeId: catalog.size,
          flavors: { LEFT: catalog.calabresa },
        },
      },
    ],
  });

  const countIn = async (tenantId: string, table: "customers" | "orders") => {
    const [row] = await runInTenant(owner, tenantId, (em) =>
      em.execute<{ count: number }[]>(
        `select count(*)::int as count from ${table}`,
      ),
    );
    return row!.count;
  };

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    stores.a.id = await insertTenant(owner, stores.a.slug);
    stores.b.id = await insertTenant(owner, stores.b.slug);
    catalog = await seedOrderStore(owner, stores.a.id);
    server = await startTestServer(
      { DATABASE_URL: database.appUrl },
      {
        requestLimits: new RequestLimits(() => now, {
          ...LIMIT_POLICIES,
          customerSignup: {
            storeIp: { max: 3, windowMs: 60 * MINUTE },
            ip: { max: 4, windowMs: 60 * MINUTE },
          },
          customerRefresh: {
            storeIp: { max: 2, windowMs: 10 * MINUTE },
            ip: { max: 100, windowMs: 10 * MINUTE },
          },
          orderQuote: {
            account: { max: 2, windowMs: 10 * MINUTE },
            storeIp: { max: 100, windowMs: 10 * MINUTE },
          },
          orderCreate: {
            account: { max: 2, windowMs: 10 * MINUTE },
            storeIp: { max: 100, windowMs: 10 * MINUTE },
          },
        }),
      },
    );
  });
  // Every test starts with fresh windows.
  beforeEach(() => {
    now += 24 * 60 * MINUTE;
  });
  after(async () => {
    await server?.close();
    await owner?.close();
    await database?.drop();
  });

  it("limits sign-ups per IP in the store and across stores", async () => {
    for (let i = 0; i < 3; i++)
      assert.equal((await register(stores.a.slug)).status, 201);
    const limited = await register(stores.a.slug);
    assert.equal(limited.status, 429);
    assert.equal((await json(limited)).code, "RATE_LIMITED");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    // Store B has its own per-store window, but the IP already spent its ceiling across stores.
    assert.equal((await register(stores.b.slug)).status, 429);
    assert.equal(await countIn(stores.a.id, "customers"), 3);
    assert.equal(await countIn(stores.b.id, "customers"), 0);
  });

  it("limits customer refresh per IP in the store", async () => {
    const created = await register(stores.a.slug);
    let { refreshToken } = await json(created);
    for (let i = 0; i < 2; i++) {
      const refreshed = await post(stores.a.slug, "auth/refresh", {
        refreshToken,
      });
      assert.equal(refreshed.status, 200);
      ({ refreshToken } = await json(refreshed));
    }
    const limited = await post(stores.a.slug, "auth/refresh", {
      refreshToken,
    });
    assert.equal(limited.status, 429);
    // The token was not spent: once the window reopens it still rotates.
    now += 10 * MINUTE;
    assert.equal(
      (await post(stores.a.slug, "auth/refresh", { refreshToken })).status,
      200,
    );
  });

  it("limits quotes and orders per customer, without touching other customers", async () => {
    const first = (await json(await register(stores.a.slug))).accessToken;
    const second = (await json(await register(stores.a.slug))).accessToken;
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await post(
            stores.a.slug,
            "me/orders/quote",
            orderBody(),
            bearer(first),
          )
        ).status,
        200,
      );
    assert.equal(
      (await post(stores.a.slug, "me/orders/quote", orderBody(), bearer(first)))
        .status,
      429,
    );

    const place = (token: string) =>
      post(
        stores.a.slug,
        "me/orders",
        { ...orderBody(), expectedTotalCents: 4000 },
        { ...bearer(token), "idempotency-key": randomUUID() },
      );
    assert.equal((await place(first)).status, 201);
    assert.equal((await place(first)).status, 201);
    const limited = await place(first);
    assert.equal(limited.status, 429);
    assert.equal((await json(limited)).code, "RATE_LIMITED");
    assert.equal((await place(second)).status, 201);
    assert.equal(await countIn(stores.a.id, "orders"), 3);
  });

  it("an anonymous flood never spends a customer's order quota", async () => {
    const token = (await json(await register(stores.a.slug))).accessToken;
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await post(stores.a.slug, "me/orders", orderBody(), {
            "idempotency-key": randomUUID(),
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await post(
          stores.a.slug,
          "me/orders",
          { ...orderBody(), expectedTotalCents: 4000 },
          { ...bearer(token), "idempotency-key": randomUUID() },
        )
      ).status,
      201,
    );
  });

  it("reports operators without an active second factor by id only", async () => {
    const app = await database.connect(database.appUrl);
    try {
      const before = await operatorMfaReport(app);
      const email = `operador-${randomUUID()}@teste.invalid`;
      const id = await insertStaffUser(owner, email, "operador-senha-forte");
      await owner.em
        .getConnection()
        .execute(
          "update staff_users set platform_role = 'OPERATOR' where id = ?",
          [id],
        );
      const report = await operatorMfaReport(app);
      assert.equal(report.operators, before.operators + 1);
      assert.ok(report.withoutMfa.includes(id));
      assert.doesNotMatch(JSON.stringify(report), /operador-/);
      await owner.em
        .getConnection()
        .execute("update staff_users set status = 'DISABLED' where id = ?", [
          id,
        ]);
      assert.deepEqual(await operatorMfaReport(app), before);
    } finally {
      await app.close();
    }
  });
});
