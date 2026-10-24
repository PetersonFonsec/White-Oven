import { createHash, createHmac, randomBytes } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { API_CONFIG, type ApiConfig } from "../config/config";
import { ApiError } from "../errors/api-error";
import { passwordProblem, hashPassword } from "../auth/password";

const slugFormat = /^[a-z0-9-]{3,40}$/;
const emailFormat = /^[^\s@]{1,64}@[a-z0-9.-]{1,189}\.[a-z]{2,}$/i;
const uuidFormat =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () =>
  new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "VALIDATION_FAILED",
    "Invalid request body.",
  );

function mapPlatformError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "42501")
    return new ApiError(
      HttpStatus.FORBIDDEN,
      "MFA_REQUIRED",
      "An active operator MFA session is required.",
    );
  if (code === "P0002")
    return new ApiError(
      HttpStatus.NOT_FOUND,
      "TENANT_NOT_FOUND",
      "Tenant not found.",
    );
  if (code === "P0004")
    return new ApiError(
      HttpStatus.CONFLICT,
      "TENANT_STATUS_CONFLICT",
      "Tenant status cannot be changed.",
    );
  if (code === "P0003")
    return new ApiError(
      HttpStatus.CONFLICT,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key was used for a different request.",
    );
  if (code === "23505")
    return new ApiError(
      HttpStatus.CONFLICT,
      "RESOURCE_CONFLICT",
      "The requested resource already exists.",
    );
  return error;
}

export interface NewTenantInput {
  slug: string;
  displayName: string;
  ownerEmail: string;
  idempotencyKey: string;
}
export interface TenantSummary {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  createdAt: Date;
}

@Injectable()
export class PlatformService {
  private readonly inviteKey: Buffer;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    const signingKey = config.auth.accessTokenPrivateKey?.export({
      type: "pkcs8",
      format: "der",
    });
    this.inviteKey = signingKey
      ? createHash("sha256")
          .update("whiteoven-owner-invite-key-v1")
          .update(signingKey)
          .digest()
      : randomBytes(32);
  }

  async listTenants(
    actorId: string,
    sessionId: string,
  ): Promise<TenantSummary[]> {
    return this.orm.em
      .fork()
      .execute<TenantSummary[]>(
        'select id, slug, display_name as "displayName", status, created_at as "createdAt" from whiteoven_platform_tenants(?, ?)',
        [actorId, sessionId],
      );
  }

  async createTenant(
    input: NewTenantInput,
    actorId: string,
    sessionId: string,
    requestId: string,
    ip: string,
  ): Promise<{ tenantId: string; inviteUrl: string; expiresIn: number }> {
    const slug = input.slug.trim();
    const displayName = input.displayName.trim();
    const email = input.ownerEmail.trim().toLowerCase();
    if (
      !slugFormat.test(slug) ||
      displayName.length < 1 ||
      displayName.length > 80 ||
      !emailFormat.test(email) ||
      !/^[A-Za-z0-9._~-]{8,128}$/.test(input.idempotencyKey)
    )
      throw invalid();
    const origin = this.config.auth.adminOrigins[0];
    if (!origin)
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        "ADMIN_ORIGIN_NOT_CONFIGURED",
        "Owner invitation is unavailable.",
      );
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ slug, displayName, email }))
      .digest();
    const token = createHmac("sha256", this.inviteKey)
      .update(input.idempotencyKey)
      .update(requestHash)
      .digest("base64url");
    let row: { tenantId: string; inviteId: string } | undefined;
    try {
      [row] = await this.orm.em
        .fork()
        .execute<{ tenantId: string; inviteId: string }[]>(
          'select tenant_id as "tenantId", invite_id as "inviteId" from whiteoven_create_tenant(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            slug,
            displayName,
            email,
            createHash("sha256").update(token).digest(),
            actorId,
            sessionId,
            this.ipHash(ip),
            this.requestUuid(requestId),
            createHash("sha256").update(input.idempotencyKey).digest(),
            requestHash,
          ],
        );
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "42501") throw mapPlatformError(error);
      if (code === "P0003") throw mapPlatformError(error);
      if (code === "23505")
        throw new ApiError(
          HttpStatus.CONFLICT,
          "TENANT_SLUG_TAKEN",
          "Tenant slug is already in use.",
        );
      throw error;
    }
    if (!row) throw new Error("tenant creation returned no row");
    return {
      tenantId: row.tenantId,
      inviteUrl: `${origin}/invite/${token}`,
      expiresIn: 72 * 60 * 60,
    };
  }

  async changeTenantStatus(
    tenantId: string,
    status: "ACTIVE" | "SUSPENDED",
    actorId: string,
    sessionId: string,
    requestId: string,
    ip: string,
  ): Promise<void> {
    if (!uuidFormat.test(tenantId)) throw invalid();
    try {
      await this.orm.em
        .fork()
        .execute("select whiteoven_change_tenant_status(?, ?, ?, ?, ?, ?)", [
          tenantId,
          status,
          actorId,
          sessionId,
          this.ipHash(ip),
          this.requestUuid(requestId),
        ]);
    } catch (error) {
      throw mapPlatformError(error);
    }
  }

  async resetOperatorMfa(
    targetId: string,
    actorId: string,
    sessionId: string,
    requestId: string,
    ip: string,
  ): Promise<void> {
    if (!uuidFormat.test(targetId)) throw invalid();
    let row: { reset: boolean } | undefined;
    try {
      [row] = await this.orm.em
        .fork()
        .execute<{ reset: boolean }[]>(
          'select whiteoven_reset_operator_mfa(?, ?, ?, ?, ?) as "reset"',
          [
            targetId,
            actorId,
            sessionId,
            this.ipHash(ip),
            this.requestUuid(requestId),
          ],
        );
    } catch (error) {
      throw mapPlatformError(error);
    }
    if (!row?.reset)
      throw new ApiError(
        HttpStatus.NOT_FOUND,
        "OPERATOR_NOT_FOUND",
        "Operator not found.",
      );
  }

  async redeemOwnerInvite(
    token: string,
    name: string,
    password: string,
    requestId: string,
  ): Promise<{ staffUserId: string; tenantId: string }> {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      name.trim().length < 1 ||
      name.trim().length > 120 ||
      password.length > 256 ||
      passwordProblem(password)
    )
      throw invalid();
    const passwordHash = await hashPassword(password);
    let row: { staffUserId: string; tenantId: string } | undefined;
    try {
      [row] = await this.orm.em
        .fork()
        .transactional((em) =>
          em.execute<{ staffUserId: string; tenantId: string }[]>(
            'select staff_user_id as "staffUserId", tenant_id as "tenantId" from whiteoven_redeem_owner_invite(?, ?, ?, ?)',
            [
              createHash("sha256").update(token).digest(),
              name.trim(),
              passwordHash,
              this.requestUuid(requestId),
            ],
          ),
        );
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "23505")
        throw new ApiError(
          HttpStatus.CONFLICT,
          "OWNER_ACCOUNT_EXISTS",
          "An account already uses this e-mail address.",
        );
      throw error;
    }
    if (!row)
      throw new ApiError(
        HttpStatus.GONE,
        "INVITE_INVALID",
        "Invitation is invalid or expired.",
      );
    return row;
  }

  private ipHash(ip: string): Buffer | null {
    return ip ? createHash("sha256").update(ip).digest() : null;
  }

  private requestUuid(requestId: string): string | null {
    return uuidFormat.test(requestId) ? requestId : null;
  }
}
