import { createHash, createHmac, randomBytes } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { API_CONFIG, type ApiConfig } from "../config/config";
import { ApiError } from "../errors/api-error";
import { passwordProblem, hashPassword } from "../auth/password";
import {
  BILLING_PERIOD,
  type BillingReport,
  buildBillingReport,
  planPeriodOf,
  type ReportEntry,
  reportMonth,
} from "../billing/billing-report";
import {
  type LegalDocumentKind,
  legalDocumentProblems,
} from "@whiteoven/contracts";

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
  if (code === "P0005")
    return new ApiError(
      HttpStatus.CONFLICT,
      "PLAN_REQUIRED",
      "The tenant needs a current plan before it can be active.",
    );
  if (code === "P0006" || code === "23P01")
    return new ApiError(
      HttpStatus.CONFLICT,
      "PLAN_SCHEDULE_CONFLICT",
      "The tenant's plan periods need review before changing the plan.",
    );
  if (code === "P0008")
    return new ApiError(
      HttpStatus.NOT_FOUND,
      "BILLING_ENTRY_NOT_FOUND",
      "Billing entry not found.",
    );
  if (code === "P0009")
    return new ApiError(
      HttpStatus.CONFLICT,
      "BILLING_ENTRY_SNAPSHOT_INCOMPLETE",
      "This billing entry has no plan snapshot and cannot be reversed.",
    );
  if (code === "P0010")
    return new ApiError(
      HttpStatus.CONFLICT,
      "LEGAL_VERSION_CONFLICT",
      "This version was already published with another text. Publish it under a new version.",
    );
  if (code === "22023") return invalid();
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
export const PLAN_CODES = ["FLEX", "PRO"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export interface TenantPlanRef {
  code: PlanCode;
  validFrom: Date;
}
export interface TenantSummary {
  id: string;
  slug: string;
  displayName: string;
  status: string;
  createdAt: Date;
  /** IANA time zone of the store; plan periods start at its local midnight. */
  timeZone: string;
  /** Current plan; null only before the first subscription. */
  plan: TenantPlanRef | null;
  /** Plan that replaces the current one at `validFrom` (next calendar month). */
  scheduledPlan: TenantPlanRef | null;
}
export interface Plan {
  code: PlanCode;
  feeBasisPoints: number;
  monthlyFeeCents: number;
}
export interface PlanSubscription extends Plan {
  id: string;
  validFrom: Date;
  validTo: Date | null;
  createdAt: Date;
}
export interface PlanChange {
  subscriptionId: string;
  plan: PlanCode;
  validFrom: Date;
  /** False when the requested plan was already current or scheduled. */
  changed: boolean;
}

export interface PublishedLegalDocument {
  id: string;
  kind: LegalDocumentKind;
  version: string;
  /** 1, 2, … per store and kind; the highest is the current text. */
  revision: number;
  publishedAt: Date;
}
export interface LegalDocumentVersion extends PublishedLegalDocument {
  body: string;
}

export const REVERSAL_REASONS = [
  "COMPLETED_BY_MISTAKE",
  "SALE_UNDONE",
] as const;
export type ReversalReason = (typeof REVERSAL_REASONS)[number];

export interface BillingEntry {
  id: string;
  type:
    "ORDER_COMPLETED" | "ORDER_REVERSED" | "SUBSCRIPTION_PERIOD" | "ADJUSTMENT";
  orderId: string | null;
  orderNumber: number | null;
  plan: PlanCode | null;
  feeBasisPoints: number | null;
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  paymentMethod: string;
  paidOnline: boolean;
  occurredAt: Date;
  /** `YYYY-MM` in the store's time zone. */
  period: string;
  reversesEntryId: string | null;
  reasonCode: ReversalReason | null;
  /** Set on a completed order's entry once an operator reversed it. */
  reversedByEntryId: string | null;
}

@Injectable()
export class PlatformService {
  private readonly inviteKey: Buffer;

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    // Invitation tokens have an independent key lifecycle from access-token signing. In
    // production config validation requires the stable secret; ephemeral fallback is local/test only.
    this.inviteKey = config.auth.ownerInviteSecret ?? randomBytes(32);
  }

  async listTenants(
    actorId: string,
    sessionId: string,
  ): Promise<TenantSummary[]> {
    // One transaction: the open-period function sets the tenant context per tenant locally.
    return this.orm.em.fork().transactional(async (em) => {
      const tenants = await em.execute<
        Omit<TenantSummary, "plan" | "scheduledPlan">[]
      >(
        'select id, slug, display_name as "displayName", status, created_at as "createdAt", timezone as "timeZone" from whiteoven_platform_tenants(?, ?)',
        [actorId, sessionId],
      );
      const periods = await em.execute<
        { tenantId: string; plan: PlanCode; validFrom: Date }[]
      >(
        'select tenant_id as "tenantId", plan, valid_from as "validFrom" from whiteoven_platform_open_plan_subscriptions(?, ?) order by valid_from',
        [actorId, sessionId],
      );
      const now = Date.now();
      return tenants.map((tenant) => {
        const own = periods.filter((p) => p.tenantId === tenant.id);
        const ref = (p: (typeof own)[number] | undefined) =>
          p ? { code: p.plan, validFrom: p.validFrom } : null;
        return {
          ...tenant,
          plan: ref(own.find((p) => new Date(p.validFrom).getTime() <= now)),
          scheduledPlan: ref(
            own.find((p) => new Date(p.validFrom).getTime() > now),
          ),
        };
      });
    });
  }

  /** Every published version of a store's legal documents, newest revision first per kind. */
  async listLegalDocuments(
    tenantId: string,
    actorId: string,
    sessionId: string,
  ): Promise<LegalDocumentVersion[]> {
    if (!uuidFormat.test(tenantId)) throw invalid();
    try {
      return await this.orm.em.fork().transactional((em) =>
        em.execute<LegalDocumentVersion[]>(
          `select id, kind, version, revision, body, published_at as "publishedAt"
             from whiteoven_platform_legal_documents(?, ?, ?)`,
          [tenantId, actorId, sessionId],
        ),
      );
    } catch (error) {
      throw mapPlatformError(error);
    }
  }

  /**
   * Publishes the text the store's counsel approved as the new current version (ADR 0030).
   * Repeating a publication with the same version and text changes nothing.
   */
  async publishLegalDocument(
    tenantId: string,
    input: { kind: unknown; version: unknown; body: unknown },
    actorId: string,
    sessionId: string,
    requestId: string,
    ip: string,
  ): Promise<PublishedLegalDocument & { changed: boolean }> {
    if (!uuidFormat.test(tenantId) || legalDocumentProblems(input).length)
      throw invalid();
    let row: (PublishedLegalDocument & { changed: boolean }) | undefined;
    try {
      [row] = await this.orm.em.fork().transactional((em) =>
        em.execute<(PublishedLegalDocument & { changed: boolean })[]>(
          `select id, kind, version, revision, published_at as "publishedAt", changed
               from whiteoven_publish_legal_document(?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tenantId,
            input.kind,
            input.version,
            input.body,
            actorId,
            sessionId,
            this.ipHash(ip),
            this.requestUuid(requestId),
          ],
        ),
      );
    } catch (error) {
      throw mapPlatformError(error);
    }
    if (!row) throw new Error("legal publication returned no row");
    return row;
  }

  async listPlans(actorId: string, sessionId: string): Promise<Plan[]> {
    return this.orm.em
      .fork()
      .execute<Plan[]>(
        'select code, fee_basis_points as "feeBasisPoints", monthly_fee_cents as "monthlyFeeCents" from whiteoven_platform_plans(?, ?)',
        [actorId, sessionId],
      );
  }

  async listPlanSubscriptions(
    tenantId: string,
    actorId: string,
    sessionId: string,
  ): Promise<PlanSubscription[]> {
    if (!uuidFormat.test(tenantId)) throw invalid();
    try {
      return await this.orm.em.fork().transactional((em) =>
        em.execute<PlanSubscription[]>(
          `select id, plan as code, fee_basis_points as "feeBasisPoints", monthly_fee_cents as "monthlyFeeCents",
                    valid_from as "validFrom", valid_to as "validTo", created_at as "createdAt"
               from whiteoven_platform_plan_subscriptions(?, ?, ?)`,
          [tenantId, actorId, sessionId],
        ),
      );
    } catch (error) {
      throw mapPlatformError(error);
    }
  }

  async changeTenantPlan(
    tenantId: string,
    plan: string,
    actorId: string,
    sessionId: string,
    requestId: string,
    ip: string,
  ): Promise<PlanChange> {
    if (
      !uuidFormat.test(tenantId) ||
      !(PLAN_CODES as readonly string[]).includes(plan)
    )
      throw invalid();
    let row: PlanChange | undefined;
    try {
      [row] = await this.orm.em
        .fork()
        .transactional((em) =>
          em.execute<PlanChange[]>(
            'select id as "subscriptionId", plan, valid_from as "validFrom", changed from whiteoven_change_tenant_plan(?, ?, ?, ?, ?, ?)',
            [
              tenantId,
              plan,
              actorId,
              sessionId,
              this.ipHash(ip),
              this.requestUuid(requestId),
            ],
          ),
        );
    } catch (error) {
      throw mapPlatformError(error);
    }
    if (!row) throw new Error("plan change returned no row");
    return row;
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

  async listBillingEntries(
    tenantId: string,
    period: string | undefined,
    actorId: string,
    sessionId: string,
  ): Promise<BillingEntry[]> {
    if (
      !uuidFormat.test(tenantId) ||
      (period !== undefined && !BILLING_PERIOD.test(period))
    )
      throw invalid();
    try {
      return await this.orm.em.fork().transactional((em) =>
        em.execute<BillingEntry[]>(
          `select id, type, order_id as "orderId", order_number as "orderNumber", plan,
                  fee_basis_points as "feeBasisPoints", items_subtotal_cents as "itemsSubtotalCents",
                  delivery_fee_cents as "deliveryFeeCents", total_cents as "totalCents",
                  payment_method as "paymentMethod", paid_online as "paidOnline", occurred_at as "occurredAt",
                  period, reverses_entry_id as "reversesEntryId", reason_code as "reasonCode",
                  reversed_by_entry_id as "reversedByEntryId"
             from whiteoven_platform_billing_entries(?, ?, ?, ?)`,
          [tenantId, period ?? null, actorId, sessionId],
        ),
      );
    } catch (error) {
      throw mapPlatformError(error);
    }
  }

  /** The tenant's billing estimate for one month (ADR 0026), from its ledger and plan periods. */
  async billingReport(
    tenantId: string,
    period: string | undefined,
    actorId: string,
    sessionId: string,
  ): Promise<BillingReport> {
    if (
      !uuidFormat.test(tenantId) ||
      (period !== undefined && !BILLING_PERIOD.test(period))
    )
      throw invalid();
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const execute = <T>(query: string, params: unknown[]) =>
          em.execute<T[]>(query, params);
        // Checks the operator's MFA session and the tenant before reading anything else.
        const periods = await em.execute<Parameters<typeof planPeriodOf>[0][]>(
          `select plan, fee_basis_points as "feeBasisPoints", monthly_fee_cents as "monthlyFeeCents",
                  valid_from as "validFrom", valid_to as "validTo"
             from whiteoven_platform_plan_subscriptions(?, ?, ?)`,
          [tenantId, actorId, sessionId],
        );
        const [tenant] = await em.execute<{ timezone: string }[]>(
          "select timezone from whiteoven_platform_tenants(?, ?) where id = ?",
          [actorId, sessionId, tenantId],
        );
        if (!tenant)
          throw new ApiError(
            HttpStatus.NOT_FOUND,
            "TENANT_NOT_FOUND",
            "Tenant not found.",
          );
        const month = await reportMonth(execute, tenant.timezone, period);
        const entries = await em.execute<ReportEntry[]>(
          `select type, plan, fee_basis_points as "feeBasisPoints", items_subtotal_cents as "itemsSubtotalCents",
                  delivery_fee_cents as "deliveryFeeCents", total_cents as "totalCents"
             from whiteoven_platform_billing_entries(?, ?, ?, ?)`,
          [tenantId, month.period, actorId, sessionId],
        );
        return buildBillingReport({
          ...month,
          timeZone: tenant.timezone,
          entries,
          planPeriods: periods.map(planPeriodOf),
        });
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw mapPlatformError(error);
    }
  }

  async reverseBillingEntry(
    tenantId: string,
    entryId: string,
    reasonCode: string,
    actorId: string,
    sessionId: string,
    requestId: string,
    ip: string,
  ): Promise<{ entryId: string; changed: boolean }> {
    if (
      !uuidFormat.test(tenantId) ||
      !uuidFormat.test(entryId) ||
      !(REVERSAL_REASONS as readonly string[]).includes(reasonCode)
    )
      throw invalid();
    let row: { entryId: string; changed: boolean } | undefined;
    try {
      [row] = await this.orm.em
        .fork()
        .transactional((em) =>
          em.execute<{ entryId: string; changed: boolean }[]>(
            'select id as "entryId", changed from whiteoven_reverse_billing_entry(?, ?, ?, ?, ?, ?, ?)',
            [
              tenantId,
              entryId,
              reasonCode,
              actorId,
              sessionId,
              this.ipHash(ip),
              this.requestUuid(requestId),
            ],
          ),
        );
    } catch (error) {
      throw mapPlatformError(error);
    }
    if (!row) throw new Error("billing reversal returned no row");
    return row;
  }

  private ipHash(ip: string): Buffer | null {
    return ip ? createHash("sha256").update(ip).digest() : null;
  }

  private requestUuid(requestId: string): string | null {
    return uuidFormat.test(requestId) ? requestId : null;
  }
}
