import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Post,
} from "@nestjs/common";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { AdminRoute } from "../src/auth/staff.guard";
import {
  TenantTransactions,
  runInTenant,
} from "../src/tenancy/tenant-transaction";
import { HeldTransactions } from "./concurrency";
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
  setMembershipStatus,
  staffLogin,
  switchTenant,
} from "./staff-fixtures";

const PASSWORD = "forno-a-lenha-2026";
const ADMIN_ORIGIN = "https://admin.whiteoven.test";

/** Lets a test pause a handler inside its tenant transaction. */
let pause: { entered: () => void; release: Promise<void> } | null = null;

/** Test-only admin routes doing tenant work, the place where privileges are exercised. */
@Controller("admin/consistency-probe")
class ConsistencyProbeController {
  constructor(
    @Inject(TenantTransactions) private readonly tenant: TenantTransactions,
  ) {}

  @Post("owner-write")
  @HttpCode(200)
  @AdminRoute("OWNER")
  ownerWrite() {
    return this.tenant.run(async () => {
      const gate = pause;
      if (gate) {
        gate.entered();
        await gate.release;
      }
      return { ok: true };
    });
  }

  @Get("read")
  @AdminRoute()
  read() {
    return this.tenant.run(async () => ({ ok: true }));
  }
}

@Module({ controllers: [ConsistencyProbeController] })
class ConsistencyProbeModule {}

/**
 * Consistency of staff authorization under revocation and concurrency (M1.4 security review).
 * Every scenario runs against PostgreSQL: the guarantees come from row locks and READ COMMITTED
 * re-checks, which a mock would not reproduce.
 */
describe(
  "staff authorization consistency",
  { ...databaseSuite, timeout: 60_000 },
  () => {
    let database: TestDatabase;
    let owner: MikroORM;
    let first: TestServer;
    let second: TestServer;
    let tenantA: string;
    let tenantB: string;
    let serial = 0;
    let locks: HeldTransactions;

    before(async () => {
      database = await createTestDatabase();
      owner = await database.connect(database.ownerUrl);
      locks = new HeldTransactions(owner);
      tenantA = await insertTenant(owner, "consistencia-a");
      tenantB = await insertTenant(owner, "consistencia-b");
      // A store never loses its last ACTIVE OWNER (ADR 0015), so each keeps one that the tests
      // below never touch; they demote and revoke other owners.
      for (const tenantId of [tenantA, tenantB])
        await insertMembership(
          owner,
          tenantId,
          await insertStaffUser(
            owner,
            `dona-fixa-${tenantId}@consistencia.test`,
            PASSWORD,
          ),
          "OWNER",
        );
      // Two API instances sharing only PostgreSQL and the signing key, as in production.
      const env = {
        DATABASE_URL: database.appUrl,
        API_ADMIN_ORIGINS: ADMIN_ORIGIN,
        AUTH_ACCESS_TOKEN_PRIVATE_KEY: generateKeyPairSync("ed25519")
          .privateKey.export({ format: "der", type: "pkcs8" })
          .toString("base64"),
      };
      first = await startTestServer(env, { imports: [ConsistencyProbeModule] });
      second = await startTestServer(env, {
        imports: [ConsistencyProbeModule],
      });
    });
    afterEach(() => locks.releaseAll());
    after(async () => {
      await first?.close();
      await second?.close();
      await database?.drop();
    });

    const sql = <T>(query: string, params: unknown[] = []) =>
      owner.em.getConnection().execute<T[]>(query, params);

    /** A fresh user with the given memberships, logged in on `server`. */
    const member = async (
      roles: Record<string, "OWNER" | "MANAGER" | "STAFF">,
      server = first,
    ) => {
      const email = `pessoa-${++serial}@consistencia.test`;
      const userId = await insertStaffUser(owner, email, PASSWORD);
      for (const [tenantId, role] of Object.entries(roles))
        await insertMembership(owner, tenantId, userId, role);
      const login = await staffLogin(server.baseUrl, email, PASSWORD);
      const sessionId = login.cookie.split("=")[1]!.split(".")[0]!;
      return { userId, sessionId, ...login };
    };

    const tokenFor = async (accessToken: string, tenantId: string) => {
      const response = await switchTenant(first.baseUrl, accessToken, tenantId);
      assert.equal(response.status, 200);
      return (await json(response)).accessToken as string;
    };

    const call = (
      server: TestServer,
      method: "GET" | "POST",
      path: string,
      accessToken: string,
    ) =>
      fetch(`${server.baseUrl}/v1${path}`, {
        method,
        headers: bearer(accessToken),
      });
    const me = (server: TestServer, accessToken: string) =>
      call(server, "GET", "/admin/me", accessToken);
    const ownerWrite = (accessToken: string) =>
      call(first, "POST", "/admin/consistency-probe/owner-write", accessToken);
    const refresh = (cookie: string) =>
      fetch(`${first.baseUrl}/v1/admin/auth/refresh`, {
        method: "POST",
        headers: { cookie, origin: ADMIN_ORIGIN },
      });

    const setRole = (tenantId: string, userId: string, role: string) =>
      runInTenant(owner, tenantId, (em) =>
        em.execute("update memberships set role = ? where staff_user_id = ?", [
          role,
          userId,
        ]),
      );

    const activeTenantOf = async (sessionId: string) =>
      (
        await sql<{ tenant: string | null }>(
          "select active_tenant_id as tenant from staff_sessions where id = ?",
          [sessionId],
        )
      )[0]!.tenant;

    const hold = (
      work: (em: EntityManager) => Promise<unknown>,
      tenantId?: string,
    ) => locks.hold(work, tenantId);
    const lockWaiters = (count: number) => locks.lockWaiters(count);

    describe("revocations apply on the next request", () => {
      it("a role changed from OWNER to STAFF loses OWNER routes immediately", async () => {
        const user = await member({ [tenantA]: "OWNER" });
        const token = await tokenFor(user.accessToken, tenantA);
        assert.equal((await ownerWrite(token)).status, 200);

        await setRole(tenantA, user.userId, "STAFF");
        const denied = await ownerWrite(token);
        assert.equal(denied.status, 403);
        assert.equal((await json(denied)).code, "ROLE_FORBIDDEN");
        assert.equal((await json(await me(first, token))).role, "STAFF");
      });

      it("a revoked membership is denied immediately", async () => {
        const user = await member({ [tenantA]: "MANAGER" });
        const token = await tokenFor(user.accessToken, tenantA);
        assert.equal((await me(first, token)).status, 200);

        await setMembershipStatus(owner, tenantA, user.userId, "REVOKED");
        const denied = await me(first, token);
        assert.equal(denied.status, 403);
        assert.equal((await json(denied)).code, "TENANT_ACCESS_DENIED");
      });

      it("a disabled user is refused on staff and admin routes immediately", async () => {
        const user = await member({ [tenantA]: "OWNER" });
        const token = await tokenFor(user.accessToken, tenantA);
        assert.equal((await me(first, token)).status, 200);

        await sql("update staff_users set status = 'DISABLED' where id = ?", [
          user.userId,
        ]);
        assert.equal((await me(first, token)).status, 401);
        assert.equal(
          (await call(first, "GET", "/admin/auth/tenants", user.accessToken))
            .status,
          401,
        );
      });

      it("a revoked session is refused immediately, with or without tenant", async () => {
        const user = await member({ [tenantA]: "OWNER" });
        const token = await tokenFor(user.accessToken, tenantA);
        assert.equal((await me(first, token)).status, 200);

        await sql(
          "update staff_sessions set revoked_at = now(), revoked_reason = 'LOGOUT' where id = ?",
          [user.sessionId],
        );
        for (const response of [
          await me(first, token),
          await call(first, "GET", "/admin/auth/tenants", user.accessToken),
          await switchTenant(first.baseUrl, user.accessToken, tenantA),
        ]) {
          assert.equal(response.status, 401);
          assert.equal((await json(response)).code, "SESSION_INVALID");
        }
      });

      it("a tenant without membership answers 404 and grants nothing", async () => {
        const user = await member({ [tenantA]: "OWNER" });
        const response = await switchTenant(
          first.baseUrl,
          user.accessToken,
          tenantB,
        );
        assert.equal(response.status, 404);
        assert.equal(await activeTenantOf(user.sessionId), null);
      });
    });

    describe("tenant work and concurrent changes", () => {
      it("work that passed the guard is refused when a role change commits before it", async () => {
        const user = await member({ [tenantA]: "OWNER" });
        const token = await tokenFor(user.accessToken, tenantA);
        // The change is written but not committed: the guard still reads OWNER.
        const change = await hold(
          (em) =>
            em.execute(
              "update memberships set role = 'STAFF' where staff_user_id = ?",
              [user.userId],
            ),
          tenantA,
        );
        const request = ownerWrite(token);
        await lockWaiters(1);
        change.commit();
        await change.done;
        const response = await request;
        assert.equal(response.status, 403);
        assert.equal((await json(response)).code, "ROLE_FORBIDDEN");
      });

      it("work that passed the guard is refused when a revocation commits before it", async () => {
        const user = await member({ [tenantA]: "OWNER" });
        const token = await tokenFor(user.accessToken, tenantA);
        const revocation = await hold(
          (em) =>
            em.execute(
              "update memberships set status = 'REVOKED' where staff_user_id = ?",
              [user.userId],
            ),
          tenantA,
        );
        const request = ownerWrite(token);
        await lockWaiters(1);
        revocation.commit();
        await revocation.done;
        const response = await request;
        assert.equal(response.status, 403);
        assert.equal((await json(response)).code, "TENANT_ACCESS_DENIED");
      });

      it("a revocation waits for running tenant work, then applies to the next request", async () => {
        const user = await member({ [tenantA]: "OWNER" });
        const token = await tokenFor(user.accessToken, tenantA);
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => (entered = resolve));
        let release!: () => void;
        pause = {
          entered,
          release: new Promise<void>((resolve) => (release = resolve)),
        };
        try {
          const request = ownerWrite(token);
          await inside;
          let revoked = false;
          const revocation = setMembershipStatus(
            owner,
            tenantA,
            user.userId,
            "REVOKED",
          ).then(() => (revoked = true));
          await lockWaiters(1);
          assert.equal(revoked, false, "revocation must wait for the work");
          release();
          assert.equal((await request).status, 200);
          await revocation;
        } finally {
          pause = null;
        }
        assert.equal((await ownerWrite(token)).status, 403);
      });
    });

    describe("tenant switch races", () => {
      it("a switch racing a revocation of that membership never stores the tenant", async () => {
        const user = await member({ [tenantA]: "OWNER" });
        const revocation = await hold(
          (em) =>
            em.execute(
              "update memberships set status = 'REVOKED' where staff_user_id = ?",
              [user.userId],
            ),
          tenantA,
        );
        const switching = switchTenant(
          first.baseUrl,
          user.accessToken,
          tenantA,
        );
        await lockWaiters(1);
        revocation.commit();
        await revocation.done;
        const response = await switching;
        assert.equal(response.status, 404);
        assert.equal(await activeTenantOf(user.sessionId), null);
      });

      it("a switch that commits first makes the revocation wait; the token then stops working", async () => {
        for (let round = 0; round < 5; round++) {
          const user = await member({ [tenantA]: "OWNER" });
          const [switched] = await Promise.all([
            switchTenant(first.baseUrl, user.accessToken, tenantA),
            setMembershipStatus(owner, tenantA, user.userId, "REVOKED"),
          ]);
          if (switched.status === 200) {
            const { accessToken } = await json(switched);
            assert.equal((await me(first, accessToken)).status, 403);
          } else {
            assert.equal(switched.status, 404);
            assert.equal(await activeTenantOf(user.sessionId), null);
          }
        }
      });

      for (const order of ["refresh first", "switch first"] as const) {
        it(`a switch racing a refresh is never overwritten (${order})`, async () => {
          // Active tenant A was revoked, so the refresh would clear it; the switch moves to B.
          const user = await member({ [tenantA]: "OWNER", [tenantB]: "STAFF" });
          await tokenFor(user.accessToken, tenantA);
          await setMembershipStatus(owner, tenantA, user.userId, "REVOKED");

          const lock = await hold((em) =>
            em.execute("select 1 from staff_sessions where id = ? for update", [
              user.sessionId,
            ]),
          );
          const start = [
            () => refresh(user.cookie),
            () => switchTenant(first.baseUrl, user.accessToken, tenantB),
          ];
          if (order === "switch first") start.reverse();
          const firstCall = start[0]!();
          await lockWaiters(1);
          const secondCall = start[1]!();
          await lockWaiters(2);
          lock.commit();
          await lock.done;
          const responses = await Promise.all([firstCall, secondCall]);
          for (const response of responses) assert.equal(response.status, 200);
          assert.equal(await activeTenantOf(user.sessionId), tenantB);
        });
      }
    });

    describe("several API instances", () => {
      it("decisions do not depend on per-instance state", async () => {
        const user = await member({ [tenantA]: "OWNER" });
        // Switched on instance 1, used on instance 2.
        const token = await tokenFor(user.accessToken, tenantA);
        for (const server of [first, second])
          assert.equal((await me(server, token)).status, 200);

        await setMembershipStatus(owner, tenantA, user.userId, "REVOKED");
        for (const server of [first, second])
          assert.equal((await me(server, token)).status, 403);

        await setMembershipStatus(owner, tenantA, user.userId, "ACTIVE");
        for (const server of [first, second])
          assert.equal((await me(server, token)).status, 200);

        // Logout on instance 1 ends the session on instance 2 at once.
        const logout = await fetch(`${first.baseUrl}/v1/admin/auth/logout`, {
          method: "POST",
          headers: { cookie: user.cookie, origin: ADMIN_ORIGIN },
        });
        assert.equal(logout.status, 204);
        for (const server of [second, first])
          assert.equal((await me(server, token)).status, 401);
      });
    });
  },
);
