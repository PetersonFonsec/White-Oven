import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
} from "./staff-fixtures";
import { runInTenant } from "../src/tenancy/tenant-transaction";

const PASSWORD = "cliente-senha-forte";
const address = {
  label: "Casa",
  postalCode: "01310-100",
  street: "Avenida Paulista",
  number: "1000",
  complement: "Apto 12",
  district: "Bela Vista",
  city: "São Paulo",
  state: "sp",
  reference: null,
};

describe("M4.2 customer accounts", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let server: TestServer;
  const stores: Record<"a" | "b", { id: string; slug: string }> = {
    a: { id: "", slug: `cliente-a-${randomUUID().slice(0, 8)}` },
    b: { id: "", slug: `cliente-b-${randomUUID().slice(0, 8)}` },
  };

  const post = (slug: string, path: string, body: unknown, token?: string) =>
    fetch(`${server.baseUrl}/v1/customer/stores/${slug}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? bearer(token) : {}),
      },
      body: JSON.stringify(body),
    });
  const call = (
    slug: string,
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
  ) =>
    fetch(`${server.baseUrl}/v1/customer/stores/${slug}/${path}`, {
      method,
      headers: {
        ...bearer(token),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const signUp = async (
    slug: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const email =
      (overrides["email"] as string | undefined) ??
      `cliente-${randomUUID()}@teste.invalid`;
    const response = await post(slug, "auth/register", {
      name: "Maria Cliente",
      password: PASSWORD,
      privacyPolicyVersion: "2026-10",
      ...overrides,
      email,
    });
    assert.equal(
      response.status,
      201,
      JSON.stringify(await response.clone().json()),
    );
    return { email, ...(await json(response)) };
  };
  const customerRow = async (tenantId: string, email: string) => {
    const [row] = await runInTenant(owner, tenantId, (em) =>
      em.execute<Record<string, unknown>[]>(
        "select * from customers where email = ?",
        [email],
      ),
    );
    return row;
  };

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    stores.a.id = await insertTenant(owner, stores.a.slug);
    stores.b.id = await insertTenant(owner, stores.b.slug);
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: "2",
    });
  });
  after(async () => {
    await server?.close();
    await owner?.close();
    await database?.drop();
  });

  it("signs up, answers no-store tokens and reads the account back", async () => {
    const email = `Nova.${randomUUID()}@Teste.Invalid`;
    const response = await post(stores.a.slug, "auth/register", {
      name: "  Ana Souza ",
      email: `  ${email} `,
      password: PASSWORD,
      phone: "+5511999990000",
      privacyPolicyVersion: "2026-10",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const tokens = await json(response);
    assert.equal(tokens.tokenType, "Bearer");
    assert.equal(tokens.expiresIn, 900);
    assert.match(tokens.refreshToken, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    const days =
      (Date.parse(tokens.refreshExpiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, String(days));

    const me = await call(stores.a.slug, "me", tokens.accessToken);
    assert.equal(me.status, 200);
    const profile = await json(me);
    assert.deepEqual(
      { ...profile, id: undefined, acceptedAt: undefined },
      {
        id: undefined,
        name: "Ana Souza",
        email: email.toLowerCase(),
        phone: "+5511999990000",
        privacyPolicyVersion: "2026-10",
        acceptedAt: undefined,
      },
    );
    // Only the hashes are stored.
    const row = await customerRow(stores.a.id, email.toLowerCase());
    assert.match(String(row!["password_hash"]), /^\$argon2id\$/);
    const [session] = await runInTenant(owner, stores.a.id, (em) =>
      em.execute<{ hash: Buffer }[]>(
        "select refresh_token_hash as hash from customer_sessions where customer_id = ?",
        [row!["id"]],
      ),
    );
    assert.equal(session!.hash.length, 32);
    assert.doesNotMatch(
      session!.hash.toString("utf8"),
      new RegExp(tokens.refreshToken.split(".")[1]),
    );
  });

  it("keeps e-mails unique per store only (D-03)", async () => {
    const first = await signUp(stores.a.slug);
    const again = await post(stores.a.slug, "auth/register", {
      name: "Outra",
      email: first.email.toUpperCase(),
      password: PASSWORD,
      privacyPolicyVersion: "2026-10",
    });
    assert.equal(again.status, 409);
    assert.equal((await json(again)).code, "EMAIL_TAKEN");
    const otherStore = await signUp(stores.b.slug, { email: first.email });
    assert.ok(otherStore.accessToken);
    const phone = `+55119${String(Date.now()).slice(-8)}`;
    await signUp(stores.a.slug, { phone });
    const samePhone = await post(stores.a.slug, "auth/register", {
      name: "Outra",
      email: `fone-${randomUUID()}@teste.invalid`,
      password: PASSWORD,
      phone,
      privacyPolicyVersion: "2026-10",
    });
    assert.equal(samePhone.status, 409);
    assert.equal((await json(samePhone)).code, "PHONE_TAKEN");
  });

  it("refuses invalid sign-ups with the offending fields only", async () => {
    const response = await post(stores.a.slug, "auth/register", {
      name: " ",
      email: "sem-arroba",
      password: "1234567890",
      phone: "11999990000",
      privacyPolicyVersion: "",
      admin: true,
    });
    assert.equal(response.status, 422);
    const body = await json(response);
    assert.equal(body.code, "VALIDATION_FAILED");
    assert.deepEqual(
      body.details.errors.map((error: { path: string }) => error.path).sort(),
      ["admin", "email", "name", "password", "phone", "privacyPolicyVersion"],
    );
    assert.doesNotMatch(JSON.stringify(body), /1234567890|sem-arroba/);
  });

  it("signs in with the same answer for an unknown e-mail and a wrong password, then locks out", async () => {
    const { email } = await signUp(stores.a.slug);
    const ok = await post(stores.a.slug, "auth/login", {
      email: ` ${email.toUpperCase()} `,
      password: PASSWORD,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const wrong = await post(stores.a.slug, "auth/login", {
      email,
      password: "senha-errada-123",
    });
    const unknown = await post(stores.a.slug, "auth/login", {
      email: `ninguem-${randomUUID()}@teste.invalid`,
      password: PASSWORD,
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(
      { ...(await json(wrong)), requestId: undefined },
      { ...(await json(unknown)), requestId: undefined },
    );
    // The account in another store is someone else: wrong store, wrong credentials.
    const elsewhere = await post(stores.b.slug, "auth/login", {
      email,
      password: PASSWORD,
    });
    assert.equal(elsewhere.status, 401);

    for (let attempt = 0; attempt < 5; attempt++)
      await post(stores.a.slug, "auth/login", {
        email,
        password: "errada-123456",
      });
    const locked = await post(stores.a.slug, "auth/login", {
      email,
      password: PASSWORD,
    });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
  });

  it("refuses a token of store A on store B (T-03) and keeps staff and customer tokens apart", async () => {
    const customer = await signUp(stores.a.slug);
    const cross = await call(stores.b.slug, "me", customer.accessToken);
    assert.equal(cross.status, 404);
    assert.equal((await json(cross)).code, "NOT_FOUND");
    const crossRefresh = await post(stores.b.slug, "auth/refresh", {
      refreshToken: customer.refreshToken,
    });
    assert.equal(crossRefresh.status, 401);
    // The refresh token still works in its own store: store B's attempt changed nothing.
    const own = await post(stores.a.slug, "auth/refresh", {
      refreshToken: customer.refreshToken,
    });
    assert.equal(own.status, 200);

    const admin = await fetch(`${server.baseUrl}/v1/admin/me`, {
      headers: bearer(customer.accessToken),
    });
    assert.equal(admin.status, 401);

    const email = `equipe-${randomUUID()}@teste.invalid`;
    const staffId = await insertStaffUser(owner, email, PASSWORD);
    await insertMembership(owner, stores.a.id, staffId, "OWNER");
    const login = await staffLogin(server.baseUrl, email, PASSWORD);
    const { accessToken: staffToken } = await json(
      await switchTenant(server.baseUrl, login.accessToken, stores.a.id),
    );
    const staffOnCustomer = await call(stores.a.slug, "me", staffToken);
    assert.equal(staffOnCustomer.status, 401);
    assert.equal((await call(stores.a.slug, "me", "nao-e-token")).status, 401);
  });

  it("rotates refresh tokens and revokes the session when a rotated one comes back", async () => {
    const customer = await signUp(stores.a.slug);
    const first = await post(stores.a.slug, "auth/refresh", {
      refreshToken: customer.refreshToken,
    });
    assert.equal(first.status, 200);
    const rotated = await json(first);
    assert.notEqual(rotated.refreshToken, customer.refreshToken);
    // The session keeps its original end: refreshing never extends it.
    assert.equal(rotated.refreshExpiresAt, customer.refreshExpiresAt);

    const replay = await post(stores.a.slug, "auth/refresh", {
      refreshToken: customer.refreshToken,
    });
    assert.equal(replay.status, 401);
    const afterReplay = await post(stores.a.slug, "auth/refresh", {
      refreshToken: rotated.refreshToken,
    });
    assert.equal(afterReplay.status, 401);
    assert.equal(
      (await call(stores.a.slug, "me", rotated.accessToken)).status,
      401,
    );
    for (const refreshToken of ["", "x", `${randomUUID()}.${"a".repeat(43)}`])
      assert.ok(
        [401, 422].includes(
          (await post(stores.a.slug, "auth/refresh", { refreshToken })).status,
        ),
      );
  });

  it("logs out on the next request and expires sessions after 30 days", async () => {
    const customer = await signUp(stores.a.slug);
    const out = await post(stores.a.slug, "auth/logout", {
      refreshToken: customer.refreshToken,
    });
    assert.equal(out.status, 204);
    assert.equal(
      (await call(stores.a.slug, "me", customer.accessToken)).status,
      401,
    );
    assert.equal(
      (
        await post(stores.a.slug, "auth/refresh", {
          refreshToken: customer.refreshToken,
        })
      ).status,
      401,
    );
    // Logging out twice, or with garbage, is still a 204.
    for (const refreshToken of [customer.refreshToken, "lixo"])
      assert.equal(
        (await post(stores.a.slug, "auth/logout", { refreshToken })).status,
        204,
      );

    const expiring = await signUp(stores.a.slug);
    await runInTenant(owner, stores.a.id, (em) =>
      em.execute(
        "update customer_sessions set expires_at = now() - interval '1 second' where id = ?",
        [expiring.refreshToken.split(".")[0]],
      ),
    );
    assert.equal(
      (await call(stores.a.slug, "me", expiring.accessToken)).status,
      401,
    );
    assert.equal(
      (
        await post(stores.a.slug, "auth/refresh", {
          refreshToken: expiring.refreshToken,
        })
      ).status,
      401,
    );
  });

  it("keeps addresses per customer: create, list, replace, remove, limit", async () => {
    const maria = await signUp(stores.a.slug);
    const joao = await signUp(stores.a.slug);
    const created = await call(
      stores.a.slug,
      "me/addresses",
      maria.accessToken,
      "POST",
      address,
    );
    assert.equal(created.status, 201);
    const saved = await json(created);
    assert.deepEqual(
      { ...saved, id: undefined },
      { ...address, id: undefined, postalCode: "01310100", state: "SP" },
    );
    assert.deepEqual(
      await json(await call(stores.a.slug, "me/addresses", maria.accessToken)),
      [saved],
    );
    assert.deepEqual(
      await json(await call(stores.a.slug, "me/addresses", joao.accessToken)),
      [],
    );

    // Another customer's address is a 404, unchanged.
    for (const [method, body] of [
      ["PUT", { ...address, label: "Roubado" }],
      ["DELETE", undefined],
    ] as const) {
      const response = await call(
        stores.a.slug,
        `me/addresses/${saved.id}`,
        joao.accessToken,
        method,
        body,
      );
      assert.equal(response.status, 404, method);
    }
    const replaced = await call(
      stores.a.slug,
      `me/addresses/${saved.id}`,
      maria.accessToken,
      "PUT",
      { ...address, label: "Trabalho", complement: " " },
    );
    assert.equal(replaced.status, 200);
    assert.deepEqual(
      { label: (await json(replaced)).label },
      { label: "Trabalho" },
    );
    const invalid = await call(
      stores.a.slug,
      "me/addresses",
      maria.accessToken,
      "POST",
      {
        ...address,
        postalCode: "123",
        state: "São",
        extra: 1,
      },
    );
    assert.equal(invalid.status, 422);
    assert.deepEqual(
      (await json(invalid)).details.errors
        .map((e: { path: string }) => e.path)
        .sort(),
      ["extra", "postalCode", "state"],
    );

    for (let index = 1; index < 10; index++)
      assert.equal(
        (
          await call(
            stores.a.slug,
            "me/addresses",
            maria.accessToken,
            "POST",
            address,
          )
        ).status,
        201,
      );
    const eleventh = await call(
      stores.a.slug,
      "me/addresses",
      maria.accessToken,
      "POST",
      address,
    );
    assert.equal(eleventh.status, 409);
    assert.equal((await json(eleventh)).code, "ADDRESS_LIMIT_REACHED");

    assert.equal(
      (
        await call(
          stores.a.slug,
          `me/addresses/${saved.id}`,
          maria.accessToken,
          "DELETE",
        )
      ).status,
      204,
    );
    assert.equal(
      (
        await call(
          stores.a.slug,
          `me/addresses/${saved.id}`,
          maria.accessToken,
          "DELETE",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          stores.a.slug,
          "me/addresses/nao-e-uuid",
          maria.accessToken,
          "DELETE",
        )
      ).status,
      404,
    );
  });

  it("deletes the account by anonymizing it: data gone, sessions revoked, id kept", async () => {
    const customer = await signUp(stores.a.slug, { phone: "+5521988887777" });
    const other = await post(stores.a.slug, "auth/login", {
      email: customer.email,
      password: PASSWORD,
    });
    const secondDevice = await json(other);
    await call(
      stores.a.slug,
      "me/addresses",
      customer.accessToken,
      "POST",
      address,
    );
    const { id } = (await customerRow(stores.a.id, customer.email))!;

    const wrong = await call(
      stores.a.slug,
      "me",
      customer.accessToken,
      "DELETE",
      {
        password: "senha-errada-123",
      },
    );
    assert.equal(wrong.status, 403);
    assert.equal((await json(wrong)).code, "PASSWORD_MISMATCH");

    const deleted = await call(
      stores.a.slug,
      "me",
      customer.accessToken,
      "DELETE",
      {
        password: PASSWORD,
      },
    );
    assert.equal(deleted.status, 204);

    const [row] = await runInTenant(owner, stores.a.id, (em) =>
      em.execute<Record<string, unknown>[]>(
        "select * from customers where id = ?",
        [id],
      ),
    );
    assert.equal(row!["status"], "DELETED");
    for (const column of ["name", "email", "phone", "password_hash"])
      assert.equal(row![column], null, column);
    assert.ok(row!["deleted_at"]);
    const [left] = await runInTenant(owner, stores.a.id, (em) =>
      em.execute<{ addresses: number; live: number }[]>(
        `select (select count(*)::int from customer_addresses where customer_id = ?) as addresses,
                (select count(*)::int from customer_sessions where customer_id = ? and revoked_at is null) as live`,
        [id, id],
      ),
    );
    assert.deepEqual(left, { addresses: 0, live: 0 });

    for (const token of [customer.accessToken, secondDevice.accessToken])
      assert.equal((await call(stores.a.slug, "me", token)).status, 401);
    assert.equal(
      (
        await post(stores.a.slug, "auth/refresh", {
          refreshToken: secondDevice.refreshToken,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await post(stores.a.slug, "auth/login", {
          email: customer.email,
          password: PASSWORD,
        })
      ).status,
      401,
    );
    // The e-mail and phone are free again: a new account, a new id.
    const again = await signUp(stores.a.slug, {
      email: customer.email,
      phone: "+5521988887777",
    });
    assert.notEqual((await customerRow(stores.a.id, again.email))!["id"], id);
  });

  it("follows the status matrix: suspended stores allow sign-in, reading and deletion only", async () => {
    const slug = `cliente-suspensa-${randomUUID().slice(0, 8)}`;
    const tenantId = await insertTenant(owner, slug);
    const customer = await signUp(slug);
    await call(slug, "me/addresses", customer.accessToken, "POST", address);
    await owner.em
      .getConnection()
      .execute("update tenants set status = 'SUSPENDED' where id = ?", [
        tenantId,
      ]);

    const register = await post(slug, "auth/register", {
      name: "Nova",
      email: `nova-${randomUUID()}@teste.invalid`,
      password: PASSWORD,
      privacyPolicyVersion: "2026-10",
    });
    assert.equal(register.status, 403);
    assert.equal((await json(register)).code, "TENANT_NOT_ACTIVE");
    const login = await post(slug, "auth/login", {
      email: customer.email,
      password: PASSWORD,
    });
    assert.equal(login.status, 200);
    const { accessToken } = await json(login);
    assert.equal((await call(slug, "me", accessToken)).status, 200);
    assert.equal((await call(slug, "me/addresses", accessToken)).status, 200);
    const write = await call(
      slug,
      "me/addresses",
      accessToken,
      "POST",
      address,
    );
    assert.equal(write.status, 403);
    assert.equal((await json(write)).code, "TENANT_NOT_ACTIVE");
    assert.equal(
      (await call(slug, "me", accessToken, "DELETE", { password: PASSWORD }))
        .status,
      204,
    );
  });

  it("lets the app role neither delete customers nor reach another store's rows", async () => {
    const customer = await signUp(stores.b.slug);
    const app = await database.connect(database.appUrl);
    try {
      const { id } = (await customerRow(stores.b.id, customer.email))!;
      await assert.rejects(
        runInTenant(app, stores.b.id, (em) =>
          em.execute("delete from customers where id = ?", [id]),
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      await assert.rejects(
        runInTenant(app, stores.b.id, (em) =>
          em.execute("delete from customer_sessions where customer_id = ?", [
            id,
          ]),
        ),
        (error: { code?: string }) => error.code === "42501",
      );
      const seen = await runInTenant(app, stores.a.id, (em) =>
        em.execute(
          `select (select count(*)::int from customers where id = ?) +
                  (select count(*)::int from customer_sessions where customer_id = ?) as n`,
          [id, id],
        ),
      );
      assert.deepEqual(seen, [{ n: 0 }]);
      // A row of store B cannot be written from store A's context either.
      await assert.rejects(
        runInTenant(app, stores.a.id, (em) =>
          em.execute(
            "insert into customer_addresses (tenant_id, customer_id, label, postal_code, street, number, district, city, state) values (?, ?, 'x', '01310100', 'r', '1', 'b', 'c', 'SP')",
            [stores.b.id, id],
          ),
        ),
        (error: { code?: string }) => error.code === "42501",
      );
    } finally {
      await app.close();
    }
  });
});
