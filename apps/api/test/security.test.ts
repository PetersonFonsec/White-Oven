import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { operatorMfaReport } from "../src/auth/check-operators-mfa";
import {
  API_SECURITY_HEADERS,
  ipLimitKey,
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
      ip: { max: 3, windowMs: 10 * MINUTE },
      account: { max: 2, windowMs: MINUTE },
    },
    one: { ip: { max: 1, windowMs: MINUTE } },
  };
  const clock = (start = 1_000_000) => {
    const state = { now: start };
    return { state, now: () => state.now };
  };

  it("admits while every scope has room and answers the wait of the exhausted scope", () => {
    const { state, now } = clock();
    const limits = new RequestLimits(now, policies);
    const ana = { ip: "10.0.0.1", account: "ana" };
    assert.equal(limits.consume("probe", ana), 0);
    assert.equal(limits.consume("probe", ana), 0);
    state.now += 20_000;
    // Ana's account window (2 per minute, opened at t0) is spent: 40 s left.
    assert.equal(limits.consume("probe", ana), 40);
    state.now += 40_000;
    assert.equal(limits.consume("probe", ana), 0);
  });

  it("a request refused by an individual scope spends nothing of the shared IP scope", () => {
    const { now } = clock();
    const limits = new RequestLimits(now, policies);
    const ana = { ip: "10.0.0.1", account: "ana" };
    assert.equal(limits.consume("probe", ana), 0);
    assert.equal(limits.consume("probe", ana), 0);
    for (let i = 0; i < 100; i++)
      assert.equal(limits.consume("probe", ana), 60);
    // The IP (3 per 10 min) holds 2 admitted requests: Bia behind the same NAT still gets one.
    assert.equal(
      limits.consume("probe", { ip: "10.0.0.1", account: "bia" }),
      0,
    );
    // That was the IP's third: now the shared scope is legitimately exhausted for everyone.
    assert.equal(
      limits.consume("probe", { ip: "10.0.0.1", account: "caio" }),
      600,
    );
  });

  it("Retry-After is the time until every exhausted scope reopens, and a retry then is admitted", () => {
    const { state, now } = clock();
    const limits = new RequestLimits(now, {
      probe: {
        ip: { max: 2, windowMs: 10 * MINUTE },
        account: { max: 2, windowMs: MINUTE },
      },
    });
    const ana = { ip: "10.0.0.1", account: "ana" };
    limits.consume("probe", ana);
    limits.consume("probe", ana);
    // Both scopes exhausted: the IP window (10 min) is the one that decides.
    const wait = limits.consume("probe", ana);
    assert.equal(wait, 600);
    state.now += (wait - 1) * 1000;
    assert.ok(limits.consume("probe", ana) > 0);
    state.now += 1000;
    assert.equal(limits.consume("probe", ana), 0);
  });

  it("refuses an unknown limit or a missing key instead of letting the request through", () => {
    const limits = new RequestLimits(Date.now, policies);
    assert.throws(() => limits.consume("nope", {}), /Unknown request limit/);
    assert.throws(
      () => limits.consume("probe", { ip: "10.0.0.1" }),
      /needs the account key/,
    );
  });

  describe("a full store (capacity 4)", () => {
    const full = () => {
      const { state, now } = clock();
      const limits = new RequestLimits(now, policies, 4);
      // The victim exhausts its window, then an attacker fills the remaining room.
      assert.equal(limits.consume("one", { ip: "victim" }), 0);
      assert.equal(limits.consume("one", { ip: "victim" }), 60);
      for (const ip of ["a1", "a2", "a3"])
        assert.equal(limits.consume("one", { ip }), 0);
      assert.equal(limits.size, 4);
      return { state, limits };
    };

    it("never drops a live window: a flood of new keys does not reset a blocked key", () => {
      const { state, limits } = full();
      for (let i = 0; i < 1000; i++) {
        state.now += 10;
        assert.ok(limits.consume("one", { ip: `flood-${i}` }) > 0);
      }
      assert.equal(limits.size, 4);
      assert.ok(limits.consume("one", { ip: "victim" }) > 0);
    });

    it("is fail-closed and deterministic for new keys, while known keys are still decided", () => {
      const { state, limits } = full();
      state.now += 15_000;
      // Earliest window ends at t0 + 60 s: the same answer for any new key.
      assert.equal(limits.consume("one", { ip: "new-1" }), 45);
      assert.equal(limits.consume("one", { ip: "new-2" }), 45);
      assert.equal(limits.consume("one", { ip: "victim" }), 45);
      assert.equal(limits.size, 4);
    });

    it("sweeps expired windows to admit new keys, and time frees the blocked one", () => {
      const { state, limits } = full();
      state.now += MINUTE;
      assert.equal(limits.consume("one", { ip: "new-1" }), 0);
      assert.equal(limits.size, 1);
      assert.equal(limits.consume("one", { ip: "victim" }), 0);
      assert.equal(limits.consume("one", { ip: "victim" }), 60);
    });

    it("keeps memory bounded under any sequence of keys", () => {
      const { state, now } = clock();
      const limits = new RequestLimits(now, policies, 50);
      for (let i = 0; i < 5000; i++) {
        state.now += 37;
        limits.consume("probe", { ip: `ip-${i % 700}`, account: `acc-${i}` });
        assert.ok(limits.size <= 50);
      }
    });
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
  const caddy = "172.30.87.3";
  const trusted = new Set([caddy]);

  it("is the TCP peer unless the peer is a trusted proxy, whatever the header says", () => {
    assert.equal(
      resolveClientIp(request("::ffff:203.0.113.9", "198.51.100.1"), trusted),
      "203.0.113.9",
    );
  });

  it("reads X-Forwarded-For right to left: a client cannot choose its address", () => {
    // Caddy replaces the header with the peer it saw ({remote_host} or {client_ip}).
    assert.equal(
      resolveClientIp(request(caddy, "203.0.113.7"), trusted),
      "203.0.113.7",
    );
    // A proxy that appends instead: the client's own entries are on the left and never used.
    assert.equal(
      resolveClientIp(
        request(caddy, "1.1.1.1, 198.51.100.1, 203.0.113.7"),
        trusted,
      ),
      "203.0.113.7",
    );
    assert.equal(
      resolveClientIp(request(caddy, ["10.0.0.1", "2001:DB8::1"]), trusted),
      "2001:db8::1",
    );
  });

  it("skips trusted hops of a proxy chain, and only trusted ones", () => {
    const chain = new Set([caddy, "172.30.87.9"]);
    assert.equal(
      resolveClientIp(
        request(caddy, "6.6.6.6, 203.0.113.7, 172.30.87.9"),
        chain,
      ),
      "203.0.113.7",
    );
    // The inner proxy is not listed: it is the client, whatever it forwarded.
    assert.equal(
      resolveClientIp(request(caddy, "203.0.113.7, 172.30.87.9"), trusted),
      "172.30.87.9",
    );
  });

  it("stops at an invalid entry and falls back to the last trusted hop", () => {
    for (const header of [
      undefined,
      "",
      "not-an-ip",
      "1.2.3.4, evil",
      "1.2.3.4,",
    ])
      assert.equal(resolveClientIp(request(caddy, header), trusted), caddy);
    assert.equal(
      resolveClientIp(request(caddy, "evil, 203.0.113.7"), trusted),
      "203.0.113.7",
    );
    assert.equal(resolveClientIp(request(caddy, caddy), trusted), caddy);
    assert.equal(resolveClientIp(request(undefined), trusted), "unknown");
    assert.equal(normalizeIp("::ffff:10.1.2.3"), "10.1.2.3");
    assert.equal(normalizeIp("10.1.2.3/8"), "");
  });

  it("rate-limits IPv6 by /64 and IPv4 by address", () => {
    assert.equal(ipLimitKey("203.0.113.7"), "203.0.113.7");
    for (const ip of [
      "2001:db8:1:2::1",
      "2001:db8:1:2:ffff:ffff:ffff:ffff",
      "2001:0db8:0001:0002::",
    ])
      assert.equal(ipLimitKey(ip), "2001:db8:1:2::/64");
    assert.equal(ipLimitKey("::1"), "0:0:0:0::/64");
    assert.equal(ipLimitKey("fe80::1:2:3:4"), "fe80:0:0:0::/64");
    assert.notEqual(
      ipLimitKey("2001:db8:1:3::1"),
      ipLimitKey("2001:db8:1:2::1"),
    );
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
    // The refusal spent nothing: store B has its own window and the IP one more sign-up across
    // stores (4), after which the shared ceiling refuses B too.
    assert.equal((await register(stores.b.slug)).status, 201);
    assert.equal((await register(stores.b.slug)).status, 429);
    assert.equal(await countIn(stores.a.id, "customers"), 3);
    assert.equal(await countIn(stores.b.id, "customers"), 1);
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
