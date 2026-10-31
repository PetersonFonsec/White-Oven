import { LoginThrottle } from "../auth/login-throttle";

/** Failures from one IP, across every store, before that IP is slowed down everywhere. */
export const CUSTOMER_IP_FAILURES_ACROSS_STORES = 300;

/**
 * Progressive customer login lockout (M4.2, ADR 0017), apart from the staff one.
 *
 * - Per store: the staff limits (5 failures per account, 30 per IP), both keyed by the store,
 *   so failures against store A never slow down sign-ins at store B from the same IP (a shared
 *   NAT, a mall Wi-Fi).
 * - Across stores: a wider ceiling per IP alone, so spreading attempts over many stores does not
 *   escape the limit.
 *
 * The IP is `clientIpOf(req)`: the socket peer, or the address written by a proxy listed in
 * `API_TRUSTED_PROXIES` (ADR 0031), never a forwarded header the client itself can set. Memory
 * only, one API instance, like the staff throttle.
 */
export class CustomerLoginThrottle {
  private readonly perStore: LoginThrottle;
  private readonly acrossStores: LoginThrottle;

  constructor(now: () => number = Date.now) {
    this.perStore = new LoginThrottle(now);
    // The account limit is unreachable here: this instance only counts per IP.
    this.acrossStores = new LoginThrottle(now, {
      account: Number.POSITIVE_INFINITY,
      ip: CUSTOMER_IP_FAILURES_ACROSS_STORES,
    });
  }

  retryAfterMs(tenantId: string, email: string, ip: string): number {
    return Math.max(
      this.perStore.retryAfterMs(...storeKeys(tenantId, email, ip)),
      this.acrossStores.retryAfterMs("", ip),
    );
  }

  recordFailure(tenantId: string, email: string, ip: string): void {
    this.perStore.recordFailure(...storeKeys(tenantId, email, ip));
    this.acrossStores.recordFailure("", ip);
  }

  /** Clears the account's history in this store; the IP counters age out on their own. */
  recordSuccess(tenantId: string, email: string): void {
    this.perStore.recordSuccess(`${tenantId}\0${email}`);
  }
}

const storeKeys = (
  tenantId: string,
  email: string,
  ip: string,
): [string, string] => [`${tenantId}\0${email}`, `${tenantId}\0${ip}`];
