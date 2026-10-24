import { MikroORM } from "@mikro-orm/postgresql";
import { ConfigError, loadConfig } from "./config/config";
import { createApp } from "./app";
import {
  UnsafeDatabaseRoleError,
  assertSafeRuntimeRole,
} from "./database/runtime-role";
import { JsonLogger } from "./logging/json-logger";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = new JsonLogger(config.logLevel);
  const app = await createApp(config, { logger });
  // Fails before listening when the database is unreachable or the role could bypass RLS/run DDL.
  await assertSafeRuntimeRole(app.get(MikroORM));
  if (!config.auth.accessTokenPrivateKey)
    logger.write(
      "warn",
      "AUTH_ACCESS_TOKEN_PRIVATE_KEY not set: using an ephemeral key (development only)",
    );
  if (!config.auth.mfaEncryptionKey)
    logger.write(
      "warn",
      "AUTH_MFA_ENCRYPTION_KEY not set: using an ephemeral key (development only)",
    );
  await app.listen(config.port, config.host);
  logger.write("info", "api listening", {
    host: config.host,
    port: config.port,
  });
}

main().catch((error: unknown) => {
  // Invalid configuration must stop the process before it listens.
  if (
    error instanceof ConfigError ||
    error instanceof UnsafeDatabaseRoleError
  ) {
    process.stderr.write(`${error.message}\n`);
  } else {
    const code = (error as { code?: unknown } | null)?.code;
    const kind = error instanceof Error ? error.constructor.name : typeof error;
    process.stderr.write(
      `API failed to start: ${kind}${typeof code === "string" ? ` (${code})` : ""}\n`,
    );
  }
  process.exit(1);
});
