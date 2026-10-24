import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { API_CONFIG, type ApiConfig } from "../config/config";
import { ApiError, ApiErrorBody } from "../errors/api-error";
import { PublicRoute } from "./route-access";
import { PASSWORD_MAX_LENGTH } from "./password";
import {
  type IssuedTokens,
  StaffAuth,
  type TenantChoice,
} from "./staff-auth.service";
import {
  AdminRoute,
  CurrentStaff,
  StaffRoute,
  type StaffPrincipal,
} from "./staff.guard";

export const REFRESH_COOKIE = "__Secure-wo_staff_refresh";
export const REFRESH_COOKIE_PATH = "/v1/admin/auth";

export class StaffLoginBody {
  @ApiProperty({ example: "dona@pizzaria.com.br" })
  email!: string;
  @ApiProperty({
    format: "password",
    minLength: 1,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  password!: string;
}

export class ActiveTenantBody {
  @ApiProperty({ format: "uuid" })
  tenantId!: string;
}

export class AccessTokenBody {
  @ApiProperty()
  accessToken!: string;
  @ApiProperty({ enum: ["Bearer"] })
  tokenType!: "Bearer";
  @ApiProperty({ example: 900 })
  expiresIn!: number;
  @ApiPropertyOptional({ format: "uuid", nullable: true, type: String })
  activeTenantId!: string | null;
}

export class TenantChoiceBody {
  @ApiProperty({ format: "uuid" })
  tenantId!: string;
  @ApiProperty()
  slug!: string;
  @ApiProperty()
  displayName!: string;
  @ApiProperty({ enum: ["OWNER", "MANAGER", "STAFF"] })
  role!: string;
}

export class AdminMeBody {
  @ApiProperty({ format: "uuid" })
  staffUserId!: string;
  @ApiProperty({ format: "uuid" })
  tenantId!: string;
  @ApiProperty({ enum: ["OWNER", "MANAGER", "STAFF"] })
  role!: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Exact keys, string values; unknown fields are rejected (same rule as packages/contracts). */
function stringFields<K extends string>(
  body: unknown,
  keys: readonly K[],
): Record<K, string> {
  const fields: Record<string, string> = {};
  const issues: string[] = [];
  if (!plain(body)) issues.push("body");
  else {
    for (const key of Object.keys(body))
      if (!(keys as readonly string[]).includes(key)) issues.push(key);
    for (const key of keys) {
      const value = body[key];
      if (typeof value !== "string" || value.length === 0) issues.push(key);
      else fields[key] = value;
    }
  }
  if (issues.length > 0)
    throw new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      "VALIDATION_FAILED",
      "Invalid request body.",
      { fields: issues },
    );
  return fields as Record<K, string>;
}

/**
 * Staff authentication (M1.4, ADR 0007). The refresh token travels only in an HttpOnly, Secure,
 * SameSite=Strict cookie scoped to this path; the access token only in response bodies and the
 * Authorization header. Refresh and logout also check `Origin` against `API_ADMIN_ORIGINS`.
 */
@ApiTags("admin auth")
@Controller("admin/auth")
export class StaffAuthController {
  constructor(
    @Inject(StaffAuth) private readonly auth: StaffAuth,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post("login")
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sign in with e-mail and password" })
  @ApiBody({ type: StaffLoginBody })
  @ApiOkResponse({ type: AccessTokenBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody })
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenBody> {
    const fields = stringFields(body, ["email", "password"] as const);
    const email = fields.email.trim().toLowerCase();
    // Oversized passwords fail like wrong ones, after throttling, without being hashed.
    const ip = req.socket.remoteAddress ?? "unknown";
    const wait = this.auth.loginRetryAfterSeconds(email, ip);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        "Too many attempts. Try again later.",
      );
    }
    const password =
      fields.password.length <= PASSWORD_MAX_LENGTH * 4 ? fields.password : "";
    const issued = await this.auth.login(email, password, ip);
    return this.respond(res, issued);
  }

  @Post("refresh")
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Rotate the refresh cookie and get a new access token",
  })
  @ApiOkResponse({ type: AccessTokenBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenBody> {
    this.assertAllowedOrigin(req);
    try {
      return this.respond(res, await this.auth.refresh(refreshCookie(req)));
    } catch (error) {
      clearRefreshCookie(res);
      throw error;
    }
  }

  @Post("logout")
  @PublicRoute()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Revoke the session of the refresh cookie" })
  @ApiNoContentResponse()
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.assertAllowedOrigin(req);
    await this.auth.logout(refreshCookie(req));
    clearRefreshCookie(res);
  }

  @Get("tenants")
  @StaffRoute()
  @ApiOperation({ summary: "Stores the signed-in staff member can switch to" })
  @ApiOkResponse({ type: TenantChoiceBody, isArray: true })
  tenants(@CurrentStaff() staff: StaffPrincipal): Promise<TenantChoice[]> {
    return this.auth.tenantChoices(staff.access.staffUserId);
  }

  @Post("active-tenant")
  @StaffRoute()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Switch the active store; returns a token for it" })
  @ApiBody({ type: ActiveTenantBody })
  @ApiOkResponse({ type: AccessTokenBody })
  async activeTenant(
    @Body() body: unknown,
    @CurrentStaff() staff: StaffPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenBody> {
    const { tenantId } = stringFields(body, ["tenantId"] as const);
    const issued = await this.auth.switchTenant(
      staff.claims,
      UUID.test(tenantId) ? tenantId : "",
    );
    return this.respond(res, issued);
  }

  private respond(res: Response, issued: IssuedTokens): AccessTokenBody {
    if (issued.refreshToken)
      res.cookie(REFRESH_COOKIE, issued.refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: REFRESH_COOKIE_PATH,
      });
    res.setHeader("Cache-Control", "no-store");
    return toBody(issued);
  }

  /** CSRF defense in depth besides SameSite=Strict (system-overview.md, "Regras"). */
  private assertAllowedOrigin(req: Request): void {
    const origin = req.get("origin");
    if (origin !== undefined && !this.config.auth.adminOrigins.includes(origin))
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        "ORIGIN_NOT_ALLOWED",
        "Origin not allowed.",
      );
  }
}

/** First admin route: who am I in the active store. Panels use it after switching tenant. */
@ApiTags("admin")
@Controller("admin")
export class AdminMeController {
  @Get("me")
  @AdminRoute()
  @ApiOperation({
    summary: "Signed-in staff member and role in the active store",
  })
  @ApiOkResponse({ type: AdminMeBody })
  me(@CurrentStaff() staff: StaffPrincipal): AdminMeBody {
    // StaffGuard verified the ACTIVE membership in the token's tenant on this request.
    return {
      staffUserId: staff.access.staffUserId,
      tenantId: staff.access.tenantId!,
      role: staff.access.role!,
    };
  }
}

function toBody(issued: IssuedTokens): AccessTokenBody {
  return {
    accessToken: issued.accessToken,
    tokenType: "Bearer",
    expiresIn: issued.expiresIn,
    activeTenantId: issued.activeTenantId,
  };
}

function refreshCookie(req: Request): string | undefined {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === REFRESH_COOKIE)
      return part.slice(index + 1).trim();
  }
  return undefined;
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
  });
}
