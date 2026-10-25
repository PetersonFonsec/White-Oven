import { createHash, createHmac, randomBytes } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { MikroORM, type EntityManager } from "@mikro-orm/postgresql";
import { ApiError } from "../errors/api-error";
import { API_CONFIG, type ApiConfig } from "../config/config";
import { hashPassword, passwordProblem } from "../auth/password";
import type { MembershipRole } from "../auth/staff.entity";
import { currentTenantContext } from "../tenancy/tenant-context";
import { TenantStatusPolicy } from "../tenancy/tenant-status-policy";
import type { TenantStatus } from "../tenancy/tenant.entity";
import { TenantTransactions } from "../tenancy/tenant-transaction";

export const TEAM_ROLES = ["OWNER", "MANAGER", "STAFF"] as const;
export const INVITE_TTL_SECONDS = 72 * 60 * 60;
const EMAIL = /^[^\s@]{1,64}@[a-z0-9.-]{1,189}\.[a-z]{2,}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TeamMember {
  membershipId: string;
  name: string;
  email: string;
  role: MembershipRole;
  since: string;
  /** The signed-in OWNER's own row. */
  you: boolean;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: MembershipRole;
  expiresAt: string;
}

export interface InvitePreview {
  storeName: string;
  role: MembershipRole;
  email: string;
  /** The invitee signs in and accepts instead of creating an account. */
  accountExists: boolean;
  expiresAt: string;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest();
const inviteGone = () =>
  new ApiError(
    HttpStatus.GONE,
    "INVITE_INVALID",
    "Invitation is invalid or expired.",
  );

/**
 * Team management (M3.6, ADR 0015). Every change goes through a SECURITY DEFINER function that
 * checks the OWNER's live session again, keeps the last OWNER, revokes sessions and audits in
 * the same transaction. Invites carry a random single-use token shown once to the OWNER (Q-12:
 * no e-mail is sent); only its SHA-256 is stored.
 */
@Injectable()
export class TeamService {
  private readonly inviteKey: Buffer;

  constructor(
    private readonly transactions: TenantTransactions,
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    // The invitation secret of the owner invites (M1.5), with its own domain below. Production
    // config requires it; the random fallback is local/test only, as there.
    this.inviteKey = config.auth.ownerInviteSecret ?? randomBytes(32);
  }

  list(): Promise<{ members: TeamMember[]; invites: PendingInvite[] }> {
    return this.transactions.run(async (em) => {
      const actor = currentTenantContext().actor;
      const me = actor.type === "staff" ? actor.staffUserId : null;
      const [members, invites] = await Promise.all([
        em.execute<
          (Omit<TeamMember, "you" | "since"> & {
            since: Date;
            staffUserId: string;
          })[]
        >(
          `select m.id as "membershipId", u.id as "staffUserId", u.name, u.email, m.role,
                  m.created_at as since
             from memberships m join staff_users u on u.id = m.staff_user_id
            where m.status = 'ACTIVE'
            order by array_position(array['OWNER','MANAGER','STAFF'], m.role), lower(u.name), u.email`,
        ),
        em.execute<(Omit<PendingInvite, "expiresAt"> & { expiresAt: Date })[]>(
          `select id, email, role, expires_at as "expiresAt" from staff_invites
            where accepted_at is null and revoked_at is null and expires_at > now()
            order by created_at desc`,
        ),
      ]);
      return {
        members: members.map(({ staffUserId, since, ...member }) => ({
          ...member,
          since: new Date(since).toISOString(),
          you: staffUserId === me,
        })),
        invites: invites.map((invite) => ({
          ...invite,
          expiresAt: new Date(invite.expiresAt).toISOString(),
        })),
      };
    });
  }

  /**
   * Creates an invite. Like the owner invites, the token is derived from the Idempotency-Key and
   * the body, so a retry returns the same link instead of replacing it.
   */
  async invite(
    rawEmail: string,
    role: MembershipRole,
    idempotencyKey: string,
    requestId: string,
  ): Promise<{ invite: PendingInvite; inviteUrl: string; expiresIn: number }> {
    const email = rawEmail.trim().toLowerCase();
    const paths = [
      ...(!EMAIL.test(email) || email.length > 254 ? ["email"] : []),
      ...(!IDEMPOTENCY_KEY.test(idempotencyKey) ? ["Idempotency-Key"] : []),
    ];
    if (paths.length)
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "VALIDATION_FAILED",
        "Invalid request body.",
        {
          errors: paths.map((path) => ({ code: "VALIDATION_FAILED", path })),
        },
      );
    const origin = this.config.auth.adminOrigins[0];
    if (!origin)
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        "ADMIN_ORIGIN_NOT_CONFIGURED",
        "Team invitation is unavailable.",
      );
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ email, role }))
      .digest();
    const { row, token } = await this.perform(requestId, async (em, actor) => {
      const token = createHmac("sha256", this.inviteKey)
        .update(`staff-invite\0${currentTenantContext().tenantId}\0`)
        .update(`${idempotencyKey}\0`)
        .update(requestHash)
        .digest("base64url");
      const [row] = await em.execute<{ inviteId: string; expiresAt: Date }[]>(
        'select invite_id as "inviteId", expires_at as "expiresAt" from whiteoven_team_invite(?, ?, ?, ?, ?, ?, ?, ?)',
        [
          email,
          role,
          hashOf(token),
          actor.staffUserId,
          actor.sessionId,
          actor.requestId,
          createHash("sha256").update(idempotencyKey).digest(),
          requestHash,
        ],
      );
      return { row, token };
    });
    return {
      invite: {
        id: row!.inviteId,
        email,
        role,
        expiresAt: new Date(row!.expiresAt).toISOString(),
      },
      inviteUrl: `${origin}/equipe/convite/${token}`,
      expiresIn: INVITE_TTL_SECONDS,
    };
  }

  async cancelInvite(inviteId: string, requestId: string): Promise<void> {
    const done = UUID.test(inviteId)
      ? await this.call(
          requestId,
          "select whiteoven_team_cancel_invite(?, ?, ?, ?) as done",
          [inviteId],
        )
      : false;
    if (!done)
      throw new ApiError(
        HttpStatus.NOT_FOUND,
        "INVITE_NOT_FOUND",
        "Invitation not found.",
      );
  }

  async changeRole(
    membershipId: string,
    role: MembershipRole,
    requestId: string,
  ): Promise<void> {
    const done = UUID.test(membershipId)
      ? await this.call(
          requestId,
          "select whiteoven_team_change_role(?, ?, ?, ?, ?) as done",
          [membershipId, role],
        )
      : false;
    if (!done) throw memberNotFound();
  }

  async revokeMember(membershipId: string, requestId: string): Promise<void> {
    const done = UUID.test(membershipId)
      ? await this.call(
          requestId,
          "select whiteoven_team_revoke_member(?, ?, ?, ?) as done",
          [membershipId],
        )
      : false;
    if (!done) throw memberNotFound();
  }

  /** What a pending invite is for; 410 for anything else, so tokens cannot be probed. */
  async preview(token: string): Promise<InvitePreview> {
    const preview = TOKEN.test(token) ? await this.peek(token) : undefined;
    if (!preview) throw inviteGone();
    return preview;
  }

  /**
   * A new person accepts an invite by creating the account it is for. An e-mail that already has
   * an account is 409 `ACCOUNT_EXISTS`, before any password is read: that person signs in (with
   * the login lockout and second factor) and accepts through `accept`.
   */
  async redeem(
    token: string,
    name: string,
    password: string,
    requestId: string,
  ): Promise<{ storeName: string; role: MembershipRole; newAccount: true }> {
    const preview = TOKEN.test(token) ? await this.peek(token) : undefined;
    if (!preview) throw inviteGone();
    if (preview.accountExists) throw accountExists();
    const trimmed = name.trim();
    const paths = [
      ...(trimmed.length < 1 || trimmed.length > 120 ? ["name"] : []),
      ...(passwordProblem(password) ? ["password"] : []),
    ];
    if (paths.length)
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "VALIDATION_FAILED",
        "Invalid request body.",
        {
          errors: paths.map((path) => ({ code: "VALIDATION_FAILED", path })),
        },
      );
    const passwordHash = await hashPassword(password);
    const row = await this.consume(() =>
      this.orm.em
        .fork()
        .transactional((em) =>
          em.execute<{ staffUserId: string }[]>(
            'select staff_user_id as "staffUserId" from whiteoven_redeem_staff_invite(?, ?, ?, ?)',
            [
              hashOf(token),
              trimmed,
              passwordHash,
              UUID.test(requestId) ? requestId : null,
            ],
          ),
        ),
    );
    if (!row) throw inviteGone();
    return {
      storeName: preview.storeName,
      role: preview.role,
      newAccount: true,
    };
  }

  /**
   * A signed-in person accepts an invite for their own e-mail. The database takes the identity
   * from the live session, not from a user id, and refuses another account's invite (403).
   */
  async accept(
    token: string,
    staffUserId: string,
    sessionId: string,
    requestId: string,
  ): Promise<{ storeName: string; role: MembershipRole; newAccount: false }> {
    const preview = TOKEN.test(token) ? await this.peek(token) : undefined;
    if (!preview) throw inviteGone();
    const row = await this.consume(() =>
      this.orm.em
        .fork()
        .transactional((em) =>
          em.execute<{ staffUserId: string }[]>(
            'select staff_user_id as "staffUserId" from whiteoven_accept_staff_invite(?, ?, ?, ?)',
            [
              hashOf(token),
              staffUserId,
              sessionId,
              UUID.test(requestId) ? requestId : null,
            ],
          ),
        ),
    );
    if (!row) throw inviteGone();
    return {
      storeName: preview.storeName,
      role: preview.role,
      newAccount: false,
    };
  }

  /** Runs a redemption, mapping the database's refusals. */
  private async consume(
    work: () => Promise<{ staffUserId: string }[]>,
  ): Promise<{ staffUserId: string } | undefined> {
    try {
      return (await work())[0];
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // P0013, or 23505 when the account was created between the check and the insert.
      if (code === "P0013" || code === "23505") throw accountExists();
      if (code === "P0010") throw alreadyMember();
      if (code === "P0012")
        throw new ApiError(
          HttpStatus.FORBIDDEN,
          "INVITE_EMAIL_MISMATCH",
          "This invitation is for another e-mail address.",
        );
      if (code === "42501")
        throw new ApiError(
          HttpStatus.UNAUTHORIZED,
          "UNAUTHORIZED",
          "Authentication required.",
        );
      throw error;
    }
  }

  private async peek(token: string): Promise<InvitePreview | undefined> {
    const [row] = await this.orm.em.fork().transactional((em) =>
      em.execute<(Omit<InvitePreview, "expiresAt"> & { expiresAt: Date })[]>(
        `select store_name as "storeName", role, email, account_exists as "accountExists",
                  expires_at as "expiresAt" from whiteoven_peek_staff_invite(?)`,
        [hashOf(token)],
      ),
    );
    return row && { ...row, expiresAt: new Date(row.expiresAt).toISOString() };
  }

  private async call(
    requestId: string,
    sql: string,
    params: unknown[],
  ): Promise<boolean> {
    const [row] = await this.perform(requestId, (em, actor) =>
      em.execute<{ done: boolean }[]>(sql, [
        ...params,
        actor.staffUserId,
        actor.sessionId,
        actor.requestId,
      ]),
    );
    return row?.done === true;
  }

  /** Runs a team function as the signed-in OWNER, mapping the database's refusals. */
  private async perform<T>(
    requestId: string,
    work: (
      em: EntityManager,
      actor: {
        staffUserId: string;
        sessionId: string;
        requestId: string | null;
      },
    ) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.transactions.run(async (em) => {
        const context = currentTenantContext();
        if (context.actor.type !== "staff")
          throw new Error("team changes require staff");
        const [tenant] = await em.execute<{ status: TenantStatus }[]>(
          "select status from tenants where id = ?",
          [context.tenantId],
        );
        if (
          !tenant ||
          !TenantStatusPolicy.allows(
            tenant.status,
            context.actor.role,
            "teamManage",
          )
        )
          throw teamForbidden();
        return work(em, {
          staffUserId: context.actor.staffUserId,
          sessionId: context.actor.sessionId,
          requestId: UUID.test(requestId) ? requestId : null,
        });
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "42501") throw teamForbidden();
      if (code === "P0010") throw alreadyMember();
      if (code === "P0003")
        throw new ApiError(
          HttpStatus.CONFLICT,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was used for a different request.",
        );
      if (code === "P0011")
        throw new ApiError(
          HttpStatus.CONFLICT,
          "LAST_OWNER",
          "The store needs at least one owner.",
        );
      throw error;
    }
  }
}

const accountExists = () =>
  new ApiError(
    HttpStatus.CONFLICT,
    "ACCOUNT_EXISTS",
    "An account already uses this e-mail address. Sign in to accept the invitation.",
  );
const alreadyMember = () =>
  new ApiError(
    HttpStatus.CONFLICT,
    "ALREADY_MEMBER",
    "This person is already on the team.",
  );
const memberNotFound = () =>
  new ApiError(
    HttpStatus.NOT_FOUND,
    "MEMBER_NOT_FOUND",
    "Team member not found.",
  );
const teamForbidden = () =>
  new ApiError(
    HttpStatus.FORBIDDEN,
    "TEAM_WRITE_FORBIDDEN",
    "The team cannot be changed in this store's status.",
  );
