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
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { Request } from "express";
import { AccessTokens, type CustomerAccessClaims } from "../auth/access-token";
import { ROUTE_ACCESS } from "../auth/route-access";
import { ApiError } from "../errors/api-error";
import {
  STORE_CAPABILITY,
  StoreTenantGuard,
  TENANT_SURFACE,
  TenantContextInterceptor,
  claimTenant,
} from "../tenancy/store-tenant.guard";
import {
  bindTenantContext,
  boundTenantContext,
} from "../tenancy/tenant-context";
import type { TenantCapability } from "../tenancy/tenant-status-policy";
import {
  customerSessionLive,
  runInTenant,
} from "../tenancy/tenant-transaction";
import { invalidCustomerSession } from "./customer-auth.service";

const claimsOf = new WeakMap<Request, CustomerAccessClaims>();

/**
 * First of the `CustomerGuard` steps: a valid customer access token, whose `tid` the slug guard
 * then compares with the store in the URL (T-03: a token of store A on store B is a 404).
 */
@Injectable()
export class CustomerTokenGuard implements CanActivate {
  constructor(@Inject(AccessTokens) private readonly tokens: AccessTokens) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const claims = token ? this.tokens.verifyCustomer(token) : null;
    if (!claims)
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Authentication required.",
      );
    claimsOf.set(req, claims);
    claimTenant(req, claims.tid);
    return true;
  }
}

/**
 * Last step: the session is live, unexpired and its customer ACTIVE, read from PostgreSQL on
 * every request under the store's RLS, so a logout or an account deletion applies on the next
 * request. Then the request runs as this customer. `TenantTransactions.run` checks the same again,
 * with row locks, in the transaction that does the work.
 */
@Injectable()
export class CustomerSessionGuard implements CanActivate {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const claims = claimsOf.get(req);
    const store = boundTenantContext(req);
    // Unreachable after the two guards before; fail closed if the decorator is ever split.
    if (!claims || !store || store.tenantId !== claims.tid)
      throw invalidCustomerSession();
    const actor = {
      type: "customer" as const,
      customerId: claims.sub,
      sessionId: claims.sid,
    };
    const live = await runInTenant(this.orm, claims.tid, (em) =>
      customerSessionLive(em, actor),
    );
    if (!live) throw invalidCustomerSession();
    bindTenantContext(req, { tenantId: claims.tid, actor });
    return true;
  }
}

/**
 * `/v1/customer/stores/{storeSlug}` with a customer token (`CustomerGuard` of system-overview.md).
 * `capability` is the row of the status matrix the route needs: reading the account and deleting
 * it work in SUSPENDED and CLOSED stores too; writing addresses only in ACTIVE ones.
 */
export const CustomerRoute = (
  capability: Extract<
    TenantCapability,
    "customerAccount" | "customerAccountWrite"
  > = "customerAccount",
) =>
  applyDecorators(
    SetMetadata(ROUTE_ACCESS, "customer"),
    SetMetadata(TENANT_SURFACE, "customer"),
    SetMetadata(STORE_CAPABILITY, capability),
    UseGuards(CustomerTokenGuard, StoreTenantGuard, CustomerSessionGuard),
    UseInterceptors(TenantContextInterceptor),
    ApiBearerAuth(),
  );
