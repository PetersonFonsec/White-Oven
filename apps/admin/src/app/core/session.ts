import { HttpClient, HttpHeaders } from "@angular/common/http";
import { Injectable, computed, inject, signal } from "@angular/core";
import { firstValueFrom } from "rxjs";
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

export type LogoutResult = "confirmed" | "unconfirmed";

/**
 * The token and what it was issued for. `lineage` changes with every sign-in, store switch and MFA
 * enrollment, and survives refreshes: a call may be retried only within its lineage and store.
 */
export interface Credentials {
  token: string;
  tenantId: string | null;
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
  private refreshing: {
    generation: number;
    promise: Promise<RefreshResult>;
  } | null = null;

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
    const body = await firstValueFrom(
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
      await firstValueFrom(
        this.http.post<TokenBody>(AUTH.loginMfa, { mfaToken, ...factor }),
      ),
    );
  }

  /**
   * Rotates the refresh cookie. Concurrent callers share one request, because the API treats a
   * second use of a rotated refresh token as theft and revokes the whole session. A refresh of an
   * older generation is never joined: the new one waits for it to settle, so the browser sends
   * the latest cookie.
   */
  refresh(): Promise<RefreshResult> {
    const generation = this.generation;
    const pending = this.refreshing;
    if (pending?.generation === generation) return pending.promise;
    const promise = (pending?.promise ?? Promise.resolve())
      .then(() => this.rotate(generation))
      .finally(() => {
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
   * Ends the session here at once, then asks the API to revoke it. A refresh in flight is awaited
   * first, so the request carries the latest refresh cookie. When the API does not confirm, the
   * session may still be alive on the server: the result says so, and the next start of the panel
   * retries the logout instead of resuming the session.
   */
  async logout(): Promise<LogoutResult> {
    const refreshing = this.refreshing?.promise;
    this.clear();
    writeLogoutPending(true);
    await refreshing;
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

  private async revoke(): Promise<LogoutResult> {
    try {
      await firstValueFrom(this.http.post(AUTH.logout, {}));
    } catch {
      writeLogoutPending(true);
      this.logoutUnconfirmed.set(true);
      return "unconfirmed";
    }
    writeLogoutPending(false);
    this.logoutUnconfirmed.set(false);
    return "confirmed";
  }

  private async rotate(generation: number): Promise<RefreshResult> {
    const current = () => generation === this.generation;
    if (!current()) return { status: "superseded" };
    let next: SignedIn | null = null;
    try {
      const body = await firstValueFrom(
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
    this.state.set(next);
    return {
      status: "renewed",
      credentials: {
        token: next.token,
        tenantId: next.tenantId,
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
    const store =
      body.activeTenantId && platform !== "mfa-setup"
        ? await this.loadStore(body.activeTenantId, headers)
        : null;
    return {
      token: body.accessToken,
      tenantId: body.activeTenantId,
      lineage: 0,
      platform,
      store,
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
  ): Promise<TenantChoice | null> {
    let me: { tenantId: string; role: Role };
    let tenants: TenantChoice[];
    try {
      [me, tenants] = await Promise.all([
        firstValueFrom(
          this.http.get<{ tenantId: string; role: Role }>(AUTH.adminMe, {
            headers,
          }),
        ),
        firstValueFrom(
          this.http.get<TenantChoice[]>(AUTH.tenants, { headers }),
        ),
      ]);
    } catch (error) {
      if (apiStatus(error) === 403) return null;
      throw error;
    }
    const choice = tenants.find((tenant) => tenant.tenantId === tenantId);
    if (me.tenantId !== tenantId || !choice) return null;
    return { ...choice, role: me.role };
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
