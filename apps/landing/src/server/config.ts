import { resolve } from "node:path";
import { parseTrustedProxies } from "./http-server.ts";
import {
  CONSENT_VERSION,
  CONTACT_CONSENT_TEXT,
  RETENTION_DAYS,
  type ConsentPolicySnapshot,
} from "@whiteoven/contracts";
export interface CaptureConfig {
  enabled: boolean;
  origin: string;
  databasePath: string;
  policy: ConsentPolicySnapshot;
}
export function getCaptureConfig(
  env: NodeJS.ProcessEnv = process.env,
): CaptureConfig {
  const controllerName = env.LEADS_CONTROLLER_NAME?.trim() ?? "";
  const privacyEmail = env.LEADS_PRIVACY_EMAIL?.trim() ?? "";
  const rawOrigin = env.SITE_ORIGIN ?? "http://localhost:4321";
  let origin = "";
  let secureOrigin = false;
  let proxyReady = false;
  try {
    const url = new URL(rawOrigin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    secureOrigin =
      url.origin === rawOrigin &&
      (url.protocol === "https:" || (local && url.protocol === "http:"));
    origin = url.origin;
    proxyReady =
      local || parseTrustedProxies(env.LEADS_TRUSTED_PROXIES).size > 0;
  } catch {
    /* Invalid config disables capture, never leaks a config exception. */
  }
  const identityReady =
    controllerName.length >= 2 &&
    controllerName.length <= 150 &&
    // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted data.
    !/[\u0000-\u001f\u007f<>]/u.test(controllerName) &&
    privacyEmail.length <= 254 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(privacyEmail);
  const storageReady =
    env.NODE_ENV !== "production" || Boolean(env.LEADS_DB_PATH);
  return {
    enabled:
      env.LEADS_ENABLED === "true" &&
      secureOrigin &&
      proxyReady &&
      identityReady &&
      storageReady,
    origin,
    databasePath: resolve(env.LEADS_DB_PATH ?? ".data/leads.dev.sqlite"),
    policy: {
      version: CONSENT_VERSION,
      text: CONTACT_CONSENT_TEXT,
      controllerName,
      privacyEmail,
      retentionDays: RETENTION_DAYS,
    },
  };
}
