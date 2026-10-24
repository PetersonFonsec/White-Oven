import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MigrationConfigError,
  loadMigrationConfig,
  scramVerifier,
} from "../src/database/migrate";

const OWNER_URL = "postgres://whiteoven_owner:pw@db.internal:5432/whiteoven";

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadMigrationConfig(env);
  } catch (error) {
    assert.ok(error instanceof MigrationConfigError);
    return error.problems;
  }
  assert.fail("expected MigrationConfigError");
};

describe("loadMigrationConfig", () => {
  it("accepts the owner URL with optional runtime passwords", () => {
    assert.deepEqual(
      loadMigrationConfig({
        DATABASE_OWNER_URL: OWNER_URL,
        DATABASE_APP_PASSWORD: "a-long-app-password",
      }),
      {
        ownerUrl: OWNER_URL,
        passwords: { whiteoven_app: "a-long-app-password" },
      },
    );
  });

  it("requires whiteoven_owner, so DDL never runs as another role", () => {
    assert.deepEqual(problemsOf({}), ["DATABASE_OWNER_URL is required"]);
    assert.deepEqual(
      problemsOf({
        DATABASE_OWNER_URL: "postgres://postgres:pw@db.internal/whiteoven",
      }),
      ["DATABASE_OWNER_URL must use the role whiteoven_owner"],
    );
  });

  it("rejects short or non-ASCII passwords without echoing them", () => {
    const problems = problemsOf({
      DATABASE_OWNER_URL: OWNER_URL,
      DATABASE_APP_PASSWORD: "short",
      DATABASE_PLATFORM_PASSWORD: "não-ascii-password-ç",
    });
    assert.deepEqual(problems, [
      "DATABASE_APP_PASSWORD must be 16-128 printable ASCII characters",
      "DATABASE_PLATFORM_PASSWORD must be 16-128 printable ASCII characters",
    ]);
  });

  it("rejects MikroORM environment overrides", () => {
    assert.deepEqual(
      problemsOf({ DATABASE_OWNER_URL: OWNER_URL, MIKRO_ORM_DEBUG: "true" }),
      ["MIKRO_ORM_* variables are not supported"],
    );
  });
});

describe("scramVerifier", () => {
  it("produces a PostgreSQL SCRAM-SHA-256 verifier with a random salt", () => {
    const first = scramVerifier("a-long-app-password");
    assert.match(
      first,
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/,
    );
    assert.notEqual(first, scramVerifier("a-long-app-password"));
    assert.doesNotMatch(first, /a-long-app-password/);
  });

  it("is deterministic for a given salt", () => {
    const salt = Buffer.alloc(16, 7);
    assert.equal(
      scramVerifier("x".repeat(16), salt),
      scramVerifier("x".repeat(16), salt),
    );
  });
});
