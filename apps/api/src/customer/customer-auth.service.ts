import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import { AccessTokens } from "../auth/access-token";
import { hashPassword, verifyPassword } from "../auth/password";
import { ApiError } from "../errors/api-error";
import { currentTenantContext } from "../tenancy/tenant-context";
import {
  TenantTransactions,
  lockCustomer,
} from "../tenancy/tenant-transaction";
import { CustomerLoginThrottle } from "./customer-login-throttle";
import type { LegalVersions, Registration } from "./customer-rules";
import { currentLegalDocuments } from "../legal/legal-documents.service";

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
  /** The terms of use version last accepted; null for accounts created before M7.2. */
  termsOfUseVersion: string | null;
  /**
   * The store published a privacy policy or terms version this customer has not accepted yet
   * (ADR 0030). The app shows the new text and records the acceptance.
   */
  legalUpdateRequired: boolean;
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

const legalUnavailable = () =>
  new ApiError(
    HttpStatus.CONFLICT,
    "LEGAL_DOCUMENTS_UNAVAILABLE",
    "This store has not published its privacy policy and terms of use yet.",
  );

export const invalidCustomerSession = () =>
  new ApiError(
    HttpStatus.UNAUTHORIZED,
    "SESSION_INVALID",
    "Session expired or revoked. Sign in again.",
  );

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
    @Inject(CUSTOMER_LOGIN_THROTTLE)
    private readonly throttle: CustomerLoginThrottle,
  ) {}

  loginRetryAfterSeconds(email: string, ip: string): number {
    return Math.ceil(this.throttle.retryAfterMs(tenantOf(), email, ip) / 1000);
  }

  /** Creates the account and signs it in. The e-mail and phone are unique in this store only. */
  async register(registration: Registration): Promise<CustomerTokens> {
    const passwordHash = await hashPassword(registration.password);
    try {
      return await this.transactions.run(async (em) => {
        const documents = await acceptedDocuments(em, registration);
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
        await recordAcceptances(em, row!.id, documents);
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
      this.throttle.recordFailure(tenantOf(), email, ip);
      throw invalidCustomerCredentials();
    }
    // The password was checked without any lock held. The session is created only if the
    // account is still the one that was checked: ACTIVE with the same password hash, read under
    // the customer lock that deleteAccount takes too. A deletion that won the race leaves
    // nothing to sign in to (the same 401 as a wrong password); one that comes after revokes
    // this session with the others.
    const tokens = await this.transactions.run(async (em) => {
      await lockCustomer(em, customer.id);
      const [still] = await em.execute(
        `select 1 from customers where id = ? and status = 'ACTIVE' and password_hash = ?
           for share`,
        [customer.id, customer.passwordHash],
      );
      return still ? this.startSession(em, customer.id) : null;
    });
    if (!tokens) {
      this.throttle.recordFailure(tenantOf(), email, ip);
      throw invalidCustomerCredentials();
    }
    this.throttle.recordSuccess(tenantOf(), email);
    return tokens;
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
        `select c.id, c.name, c.email, c.phone, c.privacy_policy_version as "privacyPolicyVersion",
                c.accepted_at as "acceptedAt",
                (select d.version from customer_legal_acceptances a
                   join legal_documents d on d.tenant_id = a.tenant_id and d.id = a.document_id
                  where a.customer_id = c.id and d.kind = 'TERMS_OF_USE'
                  order by d.revision desc limit 1) as "termsOfUseVersion",
                exists (
                  select 1 from (
                    select distinct on (d.kind) d.id from legal_documents d
                     order by d.kind, d.revision desc) cur
                   where not exists (select 1 from customer_legal_acceptances a
                                      where a.customer_id = c.id and a.document_id = cur.id)
                ) as "legalUpdateRequired"
           from customers c where c.id = ?`,
        [customerOf()],
      );
      return { ...row!, acceptedAt: new Date(row!.acceptedAt).toISOString() };
    });
  }

  /**
   * Deletes the account (domain model: exclusion anonymizes, see `erase`). Asks for the password
   * again, so a stolen access token alone cannot delete an account.
   */
  /**
   * Records that the signed-in customer accepted the store's current privacy policy and terms
   * (ADR 0030). Both versions must be the current ones, as at sign-up; accepting a document
   * already accepted is a no-op, so a retry is safe.
   */
  async acceptLegalDocuments(versions: LegalVersions): Promise<void> {
    const customerId = customerOf();
    await this.transactions.run(
      async (em) => {
        const documents = await acceptedDocuments(em, versions);
        await recordAcceptances(em, customerId, documents);
        await em.execute(
          `update customers set privacy_policy_version = ?, accepted_at = now(), updated_at = now()
            where id = ? and status = 'ACTIVE'`,
          [versions.privacyPolicyVersion, customerId],
        );
      },
      { lockCustomer: true },
    );
  }

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
    // `lockCustomer` serializes this with address creation, sign-ins and another deletion of the
    // same account; the Argon2id check above ran without it.
    await this.transactions.run(
      async (em) => {
        if (!(await erase(em, customerId, row!.passwordHash)))
          throw invalidCustomerSession();
      },
      { lockCustomer: true },
    );
  }

  /**
   * The same deletion, outside the app (ADR 0030, the web page Google Play requires): the e-mail
   * and password identify the account, with the sign-in throttle and the same answer for an
   * unknown e-mail and a wrong password, so the page reveals no account.
   */
  async deleteAccountWithCredentials(
    email: string,
    password: string,
    ip: string,
  ): Promise<void> {
    const [customer] = await this.transactions.run((em) =>
      em.execute<{ id: string; passwordHash: string }[]>(
        `select id, password_hash as "passwordHash" from customers
          where email = ? and status = 'ACTIVE'`,
        [email],
      ),
    );
    const ok = await verifyPassword(customer?.passwordHash ?? null, password);
    const erased =
      customer &&
      ok &&
      (await this.transactions.run(async (em) => {
        await lockCustomer(em, customer.id);
        return erase(em, customer.id, customer.passwordHash);
      }));
    if (!erased) {
      this.throttle.recordFailure(tenantOf(), email, ip);
      throw invalidCustomerCredentials();
    }
    this.throttle.recordSuccess(tenantOf(), email);
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

/** The store of the request: from the slug, never from the body. */
const tenantOf = () => currentTenantContext().tenantId;

/** The signed-in customer of a `@CustomerRoute()`. */
export function customerOf(): string {
  const { actor } = currentTenantContext();
  if (actor.type !== "customer") throw new Error("customer route required");
  return actor.customerId;
}

/**
 * Anonymizes one account, under the customer lock, only if it is still ACTIVE with the password
 * hash that was checked. In one transaction: name, e-mail, phone and password become null, the
 * addresses are deleted, the orders lose the name, phone, address and notes they copied (M4.3),
 * push devices are deleted and every session is revoked. The id stays, for those orders, and so
 * do the legal acceptances, which hold no personal data (ADR 0030).
 */
async function erase(
  em: EntityManager,
  customerId: string,
  passwordHash: string,
): Promise<boolean> {
  const [changed] = await em.execute<{ id: string }[]>(
    `update customers
        set status = 'DELETED', name = null, email = null, phone = null,
            password_hash = null, deleted_at = now(), updated_at = now()
      where id = ? and status = 'ACTIVE' and password_hash = ?
      returning id`,
    [customerId, passwordHash],
  );
  if (!changed) return false;
  await em.execute("delete from customer_addresses where customer_id = ?", [
    customerId,
  ]);
  await em.execute("delete from customer_push_devices where customer_id = ?", [
    customerId,
  ]);
  // Orders keep items and totals for the store, without the customer's personal data.
  await em.execute(
    `update orders
        set customer_name = null, customer_phone = null, delivery_address = null,
            notes = null, anonymized_at = now(), updated_at = now()
      where customer_id = ? and anonymized_at is null`,
    [customerId],
  );
  await revoke(em, "s.customer_id = ?", [customerId], "ACCOUNT_DELETED");
  return true;
}

/**
 * The store's current documents, if the versions the customer was shown are exactly them. A
 * publication between showing and accepting answers 409 `LEGAL_VERSION_OUTDATED` with the
 * current versions, so the app shows the new text instead of recording an acceptance of text
 * the customer never saw.
 */
async function acceptedDocuments(
  em: EntityManager,
  versions: LegalVersions,
): Promise<string[]> {
  const current = await currentLegalDocuments(em);
  if (!current.privacyPolicy || !current.termsOfUse) throw legalUnavailable();
  if (
    current.privacyPolicy.version !== versions.privacyPolicyVersion ||
    current.termsOfUse.version !== versions.termsOfUseVersion
  )
    throw new ApiError(
      HttpStatus.CONFLICT,
      "LEGAL_VERSION_OUTDATED",
      "The privacy policy or the terms of use changed. Read the current version.",
      {
        privacyPolicyVersion: current.privacyPolicy.version,
        termsOfUseVersion: current.termsOfUse.version,
      },
    );
  return [current.privacyPolicy.id, current.termsOfUse.id];
}

async function recordAcceptances(
  em: EntityManager,
  customerId: string,
  documentIds: string[],
): Promise<void> {
  for (const documentId of documentIds)
    await em.execute(
      `insert into customer_legal_acceptances (tenant_id, customer_id, document_id)
       values (current_setting('app.tenant_id')::uuid, ?, ?)
       on conflict (tenant_id, customer_id, document_id) do nothing`,
      [customerId, documentId],
    );
}

async function revoke(
  em: EntityManager,
  where: string,
  params: unknown[],
  reason: CustomerRevokedReason,
): Promise<void> {
  const revoked = await em.execute<{ id: string }[]>(
    `update customer_sessions s set revoked_at = now(), revoked_reason = ?
      where ${where} and s.revoked_at is null
      returning s.id`,
    [reason, ...params],
  );
  // A device stops receiving order notifications with the session that registered it (ADR 0027).
  if (revoked.length)
    await em.execute(
      "delete from customer_push_devices where session_id = any(?::uuid[])",
      [`{${revoked.map((row) => row.id).join(",")}}`],
    );
}
