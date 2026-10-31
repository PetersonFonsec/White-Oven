import { createHash } from "node:crypto";
import { HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { ApiError } from "../errors/api-error";

/**
 * Request rate limits of system-overview.md ("Proteção de endpoints", M7.3, ADR 0031): refresh,
 * sign-up and order creation, per IP and per account. Sign-in keeps its progressive lockout of
 * failures (`LoginThrottle`); these limits count every request, successful or not.
 *
 * Fixed windows in memory, like the login throttle: one API instance in the MVP, reset on
 * restart; revisit (shared store) before scaling horizontally. Keys are SHA-256 digests, so the
 * map never holds an e-mail, an IP or a token in clear.
 */
export interface LimitRule {
  /** Requests allowed per key and window. */
  max: number;
  windowMs: number;
}

/** A named limit: each request counts once against every scope it names. */
export type LimitPolicy = Readonly<Record<string, LimitRule>>;

const MINUTE = 60_000;

export const LIMIT_POLICIES = {
  /** Panel cookie refresh: page loads and the 15-minute token rotation of every open tab. */
  staffRefresh: { ip: { max: 120, windowMs: 10 * MINUTE } },
  /**
   * App refresh: the token rotates on every use, so the account cannot be a key without a
   * database read; per IP in the store, plus a wider ceiling per IP across stores.
   */
  customerRefresh: {
    storeIp: { max: 120, windowMs: 10 * MINUTE },
    ip: { max: 600, windowMs: 10 * MINUTE },
  },
  /** New accounts: per IP in the store and across stores (no account exists yet). */
  customerSignup: {
    storeIp: { max: 30, windowMs: 60 * MINUTE },
    ip: { max: 100, windowMs: 60 * MINUTE },
  },
  /** Quotes are cheap and repeat while the cart changes; the ceiling stops scripted floods. */
  orderQuote: {
    account: { max: 120, windowMs: 10 * MINUTE },
    storeIp: { max: 600, windowMs: 10 * MINUTE },
  },
  /**
   * Placing orders, retries of the same key included (they reuse the result but still cost a
   * transaction). Ten in ten minutes is far above a real customer and caps fake orders.
   */
  orderCreate: {
    account: { max: 10, windowMs: 10 * MINUTE },
    storeIp: { max: 60, windowMs: 10 * MINUTE },
  },
} as const satisfies Record<string, LimitPolicy>;

export type LimitName = keyof typeof LIMIT_POLICIES;
export type LimitKeys<N extends LimitName> = {
  readonly [S in keyof (typeof LIMIT_POLICIES)[N]]: string;
};

const MAX_ENTRIES = 100_000;

interface Window {
  start: number;
  count: number;
}

export class RequestLimits {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly policies: Record<
      string,
      LimitPolicy
    > = LIMIT_POLICIES as Record<string, LimitPolicy>,
  ) {}

  /**
   * Counts one request against every scope of `name`. Returns 0 when allowed, otherwise the
   * seconds until the most restrictive exhausted scope opens again. A refused request still
   * counts, so hammering a closed window never shortens it.
   */
  consume<N extends LimitName>(name: N, keys: LimitKeys<N>): number;
  consume(name: string, keys: Record<string, string>): number;
  consume(name: string, keys: Record<string, string>): number {
    const policy = this.policies[name];
    if (!policy) throw new Error(`Unknown request limit: ${name}`);
    const now = this.now();
    let waitMs = 0;
    for (const [scope, rule] of Object.entries(policy)) {
      const value = keys[scope];
      if (value === undefined)
        throw new Error(`Request limit ${name} needs the ${scope} key`);
      const key = digest(`${name}\0${scope}\0${value}`);
      const current = this.windows.get(key);
      const window =
        current && now - current.start < rule.windowMs
          ? current
          : { start: now, count: 0 };
      window.count += 1;
      this.windows.delete(key);
      this.windows.set(key, window);
      if (window.count > rule.max)
        waitMs = Math.max(waitMs, window.start + rule.windowMs - now);
    }
    this.prune();
    return Math.ceil(waitMs / 1000);
  }

  private prune(): void {
    if (this.windows.size <= MAX_ENTRIES) return;
    // Insertion order is last use (delete + set above): drop the least recently used first.
    for (const oldest of this.windows.keys()) {
      if (this.windows.size <= MAX_ENTRIES * 0.9) break;
      this.windows.delete(oldest);
    }
  }
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

/**
 * Counts the request against `name` and refuses it with 429 RATE_LIMITED and `Retry-After` when
 * a scope is exhausted. Call it after authentication (so an anonymous flood never spends a
 * customer's quota) and before any work.
 */
export function enforceLimit<N extends LimitName>(
  limits: RequestLimits,
  name: N,
  keys: LimitKeys<N>,
  res: Response,
): void {
  const wait = limits.consume(name, keys);
  if (wait <= 0) return;
  res.setHeader("Retry-After", String(wait));
  throw new ApiError(
    HttpStatus.TOO_MANY_REQUESTS,
    "RATE_LIMITED",
    "Too many requests. Try again later.",
  );
}
