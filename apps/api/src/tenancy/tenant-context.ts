import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";

/** Who acts inside the tenant. Customer actors arrive with customer accounts (M4.2). */
export type TenantActor =
  | { type: "anonymous" }
  | {
      type: "staff";
      staffUserId: string;
      sessionId: string;
      role: "OWNER" | "MANAGER" | "STAFF";
    };

/**
 * Immutable for the whole request (layer 2 of tenant-isolation.md). Created only by a surface
 * guard from a trusted source (slug, token, membership), never from a header, body or query.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly actor: Readonly<TenantActor>;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Thrown when tenant data is accessed outside a tenant context. Maps to a 500, never data. */
export class MissingTenantContextError extends Error {
  constructor() {
    super("no tenant context");
    this.name = "MissingTenantContextError";
  }
}

export function runWithTenantContext<T>(
  context: TenantContext,
  work: () => T,
): T {
  const frozen = Object.freeze({
    tenantId: context.tenantId,
    actor: Object.freeze({ ...context.actor }),
  });
  return storage.run(frozen, work);
}

const boundContexts = new WeakMap<Request, TenantContext>();

/** Called by surface guards once the tenant is trusted; `TenantContextInterceptor` runs it. */
export function bindTenantContext(req: Request, context: TenantContext): void {
  boundContexts.set(req, context);
}

export function boundTenantContext(req: Request): TenantContext | undefined {
  return boundContexts.get(req);
}

export function currentTenantContext(): TenantContext {
  const context = storage.getStore();
  if (!context) throw new MissingTenantContextError();
  return context;
}
