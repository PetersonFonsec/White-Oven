import { AsyncLocalStorage } from "node:async_hooks";

/** Who acts inside the tenant. Staff and customer actors arrive with authentication (M1.4+). */
export type TenantActor = { type: "anonymous" };

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

export function currentTenantContext(): TenantContext {
  const context = storage.getStore();
  if (!context) throw new MissingTenantContextError();
  return context;
}
