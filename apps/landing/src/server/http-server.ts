import { createServer, type RequestListener } from "node:http";
import { isIP } from "node:net";
import { withRequestClient } from "./request-context.ts";
const normalize = (address: string) =>
  address.startsWith("::ffff:") && isIP(address.slice(7)) === 4
    ? address.slice(7)
    : address;
export function parseTrustedProxies(raw = ""): ReadonlySet<string> {
  const entries = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (entries.some((entry) => !isIP(entry)))
    throw new Error("INVALID_TRUSTED_PROXIES");
  return new Set(entries.map(normalize));
}
export function resolveRequestClient(
  peer: string | undefined,
  forwarded: string | string[] | undefined,
  proxies: ReadonlySet<string>,
): string | null {
  if (!peer || !isIP(peer)) return null;
  const address = normalize(peer);
  if (!proxies.has(address)) return address; // Ignore all forwarded headers from direct clients.
  // The trusted last proxy must REPLACE, never append, the header with its verified peer IP.
  if (typeof forwarded !== "string" || !isIP(forwarded)) return null;
  return normalize(forwarded);
}
export function createCaptureServer(
  handler: RequestListener,
  proxies: ReadonlySet<string> = new Set(),
) {
  const server = createServer(
    {
      requestTimeout: 7000,
      headersTimeout: 5000,
      maxHeaderSize: 8192,
      connectionsCheckingInterval: 1000,
    },
    (req, res) => {
      const client = resolveRequestClient(
        req.socket.remoteAddress,
        req.headers["x-forwarded-for"],
        proxies,
      );
      // Astro itself trusts this header. Strip it after resolving our independently trusted identity.
      delete req.headers["x-forwarded-for"];
      if (!client) {
        res.writeHead(403, { Connection: "close" });
        res.end();
        return;
      }
      withRequestClient(client, () => handler(req, res));
    },
  );
  server.maxConnections = 128;
  server.maxHeadersCount = 50;
  server.keepAliveTimeout = 5000;
  server.setTimeout(8000, (socket) => socket.destroy());
  return server;
}
