import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { AccessTokens, type StaffAccessClaims } from "../src/auth/access-token";
import { LoginThrottle } from "../src/auth/login-throttle";
import {
  hashPassword,
  passwordProblem,
  verifyPassword,
} from "../src/auth/password";

const CLAIMS: StaffAccessClaims = {
  sub: "11111111-1111-4111-8111-111111111111",
  typ: "staff",
  tid: "22222222-2222-4222-8222-222222222222",
  sid: "33333333-3333-4333-8333-333333333333",
  mfa: false,
};

describe("AccessTokens", () => {
  const key = generateKeyPairSync("ed25519").privateKey;

  it("round-trips the minimal claims and expires after 15 minutes", () => {
    let now = Date.UTC(2026, 9, 24, 12);
    const tokens = new AccessTokens(key, () => now);
    const { token, expiresIn } = tokens.issue(CLAIMS);
    assert.equal(expiresIn, 900);
    assert.deepEqual(tokens.verify(token), CLAIMS);
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    );
    assert.deepEqual(Object.keys(payload).sort(), [
      "aud",
      "exp",
      "iat",
      "iss",
      "mfa",
      "sid",
      "sub",
      "tid",
      "typ",
    ]);
    now += 899_000;
    assert.ok(tokens.verify(token));
    now += 1_000;
    assert.equal(tokens.verify(token), null);
  });

  it("accepts tokens without an active tenant", () => {
    const tokens = new AccessTokens(key);
    const { token } = tokens.issue({ ...CLAIMS, tid: null });
    assert.equal(tokens.verify(token)?.tid, null);
  });

  it("rejects other keys, other algorithms and malformed claims", () => {
    const tokens = new AccessTokens(key);
    const other = AccessTokens.ephemeral();
    const [, payload] = tokens.issue(CLAIMS).token.split(".");
    const header = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    assert.equal(tokens.verify(other.issue(CLAIMS).token), null);
    assert.equal(tokens.verify(`${header({ alg: "none" })}.${payload}.`), null);
    assert.equal(
      tokens.verify(`${header({ alg: "HS256", typ: "JWT" })}.${payload}.x`),
      null,
    );
    for (const bad of [
      { ...CLAIMS, typ: "customer" },
      { ...CLAIMS, sub: "not-a-uuid" },
      { ...CLAIMS, tid: "" },
      { ...CLAIMS, mfa: "true" },
    ])
      assert.equal(
        tokens.verify(tokens.issue(bad as StaffAccessClaims).token),
        null,
      );
  });
});

describe("LoginThrottle", () => {
  it("locks after five account failures, doubling from 30 s up to 15 min", () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    const fail = () => throttle.recordFailure("a@x.test", `10.0.0.${now}`);
    for (let i = 0; i < 5; i++) fail();
    assert.equal(throttle.retryAfterMs("a@x.test", "10.9.9.9"), 0);
    fail();
    assert.equal(throttle.retryAfterMs("a@x.test", "10.9.9.9"), 30_000);
    fail();
    assert.equal(throttle.retryAfterMs("a@x.test", "10.9.9.9"), 60_000);
    for (let i = 0; i < 10; i++) fail();
    assert.equal(throttle.retryAfterMs("a@x.test", "10.9.9.9"), 900_000);
    assert.equal(throttle.retryAfterMs("b@x.test", "10.9.9.9"), 0);
    now += 900_000;
    assert.equal(throttle.retryAfterMs("a@x.test", "10.9.9.9"), 0);
  });

  it("limits an IP across accounts and forgets an account after success", () => {
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < 31; i++)
      throttle.recordFailure(`user${i}@x.test`, "10.0.0.1");
    assert.equal(throttle.retryAfterMs("new@x.test", "10.0.0.1"), 30_000);
    assert.equal(throttle.retryAfterMs("new@x.test", "10.0.0.2"), 0);

    for (let i = 0; i < 6; i++) throttle.recordFailure("c@x.test", "10.0.0.3");
    throttle.recordSuccess("c@x.test");
    assert.equal(throttle.retryAfterMs("c@x.test", "10.0.0.4"), 0);
  });
});

describe("passwords", () => {
  it("requires 10 to 256 characters and refuses common passwords", () => {
    assert.match(passwordProblem("curta")!, /at least 10/);
    assert.match(passwordProblem("x".repeat(257))!, /at most 256/);
    assert.equal(passwordProblem("Senha123456"), "is too common");
    assert.equal(passwordProblem("forno a lenha da vila"), undefined);
    // Code points, not UTF-16 units: ten emoji are ten characters.
    assert.equal(passwordProblem("🍕".repeat(10)), undefined);
  });

  it("hashes with Argon2id and verifies, normalizing Unicode", async () => {
    const encoded = await hashPassword("café-com-pizza");
    assert.match(encoded, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.equal(await verifyPassword(encoded, "café-com-pizza"), true);
    assert.equal(await verifyPassword(encoded, "outra-senha-qualquer"), false);
    assert.equal(await verifyPassword(null, "café-com-pizza"), false);
    assert.equal(await verifyPassword("not-a-hash", "x"), false);
  });
});
