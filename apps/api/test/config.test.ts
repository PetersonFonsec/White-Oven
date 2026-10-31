import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config/config";

const DATABASE_URL = "postgres://whiteoven_app:pw@db.internal:5432/whiteoven";
const base = { DATABASE_URL };
const ACCESS_KEY = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");
/** Production requires persistent auth/invitation keys; other settings are tested here. */
const production = {
  NODE_ENV: "production",
  IMAGE_STORAGE_DIRECTORY: "/var/lib/whiteoven/images",
  AUTH_ACCESS_TOKEN_PRIVATE_KEY: ACCESS_KEY,
  AUTH_MFA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  OWNER_INVITE_SECRET: randomBytes(32).toString("base64"),
};

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig({ ...base, ...env });
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail("expected ConfigError");
};

describe("loadConfig", () => {
  it("applies safe development defaults", () => {
    assert.deepEqual(loadConfig(base), {
      nodeEnv: "development",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      openApiEnabled: true,
      imageStorageDirectory: ".data/images",
      database: { url: DATABASE_URL, poolMax: 10 },
      auth: {
        accessTokenPrivateKey: null,
        mfaEncryptionKey: null,
        ownerInviteSecret: null,
        adminOrigins: [],
      },
      push: { delivery: "disabled", expoAccessToken: null },
    });
  });

  it("disables OpenAPI by default in production but allows opting in", () => {
    assert.equal(loadConfig({ ...base, ...production }).openApiEnabled, false);
    assert.equal(
      loadConfig({
        ...base,
        ...production,
        API_OPENAPI_ENABLED: "true",
      }).openApiEnabled,
      true,
    );
  });

  it("accepts explicit valid values and freezes the result", () => {
    const config = loadConfig({
      ...base,
      DATABASE_POOL_MAX: "20",
      ...production,
      API_HOST: "0.0.0.0",
      API_PORT: "8080",
      API_LOG_LEVEL: "warn",
      API_OPENAPI_ENABLED: "false",
      IMAGE_STORAGE_DIRECTORY: "/srv/whiteoven/images",
    });
    assert.equal(config.port, 8080);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.database.poolMax, 20);
    assert.equal(config.imageStorageDirectory, "/srv/whiteoven/images");
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.database));
  });

  for (const [name, value] of [
    ["API_PORT", "abc"],
    ["API_PORT", "0"],
    ["API_PORT", "70000"],
    ["API_PORT", "3000.5"],
    ["API_HOST", "bad host!"],
    ["API_LOG_LEVEL", "verbose"],
    ["API_OPENAPI_ENABLED", "yes"],
    ["NODE_ENV", "staging"],
    ["DATABASE_URL", ""],
    ["DATABASE_URL", "not a url"],
    ["DATABASE_URL", "mysql://app:pw@db/whiteoven"],
    ["DATABASE_URL", "postgres://db.internal/whiteoven"],
    ["DATABASE_URL", "postgres://app:pw@db.internal"],
    ["DATABASE_URL", "postgres://whiteoven_owner:pw@db.internal/whiteoven"],
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "101"],
    ["DATABASE_POOL_MAX", "ten"],
    ["DATABASE_OWNER_URL", "postgres://whiteoven_owner:pw@db/whiteoven"],
    ["AUTH_ACCESS_TOKEN_PRIVATE_KEY", "not base64!"],
    ["AUTH_ACCESS_TOKEN_PRIVATE_KEY", Buffer.from("x").toString("base64")],
    [
      "AUTH_ACCESS_TOKEN_PRIVATE_KEY",
      generateKeyPairSync("ec", { namedCurve: "P-256" })
        .privateKey.export({ format: "der", type: "pkcs8" })
        .toString("base64"),
    ],
    ["AUTH_MFA_ENCRYPTION_KEY", randomBytes(16).toString("base64")],
    ["AUTH_MFA_ENCRYPTION_KEY", "not-base64-at-all"],
    ["OWNER_INVITE_SECRET", randomBytes(16).toString("base64")],
    ["OWNER_INVITE_SECRET", "not-base64-at-all"],
    ["API_ADMIN_ORIGINS", "https://admin.example.com/"],
    ["API_ADMIN_ORIGINS", "https://ok.example.com,ftp://x.example.com"],
  ] as const) {
    it(`rejects ${name}=${value}`, () => {
      const problems = problemsOf({ [name]: value });
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, new RegExp(`^${name} `));
    });
  }

  it("requires persistent authentication and invitation keys in production only", () => {
    assert.deepEqual(
      problemsOf({
        NODE_ENV: "production",
        IMAGE_STORAGE_DIRECTORY: "/var/lib/whiteoven/images",
      }),
      [
        "AUTH_ACCESS_TOKEN_PRIVATE_KEY is required in production",
        "AUTH_MFA_ENCRYPTION_KEY is required in production",
        "OWNER_INVITE_SECRET is required in production",
      ],
    );
    const config = loadConfig({
      ...base,
      ...production,
      API_ADMIN_ORIGINS:
        "https://admin.whiteoven.com.br, http://localhost:4200",
    });
    assert.equal(
      config.auth.accessTokenPrivateKey?.asymmetricKeyType,
      "ed25519",
    );
    assert.equal(config.auth.mfaEncryptionKey?.length, 32);
    assert.equal(config.auth.ownerInviteSecret?.length, 32);
    assert.deepEqual(config.auth.adminOrigins, [
      "https://admin.whiteoven.com.br",
      "http://localhost:4200",
    ]);
    assert.ok(Object.isFrozen(config.auth));
  });

  it("requires an absolute image storage directory in production", () => {
    const problems = problemsOf({
      ...production,
      IMAGE_STORAGE_DIRECTORY: "images",
    });
    assert.deepEqual(problems, [
      "IMAGE_STORAGE_DIRECTORY must be an absolute path in production",
    ]);
  });

  it("ignores unrelated variables that share the API_ prefix", () => {
    assert.equal(loadConfig({ ...base, API_TIMEOUT_MS: "1" }).port, 3000);
  });

  it("rejects MikroORM environment overrides, which would bypass loadConfig", () => {
    const problems = problemsOf({ MIKRO_ORM_CLIENT_URL: "postgres://x@y/z" });
    assert.deepEqual(problems, [
      "MIKRO_ORM_* variables are not supported; use DATABASE_URL",
    ]);
  });

  it("keeps push delivery off unless PUSH_DELIVERY=expo, with an optional Expo token", () => {
    const token = "a".repeat(40);
    assert.deepEqual(
      loadConfig({ ...base, PUSH_DELIVERY: "expo", EXPO_ACCESS_TOKEN: token })
        .push,
      { delivery: "expo", expoAccessToken: token },
    );
    assert.deepEqual(loadConfig({ ...base, ...production }).push, {
      delivery: "disabled",
      expoAccessToken: null,
    });
    assert.deepEqual(problemsOf({ PUSH_DELIVERY: "fcm" }), [
      "PUSH_DELIVERY must be one of: disabled, expo",
    ]);
    assert.deepEqual(problemsOf({ EXPO_ACCESS_TOKEN: token }), [
      "EXPO_ACCESS_TOKEN requires PUSH_DELIVERY=expo",
    ]);
    const problems = problemsOf({
      PUSH_DELIVERY: "expo",
      EXPO_ACCESS_TOKEN: "not a token!",
    });
    assert.deepEqual(problems, [
      "EXPO_ACCESS_TOKEN must be an Expo access token",
    ]);
  });

  it("reports every problem at once without echoing values", () => {
    const secretLooking = "s3cr3t-value";
    const problems = problemsOf({
      API_PORT: secretLooking,
      API_LOG_LEVEL: secretLooking,
      DATABASE_URL: `postgres://whiteoven_owner:${secretLooking}@db/whiteoven`,
    });
    assert.equal(problems.length, 3);
    assert.ok(problems.every((problem) => !problem.includes(secretLooking)));
  });
});
