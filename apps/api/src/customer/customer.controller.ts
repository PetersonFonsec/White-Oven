import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { PASSWORD_MAX_LENGTH } from "../auth/password";
import { ApiError, ApiErrorBody } from "../errors/api-error";
import { clientIpOf, ipLimitKey } from "../security/http-security";
import { RequestLimits, enforceLimit } from "../security/request-limits";
import { StoreTenant } from "../tenancy/store-tenant.guard";
import { currentTenantContext } from "../tenancy/tenant-context";
import { CustomerAddresses } from "./customer-address.service";
import { CustomerAuth, type CustomerTokens } from "./customer-auth.service";
import { CustomerRoute } from "./customer.guard";
import {
  normalizeEmail,
  validateAddress,
  validateLegalAcceptance,
  validateRegistration,
} from "./customer-rules";

class RegisterBody {
  @ApiProperty({ maxLength: 120 }) name!: string;
  @ApiProperty({ format: "email" }) email!: string;
  @ApiProperty({ format: "password", minLength: 10, maxLength: 256 })
  password!: string;
  @ApiPropertyOptional({ example: "+5511999990000", nullable: true })
  phone?: string | null;
  @ApiProperty({
    maxLength: 40,
    description:
      "The current privacy policy version, shown and accepted (GET /public/stores/{slug}/legal)",
  })
  privacyPolicyVersion!: string;
  @ApiProperty({
    maxLength: 40,
    description: "The current terms of use version, shown and accepted",
  })
  termsOfUseVersion!: string;
}
class LegalAcceptanceBody {
  @ApiProperty({ maxLength: 40 }) privacyPolicyVersion!: string;
  @ApiProperty({ maxLength: 40 }) termsOfUseVersion!: string;
}
class LoginBody {
  @ApiProperty({ format: "email" }) email!: string;
  @ApiProperty({ format: "password" }) password!: string;
}
class RefreshBody {
  @ApiProperty({ description: "From the sign-in or the last refresh" })
  refreshToken!: string;
}
class PasswordBody {
  @ApiProperty({ format: "password" }) password!: string;
}
class AddressBody {
  @ApiProperty({ maxLength: 40, example: "Casa" }) label!: string;
  @ApiProperty({ example: "01310-100" }) postalCode!: string;
  @ApiProperty({ maxLength: 120 }) street!: string;
  @ApiProperty({ maxLength: 20 }) number!: string;
  @ApiPropertyOptional({ maxLength: 60, nullable: true })
  complement?: string | null;
  @ApiProperty({ maxLength: 80 }) district!: string;
  @ApiProperty({ maxLength: 80 }) city!: string;
  @ApiProperty({ example: "SP" }) state!: string;
  @ApiPropertyOptional({ maxLength: 120, nullable: true })
  reference?: string | null;
}

const invalid = (paths: string[]) =>
  new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "VALIDATION_FAILED",
    "Invalid request body.",
    { errors: paths.map((path) => ({ code: "VALIDATION_FAILED", path })) },
  );

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Exactly `keys`, each a non-empty string; anything else is a 422 with the paths. */
function strings<K extends string>(
  raw: unknown,
  keys: readonly K[],
): Record<K, string> {
  if (!plain(raw)) throw invalid([""]);
  const paths = [
    ...keys.filter((key) => typeof raw[key] !== "string" || raw[key] === ""),
    ...Object.keys(raw).filter(
      (key) => !(keys as readonly string[]).includes(key),
    ),
  ];
  if (paths.length) throw invalid(paths);
  return raw as Record<K, string>;
}

/** Oversized passwords fail like wrong ones, without being hashed. */
const boundedPassword = (password: string) =>
  password.length <= PASSWORD_MAX_LENGTH * 4 ? password : "";

/**
 * Customer accounts of a store (M4.2, ADR 0017). Sign-up, sign-in, refresh and logout resolve
 * the store from the slug; everything under `me` needs a customer token of that same store. The
 * app keeps the refresh token in the system's secure storage, so it travels in the body, never in
 * a cookie, and every token response is `no-store`.
 */
@ApiTags("customer")
@Controller("customer/stores/:storeSlug")
export class CustomerController {
  constructor(
    private readonly auth: CustomerAuth,
    private readonly addresses: CustomerAddresses,
    private readonly limits: RequestLimits,
  ) {}

  /** Per IP in this store and per IP across stores (ADR 0031). */
  private limitByIp(
    name: "customerSignup" | "customerRefresh",
    req: Request,
    res: Response,
  ): void {
    const ip = ipLimitKey(clientIpOf(req));
    const storeIp = `${currentTenantContext().tenantId}\0${ip}`;
    enforceLimit(this.limits, name, { storeIp, ip }, res);
  }

  @Post("auth/register")
  @StoreTenant("customerSignup")
  @ApiBody({ type: RegisterBody })
  @ApiOperation({
    summary: "Create an account in this store and sign in",
    description:
      "409 EMAIL_TAKEN or PHONE_TAKEN when another account of this store has it; 409 LEGAL_VERSION_OUTDATED (details: current versions) when a version is not the current one; 409 LEGAL_DOCUMENTS_UNAVAILABLE until the store publishes both documents.",
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody })
  async register(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerTokens> {
    this.limitByIp("customerSignup", req, res);
    const result = validateRegistration(raw);
    if (!result.ok) throw invalid(result.paths);
    res.setHeader("Cache-Control", "no-store");
    return this.auth.register(result.value);
  }

  @Post("auth/login")
  @StoreTenant("customerAccount")
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: LoginBody })
  @ApiOperation({ summary: "Sign in with e-mail and password" })
  async login(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerTokens> {
    const fields = strings(raw, ["email", "password"] as const);
    const email = normalizeEmail(fields.email);
    const ip = clientIpOf(req);
    const wait = this.auth.loginRetryAfterSeconds(email, ip);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        "Too many attempts. Try again later.",
      );
    }
    res.setHeader("Cache-Control", "no-store");
    return this.auth.login(email, boundedPassword(fields.password), ip);
  }

  @Post("auth/refresh")
  @StoreTenant("customerAccount")
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: RefreshBody })
  @ApiOperation({
    summary: "Rotate the refresh token and get a new access token",
    description:
      "Presenting an already rotated token revokes the whole session.",
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody })
  refresh(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CustomerTokens> {
    this.limitByIp("customerRefresh", req, res);
    const { refreshToken } = strings(raw, ["refreshToken"] as const);
    res.setHeader("Cache-Control", "no-store");
    return this.auth.refresh(refreshToken);
  }

  @Post("auth/logout")
  @StoreTenant("customerAccount")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBody({ type: RefreshBody })
  @ApiOperation({ summary: "End the session of a refresh token" })
  async logout(@Body() raw: unknown): Promise<void> {
    const { refreshToken } = strings(raw, ["refreshToken"] as const);
    await this.auth.logout(refreshToken);
  }

  @Get("me")
  @CustomerRoute()
  @ApiOperation({ summary: "The signed-in customer's account" })
  me(@Res({ passthrough: true }) res: Response) {
    res.setHeader("Cache-Control", "no-store");
    return this.auth.profile();
  }

  @Delete("me")
  @CustomerRoute()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBody({ type: PasswordBody })
  @ApiOperation({
    summary: "Delete the account: personal data is removed, sessions end",
    description:
      "Asks for the password again. Works in suspended and closed stores too.",
  })
  async deleteAccount(@Body() raw: unknown): Promise<void> {
    const { password } = strings(raw, ["password"] as const);
    await this.auth.deleteAccount(boundedPassword(password));
  }

  @Post("me/legal-acceptances")
  @CustomerRoute("customerAccountWrite")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBody({ type: LegalAcceptanceBody })
  @ApiOperation({
    summary:
      "Accept the store's current privacy policy and terms (when `legalUpdateRequired`)",
    description:
      "409 LEGAL_VERSION_OUTDATED when a version is not the current one. Idempotent.",
  })
  async acceptLegal(@Body() raw: unknown): Promise<void> {
    const result = validateLegalAcceptance(raw);
    if (!result.ok) throw invalid(result.paths);
    await this.auth.acceptLegalDocuments(result.value);
  }

  @Get("me/addresses")
  @CustomerRoute()
  @ApiOperation({ summary: "The signed-in customer's addresses" })
  listAddresses(@Res({ passthrough: true }) res: Response) {
    res.setHeader("Cache-Control", "no-store");
    return this.addresses.list();
  }

  @Post("me/addresses")
  @CustomerRoute("customerAccountWrite")
  @ApiBody({ type: AddressBody })
  @ApiOperation({ summary: "Add an address (at most 10)" })
  createAddress(@Body() raw: unknown) {
    const result = validateAddress(raw);
    if (!result.ok) throw invalid(result.paths);
    return this.addresses.create(result.value);
  }

  @Put("me/addresses/:addressId")
  @CustomerRoute("customerAccountWrite")
  @ApiBody({ type: AddressBody })
  @ApiOperation({ summary: "Replace an address" })
  updateAddress(@Param("addressId") id: string, @Body() raw: unknown) {
    const result = validateAddress(raw);
    if (!result.ok) throw invalid(result.paths);
    return this.addresses.update(id, result.value);
  }

  @Delete("me/addresses/:addressId")
  @CustomerRoute("customerAccountWrite")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove an address" })
  async deleteAddress(@Param("addressId") id: string): Promise<void> {
    await this.addresses.remove(id);
  }
}
