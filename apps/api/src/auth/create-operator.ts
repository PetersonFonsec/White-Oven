import { createOrm } from "../database/orm";
import { assertSafeRuntimeRole } from "../database/runtime-role";
import { ConfigError, loadConfig } from "../config/config";
import { hashPassword, passwordProblem } from "./password";

/**
 * Creates the first WhiteOven operator (M1.4, ADR 0007). Later operators are created by
 * operators (M1.5+), so this refuses to run once any operator exists.
 *
 *   printf '%s\n' "$PASSWORD" | node dist/auth/create-operator.js <email> <name>
 *
 * The password comes from stdin, never from arguments or environment (process listings, shell
 * history). Connects with the API's own configuration (`whiteoven_app`). The operator has no
 * second factor yet: on the first login it can only reach the MFA enrollment routes.
 *
 * Exit codes: 0 created, 1 failure, 3 refused (operator or e-mail already exists), 64 usage,
 * 65 invalid input.
 */
export type CreateOperatorResult =
  | { kind: "created"; id: string }
  | { kind: "refused"; reason: string }
  | { kind: "invalid"; problems: string[] };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}$/;

export async function createFirstOperator(
  databaseUrl: string,
  input: { email: string; name: string; password: string },
): Promise<CreateOperatorResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const problems: string[] = [];
  if (!EMAIL.test(email)) problems.push("e-mail is invalid");
  if (name.length < 1 || name.length > 120)
    problems.push("name must have 1 to 120 characters");
  const passwordIssue = passwordProblem(input.password);
  if (passwordIssue) problems.push(`password ${passwordIssue}`);
  if (problems.length > 0) return { kind: "invalid", problems };

  const passwordHash = await hashPassword(input.password);
  const orm = await createOrm({ url: databaseUrl, poolMax: 1 });
  try {
    await assertSafeRuntimeRole(orm);
    return await orm.em.fork().transactional(async (em) => {
      // Serializes concurrent runs: only one can see "no operator" and insert.
      await em.execute("select pg_advisory_xact_lock(20261024, 1)");
      const [existing] = await em.execute<
        { operator: boolean; email: boolean }[]
      >(
        `select bool_or(platform_role = 'OPERATOR') as operator,
                bool_or(email = ?) as email
           from staff_users`,
        [email],
      );
      if (existing?.operator)
        return {
          kind: "refused" as const,
          reason: "an operator already exists",
        };
      if (existing?.email)
        return {
          kind: "refused" as const,
          reason: "e-mail already registered",
        };
      const [row] = await em.execute<{ id: string }[]>(
        `insert into staff_users (email, name, password_hash, platform_role, status)
         values (?, ?, ?, 'OPERATOR', 'ACTIVE') returning id`,
        [email, name, passwordHash],
      );
      return { kind: "created" as const, id: row!.id };
    });
  } finally {
    await orm.close();
  }
}

async function readStdinLine(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.includes("\n") || data.length > 4096) break;
  }
  return data.split(/\r?\n/)[0] ?? "";
}

async function main(argv: string[]): Promise<number> {
  const [email, name, ...rest] = argv;
  if (!email || !name || rest.length > 0) {
    process.stderr.write(
      "usage: create-operator.js <email> <name>   (password on stdin)\n",
    );
    return 64;
  }
  const config = loadConfig(process.env);
  const result = await createFirstOperator(config.database.url, {
    email,
    name,
    password: await readStdinLine(),
  });
  switch (result.kind) {
    case "created":
      process.stdout.write(
        `operator created: ${result.id}\nsign in and enroll the second factor before any platform action\n`,
      );
      return 0;
    case "refused":
      process.stderr.write(`refused: ${result.reason}\n`);
      return 3;
    case "invalid":
      process.stderr.write(
        `invalid input:\n- ${result.problems.join("\n- ")}\n`,
      );
      return 65;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // Same rule as the API: name the failure, never echo URLs, SQL or values.
      if (error instanceof ConfigError)
        process.stderr.write(`${error.message}\n`);
      else {
        const code = (error as { code?: unknown } | null)?.code;
        const kind =
          error instanceof Error ? error.constructor.name : typeof error;
        process.stderr.write(
          `create-operator failed: ${kind}${typeof code === "string" ? ` (${code})` : ""}\n`,
        );
      }
      process.exit(1);
    },
  );
}
