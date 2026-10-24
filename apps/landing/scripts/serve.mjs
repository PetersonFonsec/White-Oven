import {
  createCaptureServer,
  parseTrustedProxies,
} from "../src/server/http-server.ts";
import { getCaptureConfig } from "../src/server/config.ts";
import { SqliteLeadStore } from "../src/server/lead-store.ts";
import { registerHealth } from "../src/server/health.ts";
// Keep Astro's static-file serving and rendering, but own the connection boundary.
process.env.ASTRO_NODE_AUTOSTART = "disabled";
process.env.NODE_ENV ??= "production";
try {
  const proxies = parseTrustedProxies(process.env.LEADS_TRUSTED_PROXIES);
  let storage;
  try {
    if (process.env.LEADS_DB_PATH)
      storage = new SqliteLeadStore(getCaptureConfig().databasePath);
  } catch {
    console.error("Armazenamento indisponível. Consulte readiness.");
  }
  const draining = registerHealth(
    getCaptureConfig,
    storage,
    process.env.LEADS_ENABLED === "true",
  );
  const { handler } = await import("../dist/server/entry.mjs");
  const server = createCaptureServer(handler, proxies);
  server.on("error", () => {
    console.error("Servidor indisponível. Confira endereço e porta.");
    process.exitCode = 1;
  });
  server.listen(
    Number(process.env.PORT ?? 4321),
    process.env.HOST ?? "127.0.0.1",
    () => console.log("Servidor WhiteOven iniciado."),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      draining();
      server.close(() => {
        storage?.close();
      });
      server.closeIdleConnections();
      // Allow existing requests to finish; only force connections after a bounded grace period.
      const deadline = setTimeout(() => server.closeAllConnections(), 10000);
      deadline.unref();
    });
} catch {
  console.error(
    "Inicialização indisponível. Confira build e configuração de proxies.",
  );
  process.exitCode = 1;
}
