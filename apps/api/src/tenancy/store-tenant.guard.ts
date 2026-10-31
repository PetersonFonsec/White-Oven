import {
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseGuards,
  UseInterceptors,
  applyDecorators,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { Request } from "express";
import { Observable } from "rxjs";
import { ApiError } from "../errors/api-error";
import { setRequestTenant } from "../logging/request-context";
import { ROUTE_ACCESS } from "../auth/route-access";
import {
  bindTenantContext,
  boundTenantContext,
  runWithTenantContext,
} from "./tenant-context";
import { TENANT_SLUG, Tenant } from "./tenant.entity";
import { Reflector } from "@nestjs/core";
import {
  type TenantCapability,
  TenantStatusPolicy,
} from "./tenant-status-policy";

/** Route metadata marking a tenant surface; the isolation matrix test lists every such route. */
export const TENANT_SURFACE = "whiteoven:tenant-surface";
export const STORE_SLUG_PARAM = "storeSlug";
/** The `TenantStatusPolicy` capability a store route checks; `publicMenu` when absent. */
export const STORE_CAPABILITY = "whiteoven:store-capability";
const CUSTOMER_CAPABILITIES: readonly TenantCapability[] = [
  "customerAccount",
  "customerAccountWrite",
  "createOrder",
];

const claimedTenants = new WeakMap<Request, string>();

/**
 * Called by authentication guards (customer token `tid`, M1.4+) before `StoreTenantGuard`. The
 * slug's tenant must match, otherwise the route answers 404 (T-03).
 */
export function claimTenant(req: Request, tenantId: string): void {
  claimedTenants.set(req, tenantId);
}

const storeNotFound = () =>
  new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "Store not found.");

/**
 * Layer 1 of tenant-isolation.md for `/v1/public/stores/{storeSlug}` (and, with a claimed tenant,
 * `/v1/customer/stores/{storeSlug}`): the tenant comes only from the slug in the URL. Unknown or
 * malformed slugs and a claimed tenant from another store answer the same 404. A store that is
 * not ACTIVE answers 403 `TENANT_NOT_ACTIVE` without its status; M1.5 moves this check into
 * `TenantStatusPolicy`.
 */
@Injectable()
export class StoreTenantGuard implements CanActivate {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const capability =
      this.reflector.get<TenantCapability | undefined>(
        STORE_CAPABILITY,
        context.getHandler(),
      ) ?? "publicMenu";
    const slug = req.params[STORE_SLUG_PARAM];
    if (typeof slug !== "string" || !TENANT_SLUG.test(slug))
      throw storeNotFound();
    const tenant = await this.orm.em
      .fork()
      .findOne(Tenant, { slug }, { fields: ["id", "status"] });
    if (!tenant) throw storeNotFound();
    const claimed = claimedTenants.get(req);
    if (claimed !== undefined && claimed !== tenant.id) throw storeNotFound();
    // Signing in runs before there is a customer, but checks what the customer may then do.
    const actor = CUSTOMER_CAPABILITIES.includes(capability)
      ? "CUSTOMER"
      : "PUBLIC";
    if (!TenantStatusPolicy.allows(tenant.status, actor, capability))
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        "TENANT_NOT_ACTIVE",
        "Store unavailable.",
      );
    bindTenantContext(req, {
      tenantId: tenant.id,
      actor: { type: "anonymous" },
    });
    setRequestTenant(req, tenant.id);
    return true;
  }
}

/** Runs the handler inside the immutable `TenantContext` a surface guard bound (layer 2). */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const tenantContext = boundTenantContext(req);
    // Unreachable behind a surface guard; fail closed if the decorators are ever split.
    if (!tenantContext) throw storeNotFound();
    return new Observable((subscriber) =>
      runWithTenantContext(tenantContext, () =>
        next.handle().subscribe(subscriber),
      ),
    );
  }
}

/**
 * Store surface: resolves the tenant from `:storeSlug` and runs the handler in its context. The
 * capability decides which tenant statuses the route serves: the public menu by default, and the
 * customer sign-up and sign-in (M4.2) with their own rows of the status matrix.
 */
export const StoreTenant = (
  capability: Extract<
    TenantCapability,
    "publicMenu" | "legalRead" | "customerSignup" | "customerAccount"
  > = "publicMenu",
) =>
  applyDecorators(
    SetMetadata(STORE_CAPABILITY, capability),
    SetMetadata(TENANT_SURFACE, "store"),
    SetMetadata(ROUTE_ACCESS, "store"),
    UseGuards(StoreTenantGuard),
    UseInterceptors(TenantContextInterceptor),
  );
