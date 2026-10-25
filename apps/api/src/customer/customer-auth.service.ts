import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import { AccessTokens } from "../auth/access-token";
import { LoginThrottle } from "../auth/login-throttle";
import { hashPassword, verifyPassword } from "../auth/password";
import { ApiError } from "../errors/api-error";
import { currentTenantContext } from "../tenancy/tenant-context";
import { TenantTransactions } from "../tenancy/tenant-transaction";
import type { Registration } from "./customer-rules";

/** Customer sessions end 30 days after sign-in; refreshing rotates the token, never extends. */
export const CUSTOMER_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** Separate from the staff throttle: one store's customers never lock out the panel. */
export const CUSTOMER_LOGIN_THROTTLE = Symbol("CUSTOMER_LOGIN_THROTTLE");

const REFRESH_TOKEN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

export type CustomerRevokedReason =
  "LOGOUT" | "REFRESH_REUSE" | "ACCOUNT_DELETED";

export interface CustomerProfile {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  privacyPolicyVersion: string;
  acceptedAt: string;
}

export interface CustomerTokens {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  /** Opaque `<sessionId>.<secret>`; the app keeps it in the system's secure storage. */
  refreshToken: string;
  /** ISO instant the session ends; signing in again is needed after it. */
  refreshExpiresAt: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();

export const invalidCustomerCredentials = () =>
  new ApiError(
    HttpStatus.UNAUTHORIZED,
    "INVALID_CREDENTIALS",
    "Invalid e-mail or password.",
  );

export const invalidCustomerSession = () =>
  new ApiError(
    HttpStatus.UNAUTHORIZED,
    "SESSION_INVALID",
    "Session expired or revoked. Sign in again.",
  );

/** The tenant comes from the store slug; the throttle key keeps the same e-mail apart per store. */
const throttleKey = (email: string) =>
  `${currentTenantContext().tenantId}\0${email}`;

/**
 * Customer accounts of one store (M4.2, ADR 0017, Q-05: e-mail and password, account required).
 * Every read and write runs in the store's tenant transaction, so RLS keeps customers, sessions
 * and refresh tokens of one store out of every other: a refresh token of store A presented at
 * store B finds no session.
 */
@Injectable()
export class CustomerAuth {
  constructor(
    private readonly transactions: TenantTransactions,
    @Inject(AccessTokens) private readonly tokens: AccessTokens,
    @Inject(CUSTOMER_LOGIN_THROTTLE) private readonly throttle: LoginThrottle,
  ) {}

  loginRetryAfterSeconds(email: string, ip: string): number {
    return Math.ceil(this.throttle.retryAfterMs(throttleKey(email), ip) / 1000);
  }

  /** Creates the account and signs it in. The e-mail and phone are unique in this store only. */
  async register(registration: Registration): Promise<CustomerTokens> {
    const passwordHash = await hashPassword(registration.password);
    try {
      return await this.transactions.run(async (em) => {
        const [row] = await em.execute<{ id: string }[]>(
          `insert into customers (tenant_id, name, email, phone, password_hash, privacy_policy_version, accepted_at)
           values (current_setting('app.tenant_id')::uuid, ?, ?, ?, ?, ?, now()) returning id`,
          [
            registration.name,
            registration.email,
            registration.phone,
            passwordHash,
            registration.privacyPolicyVersion,
          ],
        );
        return this.startSession(em, row!.id);
      });
    } catch (error) {
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint === "customers_email_key")
        throw new ApiError(
          HttpStatus.CONFLICT,
          "EMAIL_TAKEN",
          "This e-mail already has an account in this store. Sign in instead.",
        );
      if (constraint === "customers_phone_key")
        throw new ApiError(
          HttpStatus.CONFLICT,
          "PHONE_TAKEN",
          "This phone already belongs to an account in this store.",
        );
      throw error;
    }
  }

  async login(
    email: string,
    password: string,
    ip: string,
  ): Promise<CustomerTokens> {
    const [customer] = await this.transactions.run((em) =>
      em.execute<{ id: string; passwordHash: string }[]>(
        `select id, password_hash as "passwordHash" from customers
          where email = ? and status = 'ACTIVE'`,
        [email],
      ),
    );
    // Unknown e-mails cost one Argon2id verification too, so timing reveals nothing.
    const ok = await verifyPassword(customer?.passwordHash ?? null, password);
    if (!customer || !ok) {
      this.throttle.recordFailure(throttleKey(email), ip);
      throw invalidCustomerCredentials();
    }
    this.throttle.recordSuccess(throttleKey(email));
    return this.transactions.run((em) => this.startSession(em, customer.id));
  }

  /**
   * Rotates the refresh token. A token whose secret is not the session's current one is a replay
   * of a rotated token: the whole session is revoked (`REFRESH_REUSE`).
   */
  async refresh(refreshToken: string): Promise<CustomerTokens> {
    const match = REFRESH_TOKEN.exec(refreshToken);
    if (!match) throw invalidCustomerSession();
    const [, sessionId, secret] = match as unknown as [string, string, string];
    const outcome = await this.transactions.run(async (em) => {
      const [row] = await em.execute<
        {
          customerId: string;
          hash: Buffer;
          live: boolean;
          active: boolean;
          expiresAt: Date;
        }[]
      >(
        `select s.customer_id as "customerId", s.refresh_token_hash as hash,
                (s.revoked_at is null and s.expires_at > now()) as live,
                c.status = 'ACTIVE' as active, s.expires_at as "expiresAt"
           from customer_sessions s
           join customers c on c.tenant_id = s.tenant_id and c.id = s.customer_id
          where s.id = ?
            for update of s`,
        [sessionId],
      );
      if (!row?.live || !row.active) return null;
      if (!timingSafeEqual(row.hash, sha256(secret))) {
        await revoke(em, "s.id = ?", [sessionId], "REFRESH_REUSE");
        return null;
      }
      const next = randomBytes(32).toString("base64url");
      await em.execute(
        `update customer_sessions set refresh_token_hash = ?, refreshed_at = now() where id = ?`,
        [sha256(next), sessionId],
      );
      return { row, next };
    });
    if (!outcome) throw invalidCustomerSession();
    return this.issue(
      outcome.row.customerId,
      sessionId,
      outcome.next,
      outcome.row.expiresAt,
    );
  }

  /** Revokes the session of a refresh token. Idempotent: unknown or bad tokens are ignored. */
  async logout(refreshToken: string): Promise<void> {
    const match = REFRESH_TOKEN.exec(refreshToken);
    if (!match) return;
    const [, sessionId, secret] = match as unknown as [string, string, string];
    await this.transactions.run(async (em) => {
      const [row] = await em.execute<{ hash: Buffer }[]>(
        `select refresh_token_hash as hash from customer_sessions
          where id = ? and revoked_at is null for update`,
        [sessionId],
      );
      if (row && timingSafeEqual(row.hash, sha256(secret)))
        await revoke(em, "s.id = ?", [sessionId], "LOGOUT");
    });
  }

  profile(): Promise<CustomerProfile> {
    return this.transactions.run(async (em) => {
      const [row] = await em.execute<
        (Omit<CustomerProfile, "acceptedAt"> & { acceptedAt: Date })[]
      >(
        `select id, name, email, phone, privacy_policy_version as "privacyPolicyVersion",
                accepted_at as "acceptedAt"
           from customers where id = ?`,
        [customerOf()],
      );
      return { ...row!, acceptedAt: new Date(row!.acceptedAt).toISOString() };
    });
  }

  /**
   * Deletes the account (domain model: exclusion anonymizes). Asks for the password again, so a
   * stolen access token alone cannot delete an account. In one transaction: name, e-mail, phone
   * and password become null, the addresses are deleted and every session is revoked. The id
   * stays, for the orders that will point to it.
   */
  async deleteAccount(password: string): Promise<void> {
    const customerId = customerOf();
    const [row] = await this.transactions.run((em) =>
      em.execute<{ passwordHash: string }[]>(
        `select password_hash as "passwordHash" from customers where id = ? and status = 'ACTIVE'`,
        [customerId],
      ),
    );
    if (!(await verifyPassword(row?.passwordHash ?? null, password)))
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        "PASSWORD_MISMATCH",
        "The password does not match.",
      );
    await this.transactions.run(async (em) => {
      const [changed] = await em.execute<{ id: string }[]>(
        `update customers
            set status = 'DELETED', name = null, email = null, phone = null,
                password_hash = null, deleted_at = now(), updated_at = now()
          where id = ? and status = 'ACTIVE' and password_hash = ?
          returning id`,
        [customerId, row!.passwordHash],
      );
      if (!changed) throw invalidCustomerSession();
      await em.execute("delete from customer_addresses where customer_id = ?", [
        customerId,
      ]);
      await revoke(em, "s.customer_id = ?", [customerId], "ACCOUNT_DELETED");
    });
  }

  private async startSession(
    em: EntityManager,
    customerId: string,
  ): Promise<CustomerTokens> {
    const sessionId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const [row] = await em.execute<{ expiresAt: Date }[]>(
      `insert into customer_sessions (id, tenant_id, customer_id, refresh_token_hash, expires_at)
       values (?, current_setting('app.tenant_id')::uuid, ?, ?, now() + make_interval(secs => ?))
       returning expires_at as "expiresAt"`,
      [sessionId, customerId, sha256(secret), CUSTOMER_SESSION_TTL_MS / 1000],
    );
    return this.issue(customerId, sessionId, secret, row!.expiresAt);
  }

  private issue(
    customerId: string,
    sessionId: string,
    secret: string,
    expiresAt: Date,
  ): CustomerTokens {
    const { token, expiresIn } = this.tokens.issueCustomer({
      sub: customerId,
      typ: "customer",
      tid: currentTenantContext().tenantId,
      sid: sessionId,
    });
    return {
      accessToken: token,
      tokenType: "Bearer",
      expiresIn,
      refreshToken: `${sessionId}.${secret}`,
      refreshExpiresAt: new Date(expiresAt).toISOString(),
    };
  }
}

/** The signed-in customer of a `@CustomerRoute()`. */
export function customerOf(): string {
  const { actor } = currentTenantContext();
  if (actor.type !== "customer") throw new Error("customer route required");
  return actor.customerId;
}

async function revoke(
  em: EntityManager,
  where: string,
  params: unknown[],
  reason: CustomerRevokedReason,
): Promise<void> {
  await em.execute(
    `update customer_sessions s set revoked_at = now(), revoked_reason = ?
      where ${where} and s.revoked_at is null`,
    [reason, ...params],
  );
}
