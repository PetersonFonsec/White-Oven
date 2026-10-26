import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Controller, Get, Inject, Module } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
} from "@nestjs/core";
import { RequestMethod } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AccessTokens } from "../src/auth/access-token";
import { ROUTE_ACCESS, ROUTE_ACCESS_VALUES } from "../src/auth/route-access";
import { AdminRoute } from "../src/auth/staff.guard";
import { currentTenantContext } from "../src/tenancy/tenant-context";
import { TenantTransactions } from "../src/tenancy/tenant-transaction";
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
  refreshCookieOf,
  setMembershipStatus,
  staffLogin,
  switchTenant,
} from "./staff-fixtures";

const PASSWORD = "forno-a-lenha-2026";
const ADMIN_ORIGIN = "https://admin.whiteoven.test";

/** Test-only admin routes: one restricted to OWNER and one that reads tenant data. */
@Controller("admin/staff-probe")
class StaffProbeController {
  constructor(
    @Inject(TenantTransactions) private readonly tenant: TenantTransactions,
  ) {}

  @Get("owner-only")
  @AdminRoute("OWNER")
  ownerOnly() {
    return { ok: true };
  }

  @Get("memberships")
  @AdminRoute()
  memberships() {
    const { actor } = currentTenantContext();
    return this.tenant.run(async (em) => ({
      actor: actor.type,
      // Without a WHERE on tenant: RLS and the context restrict it to the active tenant.
      tenants: (
        await em.execute<{ tenant_id: string }[]>(
          "select distinct tenant_id from memberships",
        )
      ).map((row) => row.tenant_id),
    }));
  }
}

@Module({ imports: [DiscoveryModule], controllers: [StaffProbeController] })
class StaffProbeModule {}

describe("staff authentication", databaseSuite, () => {
  let database: TestDatabase;
  let owner: MikroORM;
  let server: TestServer;
  const ids = {} as Record<
    | "a"
    | "b"
    | "suspended"
    | "closed"
    | "owner"
    | "staff"
    | "disabled"
    | "lonely",
    string
  >;

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    ids.a = await insertTenant(owner, "auth-a");
    ids.b = await insertTenant(owner, "auth-b", "ONBOARDING");
    ids.suspended = await insertTenant(owner, "auth-suspensa", "SUSPENDED");
    ids.closed = await insertTenant(owner, "auth-fechada", "CLOSED");
    ids.owner = await insertStaffUser(owner, "dona@auth.test", PASSWORD);
    ids.staff = await insertStaffUser(owner, "atendente@auth.test", PASSWORD);
    ids.disabled = await insertStaffUser(
      owner,
      "desligado@auth.test",
      PASSWORD,
      "DISABLED",
    );
    ids.lonely = await insertStaffUser(owner, "sem-loja@auth.test", PASSWORD);
    await insertMembership(owner, ids.a, ids.owner, "OWNER");
    await insertMembership(owner, ids.b, ids.owner, "MANAGER");
    await insertMembership(owner, ids.suspended, ids.owner, "OWNER");
    await insertMembership(owner, ids.closed, ids.owner, "OWNER");
    await insertMembership(owner, ids.a, ids.staff, "STAFF");
    await insertMembership(owner, ids.b, ids.staff, "STAFF", "REVOKED");
    await insertMembership(owner, ids.suspended, ids.staff, "STAFF");
    server = await startTestServer(
      {
        DATABASE_URL: database.appUrl,
        API_ADMIN_ORIGINS: ADMIN_ORIGIN,
      },
      { imports: [StaffProbeModule] },
    );
  });
  after(async () => {
    await server?.close();
    await database?.drop();
  });

  const url = (path: string) => `${server.baseUrl}/v1${path}`;
  const post = (
    path: string,
    body?: unknown,
    headers: Record<string, string | null> = {},
  ) => {
    const requestHeaders = { ...headers };
    if (
      ["/admin/auth/refresh", "/admin/auth/logout"].includes(path) &&
      !Object.hasOwn(requestHeaders, "origin")
    )
      requestHeaders.origin = ADMIN_ORIGIN;
    for (const [key, value] of Object.entries(requestHeaders))
      if (value === null) delete requestHeaders[key];
    return fetch(url(path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...requestHeaders,
      } as Record<string, string>,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const get = (path: string, accessToken?: string) =>
    fetch(url(path), { headers: accessToken ? bearer(accessToken) : {} });
  const sessionRow = async (sessionId: string) => {
    const [row] = await owner.em
      .getConnection()
      .execute<{ revoked_reason: string | null; active_tenant_id: string }[]>(
        "select revoked_reason, active_tenant_id from staff_sessions where id = ?",
        [sessionId],
      );
    return row!;
  };
  const sessionIdOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;

  describe("login", () => {
    it("issues a short access token and an HttpOnly, Secure, SameSite=Strict refresh cookie", async () => {
      const response = await post("/admin/auth/login", {
        email: "  DONA@auth.test ",
        password: PASSWORD,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await json(response);
      assert.deepEqual(Object.keys(body).sort(), [
        "accessToken",
        "activeTenantId",
        "expiresIn",
        "tokenType",
      ]);
      assert.equal(body.tokenType, "Bearer");
      assert.equal(body.expiresIn, 900);
      assert.equal(body.activeTenantId, null);

      const [setCookie] = response.headers.getSetCookie();
      assert.match(
        setCookie!,
        /^__Secure-wo_staff_refresh=[0-9a-f-]{36}\.[\w-]{43};/,
      );
      assert.match(setCookie!, /; Path=\/v1\/admin\/auth/);
      assert.match(setCookie!, /; HttpOnly/);
      assert.match(setCookie!, /; Secure/);
      assert.match(setCookie!, /; SameSite=Strict/);

      // Only the SHA-256 of the secret is stored.
      const [sessionId, secret] = setCookie!
        .split(";")[0]!
        .split("=")[1]!
        .split(".");
      const [row] = await owner.em
        .getConnection()
        .execute<{ hash: Buffer }[]>(
          "select refresh_token_hash as hash from staff_sessions where id = ?",
          [sessionId],
        );
      assert.deepEqual(
        row!.hash,
        createHash("sha256").update(secret!).digest(),
      );
    });

    it("stores passwords as Argon2id with the OWASP parameters", async () => {
      const [row] = await owner.em
        .getConnection()
        .execute<{ password_hash: string }[]>(
          "select password_hash from staff_users where id = ?",
          [ids.owner],
        );
      assert.match(row!.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    });

    it("answers wrong password, unknown e-mail and disabled user identically", async () => {
      const bodies = [];
      for (const credentials of [
        { email: "dona@auth.test", password: "senha-errada-123" },
        { email: "ninguem@auth.test", password: PASSWORD },
        { email: "desligado@auth.test", password: PASSWORD },
      ]) {
        const response = await post("/admin/auth/login", credentials);
        assert.equal(response.status, 401);
        assert.deepEqual(response.headers.getSetCookie(), []);
        const body = await json(response);
        delete body.requestId;
        bodies.push(body);
      }
      assert.deepEqual(bodies[0], {
        code: "INVALID_CREDENTIALS",
        message: "Invalid e-mail or password.",
      });
      assert.deepEqual(bodies[1], bodies[0]);
      assert.deepEqual(bodies[2], bodies[0]);
    });

    it("rejects missing, extra and non-string fields", async () => {
      for (const body of [
        {},
        { email: "dona@auth.test" },
        { email: "dona@auth.test", password: PASSWORD, tenantId: ids.a },
        { email: "dona@auth.test", password: 123 },
        ["dona@auth.test", PASSWORD],
      ]) {
        const response = await post("/admin/auth/login", body);
        assert.equal(response.status, 422, JSON.stringify(body));
        assert.equal((await json(response)).code, "VALIDATION_FAILED");
      }
    });

    it("locks an account progressively, for registered and unknown e-mails alike", async () => {
      for (const email of ["lock@auth.test", "nao-existe@auth.test"]) {
        if (email === "lock@auth.test")
          await insertStaffUser(owner, email, PASSWORD);
        for (let attempt = 1; attempt <= 5; attempt++) {
          const response = await post("/admin/auth/login", {
            email,
            password: "senha-errada-123",
          });
          assert.equal(response.status, 401, `${email} attempt ${attempt}`);
        }
        // The sixth failure starts the lock; the right password is refused while locked.
        await post("/admin/auth/login", {
          email,
          password: "senha-errada-123",
        });
        const locked = await post("/admin/auth/login", {
          email,
          password: PASSWORD,
        });
        assert.equal(locked.status, 429, email);
        assert.equal((await json(locked)).code, "RATE_LIMITED");
        assert.ok(Number(locked.headers.get("retry-after")) >= 29);
      }
      // Other accounts on the same IP are unaffected below the IP threshold.
      await staffLogin(server.baseUrl, "atendente@auth.test", PASSWORD);
    });
  });

  describe("tenants and active tenant", () => {
    it("lists only ACTIVE memberships in stores that admit the role", async () => {
      const owner = await staffLogin(
        server.baseUrl,
        "dona@auth.test",
        PASSWORD,
      );
      const ownerChoices = await json(
        await get("/admin/auth/tenants", owner.accessToken),
      );
      assert.deepEqual(
        ownerChoices.map((c: { slug: string; role: string }) => [
          c.slug,
          c.role,
        ]),
        [
          ["auth-a", "OWNER"],
          ["auth-b", "MANAGER"],
          ["auth-suspensa", "OWNER"], // SUSPENDED admits the OWNER only; CLOSED nobody.
        ],
      );

      const staff = await staffLogin(
        server.baseUrl,
        "atendente@auth.test",
        PASSWORD,
      );
      const staffChoices = await json(
        await get("/admin/auth/tenants", staff.accessToken),
      );
      assert.deepEqual(
        staffChoices.map((c: { slug: string }) => c.slug),
        ["auth-a"], // REVOKED in B; STAFF is not admitted in a SUSPENDED store.
      );

      const lonely = await staffLogin(
        server.baseUrl,
        "sem-loja@auth.test",
        PASSWORD,
      );
      assert.deepEqual(
        await json(await get("/admin/auth/tenants", lonely.accessToken)),
        [],
      );
    });

    it("switches tenant only through an ACTIVE membership; anything else is 404", async () => {
      const staff = await staffLogin(
        server.baseUrl,
        "atendente@auth.test",
        PASSWORD,
      );
      for (const tenantId of [
        ids.b,
        ids.suspended,
        ids.closed,
        "00000000-0000-4000-8000-000000000000",
        "nao-uuid",
      ]) {
        const response = await switchTenant(
          server.baseUrl,
          staff.accessToken,
          tenantId,
        );
        assert.equal(response.status, 404, tenantId);
        assert.equal((await json(response)).code, "NOT_FOUND");
      }
      const response = await switchTenant(
        server.baseUrl,
        staff.accessToken,
        ids.a,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await json(response);
      assert.equal(body.activeTenantId, ids.a);
      assert.deepEqual(await json(await get("/admin/me", body.accessToken)), {
        staffUserId: ids.staff,
        sessionId: sessionIdOf(staff.cookie),
        tenantId: ids.a,
        role: "STAFF",
      });
      assert.equal(
        (await sessionRow(sessionIdOf(staff.cookie))).active_tenant_id,
        ids.a,
      );
    });

    it("runs admin handlers in the token's tenant context, under RLS", async () => {
      const login = await staffLogin(
        server.baseUrl,
        "dona@auth.test",
        PASSWORD,
      );
      const { accessToken } = await json(
        await switchTenant(server.baseUrl, login.accessToken, ids.b),
      );
      assert.deepEqual(
        await json(await get("/admin/staff-probe/memberships", accessToken)),
        { actor: "staff", tenants: [ids.b] },
      );
    });
  });

  describe("guards", () => {
    it("admin routes need a token (401) and an active tenant (403)", async () => {
      const unauthenticated = await get("/admin/me");
      assert.equal(unauthenticated.status, 401);
      assert.equal((await json(unauthenticated)).code, "UNAUTHORIZED");
      const login = await staffLogin(
        server.baseUrl,
        "dona@auth.test",
        PASSWORD,
      );
      const noTenant = await get("/admin/me", login.accessToken);
      assert.equal(noTenant.status, 403);
      assert.equal((await json(noTenant)).code, "TENANT_REQUIRED");
    });

    it("refuses tampered tokens and tokens signed by another key", async () => {
      const login = await staffLogin(
        server.baseUrl,
        "dona@auth.test",
        PASSWORD,
      );
      const { accessToken } = await json(
        await switchTenant(server.baseUrl, login.accessToken, ids.a),
      );
      const [header, payload, signature] = accessToken.split(".");
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      const forgedPayload = Buffer.from(
        JSON.stringify({ ...claims, tid: ids.b }),
      ).toString("base64url");
      const foreign = new AccessTokens(
        generateKeyPairSync("ed25519").privateKey,
      ).issue({
        ...claims,
      }).token;
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${payload}.`;
      for (const token of [
        `${header}.${forgedPayload}.${signature}`,
        foreign,
        none,
        `${accessToken}x`,
        "garbage",
      ]) {
        const response = await get("/admin/me", token);
        assert.equal(response.status, 401, token);
      }
    });

    it("enforces roles declared in code", async () => {
      for (const [email, status] of [
        ["dona@auth.test", 200],
        ["atendente@auth.test", 403],
      ] as const) {
        const login = await staffLogin(server.baseUrl, email, PASSWORD);
        const { accessToken } = await json(
          await switchTenant(server.baseUrl, login.accessToken, ids.a),
        );
        const response = await get(
          "/admin/staff-probe/owner-only",
          accessToken,
        );
        assert.equal(response.status, status, email);
        if (status === 403)
          assert.equal((await json(response)).code, "ROLE_FORBIDDEN");
      }
    });

    it("every route of the API declares its access (no route without a guard)", () => {
      const discovery = server.app.get(DiscoveryService);
      const scanner = server.app.get(MetadataScanner);
      const undeclared: string[] = [];
      let routes = 0;
      for (const { instance, metatype } of discovery.getControllers()) {
        if (!instance || !metatype) continue;
        const prototype = Object.getPrototypeOf(instance) as object;
        for (const name of scanner.getAllMethodNames(prototype)) {
          const handler = (prototype as Record<string, object>)[name]!;
          if (Reflect.getMetadata(PATH_METADATA, handler) === undefined)
            continue;
          routes++;
          const access =
            Reflect.getMetadata(ROUTE_ACCESS, handler) ??
            Reflect.getMetadata(ROUTE_ACCESS, metatype);
          if (!(ROUTE_ACCESS_VALUES as readonly string[]).includes(access))
            undeclared.push(
              `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]} ${metatype.name}.${name}`,
            );
        }
      }
      assert.ok(routes >= 9, `only ${routes} routes discovered`);
      assert.deepEqual(undeclared, []);
    });
  });

  describe("refresh and logout", () => {
    it("rotates the refresh token, keeps the active tenant and revokes the session on reuse", async () => {
      const login = await staffLogin(
        server.baseUrl,
        "dona@auth.test",
        PASSWORD,
      );
      await switchTenant(server.baseUrl, login.accessToken, ids.a);
      const first = await post("/admin/auth/refresh", undefined, {
        cookie: login.cookie,
      });
      assert.equal(first.status, 200);
      const rotated = refreshCookieOf(first)!;
      assert.notEqual(rotated, login.cookie);
      const body = await json(first);
      assert.equal(body.activeTenantId, ids.a);
      assert.equal((await get("/admin/me", body.accessToken)).status, 200);

      // Replaying the rotated-out token revokes the session for everyone holding it.
      const replay = await post("/admin/auth/refresh", undefined, {
        cookie: login.cookie,
      });
      assert.equal(replay.status, 401);
      assert.equal((await json(replay)).code, "SESSION_INVALID");
      assert.match(
        replay.headers.getSetCookie()[0]!,
        /Expires=Thu, 01 Jan 1970/,
      );
      assert.equal(
        (await sessionRow(sessionIdOf(login.cookie))).revoked_reason,
        "REFRESH_REUSE",
      );
      const legit = await post("/admin/auth/refresh", undefined, {
        cookie: rotated,
      });
      assert.equal(legit.status, 401);
      assert.equal((await get("/admin/me", body.accessToken)).status, 401);
    });

    it("drops the active tenant on refresh when the membership was revoked", async () => {
      const email = "refresh-revogado@auth.test";
      const userId = await insertStaffUser(owner, email, PASSWORD);
      await insertMembership(owner, ids.a, userId, "MANAGER");
      const login = await staffLogin(server.baseUrl, email, PASSWORD);
      await switchTenant(server.baseUrl, login.accessToken, ids.a);
      await setMembershipStatus(owner, ids.a, userId, "REVOKED");
      const response = await post("/admin/auth/refresh", undefined, {
        cookie: login.cookie,
      });
      assert.equal(response.status, 200);
      assert.equal((await json(response)).activeTenantId, null);
      assert.equal(
        (await sessionRow(sessionIdOf(login.cookie))).active_tenant_id,
        null,
      );
    });

    it("refuses expired sessions and disabled users", async () => {
      const email = "expira@auth.test";
      const userId = await insertStaffUser(owner, email, PASSWORD);
      const expired = await staffLogin(server.baseUrl, email, PASSWORD);
      await owner.em
        .getConnection()
        .execute(
          "update staff_sessions set idle_expires_at = now() - interval '1 second' where id = ?",
          [sessionIdOf(expired.cookie)],
        );
      assert.equal(
        (
          await post("/admin/auth/refresh", undefined, {
            cookie: expired.cookie,
          })
        ).status,
        401,
      );
      assert.equal(
        (await get("/admin/auth/tenants", expired.accessToken)).status,
        401,
      );

      const active = await staffLogin(server.baseUrl, email, PASSWORD);
      await owner.em
        .getConnection()
        .execute("update staff_users set status = 'DISABLED' where id = ?", [
          userId,
        ]);
      assert.equal(
        (await get("/admin/auth/tenants", active.accessToken)).status,
        401,
      );
      assert.equal(
        (
          await post("/admin/auth/refresh", undefined, {
            cookie: active.cookie,
          })
        ).status,
        401,
      );
      assert.equal(
        (await sessionRow(sessionIdOf(active.cookie))).revoked_reason,
        "USER_DISABLED",
      );
    });

    it("checks Origin on refresh and logout", async () => {
      const login = await staffLogin(
        server.baseUrl,
        "dona@auth.test",
        PASSWORD,
      );
      const missingRefreshOrigin = await post(
        "/admin/auth/refresh",
        undefined,
        {
          cookie: login.cookie,
          origin: null,
        },
      );
      assert.equal(missingRefreshOrigin.status, 403);
      assert.equal(
        (await json(missingRefreshOrigin)).code,
        "ORIGIN_NOT_ALLOWED",
      );
      const foreign = await post("/admin/auth/refresh", undefined, {
        cookie: login.cookie,
        origin: "https://evil.test",
      });
      assert.equal(foreign.status, 403);
      assert.equal((await json(foreign)).code, "ORIGIN_NOT_ALLOWED");
      const allowed = await post("/admin/auth/refresh", undefined, {
        cookie: login.cookie,
        origin: ADMIN_ORIGIN,
      });
      assert.equal(allowed.status, 200);
      assert.equal(
        (
          await post("/admin/auth/logout", undefined, {
            cookie: refreshCookieOf(allowed)!,
            origin: "https://evil.test",
          })
        ).status,
        403,
      );
      const missingLogoutOrigin = await post("/admin/auth/logout", undefined, {
        cookie: refreshCookieOf(allowed)!,
        origin: null,
      });
      assert.equal(missingLogoutOrigin.status, 403);
      assert.equal(
        (await json(missingLogoutOrigin)).code,
        "ORIGIN_NOT_ALLOWED",
      );
      assert.equal(
        (
          await post("/admin/auth/refresh", undefined, {
            cookie: refreshCookieOf(allowed)!,
            origin: ADMIN_ORIGIN,
          })
        ).status,
        200,
      );
    });

    it("logout revokes the session, clears the cookie and is idempotent", async () => {
      const login = await staffLogin(
        server.baseUrl,
        "dona@auth.test",
        PASSWORD,
      );
      const response = await post("/admin/auth/logout", undefined, {
        cookie: login.cookie,
      });
      assert.equal(response.status, 204);
      assert.match(
        response.headers.getSetCookie()[0]!,
        /^__Secure-wo_staff_refresh=;/,
      );
      assert.equal(
        (await sessionRow(sessionIdOf(login.cookie))).revoked_reason,
        "LOGOUT",
      );
      assert.equal(
        (await get("/admin/auth/tenants", login.accessToken)).status,
        401,
      );
      assert.equal(
        (await post("/admin/auth/refresh", undefined, { cookie: login.cookie }))
          .status,
        401,
      );
      assert.equal((await post("/admin/auth/logout")).status, 204);
      assert.equal(
        (await post("/admin/auth/logout", undefined, { cookie: login.cookie }))
          .status,
        204,
      );
    });
  });

  describe("database", () => {
    it("the API role cannot delete staff identities, sessions or memberships", async () => {
      const app = await database.connect(database.appUrl);
      for (const table of ["staff_users", "staff_sessions", "memberships"]) {
        await assert.rejects(
          app.em.getConnection().execute(`delete from ${table}`),
          (error: { code?: string }) => error.code === "42501",
          table,
        );
      }
    });

    it("whiteoven_staff_memberships lists one user's links and restores the caller's tenant", async () => {
      const app = await database.connect(database.appUrl);
      const rows = await app.em.fork().transactional(async (em) => {
        await em.execute("select set_config('app.tenant_id', ?, true)", [
          ids.a,
        ]);
        const links = await em.execute<{ tenant_id: string; status: string }[]>(
          "select tenant_id, status from whiteoven_staff_memberships(?) order by tenant_id",
          [ids.staff],
        );
        const [setting] = await em.execute<{ tenant: string }[]>(
          "select current_setting('app.tenant_id') as tenant",
        );
        return { links, tenant: setting!.tenant };
      });
      assert.equal(rows.tenant, ids.a);
      // CLOSED tenants are skipped; REVOKED links are listed with their status.
      assert.deepEqual(
        rows.links.map((l) => [l.tenant_id, l.status]).sort(),
        [
          [ids.a, "ACTIVE"],
          [ids.b, "REVOKED"],
          [ids.suspended, "ACTIVE"],
        ].sort(),
      );
      const [direct] = await app.em
        .getConnection()
        .execute<{ count: number }[]>(
          "select count(*)::int as count from memberships",
        );
      assert.equal(direct!.count, 0, "no context: RLS returns no memberships");
    });
  });
});
