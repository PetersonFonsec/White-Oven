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
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";
import { ApiError } from "../errors/api-error";
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
      req.ip ?? "",
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
      req.ip ?? "",
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
      req.ip ?? "",
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
