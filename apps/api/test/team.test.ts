import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { json, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import {
  bearer,
  insertMembership,
  insertStaffUser,
  insertTenant,
  staffLogin,
  switchTenant,
  type StaffLogin,
} from "./staff-fixtures";
import { runInTenant } from "../src/tenancy/tenant-transaction";

const PASSWORD = "equipe-teste-2026";
const NEW_PASSWORD = "senha-nova-da-equipe";
const ADMIN_ORIGIN = "https://admin.whiteoven.test";

interface Person {
  email: string;
  userId: string;
  /** Access token with this store active. */
  token: string;
  login: StaffLogin;
}

describe("M3.6 team management", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let server: TestServer;
  let tenantA: string;
  let tenantB: string;

  const signIn = async (
    email: string,
    tenantId: string,
    password = PASSWORD,
  ) => {
    const login = await staffLogin(server.baseUrl, email, password);
    const switched = await switchTenant(
      server.baseUrl,
      login.accessToken,
      tenantId,
    );
    assert.equal(switched.status, 200);
    return { login, token: (await json(switched)).accessToken as string };
  };
  const person = async (
    tenantId: string,
    role: "OWNER" | "MANAGER" | "STAFF",
    email = `equipe-${role.toLowerCase()}-${randomUUID()}@test.invalid`,
  ): Promise<Person> => {
    const userId = await insertStaffUser(owner, email, PASSWORD);
    await insertMembership(owner, tenantId, userId, role);
    return { email, userId, ...(await signIn(email, tenantId)) };
  };
  const api = (
    token: string | null,
    path: string,
    method = "GET",
    body?: unknown,
    /** Creating an invite needs one; each call gets a new key unless given. */
    idempotencyKey: string | null = randomUUID(),
  ) =>
    fetch(`${server.baseUrl}/v1${path}`, {
      method,
      headers: {
        ...(token ? bearer(token) : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(method === "POST" &&
        path === "/admin/team/invites" &&
        idempotencyKey
          ? { "idempotency-key": idempotencyKey }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const team = async (token: string) => {
    const response = await api(token, "/admin/team");
    assert.equal(response.status, 200);
    return json(response);
  };
  const invite = async (token: string, email: string, role = "STAFF") => {
    const response = await api(token, "/admin/team/invites", "POST", {
      email,
      role,
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await json(response);
    const prefix = `${ADMIN_ORIGIN}/equipe/convite/`;
    assert.ok(body.inviteUrl.startsWith(prefix));
    return { ...body, token: body.inviteUrl.slice(prefix.length) as string };
  };
  const preview = (token: string) =>
    api(null, "/team/invites/preview", "POST", { token });
  const redeem = (body: Record<string, string>) =>
    api(null, "/team/invites/redeem", "POST", body);
  const membershipOf = async (tenantId: string, userId: string) => {
    const [row] = await runInTenant(owner, tenantId, (em) =>
      em.execute<{ id: string; role: string; status: string }[]>(
        "select id, role, status from memberships where tenant_id = ? and staff_user_id = ?",
        [tenantId, userId],
      ),
    );
    return row;
  };
  const audits = async (tenantId: string) =>
    owner.em
      .getConnection()
      .execute<
        { action: string; actor: string; changes: Record<string, unknown> }[]
      >(
        `select action, actor_id as actor, changes from audit_events
          where tenant_id = ? and action like 'team.%' order by at, id`,
        [tenantId],
      );

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    tenantA = await insertTenant(owner, `team-a-${randomUUID().slice(0, 8)}`);
    tenantB = await insertTenant(owner, `team-b-${randomUUID().slice(0, 8)}`);
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: "3",
      API_ADMIN_ORIGINS: ADMIN_ORIGIN,
    });
  });
  after(async () => {
    await server?.close();
    await owner?.close();
    await database?.drop();
  });

  it("lets only the OWNER see the team, with their own row marked", async () => {
    const dona = await person(tenantA, "OWNER");
    const manager = await person(tenantA, "MANAGER");
    const staff = await person(tenantA, "STAFF");
    const body = await team(dona.token);
    assert.deepEqual(
      body.members.map((m: { email: string; role: string; you: boolean }) => [
        m.email,
        m.role,
        m.you,
      ]),
      [
        [dona.email, "OWNER", true],
        [manager.email, "MANAGER", false],
        [staff.email, "STAFF", false],
      ],
    );
    assert.deepEqual(body.invites, []);
    for (const who of [manager, staff]) {
      const response = await api(who.token, "/admin/team");
      assert.equal(response.status, 403);
      assert.equal((await json(response)).code, "ROLE_FORBIDDEN");
      const write = await api(who.token, "/admin/team/invites", "POST", {
        email: "x@test.invalid",
        role: "STAFF",
      });
      assert.equal(write.status, 403);
    }
  });

  it("invites a new person, who creates an account and joins with the invited role", async () => {
    const dona = await person(tenantA, "OWNER");
    const email = `nova-${randomUUID()}@test.invalid`;
    const created = await invite(dona.token, `  ${email.toUpperCase()} `);
    assert.equal(created.invite.email, email);
    assert.equal(created.invite.role, "STAFF");
    assert.equal(created.expiresIn, 72 * 60 * 60);
    assert.equal(created.token.length, 43);
    // Only the hash is stored.
    const [stored] = await runInTenant(owner, tenantA, (em) =>
      em.execute<{ token_hash: Buffer }[]>(
        "select token_hash from staff_invites where id = ?",
        [created.invite.id],
      ),
    );
    assert.deepEqual(
      stored!.token_hash,
      createHash("sha256").update(created.token).digest(),
    );
    assert.deepEqual(
      (await team(dona.token)).invites.map((i: { id: string }) => i.id),
      [created.invite.id],
    );

    const peek = await preview(created.token);
    assert.equal(peek.status, 200);
    assert.equal(peek.headers.get("cache-control"), "no-store");
    const shown = await json(peek);
    assert.match(shown.storeName, /^Pizzaria team-a-/);
    assert.equal(shown.role, "STAFF");
    assert.equal(shown.email, email);
    assert.equal(shown.accountExists, false);

    const missing = await redeem({ token: created.token, password: "curta" });
    assert.equal(missing.status, 422);
    assert.deepEqual(
      (await json(missing)).details.errors.map((e: { path: string }) => e.path),
      ["name", "password"],
    );
    const joined = await redeem({
      token: created.token,
      name: "  Nova Pessoa ",
      password: NEW_PASSWORD,
    });
    assert.equal(joined.status, 200);
    assert.deepEqual(await json(joined), {
      storeName: shown.storeName,
      role: "STAFF",
      newAccount: true,
    });
    // Single use.
    assert.equal((await preview(created.token)).status, 410);
    const again = await redeem({
      token: created.token,
      name: "Outra",
      password: NEW_PASSWORD,
    });
    assert.equal(again.status, 410);
    assert.equal((await json(again)).code, "INVITE_INVALID");

    const member = await signIn(email, tenantA, NEW_PASSWORD);
    const me = await json(await api(member.token, "/admin/me"));
    assert.equal(me.role, "STAFF");
    const listed = await team(dona.token);
    assert.deepEqual(listed.invites, []);
    assert.ok(
      listed.members.some(
        (m: { email: string; name: string }) =>
          m.email === email && m.name === "Nova Pessoa",
      ),
    );
    assert.deepEqual(
      (await audits(tenantA))
        .filter((a) => a.action !== "team.role_changed")
        .slice(-2)
        .map((a) => [a.action, a.changes]),
      [
        ["team.invite_created", { role: "STAFF", expiresInHours: 72 }],
        ["team.invite_redeemed", { role: "STAFF", newAccount: true }],
      ],
    );
  });

  it("lets a person who already has an account join by confirming their password", async () => {
    const dona = await person(tenantA, "OWNER");
    const elsewhere = await person(tenantB, "OWNER");
    const created = await invite(dona.token, elsewhere.email, "MANAGER");
    assert.equal(
      (await json(await preview(created.token))).accountExists,
      true,
    );

    const wrong = await redeem({
      token: created.token,
      password: "errada-123",
    });
    assert.equal(wrong.status, 401);
    assert.equal((await json(wrong)).code, "INVALID_CREDENTIALS");
    // The name is ignored for an existing account; the invite is still pending.
    const joined = await redeem({
      token: created.token,
      password: PASSWORD,
      name: "Outro Nome",
    });
    assert.equal(joined.status, 200);
    assert.equal((await json(joined)).newAccount, false);
    assert.equal(
      (await membershipOf(tenantA, elsewhere.userId))?.role,
      "MANAGER",
    );
    // The existing session in the other store keeps working.
    assert.equal((await api(elsewhere.token, "/admin/team")).status, 200);
  });

  it("locks the password confirmation like the login after repeated failures", async () => {
    const dona = await person(tenantA, "OWNER");
    const target = await person(tenantB, "STAFF");
    const created = await invite(dona.token, target.email);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++)
      statuses.push(
        (await redeem({ token: created.token, password: "errada-123" })).status,
      );
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 429]);
    // Even the right password waits for the lock.
    const locked = await redeem({ token: created.token, password: PASSWORD });
    assert.equal(locked.status, 429);
    assert.equal((await json(locked)).code, "RATE_LIMITED");
    assert.equal(await membershipOf(tenantA, target.userId), undefined);
  });

  it("refuses inviting an active member, replaces a pending invite and cancels one", async () => {
    const dona = await person(tenantA, "OWNER");
    const staff = await person(tenantA, "STAFF");
    const already = await api(dona.token, "/admin/team/invites", "POST", {
      email: staff.email.toUpperCase(),
      role: "MANAGER",
    });
    assert.equal(already.status, 409);
    assert.equal((await json(already)).code, "ALREADY_MEMBER");

    const email = `pendente-${randomUUID()}@test.invalid`;
    const first = await invite(dona.token, email);
    const second = await invite(dona.token, email, "MANAGER");
    assert.equal((await preview(first.token)).status, 410);
    assert.equal((await json(await preview(second.token))).role, "MANAGER");
    const pending = (await team(dona.token)).invites.filter(
      (i: { email: string }) => i.email === email,
    );
    assert.deepEqual(
      pending.map((i: { id: string }) => i.id),
      [second.invite.id],
    );

    const canceled = await api(
      dona.token,
      `/admin/team/invites/${second.invite.id}`,
      "DELETE",
    );
    assert.equal(canceled.status, 204);
    assert.equal((await preview(second.token)).status, 410);
    const twice = await api(
      dona.token,
      `/admin/team/invites/${second.invite.id}`,
      "DELETE",
    );
    assert.equal(twice.status, 404);
    assert.equal((await json(twice)).code, "INVITE_NOT_FOUND");
    assert.ok(
      (await audits(tenantA)).some((a) => a.action === "team.invite_canceled"),
    );
  });

  it("returns the same link for a retry with the same Idempotency-Key", async () => {
    const dona = await person(tenantA, "OWNER");
    const key = randomUUID();
    const email = `retry-${randomUUID()}@test.invalid`;
    const send = (role: string) =>
      api(dona.token, "/admin/team/invites", "POST", { email, role }, key);
    const first = await json(await send("STAFF"));
    const retry = await send("STAFF");
    assert.equal(retry.status, 201);
    const again = await json(retry);
    assert.equal(again.inviteUrl, first.inviteUrl);
    assert.equal(again.invite.id, first.invite.id);
    const token = (first.inviteUrl as string).split("/").pop()!;
    assert.equal((await preview(token)).status, 200);
    assert.equal(
      (await audits(tenantA)).filter(
        (a) => a.action === "team.invite_created" && a.actor === dona.userId,
      ).length,
      1,
    );
    const changed = await send("MANAGER");
    assert.equal(changed.status, 409);
    assert.equal((await json(changed)).code, "IDEMPOTENCY_CONFLICT");
    const missing = await api(
      dona.token,
      "/admin/team/invites",
      "POST",
      { email, role: "STAFF" },
      null,
    );
    assert.equal(missing.status, 422);
    assert.deepEqual(
      (await json(missing)).details.errors.map((e: { path: string }) => e.path),
      ["Idempotency-Key"],
    );
  });

  it("refuses an expired invite and malformed bodies", async () => {
    const dona = await person(tenantA, "OWNER");
    const created = await invite(
      dona.token,
      `expira-${randomUUID()}@test.invalid`,
    );
    await runInTenant(owner, tenantA, (em) =>
      em.execute(
        "update staff_invites set created_at = now() - interval '73 hours', expires_at = now() - interval '1 hour' where id = ?",
        [created.invite.id],
      ),
    );
    assert.equal((await preview(created.token)).status, 410);
    assert.equal(
      (
        await redeem({
          token: created.token,
          name: "X",
          password: NEW_PASSWORD,
        })
      ).status,
      410,
    );
    assert.equal((await preview("curto")).status, 410);

    for (const [path, body, errorPath] of [
      ["/admin/team/invites", { email: "sem-arroba", role: "STAFF" }, "email"],
      ["/admin/team/invites", { email: "a@b.test", role: "ADMIN" }, "role"],
      ["/admin/team/invites", { email: "a@b.test", role: "STAFF", x: 1 }, "x"],
    ] as const) {
      const response = await api(dona.token, path, "POST", body);
      assert.equal(response.status, 422, errorPath);
      assert.deepEqual(
        (await json(response)).details.errors.map(
          (e: { path: string }) => e.path,
        ),
        [errorPath],
      );
    }
    const extra = await redeem({
      token: created.token,
      password: "x",
      role: "OWNER",
    });
    assert.equal(extra.status, 422);
  });

  it("changes a role, takes effect on the next request and is audited", async () => {
    const dona = await person(tenantA, "OWNER");
    const staff = await person(tenantA, "STAFF");
    const membership = (await membershipOf(tenantA, staff.userId))!;
    assert.equal(
      (await api(staff.token, "/admin/store/settings", "PUT", {})).status,
      403,
    );
    const changed = await api(
      dona.token,
      `/admin/team/members/${membership.id}`,
      "PATCH",
      { role: "MANAGER" },
    );
    assert.equal(changed.status, 204);
    assert.equal(
      (await json(await api(staff.token, "/admin/me"))).role,
      "MANAGER",
    );
    const [audit] = (await audits(tenantA)).filter(
      (a) => a.action === "team.role_changed",
    );
    assert.equal(audit!.actor, dona.userId);
    assert.deepEqual(audit!.changes, {
      role: { from: "STAFF", to: "MANAGER" },
    });
    const unknown = await api(
      dona.token,
      `/admin/team/members/${randomUUID()}`,
      "PATCH",
      { role: "STAFF" },
    );
    assert.equal(unknown.status, 404);
    assert.equal((await json(unknown)).code, "MEMBER_NOT_FOUND");
  });

  it("never leaves a store without an active OWNER", async () => {
    const store = await insertTenant(
      owner,
      `team-owner-${randomUUID().slice(0, 8)}`,
    );
    const solo = await person(store, "OWNER");
    const own = (await membershipOf(store, solo.userId))!;
    for (const [method, body] of [
      ["PATCH", { role: "MANAGER" }],
      ["DELETE", undefined],
    ] as const) {
      const response = await api(
        solo.token,
        `/admin/team/members/${own.id}`,
        method,
        body,
      );
      assert.equal(response.status, 409, method);
      assert.equal((await json(response)).code, "LAST_OWNER");
    }
    // The database refuses it too, whoever writes.
    await assert.rejects(
      runInTenant(owner, store, (em) =>
        em.execute("update memberships set role = 'STAFF' where id = ?", [
          own.id,
        ]),
      ),
      (error: { code?: string }) => error.code === "P0011",
    );

    // With a second owner, one may step down.
    const second = await person(store, "OWNER");
    const secondMembership = (await membershipOf(store, second.userId))!;
    assert.equal(
      (
        await api(solo.token, `/admin/team/members/${own.id}`, "PATCH", {
          role: "MANAGER",
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await api(
          second.token,
          `/admin/team/members/${secondMembership.id}`,
          "DELETE",
        )
      ).status,
      409,
    );
  });

  it("lets only one of two owners demoting each other at once win", async () => {
    for (let round = 0; round < 5; round++) {
      const store = await insertTenant(
        owner,
        `team-race-${randomUUID().slice(0, 8)}`,
      );
      const first = await person(store, "OWNER");
      const second = await person(store, "OWNER");
      const [firstId, secondId] = [
        (await membershipOf(store, first.userId))!.id,
        (await membershipOf(store, second.userId))!.id,
      ];
      const results = await Promise.all([
        api(first.token, `/admin/team/members/${secondId}`, "PATCH", {
          role: "STAFF",
        }),
        api(second.token, `/admin/team/members/${firstId}`, "PATCH", {
          role: "STAFF",
        }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      assert.equal(
        statuses.filter((s) => s === 204).length,
        1,
        String(statuses),
      );
      const [owners] = await runInTenant(owner, store, (em) =>
        em.execute<{ count: number }[]>(
          "select count(*)::int as count from memberships where role = 'OWNER' and status = 'ACTIVE'",
        ),
      );
      assert.equal(owners!.count, 1);
    }
  });

  it("revokes a member and ends their sessions in this store only", async () => {
    const dona = await person(tenantA, "OWNER");
    const email = `revogada-${randomUUID()}@test.invalid`;
    const member = await person(tenantA, "MANAGER", email);
    await insertMembership(owner, tenantB, member.userId, "STAFF");
    const inB = await signIn(email, tenantB);
    const membership = (await membershipOf(tenantA, member.userId))!;

    const revoked = await api(
      dona.token,
      `/admin/team/members/${membership.id}`,
      "DELETE",
    );
    assert.equal(revoked.status, 204);
    assert.equal(
      (await membershipOf(tenantA, member.userId))?.status,
      "REVOKED",
    );
    // The access token stops working at once, and the session cannot be refreshed.
    assert.equal((await api(member.token, "/admin/me")).status, 401);
    const refresh = await fetch(`${server.baseUrl}/v1/admin/auth/refresh`, {
      method: "POST",
      headers: { cookie: member.login.cookie, origin: ADMIN_ORIGIN },
    });
    assert.equal(refresh.status, 401);
    const [session] = await owner.em
      .getConnection()
      .execute<{ revoked_reason: string }[]>(
        "select revoked_reason from staff_sessions where active_tenant_id = ? and staff_user_id = ?",
        [tenantA, member.userId],
      );
    assert.equal(session!.revoked_reason, "MEMBERSHIP_REVOKED");
    // The session in the other store keeps working; this store is no longer offered.
    assert.equal((await api(inB.token, "/admin/me")).status, 200);
    assert.equal(
      (await switchTenant(server.baseUrl, inB.token, tenantA)).status,
      404,
    );
    const [audit] = (await audits(tenantA)).filter(
      (a) => a.action === "team.member_revoked",
    );
    assert.deepEqual(audit!.changes, { role: "MANAGER", sessionsRevoked: 1 });
    assert.ok(
      !(await team(dona.token)).members.some(
        (m: { email: string }) => m.email === email,
      ),
    );

    // A new invite brings the person back.
    const back = await invite(dona.token, email);
    assert.equal(
      (await redeem({ token: back.token, password: PASSWORD })).status,
      200,
    );
    const rejoined = (await membershipOf(tenantA, member.userId))!;
    assert.equal(rejoined.id, membership.id);
    assert.deepEqual([rejoined.role, rejoined.status], ["STAFF", "ACTIVE"]);
  });

  it("refuses an invite redeemed after the person joined another way", async () => {
    const dona = await person(tenantA, "OWNER");
    const target = await person(tenantB, "OWNER");
    const created = await invite(dona.token, target.email, "STAFF");
    await insertMembership(owner, tenantA, target.userId, "OWNER");
    const response = await redeem({ token: created.token, password: PASSWORD });
    assert.equal(response.status, 409);
    assert.equal((await json(response)).code, "ALREADY_MEMBER");
    assert.equal((await membershipOf(tenantA, target.userId))?.role, "OWNER");
  });

  it("keeps each store's team to itself", async () => {
    const donaA = await person(tenantA, "OWNER");
    const donaB = await person(tenantB, "OWNER");
    const staffB = await person(tenantB, "STAFF");
    const membershipB = (await membershipOf(tenantB, staffB.userId))!;
    const inviteB = await invite(donaB.token, `b-${randomUUID()}@test.invalid`);
    for (const [method, path, body] of [
      ["PATCH", `/admin/team/members/${membershipB.id}`, { role: "OWNER" }],
      ["DELETE", `/admin/team/members/${membershipB.id}`, undefined],
      ["DELETE", `/admin/team/invites/${inviteB.invite.id}`, undefined],
    ] as const) {
      const response = await api(donaA.token, path, method, body);
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    assert.equal((await membershipOf(tenantB, staffB.userId))?.role, "STAFF");
    assert.equal((await preview(inviteB.token)).status, 200);
    const listA = await team(donaA.token);
    assert.ok(
      !listA.members.some((m: { email: string }) => m.email === staffB.email),
    );
    assert.ok(
      !listA.invites.some((i: { id: string }) => i.id === inviteB.invite.id),
    );
  });

  it("refuses team changes in a suspended store and its pending invites", async () => {
    const store = await insertTenant(
      owner,
      `team-susp-${randomUUID().slice(0, 8)}`,
    );
    const dona = await person(store, "OWNER");
    const created = await invite(
      dona.token,
      `susp-${randomUUID()}@test.invalid`,
    );
    await owner.em
      .getConnection()
      .execute("update tenants set status = 'SUSPENDED' where id = ?", [store]);
    const suspended = await signIn(dona.email, store);
    assert.equal((await api(suspended.token, "/admin/team")).status, 200);
    const write = await api(suspended.token, "/admin/team/invites", "POST", {
      email: "x@test.invalid",
      role: "STAFF",
    });
    assert.equal(write.status, 403);
    assert.equal((await json(write)).code, "TEAM_WRITE_FORBIDDEN");
    assert.equal((await preview(created.token)).status, 410);
  });

  it("refuses the app role running team functions without a live OWNER session", async () => {
    const staff = await person(tenantA, "STAFF");
    const dona = await person(tenantA, "OWNER");
    const membership = (await membershipOf(tenantA, dona.userId))!;
    const [session] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "select id from staff_sessions where staff_user_id = ? and active_tenant_id = ?",
        [staff.userId, tenantA],
      );
    const app = await database.connect(database.appUrl);
    try {
      await assert.rejects(
        runInTenant(app, tenantA, (em) =>
          em.execute("select whiteoven_team_revoke_member(?, ?, ?, null)", [
            membership.id,
            staff.userId,
            session!.id,
          ]),
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await assert.rejects(
        runInTenant(app, tenantA, (em) =>
          em.execute("delete from staff_invites"),
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await assert.rejects(
        app.em.getConnection().execute("select * from staff_invite_lookup"),
        (error: { code?: string }) => error.code === "42501",
      );
    } finally {
      await app.close();
    }
    assert.equal((await membershipOf(tenantA, dona.userId))?.status, "ACTIVE");
  });
});
