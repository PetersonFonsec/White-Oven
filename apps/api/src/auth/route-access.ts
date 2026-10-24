import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiError } from "../errors/api-error";
import { JsonLogger } from "../logging/json-logger";

/**
 * Every route declares who may call it (system-overview.md, "Autorização": no route without an
 * explicit guard). Values:
 * - `public`: no authentication (health, login, cookie-based refresh/logout).
 * - `store`: `@StoreTenant()`, tenant from the URL slug.
 * - `staff`: staff access token, no tenant needed (`@StaffRoute()`).
 * - `admin`: staff access token with an ACTIVE membership in the token's tenant (`@AdminRoute()`).
 */
export const ROUTE_ACCESS = "whiteoven:route-access";
export const ROUTE_ACCESS_VALUES = [
  "public",
  "store",
  "staff",
  "admin",
] as const;
export type RouteAccess = (typeof ROUTE_ACCESS_VALUES)[number];

export const PublicRoute = () => SetMetadata(ROUTE_ACCESS, "public");

/**
 * Global guard, first in line: a handler without a declaration is refused (fail closed) and
 * logged, besides failing the route coverage test in CI.
 */
@Injectable()
export class RouteAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(
      ROUTE_ACCESS,
      [context.getHandler(), context.getClass()],
    );
    if (access && (ROUTE_ACCESS_VALUES as readonly string[]).includes(access))
      return true;
    this.logger.write("error", "route without access declaration", {
      handler: `${context.getClass().name}.${context.getHandler().name}`,
    });
    throw new ApiError(HttpStatus.FORBIDDEN, "FORBIDDEN", "Access denied.");
  }
}
