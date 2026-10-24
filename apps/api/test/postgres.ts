import { randomBytes } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { runMigrations } from "../src/database/migrate";
import { createOrm } from "../src/database/orm";

/**
 * Integration tests run against a real PostgreSQL (never mocks). Point
 * TEST_DATABASE_OWNER_URL at the `whiteoven_owner` role, e.g. after
 * `docker compose -f compose.dev.yaml up -d --wait postgres`:
 *   postgres://whiteoven_owner:whiteoven-dev-owner-password@127.0.0.1:5432/whiteoven
 * Without it the suites are skipped locally and fail in CI.
 */
const OWNER_URL = process.env.TEST_DATABASE_OWNER_URL;
// Roles and passwords are cluster-wide, so every test process must set the same values; the
// defaults match compose.dev.yaml so tests do not break a running development stack.
const APP_PASSWORD =
  process.env.TEST_DATABASE_APP_PASSWORD ?? "whiteoven-dev-app-password";
const PLATFORM_PASSWORD =
  process.env.TEST_DATABASE_PLATFORM_PASSWORD ??
  "whiteoven-dev-platform-password";

if (!OWNER_URL && process.env.CI)
  throw new Error("TEST_DATABASE_OWNER_URL is required in CI");

/** `describe(name, databaseSuite, ...)`: skips with a reason when no database is configured. */
export const databaseSuite = {
  skip: OWNER_URL ? false : "TEST_DATABASE_OWNER_URL not set",
} as const;

export interface TestDatabase {
  name: string;
  ownerUrl: string;
  appUrl: string;
  platformUrl: string;
  /** Opens an ORM on this database for `url`; closed by `drop()`. */
  connect(url: string): Promise<MikroORM>;
  drop(): Promise<void>;
}

const withDatabase = (
  url: string,
  database: string,
  user?: string,
  password?: string,
) => {
  const target = new URL(url);
  target.pathname = `/${database}`;
  if (user) target.username = user;
  if (password !== undefined) target.password = password;
  return target.toString();
};

/**
 * Creates a throwaway database owned by `whiteoven_owner` and applies the migrations. Test files
 * run in parallel processes; an advisory lock in the maintenance database serializes the role
 * creation they all attempt.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  if (!OWNER_URL) throw new Error("TEST_DATABASE_OWNER_URL not set");
  const name = `whiteoven_test_${randomBytes(6).toString("hex")}`;
  const ownerUrl = withDatabase(OWNER_URL, name);
  // poolMax 1: the session-level advisory lock and its unlock share one connection.
  const maintenance = await createOrm({ url: OWNER_URL, poolMax: 1 });
  const connection = maintenance.em.getConnection();
  try {
    await connection.execute(`create database "${name}"`);
    await connection.execute("select pg_advisory_lock(20261024)");
    if (options.migrate ?? true)
      await runMigrations({
        ownerUrl,
        passwords: {
          whiteoven_app: APP_PASSWORD,
          whiteoven_platform: PLATFORM_PASSWORD,
        },
      });
  } finally {
    await connection.execute("select pg_advisory_unlock_all()").catch(() => {});
    await maintenance.close();
  }

  const opened: MikroORM[] = [];
  return {
    name,
    ownerUrl,
    appUrl: withDatabase(OWNER_URL, name, "whiteoven_app", APP_PASSWORD),
    platformUrl: withDatabase(
      OWNER_URL,
      name,
      "whiteoven_platform",
      PLATFORM_PASSWORD,
    ),
    async connect(url) {
      const orm = await createOrm({ url, poolMax: 2 });
      opened.push(orm);
      return orm;
    },
    async drop() {
      await Promise.all(opened.map((orm) => orm.close()));
      const admin = await createOrm({ url: OWNER_URL, poolMax: 1 });
      try {
        await admin.em
          .getConnection()
          .execute(`drop database if exists "${name}" with (force)`);
      } finally {
        await admin.close();
      }
    },
  };
}
