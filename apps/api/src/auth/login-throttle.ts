import { createHash } from "node:crypto";

/** Failures tolerated per key before any delay. */
export const FREE_FAILURES = { account: 5, ip: 30 } as const;
export type FailureLimits = { account: number; ip: number };
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
/** Failures older than this are forgotten. */
const WINDOW_MS = 60 * 60_000;
const MAX_ENTRIES = 50_000;

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailure: number;
}

/**
 * Progressive login lockout per account and per IP (system-overview.md, "Bloqueio progressivo").
 * After the free failures, each further failure locks the key for 30 s, doubling up to 15 min.
 *
 * Keys are SHA-256 of the normalized e-mail, whether or not the account exists, so a lockout
 * never reveals which e-mails are registered. Memory only, like the landing's limits (ADR 0002):
 * one API instance in the MVP, reset on restart; revisit before scaling horizontally. The IP is
 * the socket peer until the API is deployed behind a trusted proxy.
 */
export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    /** Staff use the defaults; customers add a wider per-IP ceiling across stores (ADR 0017). */
    private readonly limits: FailureLimits = FREE_FAILURES,
  ) {}

  /** Milliseconds until a login may be attempted for this account and IP; 0 when allowed. */
  retryAfterMs(email: string, ip: string): number {
    const now = this.now();
    return Math.max(
      0,
      ...[accountKey(email), ipKey(ip)].map(
        (key) => (this.entries.get(key)?.lockedUntil ?? 0) - now,
      ),
    );
  }

  recordFailure(email: string, ip: string): void {
    this.bump(accountKey(email), this.limits.account);
    this.bump(ipKey(ip), this.limits.ip);
  }

  /** A successful login clears the account's history; the IP's stays until it ages out. */
  recordSuccess(email: string): void {
    this.entries.delete(accountKey(email));
  }

  private bump(key: string, free: number): void {
    const now = this.now();
    const previous = this.entries.get(key);
    const failures =
      previous && now - previous.lastFailure < WINDOW_MS
        ? previous.failures + 1
        : 1;
    const excess = failures - free;
    const lockedUntil =
      excess > 0
        ? now + Math.min(BASE_LOCK_MS * 2 ** (excess - 1), MAX_LOCK_MS)
        : 0;
    this.entries.delete(key);
    this.entries.set(key, { failures, lockedUntil, lastFailure: now });
    // Insertion order is failure order (delete + set above): drop the oldest keys first.
    if (this.entries.size > MAX_ENTRIES)
      for (const oldest of this.entries.keys()) {
        if (this.entries.size <= MAX_ENTRIES * 0.9) break;
        this.entries.delete(oldest);
      }
  }
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const accountKey = (email: string) => `account:${digest(email)}`;
const ipKey = (ip: string) => `ip:${digest(ip)}`;
