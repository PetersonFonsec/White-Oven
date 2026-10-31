import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { ApiError } from "../errors/api-error";
import { clientIpOf } from "../security/http-security";
import { requestIdOf } from "../logging/request-context";
import { CurrentStaff, PlatformRoute } from "../auth/staff.guard";
import type { StaffPrincipal } from "../auth/staff.guard";
import { PublicRoute } from "../auth/route-access";
import { PlatformService } from "./platform.service";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

function fields(body: unknown, keys: readonly string[]): string[] {
  if (!isObject(body) || Object.keys(body).some((key) => !keys.includes(key)))
    throw bodyError();
  const values = keys.map((key) => body[key]);
  if (values.some((value) => typeof value !== "string" || value.length === 0))
    throw bodyError();
  return values as string[];
}

const bodyError = () =>
  new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "VALIDATION_FAILED",
    "Invalid request body.",
  );

class CreateTenantBody {
  @ApiProperty({ minLength: 3, maxLength: 40, example: "white-oven-centro" })
  slug!: string;
  @ApiProperty({ minLength: 1, maxLength: 80 }) displayName!: string;
  @ApiProperty({ format: "email" }) ownerEmail!: string;
}

class TenantStatusBody {
  @ApiProperty({ enum: ["ACTIVE", "SUSPENDED"] }) status!:
    "ACTIVE" | "SUSPENDED";
}

class TenantPlanBody {
  @ApiProperty({ enum: ["FLEX", "PRO"] }) plan!: "FLEX" | "PRO";
}

class BillingReversalBody {
  @ApiProperty({ enum: ["COMPLETED_BY_MISTAKE", "SALE_UNDONE"] }) reasonCode!:
    "COMPLETED_BY_MISTAKE" | "SALE_UNDONE";
}

class LegalDocumentBody {
  @ApiProperty({ enum: ["PRIVACY_POLICY", "TERMS_OF_USE"] }) kind!:
    "PRIVACY_POLICY" | "TERMS_OF_USE";
  @ApiProperty({
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$",
    example: "2026-11",
  })
  version!: string;
  @ApiProperty({
    maxLength: 100000,
    description:
      "Plain text: blocks separated by a blank line, `## ` headings, `- ` list items.",
  })
  body!: string;
}

class RedeemInviteBody {
  @ApiProperty({ minLength: 43, maxLength: 43 }) token!: string;
  @ApiProperty({ minLength: 1, maxLength: 120 }) name!: string;
  @ApiProperty({ format: "password", minLength: 10, maxLength: 256 })
  password!: string;
}

@ApiTags("platform")
@Controller("platform/tenants")
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  @PlatformRoute()
  @ApiOperation({ summary: "List tenants for platform operators" })
  list(@CurrentStaff() staff: StaffPrincipal) {
    return this.platform.listTenants(
      staff.access.staffUserId,
      staff.access.sessionId,
    );
  }

  @Post()
  @PlatformRoute()
  @ApiBody({ type: CreateTenantBody })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "8–128 ASCII characters; retries must reuse the same key and body.",
  })
  @ApiOperation({ summary: "Create an onboarding tenant and OWNER invitation" })
  create(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @CurrentStaff() staff: StaffPrincipal,
    @Req() req: Request,
  ) {
    const [slug, displayName, ownerEmail] = fields(body, [
      "slug",
      "displayName",
      "ownerEmail",
    ]);
    return this.platform.createTenant(
      {
        slug: slug!,
        displayName: displayName!,
        ownerEmail: ownerEmail!,
        idempotencyKey: idempotencyKey ?? "",
      },
      staff.access.staffUserId,
      staff.access.sessionId,
      requestIdOf(req),
      clientIpOf(req),
    );
  }

  @Patch(":tenantId/status")
  @PlatformRoute()
  @ApiBody({ type: TenantStatusBody })
  @ApiOperation({ summary: "Activate or suspend a tenant" })
  @HttpCode(HttpStatus.NO_CONTENT)
  async changeStatus(
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
    @CurrentStaff() staff: StaffPrincipal,
    @Req() req: Request,
  ): Promise<void> {
    const [status] = fields(body, ["status"]);
    if (status !== "ACTIVE" && status !== "SUSPENDED") throw bodyError();
    await this.platform.changeTenantStatus(
      tenantId,
      status,
      staff.access.staffUserId,
      staff.access.sessionId,
      requestIdOf(req),
      clientIpOf(req),
    );
  }

  @Get(":tenantId/plans")
  @PlatformRoute()
  @ApiOperation({ summary: "List a tenant's plan periods, newest first" })
  planHistory(
    @Param("tenantId") tenantId: string,
    @CurrentStaff() staff: StaffPrincipal,
  ) {
    return this.platform.listPlanSubscriptions(
      tenantId,
      staff.access.staffUserId,
      staff.access.sessionId,
    );
  }

  @Put(":tenantId/plan")
  @PlatformRoute()
  @ApiBody({ type: TenantPlanBody })
  @ApiOperation({
    summary:
      "Set a tenant's plan: starts now without a current plan, otherwise at the next calendar month",
  })
  changePlan(
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
    @CurrentStaff() staff: StaffPrincipal,
    @Req() req: Request,
  ) {
    const [plan] = fields(body, ["plan"]);
    return this.platform.changeTenantPlan(
      tenantId,
      plan!,
      staff.access.staffUserId,
      staff.access.sessionId,
      requestIdOf(req),
      clientIpOf(req),
    );
  }
}

@ApiTags("platform billing")
@Controller("platform/tenants/:tenantId")
export class PlatformBillingController {
  constructor(private readonly platform: PlatformService) {}

  @Get("billing-entries")
  @PlatformRoute()
  @ApiQuery({
    name: "period",
    required: false,
    description:
      "YYYY-MM in the store's time zone; defaults to the current month.",
  })
  @ApiOperation({ summary: "List one month of a tenant's billing ledger" })
  list(
    @Param("tenantId") tenantId: string,
    @Query() query: Record<string, unknown>,
    @CurrentStaff() staff: StaffPrincipal,
  ) {
    const keys = Object.keys(query);
    if (
      keys.some((key) => key !== "period") ||
      (query.period !== undefined && typeof query.period !== "string")
    )
      throw bodyError();
    return this.platform.listBillingEntries(
      tenantId,
      query.period as string | undefined,
      staff.access.staffUserId,
      staff.access.sessionId,
    );
  }

  @Get("billing-report")
  @PlatformRoute()
  @ApiQuery({
    name: "period",
    required: false,
    description:
      "YYYY-MM in the store's time zone; defaults to the current month.",
  })
  @ApiOperation({
    summary:
      "Monthly billing estimate of a tenant, built from its ledger (ADR 0026)",
  })
  report(
    @Param("tenantId") tenantId: string,
    @Query() query: Record<string, unknown>,
    @CurrentStaff() staff: StaffPrincipal,
  ) {
    const keys = Object.keys(query);
    if (
      keys.some((key) => key !== "period") ||
      (query.period !== undefined && typeof query.period !== "string")
    )
      throw bodyError();
    return this.platform.billingReport(
      tenantId,
      query.period as string | undefined,
      staff.access.staffUserId,
      staff.access.sessionId,
    );
  }

  @Post("billing-entries/:entryId/reversal")
  @PlatformRoute()
  @ApiBody({ type: BillingReversalBody })
  @ApiOperation({
    summary:
      "Reverse a completed order's billing entry; repeating it returns the existing reversal",
  })
  async reverse(
    @Param("tenantId") tenantId: string,
    @Param("entryId") entryId: string,
    @Body() body: unknown,
    @CurrentStaff() staff: StaffPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const [reasonCode] = fields(body, ["reasonCode"]);
    const result = await this.platform.reverseBillingEntry(
      tenantId,
      entryId,
      reasonCode!,
      staff.access.staffUserId,
      staff.access.sessionId,
      requestIdOf(req),
      clientIpOf(req),
    );
    res.status(result.changed ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }
}

@ApiTags("platform legal")
@Controller("platform/tenants/:tenantId/legal-documents")
export class PlatformLegalController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  @PlatformRoute()
  @ApiOperation({
    summary: "List every published version of a store's legal documents",
  })
  list(
    @Param("tenantId") tenantId: string,
    @CurrentStaff() staff: StaffPrincipal,
  ) {
    return this.platform.listLegalDocuments(
      tenantId,
      staff.access.staffUserId,
      staff.access.sessionId,
    );
  }

  @Post()
  @PlatformRoute()
  @ApiBody({ type: LegalDocumentBody })
  @ApiOperation({
    summary:
      "Publish a new current version of the store's privacy policy or terms (ADR 0030)",
    description:
      "201 for a new version; 200 when the same version and text already exist; 409 LEGAL_VERSION_CONFLICT when the version exists with another text.",
  })
  async publish(
    @Param("tenantId") tenantId: string,
    @Body() body: unknown,
    @CurrentStaff() staff: StaffPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const [kind, version, text] = fields(body, ["kind", "version", "body"]);
    const result = await this.platform.publishLegalDocument(
      tenantId,
      { kind, version, body: text },
      staff.access.staffUserId,
      staff.access.sessionId,
      requestIdOf(req),
      clientIpOf(req),
    );
    res.status(result.changed ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
  }
}

@ApiTags("platform plans")
@Controller("platform/plans")
export class PlatformPlanController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  @PlatformRoute()
  @ApiOperation({ summary: "List the plan catalog" })
  list(@CurrentStaff() staff: StaffPrincipal) {
    return this.platform.listPlans(
      staff.access.staffUserId,
      staff.access.sessionId,
    );
  }
}

@ApiTags("platform operators")
@Controller("platform/operators")
export class PlatformOperatorController {
  constructor(private readonly platform: PlatformService) {}

  @Post(":operatorId/mfa/reset")
  @PlatformRoute()
  @ApiOperation({
    summary: "Reset another operator's MFA and revoke their sessions",
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetOperatorMfa(
    @Param("operatorId") operatorId: string,
    @CurrentStaff() staff: StaffPrincipal,
    @Req() req: Request,
  ): Promise<void> {
    await this.platform.resetOperatorMfa(
      operatorId,
      staff.access.staffUserId,
      staff.access.sessionId,
      requestIdOf(req),
      clientIpOf(req),
    );
  }
}

@ApiTags("platform invites")
@Controller("platform/invites")
export class OwnerInviteController {
  constructor(private readonly platform: PlatformService) {}

  @Post("redeem")
  @PublicRoute()
  @ApiBody({ type: RedeemInviteBody })
  @ApiOperation({ summary: "Redeem a single-use OWNER invitation" })
  redeem(@Body() body: unknown, @Req() req: Request) {
    const [token, name, password] = fields(body, ["token", "name", "password"]);
    return this.platform.redeemOwnerInvite(
      token!,
      name!,
      password!,
      requestIdOf(req),
    );
  }
}
