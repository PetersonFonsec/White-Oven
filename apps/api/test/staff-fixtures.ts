import assert from "node:assert/strict";
import type { MikroORM } from "@mikro-orm/postgresql";
import { hashPassword } from "../src/auth/password";
import { runInTenant } from "../src/tenancy/tenant-transaction";

/** Synthetic staff data only. Rows are written as `whiteoven_owner`, like a seed would. */
export async function insertTenant(
  owner: MikroORM,
  slug: string,
  status = "ACTIVE",
): Promise<string> {
  const [row] = await owner.em
    .getConnection()
    .execute<{ id: string }[]>(
      "insert into tenants (slug, display_name, status) values (?, ?, ?) returning id",
      [slug, `Pizzaria ${slug}`, status],
    );
  // A live store always has a current plan (ADR 0024), as the platform functions guarantee.
  if (status === "ACTIVE" || status === "SUSPENDED")
    await owner.em.fork().transactional(async (em) => {
      await em.execute("select set_config('app.tenant_id', ?, true)", [
        row!.id,
      ]);
      await em.execute(
        `insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from)
         select ?, code, fee_basis_points, monthly_fee_cents, now() - interval '1 day' from plans where code = 'FLEX'`,
        [row!.id],
      );
    });
  await publishTestLegalDocuments(owner, row!.id);
  return row!.id;
}

/** Version every test sign-up sends for both documents. */
export const TEST_LEGAL_VERSION = "2026-10";

/**
 * Publishes a privacy policy and terms of use (ADR 0030), as an operator would before the store
 * takes sign-ups; written as the owner, like the plan above.
 */
export async function publishTestLegalDocuments(
  owner: MikroORM,
  tenantId: string,
  version = TEST_LEGAL_VERSION,
): Promise<void> {
  await owner.em.fork().transactional(async (em) => {
    // Suites that migrate only up to an earlier schema have no legal documents yet.
    const [table] = await em.execute<{ exists: boolean }[]>(
      "select to_regclass('legal_documents') is not null as exists",
    );
    if (!table!.exists) return;
    await em.execute("select set_config('app.tenant_id', ?, true)", [tenantId]);
    await em.execute(
      `insert into legal_documents (tenant_id, kind, version, revision, body, body_sha256)
       select ?, k.kind, ?::text,
              coalesce((select max(d.revision) from legal_documents d
                         where d.tenant_id = ? and d.kind = k.kind), 0) + 1,
              k.body, sha256(convert_to(k.body, 'UTF8'))
         from (values ('PRIVACY_POLICY', 'Política de teste ' || ?::text),
                      ('TERMS_OF_USE', 'Termos de teste ' || ?::text)) as k (kind, body)`,
      [tenantId, version, tenantId, version, version],
    );
  });
}

export async function insertStaffUser(
  owner: MikroORM,
  email: string,
  password: string,
  status = "ACTIVE",
): Promise<string> {
  const [row] = await owner.em
    .getConnection()
    .execute<{ id: string }[]>(
      "insert into staff_users (email, name, password_hash, status) values (?, ?, ?, ?) returning id",
      [email, "Pessoa Teste", await hashPassword(password), status],
    );
  return row!.id;
}

export async function insertMembership(
  owner: MikroORM,
  tenantId: string,
  staffUserId: string,
  role: "OWNER" | "MANAGER" | "STAFF",
  status = "ACTIVE",
): Promise<void> {
  await runInTenant(owner, tenantId, (em) =>
    em.execute(
      "insert into memberships (tenant_id, staff_user_id, role, status) values (?, ?, ?, ?)",
      [tenantId, staffUserId, role, status],
    ),
  );
}

export async function setMembershipStatus(
  owner: MikroORM,
  tenantId: string,
  staffUserId: string,
  status: "ACTIVE" | "REVOKED",
): Promise<void> {
  await runInTenant(owner, tenantId, (em) =>
    em.execute(
      "update memberships set status = ? where tenant_id = ? and staff_user_id = ?",
      [status, tenantId, staffUserId],
    ),
  );
}

export interface StaffLogin {
  accessToken: string;
  /** `name=value` of the refresh cookie, ready for a Cookie header. */
  cookie: string;
}

export const refreshCookieOf = (response: Response): string | undefined =>
  response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("__Secure-wo_staff_refresh="))
    ?.split(";")[0];

export async function staffLogin(
  baseUrl: string,
  email: string,
  password: string,
): Promise<StaffLogin> {
  const response = await fetch(`${baseUrl}/v1/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { accessToken: string };
  const cookie = refreshCookieOf(response);
  assert.ok(cookie);
  return { accessToken: body.accessToken, cookie };
}

export async function switchTenant(
  baseUrl: string,
  accessToken: string,
  tenantId: string,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/admin/auth/active-tenant`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ tenantId }),
  });
}

export const bearer = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`,
});
