import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { TENANT_SETTING } from "../database/tenant-isolation-sql";
import { ApiError } from "../errors/api-error";
import type { TenantStatus } from "../tenancy/tenant.entity";
import { runInTenant } from "../tenancy/tenant-transaction";
import { AccessTokens, type StaffAccessClaims } from "./access-token";
import { LoginThrottle } from "./login-throttle";
import { MFA_CHALLENGE_TTL_SECONDS, MfaChallenges } from "./mfa-challenges";
import { verifyPassword } from "./password";
import type { MembershipRole, SessionRevokedReason } from "./staff.entity";

/** Staff sessions slide: each refresh extends them by 12 h (system-overview.md, "Regras"). */
export const STAFF_SESSION_IDLE_MS = 12 * 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFRESH_TOKEN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  /** Opaque `<sessionId>.<secret>`; only its SHA-256 is stored. Set as an HttpOnly cookie. */
  refreshToken?: string;
  activeTenantId: string | null;
}

/** Password accepted, second factor pending: answer with `POST /admin/auth/login/mfa`. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  expiresIn: number;
}

export interface TenantChoice {
  tenantId: string;
  slug: string;
  displayName: string;
  role: MembershipRole;
}

/** What a verified access token may do right now. */
export interface StaffAccess {
  staffUserId: string;
  sessionId: string;
  /** Role in `tenantId`; null when the token has no active tenant. */
  role: MembershipRole | null;
  tenantId: string | null;
  platformRole: "NONE" | "OPERATOR";
  /** The user has an enabled second factor. */
  mfaEnrolled: boolean;
  /** This session was authenticated (or upgraded) with the second factor. */
  sessionMfa: boolean;
}

/** Login matrix of domain-model.md ("Capacidades por status do tenant"). */
export function staffMayEnter(
  role: MembershipRole,
  status: TenantStatus,
): boolean {
  if (status === "ONBOARDING" || status === "ACTIVE") return true;
  return status === "SUSPENDED" && role === "OWNER";
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

const unauthorized = (code: string, message: string) =>
  new ApiError(HttpStatus.UNAUTHORIZED, code, message);

/** 404 like any resource of another tenant: never confirms the tenant or the membership. */
const tenantNotFound = () =>
  new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "Resource not found.");

export const invalidCredentials = () =>
  unauthorized("INVALID_CREDENTIALS", "Invalid e-mail or password.");

export const invalidSession = () =>
  unauthorized("SESSION_INVALID", "Session expired or revoked. Sign in again.");

type Executor = { execute: MikroORM["em"]["execute"] };

/**
 * The user's role in `tenantId`, read inside the caller's transaction with the membership row
 * locked FOR SHARE. A concurrent revocation or role change either waits for that transaction to
 * end or, when it committed first, is seen here: under READ COMMITTED a locking read re-checks
 * the row's latest version. The tenant setting is transaction-local and cleared right after.
 */
export async function lockedMembershipRole(
  em: Executor,
  staffUserId: string,
  tenantId: string,
): Promise<MembershipRole | null> {
  await em.execute("select set_config(?, ?, true)", [TENANT_SETTING, tenantId]);
  const [row] = await em.execute<
    { role: MembershipRole; status: TenantStatus }[]
  >(
    `select m.role, t.status
       from memberships m join tenants t on t.id = m.tenant_id
      where m.staff_user_id = ? and m.status = 'ACTIVE'
        for share of m`,
    [staffUserId],
  );
  await em.execute("select set_config(?, '', true)", [TENANT_SETTING]);
  return row && staffMayEnter(row.role, row.status) ? row.role : null;
}

/**
 * Staff login, rotating refresh sessions, logout and active tenant (M1.4, ADR 0007). Global
 * tables (`staff_users`, `staff_sessions`) are read outside tenant context; memberships only
 * under the tenant setting (`runInTenant`, `lockedMembershipRole`) or through
 * `whiteoven_staff_memberships`, which keeps the tenant policy.
 *
 * Nothing is cached: every request reads the session, the user and the membership from
 * PostgreSQL, so revocations apply on the next request of any API instance.
 */
@Injectable()
export class StaffAuth {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(AccessTokens) private readonly tokens: AccessTokens,
    @Inject(LoginThrottle) private readonly throttle: LoginThrottle,
    @Inject(MfaChallenges) private readonly challenges: MfaChallenges,
  ) {}

  /** Seconds to wait before this e-mail or IP may try again; 0 when allowed. */
  loginRetryAfterSeconds(email: string, ip: string): number {
    return Math.ceil(this.throttle.retryAfterMs(email, ip) / 1000);
  }

  async login(
    email: string,
    password: string,
    ip: string,
  ): Promise<IssuedTokens | MfaChallenge> {
    const [user] = await this.sql<{
      id: string;
      passwordHash: string;
      status: string;
      mfaEnrolled: boolean;
    }>(
      `select id, password_hash as "passwordHash", status,
              mfa_enabled_at is not null as "mfaEnrolled"
         from staff_users where email = ?`,
      [email],
    );
    const passwordOk = await verifyPassword(
      user?.passwordHash ?? null,
      password,
    );
    if (!user || !passwordOk || user.status !== "ACTIVE") {
      this.throttle.recordFailure(email, ip);
      throw invalidCredentials();
    }
    if (user.mfaEnrolled)
      return {
        mfaRequired: true,
        mfaToken: this.challenges.create(user.id, email),
        expiresIn: MFA_CHALLENGE_TTL_SECONDS,
      };
    this.throttle.recordSuccess(email);
    return this.startSession(user.id, false);
  }

  /** Creates a session after every required factor was checked by the caller. */
  async startSession(staffUserId: string, mfa: boolean): Promise<IssuedTokens> {
    const sessionId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    await this.orm.em.fork().transactional(async (em) => {
      await em.execute(
        `insert into staff_sessions (id, staff_user_id, mfa, refresh_token_hash, idle_expires_at)
         values (?, ?, ?, ?, now() + make_interval(secs => ?))`,
        [
          sessionId,
          staffUserId,
          mfa,
          sha256(secret),
          STAFF_SESSION_IDLE_MS / 1000,
        ],
      );
      await em.execute(
        "update staff_users set last_login_at = now() where id = ?",
        [staffUserId],
      );
    });
    return this.issue(
      { sub: staffUserId, sid: sessionId, tid: null, mfa },
      `${sessionId}.${secret}`,
    );
  }

  /**
   * Rotates the refresh token. A token whose secret does not match the session's current one is
   * a replay of a rotated (stolen) token: the whole session is revoked (`REFRESH_REUSE`).
   */
  async refresh(refreshToken: string | undefined): Promise<IssuedTokens> {
    const match = refreshToken ? REFRESH_TOKEN.exec(refreshToken) : null;
    if (!match || !UUID.test(match[1]!)) throw invalidSession();
    const [, sessionId, secret] = match as unknown as [string, string, string];

    const outcome = await this.orm.em.fork().transactional(async (em) => {
      const [row] = await em.execute<
        {
          staffUserId: string;
          activeTenantId: string | null;
          mfa: boolean;
          hash: Buffer;
          live: boolean;
          userActive: boolean;
        }[]
      >(
        `select s.staff_user_id as "staffUserId", s.active_tenant_id as "activeTenantId",
                s.mfa, s.refresh_token_hash as hash,
                (s.revoked_at is null and s.idle_expires_at > now()) as live,
                u.status = 'ACTIVE' as "userActive"
           from staff_sessions s join staff_users u on u.id = s.staff_user_id
          where s.id = ?
            for update of s`,
        [sessionId],
      );
      if (!row || !row.live) return { kind: "invalid" as const };
      if (!timingSafeEqual(row.hash, sha256(secret))) {
        await this.revokeIn(em, sessionId, "REFRESH_REUSE");
        return { kind: "invalid" as const };
      }
      if (!row.userActive) {
        await this.revokeIn(em, sessionId, "USER_DISABLED");
        return { kind: "invalid" as const };
      }
      // Checked under the session lock, so a concurrent tenant switch cannot be overwritten.
      const tid =
        row.activeTenantId &&
        (await lockedMembershipRole(em, row.staffUserId, row.activeTenantId))
          ? row.activeTenantId
          : null;
      const next = randomBytes(32).toString("base64url");
      await em.execute(
        `update staff_sessions
            set refresh_token_hash = ?, refreshed_at = now(), active_tenant_id = ?,
                idle_expires_at = now() + make_interval(secs => ?)
          where id = ?`,
        [sha256(next), tid, STAFF_SESSION_IDLE_MS / 1000, sessionId],
      );
      return { kind: "rotated" as const, row, tid, next };
    });
    if (outcome.kind === "invalid") throw invalidSession();

    const { row, tid, next } = outcome;
    return this.issue(
      { sub: row.staffUserId, sid: sessionId, tid, mfa: row.mfa },
      `${sessionId}.${next}`,
    );
  }

  /** Revokes the session of a refresh token. Idempotent: unknown or bad tokens are ignored. */
  async logout(refreshToken: string | undefined): Promise<void> {
    const match = refreshToken ? REFRESH_TOKEN.exec(refreshToken) : null;
    if (!match) return;
    const [, sessionId, secret] = match as unknown as [string, string, string];
    await this.orm.em.fork().transactional(async (em) => {
      const [row] = await em.execute<{ hash: Buffer }[]>(
        `select refresh_token_hash as hash from staff_sessions
          where id = ? and revoked_at is null for update`,
        [sessionId],
      );
      if (row && timingSafeEqual(row.hash, sha256(secret)))
        await this.revokeIn(em, sessionId, "LOGOUT");
    });
  }

  /** Tenants this user may switch to: ACTIVE memberships in tenants whose status allows it. */
  async tenantChoices(staffUserId: string): Promise<TenantChoice[]> {
    const rows = await this.sql<TenantChoice & { status: TenantStatus }>(
      `select m.tenant_id as "tenantId", t.slug, t.display_name as "displayName",
              m.role, t.status
         from whiteoven_staff_memberships(?) m
         join tenants t on t.id = m.tenant_id
        where m.status = 'ACTIVE'
        order by t.display_name, t.slug`,
      [staffUserId],
    );
    return rows
      .filter((row) => staffMayEnter(row.role, row.status))
      .map(({ tenantId, slug, displayName, role }) => ({
        tenantId,
        slug,
        displayName,
        role,
      }));
  }

  /**
   * Switches the session's active tenant and issues a token for it. The tenant id comes from the
   * request body but grants nothing by itself: it must match an ACTIVE membership, read inside
   * that tenant's context. Unknown tenants and missing memberships answer the same 404.
   *
   * One transaction locks the session row (serializing with refresh, logout and other switches)
   * and the membership row FOR SHARE (serializing with its revocation), so the tenant stored and
   * the token issued always come from a membership that was ACTIVE when the switch committed.
   */
  async switchTenant(
    claims: StaffAccessClaims,
    tenantId: string,
  ): Promise<IssuedTokens> {
    if (!UUID.test(tenantId)) throw tenantNotFound();
    const outcome = await this.orm.em.fork().transactional(async (em) => {
      const [session] = await em.execute<{ ok: boolean }[]>(
        `select (s.revoked_at is null and s.idle_expires_at > now()
                 and u.status = 'ACTIVE') as ok
           from staff_sessions s join staff_users u on u.id = s.staff_user_id
          where s.id = ? and s.staff_user_id = ?
            for update of s`,
        [claims.sid, claims.sub],
      );
      if (!session?.ok) return "session" as const;
      if (!(await lockedMembershipRole(em, claims.sub, tenantId)))
        return "tenant" as const;
      await em.execute(
        "update staff_sessions set active_tenant_id = ? where id = ?",
        [tenantId, claims.sid],
      );
      return "switched" as const;
    });
    if (outcome === "session") throw invalidSession();
    if (outcome === "tenant") throw tenantNotFound();
    return this.issue({ ...claims, tid: tenantId });
  }

  /**
   * Checks, for every request, that the session is live, the user active and, with a tenant,
   * that the membership is ACTIVE and the tenant admits the role. Read from PostgreSQL each time,
   * so a revocation, a role change or a disabled user applies on the next request of every API
   * instance (tenant-isolation.md, required test 7). `TenantTransactions.run` checks the same
   * again, with row locks, inside the transaction that does the work.
   */
  async authorize(claims: StaffAccessClaims): Promise<StaffAccess | null> {
    const [session] = await this.sql<{
      ok: boolean;
      platformRole: StaffAccess["platformRole"];
      mfaEnrolled: boolean;
      sessionMfa: boolean;
    }>(
      `select (s.revoked_at is null and s.idle_expires_at > now()
               and u.status = 'ACTIVE') as ok,
              u.platform_role as "platformRole",
              u.mfa_enabled_at is not null as "mfaEnrolled",
              s.mfa as "sessionMfa"
         from staff_sessions s join staff_users u on u.id = s.staff_user_id
        where s.id = ? and s.staff_user_id = ?`,
      [claims.sid, claims.sub],
    );
    if (!session?.ok) return null;
    let role: MembershipRole | null = null;
    if (claims.tid) {
      role = await this.membershipRole(claims.sub, claims.tid);
      if (!role) return null;
    }
    return {
      staffUserId: claims.sub,
      sessionId: claims.sid,
      role,
      tenantId: claims.tid,
      platformRole: session.platformRole,
      mfaEnrolled: session.mfaEnrolled,
      sessionMfa: session.sessionMfa,
    };
  }

  /** The user's role in `tenantId`, or null without an ACTIVE membership the tenant admits. */
  private async membershipRole(
    staffUserId: string,
    tenantId: string,
  ): Promise<MembershipRole | null> {
    const [row] = await runInTenant(this.orm, tenantId, (em) =>
      em.execute<{ role: MembershipRole; status: TenantStatus }[]>(
        `select m.role, t.status
           from memberships m join tenants t on t.id = m.tenant_id
          where m.staff_user_id = ? and m.status = 'ACTIVE'`,
        [staffUserId],
      ),
    );
    return row && staffMayEnter(row.role, row.status) ? row.role : null;
  }

  issue(
    claims: Omit<StaffAccessClaims, "typ">,
    refreshToken?: string,
  ): IssuedTokens {
    const { token, expiresIn } = this.tokens.issue({ ...claims, typ: "staff" });
    return {
      accessToken: token,
      expiresIn,
      ...(refreshToken ? { refreshToken } : {}),
      activeTenantId: claims.tid,
    };
  }

  private async revokeIn(
    em: Executor,
    sessionId: string,
    reason: SessionRevokedReason,
  ): Promise<void> {
    await em.execute(
      `update staff_sessions set revoked_at = now(), revoked_reason = ?
        where id = ? and revoked_at is null`,
      [reason, sessionId],
    );
  }

  private sql<T>(query: string, params: unknown[] = []): Promise<T[]> {
    return this.orm.em.fork().execute<T[]>(query, params);
  }
}
