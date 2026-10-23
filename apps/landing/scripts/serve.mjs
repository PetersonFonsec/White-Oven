import {
  createCaptureServer,
  parseTrustedProxies,
} from "../src/server/http-server.ts";
// Keep Astro's static-file serving and rendering, but own the connection boundary.
process.env.ASTRO_NODE_AUTOSTART = "disabled";
process.env.NODE_ENV ??= "production";
try {
  const proxies = parseTrustedProxies(process.env.LEADS_TRUSTED_PROXIES);
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
      server.close();
      server.closeAllConnections();
    });
} catch {
  console.error(
    "Inicialização indisponível. Confira build e configuração de proxies.",
  );
  process.exitCode = 1;
}
