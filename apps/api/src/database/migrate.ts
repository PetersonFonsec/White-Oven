import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { Migrator } from "@mikro-orm/migrations";
import type { MikroORM } from "@mikro-orm/postgresql";
import { OWNER_ROLE, databaseUrlProblem } from "../config/config";
import { MIGRATIONS } from "./migrations";
import { createOrm } from "./orm";

/**
 * Migration entry point, separate from the API process. Connects as `whiteoven_owner`, applies
 * pending migrations in one transaction and optionally (re)sets the runtime roles' passwords.
 *
 *   node dist/database/migrate.js [up|check]
 *
 * `check` exits 2 when migrations are pending, without applying them.
 */
export interface MigrationConfig {
  ownerUrl: string;
  passwords: Partial<Record<RuntimeRole, string>>;
}

export const RUNTIME_ROLES = ["whiteoven_app", "whiteoven_platform"] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

const PASSWORD_VARIABLES: Record<RuntimeRole, string> = {
  whiteoven_app: "DATABASE_APP_PASSWORD",
  whiteoven_platform: "DATABASE_PLATFORM_PASSWORD",
};

export class MigrationConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid migration configuration:\n- ${problems.join("\n- ")}`);
    this.name = "MigrationConfigError";
  }
}

export function loadMigrationConfig(env: NodeJS.ProcessEnv): MigrationConfig {
  const problems: string[] = [];
  if (Object.keys(env).some((name) => name.startsWith("MIKRO_ORM_")))
    problems.push("MIKRO_ORM_* variables are not supported");

  const ownerUrl = env.DATABASE_OWNER_URL ?? "";
  const urlProblem = databaseUrlProblem(ownerUrl);
  if (urlProblem) problems.push(`DATABASE_OWNER_URL ${urlProblem}`);
  else if (new URL(ownerUrl).username !== OWNER_ROLE)
    problems.push(`DATABASE_OWNER_URL must use the role ${OWNER_ROLE}`);

  const passwords: MigrationConfig["passwords"] = {};
  for (const role of RUNTIME_ROLES) {
    const name = PASSWORD_VARIABLES[role];
    const value = env[name];
    if (value === undefined || value === "") continue;
    // Printable ASCII keeps the client-side SCRAM verifier identical to the server's SASLprep.
    if (!/^[\x21-\x7e]{16,128}$/.test(value))
      problems.push(`${name} must be 16-128 printable ASCII characters`);
    else passwords[role] = value;
  }

  if (problems.length > 0) throw new MigrationConfigError(problems);
  return { ownerUrl, passwords };
}

/** Owner ORM with the migrator wired; snapshots are off (no writes to the image filesystem). */
export function createMigrationOrm(ownerUrl: string): Promise<MikroORM> {
  return createOrm(
    { url: ownerUrl, poolMax: 1 },
    {
      extensions: [Migrator],
      migrations: {
        migrationsList: MIGRATIONS,
        transactional: true,
        allOrNothing: true,
        snapshot: false,
        snapshotOnMigrate: false,
        silent: true,
      },
    },
  );
}

/** Refuses a superuser: tables would not belong to `whiteoven_owner` and RLS would not apply. */
async function assertMigrationRole(orm: MikroORM): Promise<void> {
  const [row] = await orm.em
    .getConnection()
    .execute<{ superuser: boolean; name: string }[]>(
      "select rolsuper as superuser, current_user as name from pg_roles where rolname = current_user",
    );
  if (!row || row.name !== OWNER_ROLE || row.superuser)
    throw new Error(`migrations must run as non-superuser ${OWNER_ROLE}`);
}

/** SCRAM-SHA-256 verifier computed locally, so the plain password never reaches the server. */
export function scramVerifier(
  password: string,
  salt = randomBytes(16),
  iterations = 4096,
): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted)
    .update("Server Key")
    .digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

async function setPasswords(
  orm: MikroORM,
  passwords: MigrationConfig["passwords"],
): Promise<RuntimeRole[]> {
  const connection = orm.em.getConnection();
  const changed: RuntimeRole[] = [];
  for (const role of RUNTIME_ROLES) {
    const password = passwords[role];
    if (!password) continue;
    const [row] = await connection.execute<{ statement: string }[]>(
      "select format('alter role %I with login password %L', ?::text, ?::text) as statement",
      [role, scramVerifier(password)],
    );
    if (!row) throw new Error("could not build password statement");
    await connection.execute(row.statement);
    changed.push(role);
  }
  return changed;
}

export interface MigrationRun {
  applied: string[];
  pending: string[];
  passwordsSet: RuntimeRole[];
}

export async function runMigrations(
  config: MigrationConfig,
  mode: "up" | "check" = "up",
): Promise<MigrationRun> {
  const orm = await createMigrationOrm(config.ownerUrl);
  try {
    await assertMigrationRole(orm);
    if (mode === "check") {
      const pending = await orm.migrator.getPending();
      return {
        applied: [],
        pending: pending.map((m) => m.name),
        passwordsSet: [],
      };
    }
    const applied = await orm.migrator.up();
    const passwordsSet = await setPasswords(orm, config.passwords);
    return { applied: applied.map((m) => m.name), pending: [], passwordsSet };
  } finally {
    await orm.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const mode = argv[0] ?? "up";
  if (mode !== "up" && mode !== "check") {
    process.stderr.write("usage: migrate.js [up|check]\n");
    return 64;
  }
  const result = await runMigrations(loadMigrationConfig(process.env), mode);
  for (const name of result.applied) process.stdout.write(`applied ${name}\n`);
  for (const name of result.pending) process.stdout.write(`pending ${name}\n`);
  for (const role of result.passwordsSet)
    process.stdout.write(`password set for ${role}\n`);
  if (mode === "check") return result.pending.length > 0 ? 2 : 0;
  if (result.applied.length === 0)
    process.stdout.write("no pending migrations\n");
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // Same rule as the API: name the failure, never echo URLs, SQL or values.
      if (error instanceof MigrationConfigError)
        process.stderr.write(`${error.message}\n`);
      else {
        const code = (error as { code?: unknown } | null)?.code;
        const kind =
          error instanceof Error ? error.constructor.name : typeof error;
        process.stderr.write(
          `migration failed: ${kind}${typeof code === "string" ? ` (${code})` : ""}\n`,
        );
      }
      process.exit(1);
    },
  );
}
