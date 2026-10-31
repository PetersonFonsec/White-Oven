import type { MikroORM } from "@mikro-orm/postgresql";
import { ConfigError, loadConfig } from "../config/config";
import { createOrm } from "../database/orm";
import { assertSafeRuntimeRole } from "../database/runtime-role";

/**
 * M7.3 security review (ADR 0031): confirms that every operator that can still sign in has an
 * active second factor. `PlatformGuard` already refuses every platform route without one (ADR
 * 0007); this check is the evidence for the signed checklist, run before the pilot and after any
 * operator change.
 *
 *   node dist/auth/check-operators-mfa.js
 *
 * Connects with the API's own configuration (`whiteoven_app`) and only reads. Prints counts and
 * the ids of the operators without MFA (never e-mails or names).
 *
 * Exit codes: 0 every operator has MFA, 2 at least one does not, 1 failure.
 */
export interface OperatorMfaReport {
  operators: number;
  withoutMfa: string[];
}

export async function operatorMfaReport(
  orm: MikroORM,
): Promise<OperatorMfaReport> {
  const rows = await orm.em
    .fork()
    .getConnection()
    .execute<{ id: string; mfa: boolean }[]>(
      `select id, mfa_enabled_at is not null as mfa
         from staff_users
        where platform_role = 'OPERATOR' and status <> 'DISABLED'
        order by id`,
    );
  return {
    operators: rows.length,
    withoutMfa: rows.filter((row) => !row.mfa).map((row) => row.id),
  };
}

async function main(): Promise<number> {
  const config = loadConfig(process.env);
  const orm = await createOrm({ url: config.database.url, poolMax: 1 });
  try {
    await assertSafeRuntimeRole(orm);
    const report = await operatorMfaReport(orm);
    process.stdout.write(
      `operators that can sign in: ${report.operators}\noperators without MFA: ${report.withoutMfa.length}\n`,
    );
    if (report.withoutMfa.length === 0) return 0;
    process.stdout.write(
      `${report.withoutMfa.map((id) => `- ${id}`).join("\n")}\nenroll their second factor or disable them before the pilot\n`,
    );
    return 2;
  } finally {
    await orm.close();
  }
}

if (require.main === module) {
  main().then(
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
          `check-operators-mfa failed: ${kind}${typeof code === "string" ? ` (${code})` : ""}\n`,
        );
      }
      process.exit(1);
    },
  );
}
