import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";

/**
 * Security headers on every API response (M7.3, ADR 0031). The reverse proxy adds HSTS, since it
 * terminates TLS; these are set here so the API is safe behind any proxy. JSON and images never
 * need scripts, styles or frames: `default-src 'none'` and `frame-ancestors 'none'`. The legal
 * pages (ADR 0030) replace the CSP with their own, still without scripts.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function securityHeaders() {
  return (_req: Request, res: Response, next: NextFunction) => {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS))
      res.setHeader(name, value);
    next();
  };
}

const clientIps = new WeakMap<Request, string>();

/** At most this many `X-Forwarded-For` hops are examined (a proxy chain is never longer). */
const MAX_FORWARDED_HOPS = 16;

/**
 * Resolves the client IP once per request (ADR 0031). Rules:
 *
 * - The peer of the TCP connection is the starting point. If it is not in `trustedProxies`
 *   (exact addresses, `API_TRUSTED_PROXIES`), it is the client and `X-Forwarded-For` is ignored.
 * - From a trusted peer, `X-Forwarded-For` is read **right to left**: each address was appended
 *   by the hop before it. Addresses that are themselves trusted proxies are skipped; the first
 *   one that is not is the client. Entries to its left were written by the client (or by
 *   untrusted hops) and are never used, so a client cannot choose its own IP by sending the
 *   header.
 * - An entry that is not a valid IP stops the walk: nothing to its left can be trusted, and the
 *   last trusted hop is used (fail safe: all such requests share that proxy's quota rather than a
 *   forged one). The same happens when the header is missing or every entry is a trusted proxy.
 */
export function clientIpResolver(trustedProxies: readonly string[]) {
  const trusted = new Set(trustedProxies.map(normalizeIp));
  return (req: Request, _res: Response, next: NextFunction) => {
    clientIps.set(req, resolveClientIp(req, trusted));
    next();
  };
}

export function resolveClientIp(
  req: Pick<Request, "socket" | "headers">,
  trusted: ReadonlySet<string>,
): string {
  let client = normalizeIp(req.socket.remoteAddress ?? "");
  if (!client) return "unknown";
  if (!trusted.has(client)) return client;
  const header = req.headers["x-forwarded-for"];
  // Node joins repeated headers with ", ": the order of hops is kept.
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  const hops = raw.split(",").map((hop) => hop.trim());
  for (
    let i = hops.length - 1;
    i >= 0 && hops.length - i <= MAX_FORWARDED_HOPS;
    i--
  ) {
    const hop = normalizeIp(hops[i]!);
    if (!hop) break;
    client = hop;
    if (!trusted.has(hop)) break;
  }
  return client;
}

/**
 * The key a client IP is rate-limited under: IPv4 as is, IPv6 by its /64 prefix. One subscriber
 * usually gets a whole /64, so per-address keys would let a single host mint unlimited keys
 * (a fresh quota each, and a way to fill `RequestLimits`).
 */
export function ipLimitKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // An embedded IPv4 tail (::ffff:a.b.c.d forms) only affects the last 32 bits, outside the /64.
  const groups = ip.includes("::")
    ? [
        ...left,
        ...Array<string>(8 - left.length - right.length).fill("0"),
        ...right,
      ]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => (parseInt(group, 16) || 0).toString(16))
    .join(":")}::/64`;
}

/** The request's client IP (the TCP peer if the resolver did not run). */
export const clientIpOf = (req: Request): string =>
  clientIps.get(req) ??
  (normalizeIp(req.socket.remoteAddress ?? "") || "unknown");

/** A valid IP in canonical form (IPv4-mapped IPv6 as IPv4), or "" when `raw` is not one. */
export function normalizeIp(raw: string): string {
  const value = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  if (isIP(value) === 0) return "";
  return isIP(value) === 6 ? value.toLowerCase() : value;
}
