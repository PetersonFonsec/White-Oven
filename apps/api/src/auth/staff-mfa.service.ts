import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { ApiError } from "../errors/api-error";
import type { StaffAccessClaims } from "./access-token";
import { LoginThrottle } from "./login-throttle";
import { MfaChallenges } from "./mfa-challenges";
import { type IssuedTokens, StaffAuth } from "./staff-auth.service";
import {
  SecretBox,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  recoveryCodeHash,
} from "./totp";

/** Second factor sent with the MFA step of the login: exactly one of the two. */
export type SecondFactor = { code: string } | { recoveryCode: string };

/**
 * PostgreSQL array literal for `bytea[]`: the query builder expands a JS array binding into a
 * list of parameters, so arrays travel as one text literal of hex-escaped elements.
 */
const byteaArray = (values: Buffer[]) =>
  `{${values.map((value) => `"\\\\x${value.toString("hex")}"`).join(",")}}`;

const invalidCode = () =>
  new ApiError(HttpStatus.UNAUTHORIZED, "MFA_INVALID", "Invalid code.");

/**
 * TOTP enrollment, the second login step and single-use recovery codes (M1.4 part B, ADR 0007).
 * Secrets are sealed with `SecretBox` (key outside the database). Every check of a code runs
 * under `select ... for update` of the user row, so a TOTP step or a recovery code is accepted
 * once even with concurrent requests. Mandatory for operators; optional for store staff.
 */
@Injectable()
export class StaffMfa {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SecretBox) private readonly box: SecretBox,
    @Inject(StaffAuth) private readonly auth: StaffAuth,
    @Inject(MfaChallenges) private readonly challenges: MfaChallenges,
    @Inject(LoginThrottle) private readonly throttle: LoginThrottle,
  ) {}

  /** Starts (or restarts) enrollment: a new pending secret, shown once to the user. */
  async setup(
    staffUserId: string,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const secret = newTotpSecret();
    const [row] = await this.orm.em.fork().execute<{ email: string }[]>(
      `update staff_users set mfa_pending_secret = ?, updated_at = now()
        where id = ? and mfa_enabled_at is null
        returning email`,
      [this.box.seal(secret, staffUserId), staffUserId],
    );
    if (!row)
      throw new ApiError(
        HttpStatus.CONFLICT,
        "MFA_ALREADY_ENABLED",
        "Two-factor authentication is already enabled.",
      );
    return { secret, otpauthUri: otpauthUri(secret, row.email) };
  }

  /**
   * Confirms enrollment with a first code, stores the recovery code hashes and upgrades the
   * current session to `mfa = true` (the user just proved the password and the second factor).
   */
  async activate(
    claims: StaffAccessClaims,
    code: string,
  ): Promise<{ recoveryCodes: string[]; tokens: IssuedTokens }> {
    const recoveryCodes = newRecoveryCodes();
    const activated = await this.orm.em.fork().transactional(async (em) => {
      const [user] = await em.execute<
        { pending: string | null; enabled: boolean }[]
      >(
        `select mfa_pending_secret as pending, mfa_enabled_at is not null as enabled
           from staff_users where id = ? for update`,
        [claims.sub],
      );
      if (!user || user.enabled || !user.pending) return "no-pending" as const;
      const secret = this.box.open(user.pending, claims.sub);
      const step = secret ? matchTotp(secret, code, null) : null;
      if (step === null) return "invalid" as const;
      await em.execute(
        `update staff_users
            set mfa_secret = mfa_pending_secret, mfa_pending_secret = null,
                mfa_enabled_at = now(), mfa_last_used_step = ?,
                mfa_recovery_code_hashes = ?::bytea[], updated_at = now()
          where id = ?`,
        [step, byteaArray(recoveryCodes.map(recoveryCodeHash)), claims.sub],
      );
      const sessions = await em.execute<{ id: string }[]>(
        `update staff_sessions set mfa = true
           where id = ? and staff_user_id = ? and revoked_at is null
             and idle_expires_at > now()
           returning id`,
        [claims.sid, claims.sub],
      );
      // Roll back enrollment as well if the session was revoked mid-request.
      if (sessions.length !== 1)
        throw new ApiError(
          HttpStatus.UNAUTHORIZED,
          "SESSION_INVALID",
          "Session expired or revoked. Sign in again.",
        );
      return "activated" as const;
    });
    if (activated === "no-pending")
      throw new ApiError(
        HttpStatus.CONFLICT,
        "MFA_SETUP_REQUIRED",
        "Start the two-factor setup first.",
      );
    if (activated === "invalid") throw invalidCode();
    return {
      recoveryCodes,
      tokens: this.auth.issue({ ...claims, mfa: true }),
    };
  }

  /** E-mail behind a pending challenge, for throttling the second step; "" when unknown. */
  challengeEmail(mfaToken: string): string {
    return this.challenges.peek(mfaToken)?.email ?? "";
  }

  /**
   * Second login step: a TOTP code or a recovery code for the challenge's user. The factor is
   * consumed and the session created in one transaction, so a database error never burns a code
   * without a session, and the challenge is consumed only after that transaction committed.
   */
  async completeLogin(
    mfaToken: string,
    factor: SecondFactor,
    ip: string,
  ): Promise<IssuedTokens> {
    const challenge = this.challenges.beginVerification(mfaToken);
    if (!challenge)
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        "MFA_CHALLENGE_INVALID",
        "Sign in again.",
      );
    let tokens: IssuedTokens | null;
    try {
      tokens = await this.orm.em
        .fork()
        .transactional(async (em) =>
          (await this.consumeFactor(em, challenge.staffUserId, factor))
            ? this.auth.startSession(challenge.staffUserId, true, em)
            : null,
        );
    } catch (error) {
      // The check failed, not the code: free the challenge without counting an attempt.
      this.challenges.release(mfaToken);
      throw error;
    }
    if (!tokens) {
      this.challenges.recordFailure(mfaToken);
      this.throttle.recordFailure(challenge.email, ip);
      throw invalidCode();
    }
    this.challenges.consume(mfaToken);
    this.throttle.recordSuccess(challenge.email);
    return tokens;
  }

  /** Checks and consumes a factor inside `em`'s transaction, under the user row lock. */
  private async consumeFactor(
    em: EntityManager,
    staffUserId: string,
    factor: SecondFactor,
  ): Promise<boolean> {
    const [user] = await em.execute<
      {
        secret: string | null;
        lastStep: string | null;
        recovery: Buffer[];
        active: boolean;
      }[]
    >(
      `select mfa_secret as secret, mfa_last_used_step as "lastStep",
              mfa_recovery_code_hashes as recovery, status = 'ACTIVE' as active
         from staff_users where id = ? for update`,
      [staffUserId],
    );
    if (!user?.secret || !user.active) return false;

    if ("code" in factor) {
      const secret = this.box.open(user.secret, staffUserId);
      const step = secret
        ? matchTotp(
            secret,
            factor.code,
            user.lastStep === null ? null : Number(user.lastStep),
          )
        : null;
      if (step === null) return false;
      await em.execute(
        "update staff_users set mfa_last_used_step = ? where id = ?",
        [step, staffUserId],
      );
      return true;
    }

    const hash = recoveryCodeHash(factor.recoveryCode);
    const remaining = user.recovery.filter((stored) => !stored.equals(hash));
    if (remaining.length === user.recovery.length) return false;
    await em.execute(
      "update staff_users set mfa_recovery_code_hashes = ?::bytea[] where id = ?",
      [byteaArray(remaining), staffUserId],
    );
    return true;
  }
}
