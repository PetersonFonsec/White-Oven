import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config/config";

const DATABASE_URL = "postgres://whiteoven_app:pw@db.internal:5432/whiteoven";
const base = { DATABASE_URL };

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
      database: { url: DATABASE_URL, poolMax: 10 },
    });
  });

  it("disables OpenAPI by default in production but allows opting in", () => {
    assert.equal(
      loadConfig({ ...base, NODE_ENV: "production" }).openApiEnabled,
      false,
    );
    assert.equal(
      loadConfig({
        ...base,
        NODE_ENV: "production",
        API_OPENAPI_ENABLED: "true",
      }).openApiEnabled,
      true,
    );
  });

  it("accepts explicit valid values and freezes the result", () => {
    const config = loadConfig({
      ...base,
      DATABASE_POOL_MAX: "20",
      NODE_ENV: "production",
      API_HOST: "0.0.0.0",
      API_PORT: "8080",
      API_LOG_LEVEL: "warn",
      API_OPENAPI_ENABLED: "false",
    });
    assert.equal(config.port, 8080);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.database.poolMax, 20);
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
  ] as const) {
    it(`rejects ${name}=${value}`, () => {
      const problems = problemsOf({ [name]: value });
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, new RegExp(`^${name} `));
    });
  }

  it("ignores unrelated variables that share the API_ prefix", () => {
    assert.equal(loadConfig({ ...base, API_TIMEOUT_MS: "1" }).port, 3000);
  });

  it("rejects MikroORM environment overrides, which would bypass loadConfig", () => {
    const problems = problemsOf({ MIKRO_ORM_CLIENT_URL: "postgres://x@y/z" });
    assert.deepEqual(problems, [
      "MIKRO_ORM_* variables are not supported; use DATABASE_URL",
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
