import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { UNREACHABLE_DATABASE_URL } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";

// Compiled layout: dist/tests/test/startup.test.js -> dist/tests/src/main.js
const MAIN = join(__dirname, "..", "src", "main.js");

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });

function run(env: NodeJS.ProcessEnv, untilOutput?: RegExp) {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout; stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (untilOutput?.test(stdout)) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("process startup", () => {
  it("refuses to start with invalid configuration and exits 1 before listening", async () => {
    const result = await run({
      NODE_ENV: "test",
      API_PORT: "not-a-port",
      API_LOG_LEVEL: "x",
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid API configuration/);
    assert.match(result.stderr, /API_PORT must be an integer/);
    assert.match(result.stderr, /API_LOG_LEVEL must be one of/);
    assert.doesNotMatch(result.stderr, /not-a-port|\n\s+at /);
    assert.doesNotMatch(result.stdout, /api listening/);
  });

  it("refuses to start when the database is unreachable, without echoing the URL", async () => {
    const result = await run({
      NODE_ENV: "test",
      API_PORT: String(await freePort()),
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
    });
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /^API failed to start: \w+ \(ECONNREFUSED\)\n$/,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /unused-password/);
    assert.doesNotMatch(result.stdout, /api listening/);
  });
});

describe("process startup with PostgreSQL", databaseSuite, () => {
  let database: TestDatabase;
  before(async () => {
    database = await createTestDatabase();
  });
  after(() => database?.drop());

  it("starts as whiteoven_app, logs JSON and stops on SIGTERM", async () => {
    const port = await freePort();
    const result = await run(
      {
        NODE_ENV: "test",
        API_PORT: String(port),
        DATABASE_URL: database.appUrl,
      },
      /api listening/,
    );
    assert.equal(result.stderr, "");
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const listening = lines.find((line) => line.msg === "api listening");
    assert.equal(listening.port, port);
    // Nest closes the app on SIGTERM, then re-raises the signal so the exit reason is preserved.
    assert.equal(result.signal, "SIGTERM");
  });

  /** Creates a login role able to connect (owner has CREATEROLE), runs `fn`, then drops it. */
  async function withRole<T>(
    attributes: string,
    fn: (url: string) => Promise<T>,
  ): Promise<T> {
    const role = `whiteoven_test_role_${process.pid}`;
    const password = "test-role-password-1234";
    const owner = await database.connect(database.ownerUrl);
    const sql = owner.em.getConnection();
    await sql.execute(
      `create role ${role} login ${attributes} password '${password}'`,
    );
    try {
      await sql.execute(
        `grant connect on database "${database.name}" to ${role}`,
      );
      await sql.execute(`grant usage on schema public to ${role}`);
      const url = new URL(database.appUrl);
      url.username = role;
      url.password = password;
      return await fn(url.toString());
    } finally {
      await sql.execute(`revoke usage on schema public from ${role}`);
      await sql.execute(
        `revoke connect on database "${database.name}" from ${role}`,
      );
      await sql.execute(`drop role ${role}`);
    }
  }

  const startWith = async (databaseUrl: string) =>
    run({
      NODE_ENV: "test",
      API_PORT: String(await freePort()),
      DATABASE_URL: databaseUrl,
    });

  it("refuses to serve as any role other than whiteoven_app, even without elevated privileges", async () => {
    await withRole(
      "nosuperuser nobypassrls nocreatedb nocreaterole noreplication noinherit",
      async (url) => {
        const result = await startWith(url);
        assert.equal(result.code, 1);
        assert.equal(
          result.stderr,
          "Unsafe database role for the API: not_app_role\n",
        );
        assert.doesNotMatch(result.stdout, /api listening/);
      },
    );
  });

  it("refuses to serve as whiteoven_platform", async () => {
    const result = await startWith(database.platformUrl);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "Unsafe database role for the API: not_app_role\n",
    );
    assert.doesNotMatch(result.stdout, /api listening/);
  });

  it("refuses to serve with a role that could create databases, before listening", async () => {
    // loadConfig already rejects whiteoven_owner by name; the database check catches any other
    // unsafe role.
    await withRole("createdb", async (url) => {
      const result = await startWith(url);
      assert.equal(result.code, 1);
      assert.equal(
        result.stderr,
        "Unsafe database role for the API: not_app_role, create_db\n",
      );
      assert.doesNotMatch(result.stdout, /api listening/);
    });
  });
});
