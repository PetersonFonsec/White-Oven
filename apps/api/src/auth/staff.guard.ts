import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  UseInterceptors,
  applyDecorators,
  createParamDecorator,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { Request } from "express";
import { ApiError } from "../errors/api-error";
import { setRequestTenant } from "../logging/request-context";
import {
  TENANT_SURFACE,
  TenantContextInterceptor,
} from "../tenancy/store-tenant.guard";
import { bindTenantContext } from "../tenancy/tenant-context";
import { AccessTokens, type StaffAccessClaims } from "./access-token";
import { ROUTE_ACCESS, type RouteAccess } from "./route-access";
import type { MembershipRole } from "./staff.entity";
import {
  type StaffAccess,
  StaffAuth,
  invalidSession,
} from "./staff-auth.service";

const ROLES = "whiteoven:roles";
/** Routes an operator without MFA may still reach: only the second factor enrollment. */
const ALLOW_WITHOUT_MFA = "whiteoven:allow-without-mfa";

export interface StaffPrincipal {
  claims: StaffAccessClaims;
  access: StaffAccess;
}

const principals = new WeakMap<Request, StaffPrincipal>();

const authenticationRequired = () =>
  new ApiError(
    HttpStatus.UNAUTHORIZED,
    "UNAUTHORIZED",
    "Authentication required.",
  );

/**
 * `StaffGuard` for `/v1/admin`: verifies the access token, then asks `StaffAuth.authorize`
 * whether the session is live and, on admin routes, whether the membership in the token's
 * tenant is ACTIVE on this request. Admin routes then check the role and bind the
 * `TenantContext`; the tenant comes only from the verified token (tenant-isolation.md).
 */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AccessTokens) private readonly tokens: AccessTokens,
    @Inject(StaffAuth) private readonly auth: StaffAuth,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const claims = token ? this.tokens.verify(token) : null;
    if (!claims) throw authenticationRequired();

    const surface = this.reflector.getAllAndOverride<RouteAccess | undefined>(
      ROUTE_ACCESS,
      [context.getHandler(), context.getClass()],
    );
    const admin = surface === "admin";
    if (admin && !claims.tid)
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        "TENANT_REQUIRED",
        "Select a store first.",
      );

    const access = await this.auth.authorize(
      admin ? claims : { ...claims, tid: null },
    );
    if (!access) {
      // Session gone, or (admin) membership revoked or tenant no longer admits the role.
      if (!admin) throw invalidSession();
      const sessionOnly = await this.auth.authorize({ ...claims, tid: null });
      if (!sessionOnly) throw invalidSession();
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        "TENANT_ACCESS_DENIED",
        "No access to this store.",
      );
    }

    if (admin) {
      const roles =
        this.reflector.getAllAndOverride<MembershipRole[] | undefined>(ROLES, [
          context.getHandler(),
          context.getClass(),
        ]) ?? [];
      if (roles.length > 0 && !roles.includes(access.role!))
        throw new ApiError(
          HttpStatus.FORBIDDEN,
          "ROLE_FORBIDDEN",
          "Your role cannot perform this action.",
        );
      setRequestTenant(req, access.tenantId!);
      bindTenantContext(req, {
        tenantId: access.tenantId!,
        actor: {
          type: "staff",
          staffUserId: access.staffUserId,
          sessionId: access.sessionId,
          role: access.role!,
        },
      });
    }
    // An operator acts only from a session authenticated with the second factor; before
    // enrolling, the only reachable routes are the enrollment ones (system-overview.md).
    const allowWithoutMfa = this.reflector.getAllAndOverride<
      boolean | undefined
    >(ALLOW_WITHOUT_MFA, [context.getHandler(), context.getClass()]);
    if (
      access.platformRole === "OPERATOR" &&
      !access.sessionMfa &&
      !allowWithoutMfa
    )
      throw mfaRequired();

    principals.set(req, { claims, access });
    return true;
  }
}

const mfaRequired = () =>
  new ApiError(
    HttpStatus.FORBIDDEN,
    "MFA_REQUIRED",
    "Two-factor authentication is required.",
  );

/**
 * `PlatformGuard`, after `StaffGuard`: platform role OPERATOR and a session with `mfa = true`,
 * both in the token and in the database. Anything else is 403, so no platform route works
 * without the second factor (M1.4 acceptance criterion).
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const principal = principals.get(
      context.switchToHttp().getRequest<Request>(),
    );
    if (!principal) throw authenticationRequired();
    const { claims, access } = principal;
    if (access.platformRole !== "OPERATOR")
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        "PLATFORM_FORBIDDEN",
        "Platform access only.",
      );
    if (!claims.mfa || !access.sessionMfa || !access.mfaEnrolled)
      throw mfaRequired();
    return true;
  }
}

/** Staff token required, no tenant: tenant picker, switching tenant, own session. */
export const StaffRoute = (options: { allowWithoutMfa?: boolean } = {}) =>
  applyDecorators(
    SetMetadata(ROUTE_ACCESS, "staff"),
    SetMetadata(ALLOW_WITHOUT_MFA, options.allowWithoutMfa === true),
    UseGuards(StaffGuard),
    ApiBearerAuth(),
  );

/** `/v1/platform`: WhiteOven operators with a second-factor session (`PlatformGuard`). */
export const PlatformRoute = () =>
  applyDecorators(
    SetMetadata(ROUTE_ACCESS, "platform"),
    UseGuards(StaffGuard, PlatformGuard),
    ApiBearerAuth(),
  );

/**
 * `/v1/admin` tenant surface: staff token, ACTIVE membership in the token's tenant and, when
 * given, one of `roles` (permissions are code, system-overview.md "Autorização"). Runs the
 * handler in the tenant's `TenantContext`, so `TenantTransactions.run` works.
 */
export const AdminRoute = (...roles: MembershipRole[]) =>
  applyDecorators(
    SetMetadata(ROUTE_ACCESS, "admin"),
    SetMetadata(TENANT_SURFACE, "admin"),
    SetMetadata("whiteoven:tenant-surface", "admin"),
    SetMetadata(ROLES, roles),
    UseGuards(StaffGuard),
    UseInterceptors(TenantContextInterceptor),
    ApiBearerAuth(),
  );

/** The authenticated staff member of a `@StaffRoute()`, `@AdminRoute()` or `@PlatformRoute()`. */
export const CurrentStaff = createParamDecorator(
  (_: unknown, context: ExecutionContext): StaffPrincipal => {
    const principal = principals.get(
      context.switchToHttp().getRequest<Request>(),
    );
    // Unreachable behind StaffGuard; fail closed if the decorator is used elsewhere.
    if (!principal) throw authenticationRequired();
    return principal;
  },
);
