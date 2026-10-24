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
}

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

  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze({ nodeEnv, host, port, logLevel, openApiEnabled });
}

/** Injection token for the validated, frozen configuration. */
export const API_CONFIG = Symbol("API_CONFIG");
