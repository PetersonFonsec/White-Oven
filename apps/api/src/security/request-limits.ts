import { createHash } from "node:crypto";
import { HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { ApiError } from "../errors/api-error";

/**
 * Request rate limits of system-overview.md ("Proteção de endpoints", M7.3, ADR 0031): refresh,
 * sign-up and order creation, per IP and per account. Sign-in keeps its progressive lockout of
 * failures (`LoginThrottle`); these limits count every admitted request, successful or not.
 *
 * Fixed windows in memory, like the login throttle: one API instance in the MVP, reset on
 * restart; revisit (shared store) before scaling horizontally. Keys are SHA-256 digests, so the
 * map never holds an e-mail, an IP or a token in clear. See `RequestLimits` for how refusals
 * and a full map are handled.
 */
export interface LimitRule {
  /** Requests allowed per key and window. */
  max: number;
  windowMs: number;
}

/** A named limit: an admitted request counts once against every scope it names. */
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

/** Default capacity: about 10 MB of windows (digest key plus three numbers each). */
export const MAX_LIMIT_ENTRIES = 100_000;

interface Window {
  start: number;
  count: number;
  /** `start + windowMs`: from this instant the window is spent and may be dropped. */
  expiresAt: number;
}

/**
 * Semantics (ADR 0031):
 *
 * - **Check, then commit.** A request is admitted only if every scope still has room; then, and
 *   only then, it counts once in every scope. A refused request counts nowhere: a customer who hit
 *   their own limit never spends the IP quota their neighbours behind the same NAT share. Windows
 *   are fixed, so not counting refusals never shortens a wait.
 * - **Retry-After** is the time until every exhausted scope reopens (the latest of their ends).
 * - **Bounded memory, never evicting a live window.** At most `capacity` windows. When a request
 *   needs new windows and the map is full, expired windows are swept first. If there is still no
 *   room, the request is refused (fail closed) with the time until the earliest window expires;
 *   live windows are never dropped, so flooding the map with new keys cannot reset anybody's
 *   quota. Requests whose windows already exist keep being decided normally. Callers keep the
 *   key space small (IPv6 by /64, accounts only after authentication) so that filling the map
 *   takes ~100 000 distinct addresses within one window.
 */
export class RequestLimits {
  private readonly windows = new Map<string, Window>();
  /** A lower bound of every held `expiresAt`: no sweep can free anything before it. */
  private nextExpiry = Number.POSITIVE_INFINITY;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly policies: Record<
      string,
      LimitPolicy
    > = LIMIT_POLICIES as Record<string, LimitPolicy>,
    private readonly capacity: number = MAX_LIMIT_ENTRIES,
  ) {}

  /** Live and expired windows currently held (for tests and diagnostics). */
  get size(): number {
    return this.windows.size;
  }

  /**
   * Admits one request against every scope of `name`. Returns 0 when admitted (and counted),
   * otherwise the seconds until a retry can be admitted (nothing is counted).
   */
  consume<N extends LimitName>(name: N, keys: LimitKeys<N>): number;
  consume(name: string, keys: Record<string, string>): number;
  consume(name: string, keys: Record<string, string>): number {
    const policy = this.policies[name];
    if (!policy) throw new Error(`Unknown request limit: ${name}`);
    const now = this.now();
    const plan: { key: string; window: Window; fresh: boolean }[] = [];
    let waitMs = 0;
    for (const [scope, rule] of Object.entries(policy)) {
      const value = keys[scope];
      if (value === undefined)
        throw new Error(`Request limit ${name} needs the ${scope} key`);
      const key = digest(`${name}\0${scope}\0${value}`);
      const current = this.windows.get(key);
      const live = current && current.expiresAt > now ? current : undefined;
      if (live && live.count >= rule.max)
        waitMs = Math.max(waitMs, live.expiresAt - now);
      plan.push({
        key,
        window: live ?? {
          start: now,
          count: 0,
          expiresAt: now + rule.windowMs,
        },
        fresh: !current,
      });
    }
    if (waitMs > 0) return Math.ceil(waitMs / 1000);

    const needed = plan.filter((entry) => entry.fresh).length;
    if (needed > 0 && this.windows.size + needed > this.capacity) {
      this.sweep(now);
      if (this.windows.size + needed > this.capacity)
        return Math.max(1, Math.ceil((this.nextExpiry - now) / 1000));
    }
    for (const { key, window } of plan) {
      window.count += 1;
      this.windows.set(key, window);
      this.nextExpiry = Math.min(this.nextExpiry, window.expiresAt);
    }
    return 0;
  }

  /** Drops spent windows; skipped while nothing held can have expired yet. */
  private sweep(now: number): void {
    if (now < this.nextExpiry) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const [key, window] of this.windows)
      if (window.expiresAt <= now) this.windows.delete(key);
      else earliest = Math.min(earliest, window.expiresAt);
    this.nextExpiry = earliest;
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
