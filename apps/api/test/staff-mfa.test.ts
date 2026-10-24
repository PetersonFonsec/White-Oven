import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createFirstOperator } from "../src/auth/create-operator";
import { currentStep, totpCode } from "../src/auth/totp";
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
} from "./staff-fixtures";

const PASSWORD = "segundo-fator-2026";
// Compiled layout: dist/tests/test/staff-mfa.test.js -> dist/tests/src/auth/create-operator.js
const CLI = join(__dirname, "..", "src", "auth", "create-operator.js");

describe("staff MFA, platform guard and first operator", databaseSuite, () => {
  let database: TestDatabase;
  let owner: MikroORM;
  let server: TestServer;
  let tenantId: string;
  /** Second-factor platform token of the first operator, set by the operator tests. */
  let operatorToken = "";

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    tenantId = await insertTenant(owner, "mfa-loja");
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
    });
  });
  after(async () => {
    await server?.close();
    await database?.drop();
  });

  const url = (path: string) => `${server.baseUrl}/v1${path}`;
  const post = (path: string, body?: unknown, headers = {}) =>
    fetch(url(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const get = (path: string, token: string) =>
    fetch(url(path), { headers: bearer(token) });
  const login = async (email: string) =>
    json(await post("/admin/auth/login", { email, password: PASSWORD }));

  /** Enrolls `token`'s user; returns the secret, recovery codes and the upgraded token. */
  const enroll = async (token: string) => {
    const setup = await post("/admin/auth/mfa/setup", undefined, bearer(token));
    assert.equal(setup.status, 200);
    assert.equal(setup.headers.get("cache-control"), "no-store");
    const { secret, otpauthUri } = await json(setup);
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(
      otpauthUri,
      new RegExp(
        `^otpauth://totp/WhiteOven%3A.+\\?secret=${secret}&issuer=WhiteOven&algorithm=SHA1&digits=6&period=30$`,
      ),
    );
    const activated = await post(
      "/admin/auth/mfa/activate",
      { code: totpCode(secret, currentStep()) },
      bearer(token),
    );
    assert.equal(activated.status, 200);
    const body = await json(activated);
    return {
      secret,
      recoveryCodes: body.recoveryCodes as string[],
      token: body.accessToken as string,
    };
  };

  describe("enrollment", () => {
    it("activates with a valid code, returns 10 recovery codes once and upgrades the session", async () => {
      const userId = await insertStaffUser(owner, "dona@mfa.test", PASSWORD);
      await insertMembership(owner, tenantId, userId, "OWNER");
      const { accessToken } = await login("dona@mfa.test");
      const claimsOf = (token: string) =>
        JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
      assert.equal(claimsOf(accessToken).mfa, false);

      const setup = await json(
        await post("/admin/auth/mfa/setup", undefined, bearer(accessToken)),
      );
      const wrong = await post(
        "/admin/auth/mfa/activate",
        { code: "000000" },
        bearer(accessToken),
      );
      assert.equal(wrong.status, 401);
      assert.equal((await json(wrong)).code, "MFA_INVALID");

      const activated = await post(
        "/admin/auth/mfa/activate",
        { code: totpCode(setup.secret, currentStep()) },
        bearer(accessToken),
      );
      assert.equal(activated.status, 200);
      const body = await json(activated);
      assert.equal(body.recoveryCodes.length, 10);
      assert.ok(
        body.recoveryCodes.every((c: string) =>
          /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c),
        ),
      );
      assert.equal(claimsOf(body.accessToken).mfa, true);

      const again = await post(
        "/admin/auth/mfa/setup",
        undefined,
        bearer(body.accessToken),
      );
      assert.equal(again.status, 409);
      assert.equal((await json(again)).code, "MFA_ALREADY_ENABLED");

      // At rest: sealed secret, no plain base32, recovery codes only as hashes.
      const [row] = await owner.em
        .getConnection()
        .execute<
          { secret: string; pending: string | null; hashes: Buffer[] }[]
        >(
          `select mfa_secret as secret, mfa_pending_secret as pending,
                mfa_recovery_code_hashes as hashes
           from staff_users where id = ?`,
          [userId],
        );
      assert.match(row!.secret, /^v1\./);
      assert.ok(!row!.secret.includes(setup.secret));
      assert.equal(row!.pending, null);
      assert.equal(row!.hashes.length, 10);
      assert.ok(row!.hashes.every((h) => h.length === 32));
    });

    it("activation without setup answers 409", async () => {
      await insertStaffUser(owner, "sem-setup@mfa.test", PASSWORD);
      const { accessToken } = await login("sem-setup@mfa.test");
      const response = await post(
        "/admin/auth/mfa/activate",
        { code: "123456" },
        bearer(accessToken),
      );
      assert.equal(response.status, 409);
      assert.equal((await json(response)).code, "MFA_SETUP_REQUIRED");
    });

    it("a sealed secret copied to another user does not decrypt", async () => {
      const a = await insertStaffUser(owner, "copia-a@mfa.test", PASSWORD);
      await insertStaffUser(owner, "copia-b@mfa.test", PASSWORD);
      const tokenA = (await login("copia-a@mfa.test")).accessToken;
      const tokenB = (await login("copia-b@mfa.test")).accessToken;
      const { secret } = await json(
        await post("/admin/auth/mfa/setup", undefined, bearer(tokenA)),
      );
      await post("/admin/auth/mfa/setup", undefined, bearer(tokenB));
      await owner.em.getConnection().execute(
        `update staff_users set mfa_pending_secret = (select mfa_pending_secret from staff_users where id = ?)
          where email = 'copia-b@mfa.test'`,
        [a],
      );
      const response = await post(
        "/admin/auth/mfa/activate",
        { code: totpCode(secret, currentStep()) },
        bearer(tokenB),
      );
      assert.equal(response.status, 401);
    });
  });

  describe("login with a second factor", () => {
    it("asks for the second factor, accepts a TOTP code once and refuses replays", async () => {
      await insertStaffUser(owner, "totp@mfa.test", PASSWORD);
      const { secret } = await enroll(
        (await login("totp@mfa.test")).accessToken,
      );

      const first = await login("totp@mfa.test");
      assert.deepEqual(Object.keys(first).sort(), [
        "expiresIn",
        "mfaRequired",
        "mfaToken",
      ]);
      assert.equal(first.mfaRequired, true);
      assert.equal(first.expiresIn, 300);

      // Activation used the current step; the next step is still inside the drift window.
      const code = totpCode(secret, currentStep() + 1);
      const ok = await post("/admin/auth/login/mfa", {
        mfaToken: first.mfaToken,
        code,
      });
      assert.equal(ok.status, 200);
      assert.ok(refreshCookieOf(ok));
      const tokens = await json(ok);
      assert.equal(
        JSON.parse(
          Buffer.from(tokens.accessToken.split(".")[1], "base64url").toString(),
        ).mfa,
        true,
      );

      // Single-use challenge, and the same code cannot open another session.
      const reused = await post("/admin/auth/login/mfa", {
        mfaToken: first.mfaToken,
        code,
      });
      assert.equal(reused.status, 401);
      assert.equal((await json(reused)).code, "MFA_CHALLENGE_INVALID");
      const second = await login("totp@mfa.test");
      const replay = await post("/admin/auth/login/mfa", {
        mfaToken: second.mfaToken,
        code,
      });
      assert.equal(replay.status, 401);
      assert.equal((await json(replay)).code, "MFA_INVALID");
    });

    it("accepts each recovery code once, in any case and with or without the dash", async () => {
      await insertStaffUser(owner, "recupera@mfa.test", PASSWORD);
      const { recoveryCodes } = await enroll(
        (await login("recupera@mfa.test")).accessToken,
      );
      const code = recoveryCodes[3]!;
      const typed = code.replace("-", "").toUpperCase();
      const first = await login("recupera@mfa.test");
      const ok = await post("/admin/auth/login/mfa", {
        mfaToken: first.mfaToken,
        recoveryCode: typed,
      });
      assert.equal(ok.status, 200);
      const second = await login("recupera@mfa.test");
      const again = await post("/admin/auth/login/mfa", {
        mfaToken: second.mfaToken,
        recoveryCode: code,
      });
      assert.equal(again.status, 401);
      const [row] = await owner.em
        .getConnection()
        .execute<{ n: number }[]>(
          "select cardinality(mfa_recovery_code_hashes) as n from staff_users where email = ?",
          ["recupera@mfa.test"],
        );
      assert.equal(row!.n, 9);
    });

    it("drops the challenge after 5 wrong codes and rejects mixed or unknown fields", async () => {
      await insertStaffUser(owner, "erra@mfa.test", PASSWORD);
      const { secret } = await enroll(
        (await login("erra@mfa.test")).accessToken,
      );
      const { mfaToken } = await login("erra@mfa.test");
      for (const body of [
        { mfaToken, code: "123456", recoveryCode: "abcde-fghij" },
        { mfaToken },
        { mfaToken, code: "123456", extra: true },
      ]) {
        const response = await post("/admin/auth/login/mfa", body);
        assert.equal(response.status, 422, JSON.stringify(body));
      }
      for (let i = 0; i < 5; i++)
        assert.equal(
          (await post("/admin/auth/login/mfa", { mfaToken, code: "000000" }))
            .status,
          401,
        );
      const late = await post("/admin/auth/login/mfa", {
        mfaToken,
        code: totpCode(secret, currentStep() + 1),
      });
      assert.equal(late.status, 401);
      assert.equal((await json(late)).code, "MFA_CHALLENGE_INVALID");
    });
  });

  describe("operators and the platform guard", () => {
    it("creates the first operator once, refusing a second one", async () => {
      const created = await createFirstOperator(database.appUrl, {
        email: " Operadora@WhiteOven.test ",
        name: "Operadora",
        password: PASSWORD,
      });
      assert.equal(created.kind, "created");
      assert.deepEqual(
        await createFirstOperator(database.appUrl, {
          email: "outra@whiteoven.test",
          name: "Outra",
          password: PASSWORD,
        }),
        { kind: "refused", reason: "an operator already exists" },
      );
      assert.deepEqual(
        await createFirstOperator(database.appUrl, {
          email: "x",
          name: "",
          password: "curta",
        }),
        {
          kind: "invalid",
          problems: [
            "e-mail is invalid",
            "name must have 1 to 120 characters",
            "password must have at least 10 characters",
          ],
        },
      );
    });

    it("an operator without MFA reaches only enrollment; with it, the platform routes", async () => {
      const { accessToken } = await login("operadora@whiteoven.test");
      for (const path of ["/platform/me", "/admin/auth/tenants"]) {
        const response = await get(path, accessToken);
        assert.equal(response.status, 403, path);
        assert.equal((await json(response)).code, "MFA_REQUIRED");
      }
      const { token, secret } = await enroll(accessToken);
      const me = await get("/platform/me", token);
      assert.equal(me.status, 200);
      assert.equal((await json(me)).platformRole, "OPERATOR");
      // The pre-enrollment token still says mfa=false: refused even though the session upgraded.
      assert.equal((await get("/platform/me", accessToken)).status, 403);

      // Next login: password alone is not enough; the second step opens the platform.
      const challenge = await login("operadora@whiteoven.test");
      assert.equal(challenge.mfaRequired, true);
      const done = await json(
        await post("/admin/auth/login/mfa", {
          mfaToken: challenge.mfaToken,
          code: totpCode(secret, currentStep() + 1),
        }),
      );
      assert.equal((await get("/platform/me", done.accessToken)).status, 200);
      operatorToken = done.accessToken;
    });

    it("checks the session in the database too, not only the token's mfa claim", async () => {
      await owner.em
        .getConnection()
        .execute("update staff_sessions set mfa = false where id = ?", [
          JSON.parse(
            Buffer.from(operatorToken.split(".")[1]!, "base64url").toString(),
          ).sid,
        ]);
      const response = await get("/platform/me", operatorToken);
      assert.equal(response.status, 403);
      assert.equal((await json(response)).code, "MFA_REQUIRED");
    });

    it("store staff get 403 on platform routes", async () => {
      await insertStaffUser(owner, "loja@mfa.test", PASSWORD);
      const token = (await login("loja@mfa.test")).accessToken;
      const response = await get("/platform/me", token);
      assert.equal(response.status, 403);
      assert.equal((await json(response)).code, "PLATFORM_FORBIDDEN");
    });
  });

  describe("create-operator CLI", () => {
    const run = (args: string[], stdin: string, env: NodeJS.ProcessEnv) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(process.execPath, [CLI, ...args], {
            env: { PATH: process.env.PATH, NODE_ENV: "test", ...env },
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.on("exit", (code) => resolve({ code, stdout, stderr }));
          child.stdin.end(stdin);
        },
      );

    it("reads the password from stdin and reports outcomes by exit code", async () => {
      const fresh = await createTestDatabase();
      try {
        const env = { DATABASE_URL: fresh.appUrl };
        assert.equal((await run([], "", env)).code, 64);
        const weak = await run(
          ["op@whiteoven.test", "Op"],
          "1234567890\n",
          env,
        );
        assert.equal(weak.code, 65);
        assert.match(weak.stderr, /password is too common/);
        assert.ok(!weak.stderr.includes("1234567890"));
        const created = await run(
          ["op@whiteoven.test", "Op"],
          `${PASSWORD}\n`,
          env,
        );
        assert.equal(created.code, 0, created.stderr);
        assert.match(created.stdout, /^operator created: [0-9a-f-]{36}\n/);
        const again = await run(
          ["op2@whiteoven.test", "Op"],
          `${PASSWORD}\n`,
          env,
        );
        assert.equal(again.code, 3);
        assert.match(again.stderr, /an operator already exists/);
        const badConfig = await run(
          ["op@whiteoven.test", "Op"],
          `${PASSWORD}\n`,
          {
            DATABASE_URL: "nope",
          },
        );
        assert.equal(badConfig.code, 1);
        assert.match(
          badConfig.stderr,
          /DATABASE_URL must be a postgres:\/\/ URL/,
        );
      } finally {
        await fresh.drop();
      }
    });
  });
});
