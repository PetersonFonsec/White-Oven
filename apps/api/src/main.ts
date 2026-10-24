import { ConfigError, loadConfig } from "./config/config";
import { createApp } from "./app";
import { JsonLogger } from "./logging/json-logger";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = new JsonLogger(config.logLevel);
  const app = await createApp(config, { logger });
  await app.listen(config.port, config.host);
  logger.write("info", "api listening", {
    host: config.host,
    port: config.port,
  });
}

main().catch((error: unknown) => {
  // Invalid configuration must stop the process before it listens.
  if (error instanceof ConfigError) {
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
