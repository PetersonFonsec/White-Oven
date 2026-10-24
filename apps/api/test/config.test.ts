import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config/config";

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail("expected ConfigError");
};

describe("loadConfig", () => {
  it("applies safe development defaults", () => {
    assert.deepEqual(loadConfig({}), {
      nodeEnv: "development",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      openApiEnabled: true,
    });
  });

  it("disables OpenAPI by default in production but allows opting in", () => {
    assert.equal(loadConfig({ NODE_ENV: "production" }).openApiEnabled, false);
    assert.equal(
      loadConfig({ NODE_ENV: "production", API_OPENAPI_ENABLED: "true" })
        .openApiEnabled,
      true,
    );
  });

  it("accepts explicit valid values and freezes the result", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      API_HOST: "0.0.0.0",
      API_PORT: "8080",
      API_LOG_LEVEL: "warn",
      API_OPENAPI_ENABLED: "false",
    });
    assert.equal(config.port, 8080);
    assert.equal(config.host, "0.0.0.0");
    assert.ok(Object.isFrozen(config));
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
  ] as const) {
    it(`rejects ${name}=${value}`, () => {
      const problems = problemsOf({ [name]: value });
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, new RegExp(`^${name} `));
    });
  }

  it("ignores unrelated variables that share the API_ prefix", () => {
    assert.equal(loadConfig({ API_TIMEOUT_MS: "1" }).port, 3000);
  });

  it("reports every problem at once without echoing values", () => {
    const secretLooking = "s3cr3t-value";
    const problems = problemsOf({
      API_PORT: secretLooking,
      API_LOG_LEVEL: secretLooking,
    });
    assert.equal(problems.length, 2);
    assert.ok(problems.every((problem) => !problem.includes(secretLooking)));
  });
});
