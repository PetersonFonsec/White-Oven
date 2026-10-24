import type { NestExpressApplication } from "@nestjs/platform-express";
import { type CreateAppOptions, createApp } from "../src/app";
import { type ApiConfig, loadConfig } from "../src/config/config";
import { JsonLogger } from "../src/logging/json-logger";

export interface TestServer {
  app: NestExpressApplication;
  baseUrl: string;
  logs: Record<string, unknown>[];
  close(): Promise<void>;
}

/** Nothing listens on the discard port: unit tests never reach a database. */
export const UNREACHABLE_DATABASE_URL =
  "postgres://whiteoven_app:unused-password@127.0.0.1:9/whiteoven";

export async function startTestServer(
  overrides: NodeJS.ProcessEnv = {},
  options: Omit<CreateAppOptions, "logger"> = {},
): Promise<TestServer> {
  const config: ApiConfig = loadConfig({
    NODE_ENV: "test",
    API_LOG_LEVEL: "debug",
    DATABASE_URL: UNREACHABLE_DATABASE_URL,
    ...overrides,
  });
  const logs: Record<string, unknown>[] = [];
  const logger = new JsonLogger(config.logLevel, (line) =>
    logs.push(JSON.parse(line)),
  );
  const app = await createApp(config, { ...options, logger });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (!address || typeof address === "string")
    throw new Error("server did not bind a TCP port");
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    logs,
    close: () => app.close(),
  };
}

/** Request logs are written on `finish`, which can land just after the client sees the body. */
export const nextTick = () => new Promise((resolve) => setImmediate(resolve));

/** Response bodies in tests are asserted structurally, so loose typing is intended. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = (response: Response): Promise<any> => response.json();
