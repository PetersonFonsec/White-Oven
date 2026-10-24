import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PlatformService } from "../src/platform/platform.service";
import { hashPassword } from "../src/auth/password";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import { insertTenant } from "./staff-fixtures";
import type { ApiConfig } from "../src/config/config";

const REQUEST_ID = "0a0b0c0d-1111-4222-8333-444455556666";

describe("M1.5 platform operations", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let app: Awaited<ReturnType<TestDatabase["connect"]>>;
  let platform: PlatformService;
  let testConfig: ApiConfig;
  let operatorId: string;
  let operatorSessionId: string;

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    app = await database.connect(database.appUrl);
    const hash = await hashPassword("correct horse battery staple 2026");
    const [operator] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_users (email, name, password_hash, platform_role, mfa_secret, mfa_enabled_at) values (?, ?, ?, 'OPERATOR', 'v1.operator', now()) returning id",
        [`operator-${Date.now()}@example.test`, "Operator", hash],
      );
    operatorId = operator!.id;
    const [operatorSession] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_sessions (staff_user_id, mfa, refresh_token_hash, idle_expires_at) values (?, true, ?, now() + interval '1 hour') returning id",
        [operatorId, Buffer.alloc(32, 3)],
      );
    operatorSessionId = operatorSession!.id;
    testConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "error",
      openApiEnabled: false,
      database: { url: database.appUrl, poolMax: 2 },
      auth: {
        accessTokenPrivateKey: null,
        mfaEncryptionKey: null,
        ownerInviteSecret: Buffer.alloc(32, 9),
        adminOrigins: ["https://admin.example.test"],
      },
    };
    platform = new PlatformService(app, testConfig);
  });

  after(async () => {
    await app?.close();
    await owner?.close();
    await database?.drop();
  });

  it("creates a tenant and a 72-hour single-use OWNER invitation", async () => {
    const created = await platform.createTenant(
      {
        slug: "white-oven-one",
        displayName: "White Oven One",
        ownerEmail: " Owner@Example.test ",
        idempotencyKey: "create-white-oven-one-001",
      },
      operatorId,
      operatorSessionId,
      REQUEST_ID,
      "127.0.0.1",
    );
    assert.match(
      created.inviteUrl,
      /^https:\/\/admin\.example\.test\/invite\/[A-Za-z0-9_-]{43}$/,
    );
    assert.equal(created.expiresIn, 72 * 60 * 60);
    const restarted = new PlatformService(app, testConfig);
    const afterRestart = await restarted.createTenant(
      {
        slug: "white-oven-one",
        displayName: "White Oven One",
        ownerEmail: "owner@example.test",
        idempotencyKey: "create-white-oven-one-001",
      },
      operatorId,
      operatorSessionId,
      REQUEST_ID,
      "127.0.0.1",
    );
    assert.deepEqual(afterRestart, created);
    const retried = await platform.createTenant(
      {
        slug: "white-oven-one",
        displayName: "White Oven One",
        ownerEmail: "owner@example.test",
        idempotencyKey: "create-white-oven-one-001",
      },
      operatorId,
      operatorSessionId,
      REQUEST_ID,
      "127.0.0.1",
    );
    assert.deepEqual(retried, created);
    await assert.rejects(
      platform.createTenant(
        {
          slug: "different-slug",
          displayName: "Different",
          ownerEmail: "owner@example.test",
          idempotencyKey: "create-white-oven-one-001",
        },
        operatorId,
        operatorSessionId,
        REQUEST_ID,
        "127.0.0.1",
      ),
    );
    const token = new URL(created.inviteUrl).pathname.split("/").at(-1)!;
    const [invite] = await runInTenant(owner, created.tenantId, (em) =>
      em.execute<{ expiresAt: Date; tokenHash: Buffer }[]>(
        'select expires_at as "expiresAt", token_hash as "tokenHash" from owner_invites where tenant_id = ?',
        [created.tenantId],
      ),
    );
    assert.equal(
      invite!.tokenHash.equals(createHash("sha256").update(token).digest()),
      true,
    );
    await assert.rejects(
      app.em.getConnection().execute("select * from owner_invite_lookup"),
      (error: { code?: string }) => error.code === "42501",
    );
    assert.ok(
      Math.abs(
        new Date(invite!.expiresAt).getTime() - Date.now() - 72 * 60 * 60_000,
      ) < 10_000,
    );
    await runInTenant(owner, created.tenantId, (em) =>
      em.execute(
        "update owner_invites set expires_at = now() - interval '1 second'",
      ),
    );
    await assert.rejects(
      platform.redeemOwnerInvite(
        token,
        "Owner One",
        "a sufficiently long secure password",
        REQUEST_ID,
      ),
    );
    await runInTenant(owner, created.tenantId, (em) =>
      em.execute(
        "update owner_invites set expires_at = now() + interval '1 hour'",
      ),
    );
    for (let index = 0; index < 75; index++)
      await owner.em
        .getConnection()
        .execute(
          "insert into tenants (slug, display_name, status) values (?, ?, 'ONBOARDING')",
          [`invite-load-${index}-${Date.now()}`, `Invite load ${index}`],
        );

    const redeemed = await platform.redeemOwnerInvite(
      token,
      "Owner One",
      "a sufficiently long secure password",
      REQUEST_ID,
    );
    assert.equal(redeemed.tenantId, created.tenantId);
    assert.equal(
      await owner.em
        .getConnection()
        .execute<{ count: number }[]>(
          "select count(*)::int as count from owner_invite_lookup where token_hash = ?",
          [createHash("sha256").update(token).digest()],
        )
        .then(([row]) => row!.count),
      0,
    );
    await assert.rejects(
      platform.redeemOwnerInvite(
        token,
        "Owner One",
        "a sufficiently long secure password",
        REQUEST_ID,
      ),
    );
    const memberships = await runInTenant(owner, created.tenantId, (em) =>
      em.execute<{ role: string; status: string }[]>(
        "select role, status from memberships where staff_user_id = ?",
        [redeemed.staffUserId],
      ),
    );
    assert.deepEqual(memberships, [{ role: "OWNER", status: "ACTIVE" }]);
  });

  it("suspends, rejects PLACED orders, revokes non-owner sessions and records audit atomically", async () => {
    const created = await platform.createTenant(
      {
        slug: "white-oven-two",
        displayName: "White Oven Two",
        ownerEmail: "owner2@example.test",
        idempotencyKey: "create-white-oven-two-001",
      },
      operatorId,
      operatorSessionId,
      REQUEST_ID,
      "127.0.0.1",
    );
    const [manager] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_users (email, name, password_hash) values (?, ?, ?) returning id",
        [
          `manager-${Date.now()}@example.test`,
          "Manager",
          await hashPassword("another secure test password"),
        ],
      );
    const [session] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_sessions (staff_user_id, active_tenant_id, refresh_token_hash, idle_expires_at) values (?, ?, ?, now() + interval '1 hour') returning id",
        [manager!.id, created.tenantId, Buffer.alloc(32, 1)],
      );
    const otherTenantId = await insertTenant(owner, `other-${Date.now()}`);
    const [otherSession] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_sessions (staff_user_id, active_tenant_id, refresh_token_hash, idle_expires_at) values (?, ?, ?, now() + interval '1 hour') returning id",
        [manager!.id, otherTenantId, Buffer.alloc(32, 2)],
      );
    const [order] = await runInTenant(owner, created.tenantId, (em) =>
      em.execute<{ id: string }[]>(
        "insert into orders (tenant_id) values (?) returning id",
        [created.tenantId],
      ),
    );
    await runInTenant(owner, created.tenantId, (em) =>
      em.execute(
        "insert into memberships (tenant_id, staff_user_id, role, status) values (?, ?, 'MANAGER', 'ACTIVE')",
        [created.tenantId, manager!.id],
      ),
    );
    await runInTenant(owner, otherTenantId, (em) =>
      em.execute(
        "insert into memberships (tenant_id, staff_user_id, role, status) values (?, ?, 'MANAGER', 'ACTIVE')",
        [otherTenantId, manager!.id],
      ),
    );

    await assert.rejects(
      platform.changeTenantStatus(
        created.tenantId,
        "SUSPENDED",
        manager!.id,
        session!.id,
        REQUEST_ID,
        "127.0.0.1",
      ),
    );
    await assert.rejects(
      app.em
        .getConnection()
        .execute(
          "select whiteoven_change_tenant_status(?, 'SUSPENDED', ?, ?, null, ?::uuid)",
          [created.tenantId, operatorId, session!.id, REQUEST_ID],
        ),
      (error: { code?: string }) => error.code === "42501",
    );
    await assert.rejects(
      app.em
        .getConnection()
        .execute(
          "select whiteoven_change_tenant_status(?, 'SUSPENDED', ?, ?, null, ?::uuid)",
          [created.tenantId, manager!.id, operatorSessionId, REQUEST_ID],
        ),
      (error: { code?: string }) => error.code === "42501",
    );

    await platform.changeTenantStatus(
      created.tenantId,
      "SUSPENDED",
      operatorId,
      operatorSessionId,
      REQUEST_ID,
      "127.0.0.1",
    );
    const [orderRow] = await runInTenant(owner, created.tenantId, (em) =>
      em.execute<{ status: string; rejectionReason: string }[]>(
        'select status, rejection_reason as "rejectionReason" from orders where id = ?',
        [order!.id],
      ),
    );
    assert.deepEqual(orderRow, {
      status: "REJECTED",
      rejectionReason: "STORE_SUSPENDED",
    });
    const [sessionRow] = await owner.em
      .getConnection()
      .execute<{ revokedAt: Date | null; reason: string }[]>(
        'select revoked_at as "revokedAt", revoked_reason as "reason" from staff_sessions where id = ?',
        [session!.id],
      );
    assert.ok(sessionRow!.revokedAt);
    assert.equal(sessionRow!.reason, "TENANT_SUSPENDED");
    const [otherSessionRow] = await owner.em
      .getConnection()
      .execute<{ revokedAt: Date | null }[]>(
        'select revoked_at as "revokedAt" from staff_sessions where id = ?',
        [otherSession!.id],
      );
    assert.equal(otherSessionRow!.revokedAt, null);
    const [audit] = await owner.em
      .getConnection()
      .execute<{ action: string }[]>(
        "select action from audit_events where tenant_id = ? and action = 'tenant.status_changed'",
        [created.tenantId],
      );
    assert.equal(audit!.action, "tenant.status_changed");
    await platform.changeTenantStatus(
      created.tenantId,
      "ACTIVE",
      operatorId,
      operatorSessionId,
      REQUEST_ID,
      "127.0.0.1",
    );
  });

  it("resets another operator's MFA, revokes their sessions and appends platform audit", async () => {
    const [other] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_users (email, name, password_hash, platform_role, mfa_secret, mfa_enabled_at) values (?, ?, ?, 'OPERATOR', 'v1.sealed', now()) returning id",
        [
          `other-operator-${Date.now()}@example.test`,
          "Other operator",
          await hashPassword("another secure test password"),
        ],
      );
    const [session] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into staff_sessions (staff_user_id, mfa, refresh_token_hash, idle_expires_at) values (?, true, ?, now() + interval '1 hour') returning id",
        [other!.id, Buffer.alloc(32, 2)],
      );
    await platform.resetOperatorMfa(
      other!.id,
      operatorId,
      operatorSessionId,
      REQUEST_ID,
      "127.0.0.1",
    );
    const [user] = await owner.em
      .getConnection()
      .execute<{ mfaEnabledAt: Date | null }[]>(
        'select mfa_enabled_at as "mfaEnabledAt" from staff_users where id = ?',
        [other!.id],
      );
    const [revoked] = await owner.em
      .getConnection()
      .execute<{ reason: string }[]>(
        'select revoked_reason as "reason" from staff_sessions where id = ?',
        [session!.id],
      );
    const [audit] = await owner.em
      .getConnection()
      .execute<{ action: string }[]>(
        "select action from audit_events where entity_id = ? and action = 'operator.mfa_reset'",
        [other!.id],
      );
    assert.equal(user!.mfaEnabledAt, null);
    assert.equal(revoked!.reason, "MFA_RESET");
    assert.equal(audit!.action, "operator.mfa_reset");
    await assert.rejects(
      platform.resetOperatorMfa(
        operatorId,
        operatorId,
        operatorSessionId,
        REQUEST_ID,
        "127.0.0.1",
      ),
    );
  });
});
