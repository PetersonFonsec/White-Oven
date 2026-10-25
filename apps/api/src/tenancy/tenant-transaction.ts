import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { IsolationLevel } from "@mikro-orm/core";
import { type EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { TENANT_SETTING } from "../database/tenant-isolation-sql";
import { ApiError } from "../errors/api-error";
import { TENANT_FILTER } from "./tenant-filter";
import { type TenantActor, currentTenantContext } from "./tenant-context";
import { TenantStatusPolicy } from "./tenant-status-policy";
import type { TenantStatus } from "./tenant.entity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Runs `work` in one transaction scoped to `tenantId` (layers 4 and 5 of tenant-isolation.md):
 * `set_config('app.tenant_id', id, true)` lasts only until commit or rollback, so a pooled
 * connection never carries a tenant into the next transaction, and the ORM filter gets the same
 * id. Session-level `SET` of the tenant is forbidden.
 *
 * Takes `tenantId` explicitly so jobs can iterate tenants one transaction at a time; request code
 * uses `TenantTransactions`, which reads it from the `TenantContext`.
 *
 * `isolationLevel` defaults to PostgreSQL's READ COMMITTED; a reader that needs every statement
 * to see the same snapshot (the public menu) asks for REPEATABLE READ.
 */
export async function runInTenant<T>(
  orm: MikroORM,
  tenantId: string,
  work: (em: EntityManager) => Promise<T>,
  options: { isolationLevel?: IsolationLevel } = {},
): Promise<T> {
  if (!UUID.test(tenantId))
    throw new Error("tenantId must be a lowercase UUID");
  const em = orm.em.fork({ clear: true });
  return em.transactional(async (tx) => {
    await tx.execute("select set_config(?, ?, true)", [
      TENANT_SETTING,
      tenantId,
    ]);
    tx.setFilterParams(TENANT_FILTER, { tenantId });
    return work(tx);
  }, options);
}

/**
 * Request-scoped entry point to tenant data: the only way services should reach it.
 *
 * For a staff actor the transaction first re-reads the session, the user and the membership with
 * row locks (FOR SHARE). The guard's check ran in an earlier transaction; this one closes the gap:
 * a logout, a disabled user, a revocation or a role change either committed before (the work is
 * refused) or waits until the work commits. No tenant work runs on an outdated role. A customer
 * actor gets the same treatment for its session and account (M4.2): a logout or an account
 * deletion is never overtaken by work started with the old token.
 */
@Injectable()
export class TenantTransactions {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async run<T>(
    work: (em: EntityManager) => Promise<T>,
    options: { isolationLevel?: IsolationLevel } = {},
  ): Promise<T> {
    const { tenantId, actor } = currentTenantContext();
    return runInTenant(
      this.orm,
      tenantId,
      async (em) => {
        if (actor.type === "staff") await assertStaffStillAllowed(em, actor);
        if (actor.type === "customer")
          await assertCustomerStillAllowed(em, actor);
        return work(em);
      },
      options,
    );
  }
}

/** Live, unexpired session of an ACTIVE customer, both rows locked FOR SHARE. */
export async function customerSessionLive(
  em: Pick<EntityManager, "execute">,
  actor: Extract<TenantActor, { type: "customer" }>,
): Promise<boolean> {
  const rows = await em.execute(
    `select 1 from customer_sessions s join customers c
         on c.tenant_id = s.tenant_id and c.id = s.customer_id
      where s.id = ? and s.customer_id = ? and s.revoked_at is null
        and s.expires_at > now() and c.status = 'ACTIVE'
        for share of s, c`,
    [actor.sessionId, actor.customerId],
  );
  return rows.length === 1;
}

async function assertCustomerStillAllowed(
  em: EntityManager,
  actor: Extract<TenantActor, { type: "customer" }>,
): Promise<void> {
  if (!(await customerSessionLive(em, actor)))
    throw new ApiError(
      HttpStatus.UNAUTHORIZED,
      "SESSION_INVALID",
      "Session expired or revoked. Sign in again.",
    );
}

async function assertStaffStillAllowed(
  em: EntityManager,
  actor: Extract<TenantActor, { type: "staff" }>,
): Promise<void> {
  // Match the platform suspension lock order: tenant row before session/user/membership rows.
  // This serializes access with suspension without deadlocking a request against the platform op.
  const [tenant] = await em.execute<{ status: TenantStatus }[]>(
    "select whiteoven_lock_tenant_status(?) as status",
    [currentTenantContext().tenantId],
  );
  const sessions = await em.execute(
    `select 1 from staff_sessions s join staff_users u on u.id = s.staff_user_id
      where s.id = ? and s.staff_user_id = ? and s.revoked_at is null
        and s.idle_expires_at > now() and u.status = 'ACTIVE'
        for share of s, u`,
    [actor.sessionId, actor.staffUserId],
  );
  if (sessions.length !== 1)
    throw new ApiError(
      HttpStatus.UNAUTHORIZED,
      "SESSION_INVALID",
      "Session expired or revoked. Sign in again.",
    );
  // Same login matrix as staffMayEnter (domain-model.md), under the tenant setting of this
  // transaction, so RLS still limits the read to the current tenant.
  const [membership] = await em.execute<
    { role: "OWNER" | "MANAGER" | "STAFF" }[]
  >(
    `select m.role from memberships m
      where m.staff_user_id = ? and m.status = 'ACTIVE'
        for share of m`,
    [actor.staffUserId],
  );
  if (!membership)
    throw new ApiError(
      HttpStatus.FORBIDDEN,
      "TENANT_ACCESS_DENIED",
      "No access to this store.",
    );
  if (
    !tenant?.status ||
    !TenantStatusPolicy.staffMayEnter(tenant.status, membership.role)
  )
    throw new ApiError(
      HttpStatus.FORBIDDEN,
      "TENANT_ACCESS_DENIED",
      "No access to this store.",
    );
  if (membership.role !== actor.role)
    throw new ApiError(
      HttpStatus.FORBIDDEN,
      "ROLE_FORBIDDEN",
      "Your role cannot perform this action.",
    );
}
