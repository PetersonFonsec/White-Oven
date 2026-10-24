import { getCaptureConfig } from "../src/server/config.ts";
import { parseTrustedProxies } from "../src/server/http-server.ts";
export function validateDeployment(env) {
  const config = getCaptureConfig({
    ...env,
    NODE_ENV: "production",
    LEADS_DB_PATH: "/var/lib/whiteoven/leads.sqlite",
  });
  if (!env.WHITEOVEN_IMAGE || /[\s`$]/.test(env.WHITEOVEN_IMAGE))
    throw new Error("IMAGE");
  if (
    !/^\d+$/.test(env.WHITEOVEN_PORT ?? "4321") ||
    Number(env.WHITEOVEN_PORT ?? 4321) < 1024 ||
    Number(env.WHITEOVEN_PORT ?? 4321) > 65535
  )
    throw new Error("PORT");
  if (!["true", "false"].includes(env.LEADS_ENABLED))
    throw new Error("ACTIVATION");
  const proxies = parseTrustedProxies(env.LEADS_TRUSTED_PROXIES);
  if (
    env.LEADS_ENABLED === "true" &&
    env.CADDY_INTERNAL_IP &&
    !proxies.has(env.CADDY_INTERNAL_IP)
  )
    throw new Error("PROXY_PEER");
  if (
    env.LEADS_ENABLED === "true" &&
    env.WHITEOVEN_DOMAIN &&
    new URL(env.SITE_ORIGIN).hostname !== env.WHITEOVEN_DOMAIN
  )
    throw new Error("DOMAIN");
  if (env.LEADS_ENABLED === "true" && !config.enabled)
    throw new Error("CAPTURE_CONFIG");
  if (
    env.LEADS_ENABLED === "true" &&
    (!env.SITE_ORIGIN?.startsWith("https://") ||
      env.SITE_ORIGIN.includes(".invalid") ||
      env.SITE_ORIGIN.includes("example."))
  )
    throw new Error("REAL_ORIGIN");
  if (!env.SITE_ORIGIN || new URL(env.SITE_ORIGIN).origin !== env.SITE_ORIGIN)
    throw new Error("ORIGIN");
  return true;
}
if (process.argv[1]?.endsWith("/validate-deployment.mjs")) {
  try {
    validateDeployment(process.env);
    console.log("Configuração válida; valores privados omitidos.");
  } catch {
    console.error(
      "Configuração inválida. Consulte ops/.env.example e o runbook; nenhum valor foi impresso.",
    );
    process.exitCode = 1;
  }
}
