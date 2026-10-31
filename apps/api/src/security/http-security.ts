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

/**
 * Resolves the client IP once per request. It is the TCP peer, unless the peer is one of
 * `trustedProxies` (exact addresses, `API_TRUSTED_PROXIES`): then it is the last address of
 * `X-Forwarded-For`, the one that proxy wrote. A header from anyone else is ignored, so a client
 * can never choose the IP its login lockout or rate limits are counted against.
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
  const peer = normalizeIp(req.socket.remoteAddress ?? "");
  if (!peer) return "unknown";
  if (!trusted.has(peer)) return peer;
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");
  const last = normalizeIp(raw.split(",").at(-1)?.trim() ?? "");
  return last || peer;
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
