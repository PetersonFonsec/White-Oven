export const NODE_ENVS = ["development", "test", "production"] as const;
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ApiConfig {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  logLevel: LogLevel;
  openApiEnabled: boolean;
  database: DatabaseConfig;
}

export interface DatabaseConfig {
  /** Connection URL of the runtime role (`whiteoven_app`). Contains a secret: never log it. */
  url: string;
  poolMax: number;
}

/** Owns tables and runs migrations only; the API process must never connect with it. */
export const OWNER_ROLE = "whiteoven_owner";
/** The only role the API process may run as. */
export const APP_ROLE = "whiteoven_app";

const HOST_PATTERN =
  /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:]+\]|[0-9A-Fa-f:]+)$/;

/** Thrown when the environment is invalid. Messages name variables, never their values. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid API configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

const oneOf = <T extends string>(
  values: readonly T[],
  raw: string | undefined,
  fallback: T,
  name: string,
  problems: string[],
): T => {
  if (raw === undefined || raw === "") return fallback;
  if ((values as readonly string[]).includes(raw)) return raw as T;
  problems.push(`${name} must be one of: ${values.join(", ")}`);
  return fallback;
};

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const problems: string[] = [];

  const nodeEnv = oneOf(
    NODE_ENVS,
    env.NODE_ENV,
    "development",
    "NODE_ENV",
    problems,
  );

  const host = env.API_HOST || "127.0.0.1";
  if (!HOST_PATTERN.test(host))
    problems.push("API_HOST must be a hostname or IP address");

  let port = 3000;
  if (env.API_PORT !== undefined && env.API_PORT !== "") {
    port = /^\d{1,5}$/.test(env.API_PORT) ? Number(env.API_PORT) : Number.NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push("API_PORT must be an integer between 1 and 65535");
    }
  }

  const logLevel = oneOf(
    LOG_LEVELS,
    env.API_LOG_LEVEL,
    "info",
    "API_LOG_LEVEL",
    problems,
  );

  let openApiEnabled = nodeEnv !== "production";
  if (env.API_OPENAPI_ENABLED !== undefined && env.API_OPENAPI_ENABLED !== "") {
    if (env.API_OPENAPI_ENABLED === "true") openApiEnabled = true;
    else if (env.API_OPENAPI_ENABLED === "false") openApiEnabled = false;
    else problems.push("API_OPENAPI_ENABLED must be true or false");
  }

  // MikroORM merges MIKRO_ORM_* variables into its options; configuration has one entry point.
  if (Object.keys(env).some((name) => name.startsWith("MIKRO_ORM_")))
    problems.push("MIKRO_ORM_* variables are not supported; use DATABASE_URL");

  // Owner credentials belong to the migration process only.
  if (env.DATABASE_OWNER_URL !== undefined)
    problems.push("DATABASE_OWNER_URL must not be set for the API process");

  const databaseUrl = env.DATABASE_URL ?? "";
  const urlProblem = databaseUrlProblem(databaseUrl);
  if (urlProblem) problems.push(`DATABASE_URL ${urlProblem}`);
  else if (new URL(databaseUrl).username === OWNER_ROLE)
    problems.push(`DATABASE_URL must not use the migration role ${OWNER_ROLE}`);

  let poolMax = 10;
  if (env.DATABASE_POOL_MAX !== undefined && env.DATABASE_POOL_MAX !== "") {
    poolMax = /^\d{1,3}$/.test(env.DATABASE_POOL_MAX)
      ? Number(env.DATABASE_POOL_MAX)
      : Number.NaN;
    if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 100)
      problems.push("DATABASE_POOL_MAX must be an integer between 1 and 100");
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze({
    nodeEnv,
    host,
    port,
    logLevel,
    openApiEnabled,
    database: Object.freeze({ url: databaseUrl, poolMax }),
  });
}

/** Returns why `raw` is not a usable PostgreSQL URL, without echoing any part of it. */
export function databaseUrlProblem(raw: string): string | undefined {
  if (raw === "") return "is required";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be a postgres:// URL";
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    return "must be a postgres:// URL";
  if (!url.hostname || !url.username || url.pathname.length < 2)
    return "must include user, host and database name";
  return undefined;
}

/** Injection token for the validated, frozen configuration. */
export const API_CONFIG = Symbol("API_CONFIG");
