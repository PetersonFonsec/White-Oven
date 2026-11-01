import { type KeyObject, createPrivateKey } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

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
  imageStorageDirectory: string;
  database: DatabaseConfig;
  auth: AuthConfig;
  push: PushConfig;
  /**
   * Exact addresses of the reverse proxies allowed to set `X-Forwarded-For` (ADR 0031). Empty:
   * the client IP is always the TCP peer.
   */
  trustedProxies: readonly string[];
  /**
   * Bearer token for `GET /metrics` (ADR 0032). `null`: the route answers 404. Secret.
   */
  metricsToken: string | null;
}

export const PUSH_DELIVERIES = ["disabled", "expo"] as const;

/** Order status notifications to the app (M5.5, ADR 0027). */
export interface PushConfig {
  /** `expo` sends through Expo Push; `disabled` (the default) keeps the outbox untouched. */
  delivery: (typeof PUSH_DELIVERIES)[number];
  /** Expo "enhanced push security" access token, when the Expo account requires one. Secret. */
  expoAccessToken: string | null;
}

export interface AuthConfig {
  /**
   * Ed25519 key that signs staff access tokens. Required in production; elsewhere `null` means
   * the process generates an ephemeral key at boot (tokens die with the process). Secret.
   */
  accessTokenPrivateKey: KeyObject | null;
  /**
   * 32-byte AES-256-GCM key for TOTP secrets at rest, kept outside the database. Required in
   * production; elsewhere `null` means an ephemeral key (enrollments do not survive a restart).
   */
  mfaEncryptionKey: Buffer | null;
  /** Dedicated persistent 32-byte secret for deterministic OWNER invitation tokens. */
  ownerInviteSecret: Buffer | null;
  /** Browser origins allowed to call the cookie-based refresh and logout endpoints. */
  adminOrigins: readonly string[];
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

  const imageStorageDirectory = env.IMAGE_STORAGE_DIRECTORY || ".data/images";
  if (nodeEnv === "production" && !isAbsolute(imageStorageDirectory))
    problems.push(
      "IMAGE_STORAGE_DIRECTORY must be an absolute path in production",
    );

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

  const auth = loadAuthConfig(env, nodeEnv, problems);

  const pushDelivery = oneOf(
    PUSH_DELIVERIES,
    env.PUSH_DELIVERY,
    "disabled",
    "PUSH_DELIVERY",
    problems,
  );
  const expoAccessToken = env.EXPO_ACCESS_TOKEN || null;
  if (expoAccessToken !== null) {
    if (pushDelivery !== "expo")
      problems.push("EXPO_ACCESS_TOKEN requires PUSH_DELIVERY=expo");
    else if (!/^[A-Za-z0-9_-]{20,200}$/.test(expoAccessToken))
      problems.push("EXPO_ACCESS_TOKEN must be an Expo access token");
  }

  const trustedProxies = (env.API_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
  // Exact addresses only: a CIDR or a name would trust whoever ends up behind it.
  if (trustedProxies.some((address) => isIP(address) === 0))
    problems.push(
      "API_TRUSTED_PROXIES must be a comma-separated list of IP addresses",
    );

  const metricsToken = env.API_METRICS_TOKEN || null;
  if (
    metricsToken !== null &&
    !/^[A-Za-z0-9._~+/=-]{32,512}$/.test(metricsToken)
  )
    problems.push(
      "API_METRICS_TOKEN must be at least 32 characters (letters, digits, ._~+/=-)",
    );

  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze({
    nodeEnv,
    host,
    port,
    logLevel,
    openApiEnabled,
    imageStorageDirectory,
    database: Object.freeze({ url: databaseUrl, poolMax }),
    auth: Object.freeze(auth),
    push: Object.freeze({ delivery: pushDelivery, expoAccessToken }),
    trustedProxies: Object.freeze(trustedProxies),
    metricsToken,
  });
}

function loadAuthConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: NodeEnv,
  problems: string[],
): AuthConfig {
  let accessTokenPrivateKey: KeyObject | null = null;
  const rawKey = env.AUTH_ACCESS_TOKEN_PRIVATE_KEY;
  if (rawKey === undefined || rawKey === "") {
    if (nodeEnv === "production")
      problems.push("AUTH_ACCESS_TOKEN_PRIVATE_KEY is required in production");
  } else {
    accessTokenPrivateKey = ed25519PrivateKey(rawKey);
    if (!accessTokenPrivateKey)
      problems.push(
        "AUTH_ACCESS_TOKEN_PRIVATE_KEY must be a base64 PKCS#8 DER Ed25519 private key",
      );
  }

  let mfaEncryptionKey: Buffer | null = null;
  const rawMfaKey = env.AUTH_MFA_ENCRYPTION_KEY;
  if (rawMfaKey === undefined || rawMfaKey === "") {
    if (nodeEnv === "production")
      problems.push("AUTH_MFA_ENCRYPTION_KEY is required in production");
  } else {
    const bytes = /^[A-Za-z0-9+/]{43}=$/.test(rawMfaKey)
      ? Buffer.from(rawMfaKey, "base64")
      : null;
    if (bytes?.length === 32) mfaEncryptionKey = bytes;
    else
      problems.push(
        "AUTH_MFA_ENCRYPTION_KEY must be 32 bytes encoded in base64",
      );
  }

  let ownerInviteSecret: Buffer | null = null;
  const rawInviteKey = env.OWNER_INVITE_SECRET;
  if (rawInviteKey === undefined || rawInviteKey === "") {
    if (nodeEnv === "production")
      problems.push("OWNER_INVITE_SECRET is required in production");
  } else {
    const bytes = /^[A-Za-z0-9+/]{43}=$/.test(rawInviteKey)
      ? Buffer.from(rawInviteKey, "base64")
      : null;
    if (bytes?.length === 32) ownerInviteSecret = bytes;
    else
      problems.push("OWNER_INVITE_SECRET must be 32 bytes encoded in base64");
  }

  const adminOrigins = (env.API_ADMIN_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  if (adminOrigins.some((origin) => !isOrigin(origin)))
    problems.push(
      "API_ADMIN_ORIGINS must be a comma-separated list of http(s) origins",
    );

  return {
    accessTokenPrivateKey,
    mfaEncryptionKey,
    ownerInviteSecret,
    adminOrigins: Object.freeze(adminOrigins),
  };
}

function ed25519PrivateKey(raw: string): KeyObject | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  try {
    const key = createPrivateKey({
      key: Buffer.from(raw, "base64"),
      format: "der",
      type: "pkcs8",
    });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

function isOrigin(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === raw
    );
  } catch {
    return false;
  }
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
