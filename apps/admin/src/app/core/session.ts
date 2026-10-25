import { HttpClient } from "@angular/common/http";
import { Injectable, computed, inject, signal } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { AUTH, apiErrorCode } from "./api";

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

/**
 * The staff session of the panel (ADR 0007, ADR 0012). The access token lives only in this
 * service's memory: never in storage, cookies or the URL. The refresh token is the API's HttpOnly
 * cookie, so a reload restores the session through `restore()`.
 */
@Injectable({ providedIn: "root" })
export class Session {
  private readonly http = inject(HttpClient);
  private readonly token = signal<string | null>(null);
  private refreshing: Promise<string | null> | null = null;

  readonly platform = signal<PlatformAccess | null>(null);
  readonly store = signal<TenantChoice | null>(null);
  readonly signedIn = computed(() => this.token() !== null);
  readonly role = computed(() => this.store()?.role ?? null);

  accessToken(): string | null {
    return this.token();
  }

  /** Startup: resumes the session of the refresh cookie, if any. Never throws. */
  async restore(): Promise<void> {
    await this.refresh();
  }

  async login(
    email: string,
    password: string,
  ): Promise<"signed-in" | { mfaToken: string }> {
    const body = await firstValueFrom(
      this.http.post<TokenBody | MfaChallengeBody>(AUTH.login, {
        email,
        password,
      }),
    );
    if ("mfaRequired" in body) return { mfaToken: body.mfaToken };
    await this.accept(body);
    return "signed-in";
  }

  async loginMfa(mfaToken: string, factor: SecondFactor): Promise<void> {
    await this.accept(
      await firstValueFrom(
        this.http.post<TokenBody>(AUTH.loginMfa, { mfaToken, ...factor }),
      ),
    );
  }

  /**
   * Rotates the refresh cookie. Concurrent callers share one request, because the API treats a
   * second use of a rotated refresh token as theft and revokes the whole session.
   */
  refresh(): Promise<string | null> {
    this.refreshing ??= firstValueFrom(
      this.http.post<TokenBody>(AUTH.refresh, {}),
    )
      .then(async (body) => {
        await this.accept(body);
        return body.accessToken;
      })
      .catch(() => {
        this.clear();
        return null;
      })
      .finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  tenants(): Promise<TenantChoice[]> {
    return firstValueFrom(this.http.get<TenantChoice[]>(AUTH.tenants));
  }

  async selectStore(tenantId: string): Promise<void> {
    await this.accept(
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
    const body = await firstValueFrom(
      this.http.post<TokenBody & { recoveryCodes: string[] }>(
        AUTH.mfaActivate,
        { code },
      ),
    );
    await this.accept(body);
    return body.recoveryCodes;
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post(AUTH.logout, {}));
    } catch {
      // The local session ends anyway; the cookie expires with its server session.
    }
    this.clear();
  }

  clear(): void {
    this.token.set(null);
    this.platform.set(null);
    this.store.set(null);
  }

  private async accept(body: TokenBody): Promise<void> {
    this.token.set(body.accessToken);
    this.platform.set(await this.loadPlatform());
    this.store.set(
      body.activeTenantId ? await this.loadStore(body.activeTenantId) : null,
    );
  }

  private async loadPlatform(): Promise<PlatformAccess> {
    try {
      await firstValueFrom(this.http.get(AUTH.platformMe));
      return "operator";
    } catch (error) {
      return apiErrorCode(error) === "MFA_REQUIRED" ? "mfa-setup" : "none";
    }
  }

  /** Role and name in the active store, read from the API (never from the token). */
  private async loadStore(tenantId: string): Promise<TenantChoice | null> {
    if (this.platform() === "mfa-setup") return null;
    try {
      const [me, tenants] = await Promise.all([
        firstValueFrom(
          this.http.get<{ tenantId: string; role: Role }>(AUTH.adminMe),
        ),
        this.tenants(),
      ]);
      const choice = tenants.find((tenant) => tenant.tenantId === tenantId);
      if (me.tenantId !== tenantId || !choice) return null;
      return { ...choice, role: me.role };
    } catch {
      return null;
    }
  }
}
