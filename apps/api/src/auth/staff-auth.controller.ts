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
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { API_CONFIG, type ApiConfig } from "../config/config";
import { ApiError, ApiErrorBody } from "../errors/api-error";
import { clientIpOf, ipLimitKey } from "../security/http-security";
import { RequestLimits, enforceLimit } from "../security/request-limits";
import { PublicRoute } from "./route-access";
import { PASSWORD_MAX_LENGTH } from "./password";
import {
  type IssuedTokens,
  type MfaChallenge,
  StaffAuth,
  type TenantChoice,
} from "./staff-auth.service";
import { type SecondFactor, StaffMfa } from "./staff-mfa.service";
import {
  AdminRoute,
  CurrentStaff,
  PlatformRoute,
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

export class MfaChallengeBody {
  @ApiProperty({ enum: [true] })
  mfaRequired!: true;
  @ApiProperty({
    description: "Single use; send it to POST /v1/admin/auth/login/mfa",
  })
  mfaToken!: string;
  @ApiProperty({ example: 300 })
  expiresIn!: number;
}

export class MfaLoginBody {
  @ApiProperty()
  mfaToken!: string;
  @ApiPropertyOptional({
    example: "123456",
    description: "TOTP code, or recoveryCode",
  })
  code?: string;
  @ApiPropertyOptional({ example: "abcde-fghij" })
  recoveryCode?: string;
}

export class MfaCodeBody {
  @ApiProperty({ example: "123456" })
  code!: string;
}

export class MfaSetupResponse {
  @ApiProperty({ description: "Base32 TOTP secret, shown once" })
  secret!: string;
  @ApiProperty({ example: "otpauth://totp/WhiteOven:..." })
  otpauthUri!: string;
}

export class MfaActivatedBody extends AccessTokenBody {
  @ApiProperty({ type: [String], description: "Single-use codes, shown once" })
  recoveryCodes!: string[];
}

export class PlatformMeBody {
  @ApiProperty({ format: "uuid" })
  staffUserId!: string;
  @ApiProperty({ enum: ["OPERATOR"] })
  platformRole!: "OPERATOR";
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
  @ApiProperty({
    format: "uuid",
    description: "Verified staff session identifier",
  })
  sessionId!: string;
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
@ApiExtraModels(AccessTokenBody, MfaChallengeBody)
@Controller("admin/auth")
export class StaffAuthController {
  constructor(
    @Inject(StaffAuth) private readonly auth: StaffAuth,
    @Inject(StaffMfa) private readonly mfa: StaffMfa,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(RequestLimits) private readonly limits: RequestLimits,
  ) {}

  @Post("login")
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sign in with e-mail and password" })
  @ApiBody({ type: StaffLoginBody })
  @ApiOkResponse({
    description:
      "Tokens, or an MFA challenge when the user has a second factor",
    schema: {
      oneOf: [
        { $ref: getSchemaPath(AccessTokenBody) },
        { $ref: getSchemaPath(MfaChallengeBody) },
      ],
    },
  })
  @ApiUnauthorizedResponse({ type: ApiErrorBody })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody })
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenBody | MfaChallengeBody> {
    const fields = stringFields(body, ["email", "password"] as const);
    const email = fields.email.trim().toLowerCase();
    const ip = clientIpOf(req);
    this.assertNotThrottled(email, ip, res);
    // Oversized passwords fail like wrong ones, after throttling, without being hashed.
    const password =
      fields.password.length <= PASSWORD_MAX_LENGTH * 4 ? fields.password : "";
    const result = await this.auth.login(email, password, ip);
    if ("mfaRequired" in result) {
      res.setHeader("Cache-Control", "no-store");
      return result satisfies MfaChallenge;
    }
    return this.respond(res, result);
  }

  @Post("login/mfa")
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Second login step: TOTP code or recovery code" })
  @ApiBody({ type: MfaLoginBody })
  @ApiOkResponse({ type: AccessTokenBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody })
  async loginMfa(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenBody> {
    const usesRecovery = plain(body) && Object.hasOwn(body, "recoveryCode");
    const fields = stringFields(
      body,
      usesRecovery
        ? (["mfaToken", "recoveryCode"] as const)
        : (["mfaToken", "code"] as const),
    ) as Record<string, string>;
    const factor: SecondFactor = usesRecovery
      ? { recoveryCode: fields.recoveryCode!.slice(0, 64) }
      : { code: fields.code!.slice(0, 16) };
    const ip = clientIpOf(req);
    this.assertNotThrottled(this.mfa.challengeEmail(fields.mfaToken!), ip, res);
    return this.respond(
      res,
      await this.mfa.completeLogin(fields.mfaToken!, factor, ip),
    );
  }

  @Post("mfa/setup")
  @StaffRoute({ allowWithoutMfa: true })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Start TOTP enrollment (new pending secret)" })
  @ApiOkResponse({ type: MfaSetupResponse })
  async mfaSetup(
    @CurrentStaff() staff: StaffPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MfaSetupResponse> {
    res.setHeader("Cache-Control", "no-store");
    return this.mfa.setup(staff.access.staffUserId);
  }

  @Post("mfa/activate")
  @StaffRoute({ allowWithoutMfa: true })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Confirm enrollment with a first code; returns recovery codes once",
  })
  @ApiBody({ type: MfaCodeBody })
  @ApiOkResponse({ type: MfaActivatedBody })
  async mfaActivate(
    @Body() body: unknown,
    @CurrentStaff() staff: StaffPrincipal,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MfaActivatedBody> {
    const { code } = stringFields(body, ["code"] as const);
    const { recoveryCodes, tokens } = await this.mfa.activate(
      staff.claims,
      code.slice(0, 16),
    );
    res.setHeader("Cache-Control", "no-store");
    return { ...toBody(tokens), recoveryCodes };
  }

  private assertNotThrottled(email: string, ip: string, res: Response): void {
    const wait = this.auth.loginRetryAfterSeconds(email, ip);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        "Too many attempts. Try again later.",
      );
    }
  }

  @Post("refresh")
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Rotate the refresh cookie and get a new access token",
  })
  @ApiOkResponse({ type: AccessTokenBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenBody> {
    this.assertAllowedOrigin(req);
    // A 429 keeps the cookie: the session is fine, only this IP must wait (ADR 0031).
    enforceLimit(
      this.limits,
      "staffRefresh",
      { ip: ipLimitKey(clientIpOf(req)) },
      res,
    );
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
    if (origin === undefined || !this.config.auth.adminOrigins.includes(origin))
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
      sessionId: staff.access.sessionId,
      tenantId: staff.access.tenantId!,
      role: staff.access.role!,
    };
  }
}

/** First platform route: proves `PlatformGuard` (operator + second-factor session). */
@ApiTags("platform")
@Controller("platform")
export class PlatformMeController {
  @Get("me")
  @PlatformRoute()
  @ApiOperation({ summary: "Signed-in WhiteOven operator" })
  @ApiOkResponse({ type: PlatformMeBody })
  me(@CurrentStaff() staff: StaffPrincipal): PlatformMeBody {
    return { staffUserId: staff.access.staffUserId, platformRole: "OPERATOR" };
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
