import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import {
  MFA_CHALLENGE_ATTEMPTS,
  MFA_CHALLENGE_TTL_SECONDS,
  MfaChallenges,
} from "../src/auth/mfa-challenges";
import { currentStep, totpCode } from "../src/auth/totp";
import { HeldTransactions } from "./concurrency";
import { json, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import { bearer, insertStaffUser } from "./staff-fixtures";

const PASSWORD = "segundo-fator-2026";

describe("MfaChallenges lifecycle", () => {
  const clock = () => {
    let now = 1_000_000;
    return {
      now: () => now,
      advance: (ms: number) => (now += ms),
    };
  };

  it("lets one verification run at a time and is single use", () => {
    const challenges = new MfaChallenges();
    const token = challenges.create("user", "a@b.test");
    assert.ok(challenges.beginVerification(token));
    assert.equal(challenges.beginVerification(token), null, "reserved");
    challenges.consume(token);
    assert.equal(challenges.beginVerification(token), null, "consumed");
    assert.equal(challenges.peek(token), null);
  });

  it("counts wrong codes and drops the challenge after the last attempt", () => {
    const challenges = new MfaChallenges();
    const token = challenges.create("user", "a@b.test");
    for (let i = 1; i < MFA_CHALLENGE_ATTEMPTS; i++) {
      assert.ok(challenges.beginVerification(token));
      challenges.recordFailure(token);
      assert.equal(
        challenges.peek(token)?.attemptsLeft,
        MFA_CHALLENGE_ATTEMPTS - i,
      );
    }
    assert.ok(challenges.beginVerification(token));
    challenges.recordFailure(token);
    assert.equal(challenges.beginVerification(token), null);
  });

  it("an unexpected error releases the challenge without spending an attempt", () => {
    const challenges = new MfaChallenges();
    const token = challenges.create("user", "a@b.test");
    assert.ok(challenges.beginVerification(token));
    challenges.release(token);
    const again = challenges.beginVerification(token);
    assert.equal(again?.attemptsLeft, MFA_CHALLENGE_ATTEMPTS);
  });

  it("rejects an expired challenge, even one left reserved", () => {
    const time = clock();
    const challenges = new MfaChallenges(time.now);
    const idle = challenges.create("user", "a@b.test");
    const reserved = challenges.create("user", "a@b.test");
    assert.ok(challenges.beginVerification(reserved));
    time.advance(MFA_CHALLENGE_TTL_SECONDS * 1000 - 1);
    assert.ok(challenges.peek(idle));
    time.advance(1);
    assert.equal(challenges.beginVerification(idle), null);
    assert.equal(challenges.peek(reserved), null);
    challenges.release(reserved);
    assert.equal(challenges.beginVerification(reserved), null);
  });
});

/**
 * MFA under concurrency and failures (M1.4 security review), against PostgreSQL: the
 * single-use guarantees of TOTP steps and recovery codes come from row locks in the database.
 */
describe("staff MFA consistency", { ...databaseSuite, timeout: 60_000 }, () => {
  let database: TestDatabase;
  let owner: MikroORM;
  let first: TestServer;
  let second: TestServer;
  let locks: HeldTransactions;
  let serial = 0;

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    locks = new HeldTransactions(owner);
    // Two instances sharing PostgreSQL and the keys, as in production.
    const env = {
      DATABASE_URL: database.appUrl,
      AUTH_ACCESS_TOKEN_PRIVATE_KEY: generateKeyPairSync("ed25519")
        .privateKey.export({ format: "der", type: "pkcs8" })
        .toString("base64"),
      AUTH_MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    };
    first = await startTestServer(env);
    second = await startTestServer(env);
  });
  afterEach(() => locks.releaseAll());
  after(async () => {
    await first?.close();
    await second?.close();
    await database?.drop();
  });

  const sql = <T>(query: string, params: unknown[] = []) =>
    owner.em.getConnection().execute<T[]>(query, params);
  const post = (path: string, body?: unknown, headers = {}, server = first) =>
    fetch(`${server.baseUrl}/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const get = (path: string, token: string) =>
    fetch(`${first.baseUrl}/v1${path}`, { headers: bearer(token) });
  const login = async (email: string, server = first) =>
    json(
      await post(
        "/admin/auth/login",
        { email, password: PASSWORD },
        {},
        server,
      ),
    );
  const claimsOf = (token: string) =>
    JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());

  /** A fresh user; `enrolled` also activates MFA (using the current TOTP step). */
  const user = async (enrolled: boolean, platformRole = "NONE") => {
    const email = `pessoa-${++serial}@mfa-consistencia.test`;
    const id = await insertStaffUser(owner, email, PASSWORD);
    if (platformRole !== "NONE")
      await sql("update staff_users set platform_role = ? where id = ?", [
        platformRole,
        id,
      ]);
    const { accessToken } = await login(email);
    const setup = await json(
      await post("/admin/auth/mfa/setup", undefined, bearer(accessToken)),
    );
    if (!enrolled)
      return { id, email, accessToken, secret: setup.secret as string };
    const activated = await post(
      "/admin/auth/mfa/activate",
      { code: totpCode(setup.secret, currentStep()) },
      bearer(accessToken),
    );
    assert.equal(activated.status, 200);
    const body = await json(activated);
    return {
      id,
      email,
      accessToken: body.accessToken as string,
      secret: setup.secret as string,
      recoveryCodes: body.recoveryCodes as string[],
    };
  };
  /** Next TOTP code: activation spent the current step. */
  const nextCode = (secret: string) => totpCode(secret, currentStep() + 1);
  const mfaSessions = async (userId: string) =>
    (
      await sql<{ n: number }>(
        "select count(*)::int as n from staff_sessions where staff_user_id = ? and mfa",
        [userId],
      )
    )[0]!.n;
  const recoveryLeft = async (userId: string) =>
    (
      await sql<{ n: number }>(
        "select cardinality(mfa_recovery_code_hashes) as n from staff_users where id = ?",
        [userId],
      )
    )[0]!.n;
  /** Locks the user row so verifications queue behind it. */
  const lockUser = (userId: string) =>
    locks.hold((em) =>
      em.execute("select 1 from staff_users where id = ? for update", [userId]),
    );

  describe("second login step", () => {
    it("the same challenge and TOTP code twice at once: one session", async () => {
      const u = await user(true);
      const sessionsBefore = await mfaSessions(u.id);
      const { mfaToken } = await login(u.email);
      const code = nextCode(u.secret);
      const lock = await lockUser(u.id);
      const winner = post("/admin/auth/login/mfa", { mfaToken, code });
      await locks.lockWaiters(1);
      // The challenge is reserved: the second request is refused without waiting.
      const loser = await post("/admin/auth/login/mfa", { mfaToken, code });
      assert.equal(loser.status, 401);
      assert.equal((await json(loser)).code, "MFA_CHALLENGE_INVALID");
      lock.commit();
      await lock.done;
      assert.equal((await winner).status, 200);
      assert.equal(await mfaSessions(u.id), sessionsBefore + 1);
    });

    it("a TOTP code and a recovery code on the same challenge: one session, code kept", async () => {
      const u = await user(true);
      const sessionsBefore = await mfaSessions(u.id);
      const { mfaToken } = await login(u.email);
      const lock = await lockUser(u.id);
      const totp = post("/admin/auth/login/mfa", {
        mfaToken,
        code: nextCode(u.secret),
      });
      await locks.lockWaiters(1);
      const recovery = await post("/admin/auth/login/mfa", {
        mfaToken,
        recoveryCode: u.recoveryCodes![0],
      });
      assert.equal(recovery.status, 401);
      lock.commit();
      await lock.done;
      assert.equal((await totp).status, 200);
      assert.equal(await mfaSessions(u.id), sessionsBefore + 1);
      assert.equal(await recoveryLeft(u.id), 10, "recovery code not spent");
    });

    for (const factor of ["TOTP code", "recovery code"] as const) {
      it(`the same ${factor} on two challenges, on two instances, at once: one session`, async () => {
        const u = await user(true);
        const sessionsBefore = await mfaSessions(u.id);
        const a = await login(u.email, first);
        const b = await login(u.email, second);
        const body =
          factor === "TOTP code"
            ? { code: nextCode(u.secret) }
            : { recoveryCode: u.recoveryCodes![4] };
        const lock = await lockUser(u.id);
        const requests = [
          post(
            "/admin/auth/login/mfa",
            { mfaToken: a.mfaToken, ...body },
            {},
            first,
          ),
          post(
            "/admin/auth/login/mfa",
            { mfaToken: b.mfaToken, ...body },
            {},
            second,
          ),
        ];
        await locks.lockWaiters(2);
        lock.commit();
        await lock.done;
        const statuses = (await Promise.all(requests))
          .map((r) => r.status)
          .sort();
        assert.deepEqual(statuses, [200, 401]);
        assert.equal(await mfaSessions(u.id), sessionsBefore + 1);
        if (factor === "recovery code")
          assert.equal(await recoveryLeft(u.id), 9);
      });
    }

    it("a recovery code works once", async () => {
      const u = await user(true);
      const code = u.recoveryCodes![7]!;
      const one = await login(u.email);
      assert.equal(
        (
          await post("/admin/auth/login/mfa", {
            mfaToken: one.mfaToken,
            recoveryCode: code,
          })
        ).status,
        200,
      );
      const two = await login(u.email);
      const reused = await post("/admin/auth/login/mfa", {
        mfaToken: two.mfaToken,
        recoveryCode: code,
      });
      assert.equal(reused.status, 401);
      assert.equal((await json(reused)).code, "MFA_INVALID");
    });

    it("five wrong codes end the challenge; the right code is then refused", async () => {
      const u = await user(true);
      const { mfaToken } = await login(u.email);
      for (let i = 0; i < 5; i++) {
        const wrong = await post("/admin/auth/login/mfa", {
          mfaToken,
          code: "000000",
        });
        assert.equal((await json(wrong)).code, "MFA_INVALID");
      }
      const late = await post("/admin/auth/login/mfa", {
        mfaToken,
        code: nextCode(u.secret),
      });
      assert.equal((await json(late)).code, "MFA_CHALLENGE_INVALID");
    });

    it("a database error neither burns the factor nor the challenge", async () => {
      const u = await user(true);
      const sessionsBefore = await mfaSessions(u.id);
      const { mfaToken } = await login(u.email);
      const code = u.recoveryCodes![2]!;
      // The factor is consumed first; creating the session then fails.
      await sql("revoke insert on staff_sessions from whiteoven_app");
      let failed: Response;
      try {
        failed = await post("/admin/auth/login/mfa", {
          mfaToken,
          recoveryCode: code,
        });
      } finally {
        await sql("grant insert on staff_sessions to whiteoven_app");
      }
      assert.equal(failed.status, 500);
      assert.equal(await recoveryLeft(u.id), 10, "rolled back with it");
      assert.equal(await mfaSessions(u.id), sessionsBefore);

      // Same challenge, same code: not locked, no attempt spent.
      const retry = await post("/admin/auth/login/mfa", {
        mfaToken,
        recoveryCode: code,
      });
      assert.equal(retry.status, 200);
      assert.equal(await recoveryLeft(u.id), 9);
    });

    it("a challenge exists only on the instance that issued it (fails closed)", async () => {
      const u = await user(true);
      const { mfaToken } = await login(u.email, first);
      const elsewhere = await post(
        "/admin/auth/login/mfa",
        { mfaToken, code: nextCode(u.secret) },
        {},
        second,
      );
      assert.equal(elsewhere.status, 401);
      assert.equal((await json(elsewhere)).code, "MFA_CHALLENGE_INVALID");
    });
  });

  describe("activation", () => {
    const activate = (token: string, code: string) =>
      post("/admin/auth/mfa/activate", { code }, bearer(token));
    const enrollment = async (userId: string) =>
      (
        await sql<{ enabled: boolean; pending: boolean }>(
          `select mfa_enabled_at is not null as enabled,
                    mfa_pending_secret is not null as pending
               from staff_users where id = ?`,
          [userId],
        )
      )[0]!;

    for (const change of ["revoked", "expired"] as const) {
      it(`a session ${change} during activation rolls the enrollment back`, async () => {
        const u = await user(false);
        const sid = claimsOf(u.accessToken).sid;
        const update =
          change === "revoked"
            ? "update staff_sessions set revoked_at = now(), revoked_reason = 'LOGOUT' where id = ?"
            : "update staff_sessions set idle_expires_at = now() - interval '1 second' where id = ?";
        // Uncommitted: the guard still sees a live session; activation waits on the row.
        const lock = await locks.hold((em) => em.execute(update, [sid]));
        const request = activate(
          u.accessToken,
          totpCode(u.secret, currentStep()),
        );
        await locks.lockWaiters(1);
        lock.commit();
        await lock.done;
        const response = await request;
        assert.equal(response.status, 401);
        const body = await json(response);
        assert.equal(body.code, "SESSION_INVALID");
        assert.equal(body.accessToken, undefined);
        assert.deepEqual(await enrollment(u.id), {
          enabled: false,
          pending: true,
        });
      });
    }

    it("two activations at once: one succeeds", async () => {
      const u = await user(false);
      const code = totpCode(u.secret, currentStep());
      const lock = await lockUser(u.id);
      const requests = [
        activate(u.accessToken, code),
        activate(u.accessToken, code),
      ];
      await locks.lockWaiters(2);
      lock.commit();
      await lock.done;
      const responses = await Promise.all(requests);
      const statuses = responses.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 409]);
      const loser = responses.find((r) => r.status === 409)!;
      assert.equal((await json(loser)).code, "MFA_SETUP_REQUIRED");
      assert.equal(await recoveryLeft(u.id), 10);
      assert.deepEqual(await enrollment(u.id), {
        enabled: true,
        pending: false,
      });
    });
  });

  describe("operators", () => {
    it("never reach privileged routes without a valid second factor", async () => {
      const op = await user(false, "OPERATOR");
      for (const path of ["/platform/me", "/admin/auth/tenants"]) {
        const response = await get(path, op.accessToken);
        assert.equal(response.status, 403, path);
        assert.equal((await json(response)).code, "MFA_REQUIRED");
      }
      // A wrong code does not upgrade anything.
      const wrong = await post(
        "/admin/auth/mfa/activate",
        { code: "000000" },
        bearer(op.accessToken),
      );
      assert.equal(wrong.status, 401);
      assert.equal((await get("/platform/me", op.accessToken)).status, 403);

      const activated = await json(
        await post(
          "/admin/auth/mfa/activate",
          { code: totpCode(op.secret, currentStep()) },
          bearer(op.accessToken),
        ),
      );
      assert.equal(
        (await get("/platform/me", activated.accessToken)).status,
        200,
      );
      // The session loses MFA in the database (or is revoked): the token stops working.
      await sql("update staff_sessions set mfa = false where id = ?", [
        claimsOf(activated.accessToken).sid,
      ]);
      assert.equal(
        (await get("/platform/me", activated.accessToken)).status,
        403,
      );
      await sql(
        "update staff_sessions set mfa = true, revoked_at = now(), revoked_reason = 'LOGOUT' where id = ?",
        [claimsOf(activated.accessToken).sid],
      );
      assert.equal(
        (await get("/platform/me", activated.accessToken)).status,
        401,
      );
    });
  });
});
