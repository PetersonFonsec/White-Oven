import { HttpClient, HttpHeaders } from "@angular/common/http";
import { Injectable, computed, inject, signal } from "@angular/core";
import { type Observable, firstValueFrom, timeout } from "rxjs";
import { AUTH, apiErrorCode, apiStatus } from "./api";

export type Role = "OWNER" | "MANAGER" | "STAFF";

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Dono",
  MANAGER: "Gerente",
  STAFF: "Equipe",
};

interface TokenBody {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  activeTenantId: string | null;
}

interface MfaChallengeBody {
  mfaRequired: true;
  mfaToken: string;
  expiresIn: number;
}

export interface TenantChoice {
  tenantId: string;
  slug: string;
  displayName: string;
  role: Role;
}

export interface MfaSetup {
  secret: string;
  otpauthUri: string;
}

/**
 * - `operator`: WhiteOven operator signed in with the second factor.
 * - `mfa-setup`: operator who still has to enroll the second factor; the API refuses anything else.
 * - `none`: store staff.
 */
export type PlatformAccess = "operator" | "mfa-setup" | "none";

export type SecondFactor = { code: string } | { recoveryCode: string };

/** What a refresh produced, for the interceptor's retry decision. */
export type RefreshResult =
  | { status: "renewed"; credentials: Credentials }
  | { status: "signed-out" }
  /** A logout or a newer sign-in, store switch or MFA enrollment made this result obsolete. */
  | { status: "superseded" };

/** `superseded`: a newer sign-in started meanwhile, so this result no longer describes the browser. */
export type LogoutResult = "confirmed" | "unconfirmed" | "superseded";

/**
 * Longest wait for a request that sets or clears the refresh cookie. They run one at a time, so a
 * request that never answers must not hold the others forever.
 */
export const COOKIE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The token and what it was issued for. `lineage` changes with every sign-in, store switch and MFA
 * enrollment, and survives refreshes: a call may be retried only within its lineage and store.
 */
export interface Credentials {
  token: string;
  tenantId: string | null;
  /** API-verified identity scope for short-lived browser state. */
  userId: string | null;
  sessionId: string | null;
  lineage: number;
}

/** Everything the panel knows about the signed-in person, published as one value. */
interface SignedIn extends Credentials {
  platform: PlatformAccess;
  store: TenantChoice | null;
}

/** Raised by a sign-in, store switch or enrollment that a logout or a newer one made obsolete. */
export class SupersededError extends Error {
  constructor() {
    super("A newer session operation replaced this one.");
  }
}

/** Non-secret marker: a logout the API did not confirm. Never holds a token. */
export const LOGOUT_PENDING_KEY = "whiteoven.admin.logout-pending";

/**
 * The staff session of the panel (ADR 0007, ADR 0012). The access token lives only in this
 * service's memory: never in storage, cookies or the URL. The refresh token is the API's HttpOnly
 * cookie, so a reload restores the session through `restore()`.
 *
 * Asynchronous operations never publish stale results. Every operation records the session
 * generation when it starts and publishes only if the generation is unchanged when it ends:
 * - `logout()`/`clear()` start a new generation, so nothing started before them publishes.
 * - Sign-in, MFA, store switch and MFA enrollment start a new generation (they supersede pending
 *   refreshes) and start another one once published (a refresh started meanwhile may carry the
 *   previous store and must not overwrite them).
 * - A refresh keeps the generation: it renews the current session, it does not replace it.
 * - Requests that set or clear the refresh cookie run one at a time, in call order (`exclusive`),
 *   so an older logout can neither clear a newer sign-in's cookie nor be overtaken by it.
 *
 * The token, platform access and active store are loaded with the new token passed explicitly,
 * then published together, so the panel never sees a token without its permissions.
 */
@Injectable({ providedIn: "root" })
export class Session {
  private readonly http = inject(HttpClient);
  private readonly state = signal<SignedIn | null>(null);
  private generation = 0;
  private lineages = 0;
  /** Counts published sessions; a logout's outcome only stands while none was published. */
  private published = 0;
  private refreshing: {
    generation: number;
    promise: Promise<RefreshResult>;
  } | null = null;
  /** Tail of the requests that set or clear the refresh cookie (see `exclusive`). */
  private cookieQueue: Promise<unknown> = Promise.resolve();

  readonly platform = computed(() => this.state()?.platform ?? null);
  readonly store = computed(() => this.state()?.store ?? null);
  readonly signedIn = computed(() => this.state() !== null);
  readonly role = computed(() => this.store()?.role ?? null);
  /** Set when the last logout could not be confirmed by the API. */
  readonly logoutUnconfirmed = signal(false);

  constructor() {
    this.logoutUnconfirmed.set(readLogoutPending());
  }

  accessToken(): string | null {
    return this.state()?.token ?? null;
  }

  /** Token, store and lineage of the current session, for the interceptor. */
  credentials(): Credentials | null {
    const state = this.state();
    return (
      state && {
        token: state.token,
        tenantId: state.tenantId,
        userId: state.userId,
        sessionId: state.sessionId,
        lineage: state.lineage,
      }
    );
  }

  /**
   * Startup: resumes the session of the refresh cookie, if any. Never throws. After a logout the
   * API did not confirm, the session is not resumed: the logout is retried instead, and the
   * person signs in again.
   */
  async restore(): Promise<void> {
    if (readLogoutPending()) {
      await this.revoke();
      return;
    }
    await this.refresh();
  }

  async login(
    email: string,
    password: string,
  ): Promise<"signed-in" | { mfaToken: string }> {
    const generation = ++this.generation;
    const body = await this.exclusive(generation, () =>
      this.http.post<TokenBody | MfaChallengeBody>(AUTH.login, {
        email,
        password,
      }),
    );
    if ("mfaRequired" in body) {
      if (generation !== this.generation) throw new SupersededError();
      return { mfaToken: body.mfaToken };
    }
    await this.replace(generation, body);
    return "signed-in";
  }

  async loginMfa(mfaToken: string, factor: SecondFactor): Promise<void> {
    const generation = ++this.generation;
    await this.replace(
      generation,
      await this.exclusive(generation, () =>
        this.http.post<TokenBody>(AUTH.loginMfa, { mfaToken, ...factor }),
      ),
    );
  }

  /**
   * Rotates the refresh cookie. Concurrent callers share one request, because the API treats a
   * second use of a rotated refresh token as theft and revokes the whole session. A refresh of an
   * older generation is never joined; the new one queues behind it (`exclusive`), so the browser
   * sends the latest cookie.
   */
  refresh(): Promise<RefreshResult> {
    const generation = this.generation;
    const pending = this.refreshing;
    if (pending?.generation === generation) return pending.promise;
    const promise = this.rotate(generation).finally(() => {
      if (this.refreshing?.promise === promise) this.refreshing = null;
    });
    this.refreshing = { generation, promise };
    return promise;
  }

  tenants(): Promise<TenantChoice[]> {
    return firstValueFrom(this.http.get<TenantChoice[]>(AUTH.tenants));
  }

  async selectStore(tenantId: string): Promise<void> {
    const generation = ++this.generation;
    await this.replace(
      generation,
      await firstValueFrom(
        this.http.post<TokenBody>(AUTH.activeTenant, { tenantId }),
      ),
    );
  }

  setupMfa(): Promise<MfaSetup> {
    return firstValueFrom(this.http.post<MfaSetup>(AUTH.mfaSetup, {}));
  }

  /** Enrolls the second factor; returns the recovery codes, shown once. */
  async activateMfa(code: string): Promise<string[]> {
    const generation = ++this.generation;
    const body = await firstValueFrom(
      this.http.post<TokenBody & { recoveryCodes: string[] }>(
        AUTH.mfaActivate,
        { code },
      ),
    );
    await this.replace(generation, body);
    return body.recoveryCodes;
  }

  /**
   * Ends the session here at once, then asks the API to revoke it. The request queues behind any
   * cookie request already sent (a refresh in flight), so it carries the latest refresh cookie,
   * and a sign-in started afterwards waits for it, so the logout never clears the new cookie.
   * When the API does not confirm, the session may still be alive on the server: the result says
   * so, and the next start of the panel retries the logout instead of resuming the session.
   */
  logout(): Promise<LogoutResult> {
    this.clear();
    writeLogoutPending(true);
    return this.revoke();
  }

  /** Asks the API again to revoke the session of a logout it did not confirm. */
  retryLogout(): Promise<LogoutResult> {
    return this.revoke();
  }

  clear(): void {
    this.generation++;
    this.state.set(null);
  }

  /**
   * Revokes the session of the cookie the browser holds when the request leaves. It is always sent,
   * even after a newer sign-in started: queued before that sign-in, it still carries the old
   * cookie, and the sign-in's request waits for it. Its outcome describes the browser only while
   * no session was published since it started; after that it touches neither the warning nor its
   * marker (the published sign-in already cleared both).
   */
  private async revoke(): Promise<LogoutResult> {
    const published = this.published;
    let confirmed = true;
    try {
      await this.exclusive(null, () => this.http.post(AUTH.logout, {}));
    } catch {
      confirmed = false;
    }
    if (published !== this.published || this.state() !== null)
      return "superseded";
    writeLogoutPending(!confirmed);
    this.logoutUnconfirmed.set(!confirmed);
    return confirmed ? "confirmed" : "unconfirmed";
  }

  /**
   * Sends a request that sets or clears the refresh cookie (sign-in, MFA sign-in, refresh, logout)
   * after the previous one settled, in call order. The API answers each with `Set-Cookie`, so two
   * in flight could land in any order: a logout's cookie removal could erase a newer sign-in, or
   * a refresh could reuse a rotated token. A request whose `generation` became obsolete while
   * queued is not sent (a logout passes `null`: it is always sent). Each one times out after
   * `COOKIE_REQUEST_TIMEOUT_MS`, so the queue always moves on.
   */
  private exclusive<T>(
    generation: number | null,
    request: () => Observable<T>,
  ): Promise<T> {
    const run = this.cookieQueue.then(() => {
      if (generation !== null && generation !== this.generation)
        throw new SupersededError();
      return firstValueFrom(
        request().pipe(timeout({ first: COOKIE_REQUEST_TIMEOUT_MS })),
      );
    });
    this.cookieQueue = run.catch(() => undefined);
    return run;
  }

  private async rotate(generation: number): Promise<RefreshResult> {
    const current = () => generation === this.generation;
    if (!current()) return { status: "superseded" };
    let next: SignedIn | null = null;
    try {
      const body = await this.exclusive(generation, () =>
        this.http.post<TokenBody>(AUTH.refresh, {}),
      );
      if (current()) next = await this.prepare(body);
    } catch {
      // No cookie, a dead session or a failed load: signed out, unless superseded.
    }
    if (!current()) return { status: "superseded" };
    if (!next) {
      this.clear();
      return { status: "signed-out" };
    }
    // A refresh renews the session it was started for; on startup it begins a new lineage.
    next.lineage = this.state()?.lineage ?? ++this.lineages;
    this.published++;
    this.state.set(next);
    return {
      status: "renewed",
      credentials: {
        token: next.token,
        tenantId: next.tenantId,
        userId: next.userId,
        sessionId: next.sessionId,
        lineage: next.lineage,
      },
    };
  }

  /** Publishes the session of a sign-in, store switch or enrollment, unless superseded. */
  private async replace(generation: number, body: TokenBody): Promise<void> {
    if (generation !== this.generation) throw new SupersededError();
    const next = await this.prepare(body);
    if (generation !== this.generation) throw new SupersededError();
    next.lineage = ++this.lineages;
    this.published++;
    this.state.set(next);
    this.generation++;
    writeLogoutPending(false);
    this.logoutUnconfirmed.set(false);
  }

  /** Loads what the new token may do, with that token, before anything is published. */
  private async prepare(body: TokenBody): Promise<SignedIn> {
    const headers = new HttpHeaders({
      authorization: `Bearer ${body.accessToken}`,
    });
    const platform = await this.loadPlatform(headers);
    const loadedStore =
      body.activeTenantId && platform !== "mfa-setup"
        ? await this.loadStore(body.activeTenantId, headers)
        : null;
    return {
      token: body.accessToken,
      tenantId: body.activeTenantId,
      userId: loadedStore?.staffUserId ?? null,
      sessionId: loadedStore?.sessionId ?? null,
      lineage: 0,
      platform,
      store: loadedStore?.store ?? null,
    };
  }

  private async loadPlatform(headers: HttpHeaders): Promise<PlatformAccess> {
    try {
      await firstValueFrom(this.http.get(AUTH.platformMe, { headers }));
      return "operator";
    } catch (error) {
      if (apiStatus(error) !== 403) throw error;
      return apiErrorCode(error) === "MFA_REQUIRED" ? "mfa-setup" : "none";
    }
  }

  /**
   * Role and name in the active store, read from the API (never from the token). A store the
   * person can no longer enter (403) leaves no store selected; any other failure fails the
   * operation, which then publishes nothing.
   */
  private async loadStore(
    tenantId: string,
    headers: HttpHeaders,
  ): Promise<{
    store: TenantChoice | null;
    staffUserId: string;
    sessionId: string;
  } | null> {
    let me: {
      staffUserId: string;
      sessionId: string;
      tenantId: string;
      role: Role;
    };
    let tenants: TenantChoice[];
    try {
      [me, tenants] = await Promise.all([
        firstValueFrom(
          this.http.get<{
            staffUserId: string;
            sessionId: string;
            tenantId: string;
            role: Role;
          }>(AUTH.adminMe, { headers }),
        ),
        firstValueFrom(
          this.http.get<TenantChoice[]>(AUTH.tenants, { headers }),
        ).catch((error: unknown) => {
          if (apiStatus(error) === 403) return [];
          throw error;
        }),
      ]);
    } catch (error) {
      if (apiStatus(error) === 403) return null;
      throw error;
    }
    const choice = tenants.find((tenant) => tenant.tenantId === tenantId);
    return {
      store:
        me.tenantId === tenantId && choice
          ? { ...choice, role: me.role }
          : null,
      staffUserId: me.staffUserId,
      sessionId: me.sessionId,
    };
  }
}

function readLogoutPending(): boolean {
  try {
    return localStorage.getItem(LOGOUT_PENDING_KEY) !== null;
  } catch {
    return false;
  }
}

function writeLogoutPending(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(LOGOUT_PENDING_KEY, "1");
    else localStorage.removeItem(LOGOUT_PENDING_KEY);
  } catch {
    // Storage blocked: the warning still shows until the page is closed.
  }
}
