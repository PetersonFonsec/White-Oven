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
  insertMembership,
  insertStaffUser,
  insertTenant,
  staffLogin,
  switchTenant,
} from "./staff-fixtures";
import { runInTenant } from "../src/tenancy/tenant-transaction";

describe("M2.3 tenant catalog API", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let server: TestServer;
  let tenantId: string;
  let token: string;
  let staffUserId: string;
  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    tenantId = await insertTenant(owner, `catalog-${randomUUID().slice(0, 8)}`);
    const email = `catalog-${randomUUID()}@test.invalid`;
    staffUserId = await insertStaffUser(owner, email, "catalog-test-password");
    await insertMembership(owner, tenantId, staffUserId, "OWNER");
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: "2",
    });
    const login = await staffLogin(
      server.baseUrl,
      email,
      "catalog-test-password",
    );
    const switched = await switchTenant(
      server.baseUrl,
      login.accessToken,
      tenantId,
    );
    token = (await json(switched)).accessToken;
  });
  after(async () => {
    await server?.close();
    await owner?.close();
    await database?.drop();
  });
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(`${server.baseUrl}/v1/admin/catalog${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  it("creates tenant-scoped catalog and audits price changes atomically", async () => {
    const category = await json(
      await call("/categories", "POST", { name: "Pizzas", kind: "PIZZA" }),
    );
    const size = await json(
      await call("/sizes", "POST", {
        name: "Grande",
        slices: 8,
        maxFlavors: 2,
      }),
    );
    const ingredient = await json(
      await call("/ingredients", "POST", { name: "Tomate", removable: true }),
    );
    const flavor = await json(
      await call("/flavors", "POST", {
        categoryId: category.id,
        name: "Marguerita",
        ingredientIds: [ingredient.id],
      }),
    );
    assert.equal(
      (
        await call(`/flavors/${flavor.id}/prices/${size.id}`, "PUT", {
          priceCents: 4500,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(`/flavors/${flavor.id}/prices/${size.id}`, "PUT", {
          priceCents: 4900,
        })
      ).status,
      200,
    );
    const catalog = await json(await call("/items"));
    assert.equal(catalog.flavors[0].name, "Marguerita");
    assert.deepEqual(catalog.flavors[0].ingredientIds, [ingredient.id]);
    const audit = await json(await call("/audit-events"));
    assert.ok(
      audit.some(
        (event: { action: string; changes: { from?: number; to?: number } }) =>
          event.action === "catalog.flavor.price_changed" &&
          event.changes.from === 4500 &&
          event.changes.to === 4900,
      ),
    );
  });

  it("serializes concurrent first price writes and preserves archived recipe links", async () => {
    const category = await json(
      await call("/categories", "POST", {
        name: "Concorrência",
        kind: "PIZZA",
      }),
    );
    const size = await json(
      await call("/sizes", "POST", {
        name: "Concorrência",
        slices: 8,
        maxFlavors: 2,
      }),
    );
    const ingredient = await json(
      await call("/ingredients", "POST", { name: "Catupiry" }),
    );
    const flavor = await json(
      await call("/flavors", "POST", {
        categoryId: category.id,
        name: "Quatro queijos",
        ingredientIds: [ingredient.id],
      }),
    );
    const prices = await Promise.all(
      [5100, 5200].map((priceCents) =>
        call(`/flavors/${flavor.id}/prices/${size.id}`, "PUT", { priceCents }),
      ),
    );
    assert.deepEqual(
      prices.map((response) => response.status),
      [200, 200],
    );
    const audit = await json(await call("/audit-events"));
    const priceEvents = audit.filter(
      (event: { entityType: string; entityId: string }) =>
        event.entityType === "flavor_price" && event.entityId === flavor.id,
    );
    assert.equal(
      priceEvents.filter(
        (event: { action: string }) =>
          event.action === "catalog.flavor.price_created",
      ).length,
      1,
    );
    assert.equal(
      priceEvents.filter(
        (event: { action: string }) =>
          event.action === "catalog.flavor.price_changed",
      ).length,
      1,
    );
    assert.equal(
      (await call(`/ingredients/${ingredient.id}`, "DELETE")).status,
      204,
    );
    const catalog = await json(await call("/items"));
    assert.equal(
      catalog.flavors.find((row: { id: string }) => row.id === flavor.id)
        .ingredientIds[0],
      ingredient.id,
    );
    assert.equal(
      catalog.ingredients.find(
        (row: { id: string }) => row.id === ingredient.id,
      ).archived,
      true,
    );
  });

  it("serializes simultaneous first price creation and deletion", async () => {
    const category = await json(
      await call("/categories", "POST", {
        name: "Put-delete concorrente",
        kind: "PIZZA",
      }),
    );
    const size = await json(
      await call("/sizes", "POST", {
        name: "Put-delete concorrente",
        slices: 8,
        maxFlavors: 2,
      }),
    );
    const flavor = await json(
      await call("/flavors", "POST", {
        categoryId: category.id,
        name: "Put-delete concorrente",
      }),
    );
    const [put, remove] = await Promise.all([
      call(`/flavors/${flavor.id}/prices/${size.id}`, "PUT", {
        priceCents: 6100,
      }),
      call(`/flavors/${flavor.id}/prices/${size.id}`, "DELETE"),
    ]);
    assert.equal(put.status, 200);
    assert.ok([204, 404].includes(remove.status));
    const catalog = await json(await call("/items"));
    const exists = catalog.flavorPrices.some(
      (price: { flavorId: string; sizeId: string }) =>
        price.flavorId === flavor.id && price.sizeId === size.id,
    );
    assert.equal(exists, remove.status === 404);
    const audit = await json(await call("/audit-events"));
    const events = audit.filter(
      (event: { entityType: string; entityId: string }) =>
        event.entityType === "flavor_price" && event.entityId === flavor.id,
    );
    assert.deepEqual(
      events.map((event: { action: string }) => event.action).sort(),
      remove.status === 404
        ? ["catalog.flavor.price_created"]
        : ["catalog.flavor.price_created", "catalog.flavor.price_removed"],
    );
  });

  it("archives a category and its linked flavors while retaining their recipe links", async () => {
    const category = await json(
      await call("/categories", "POST", {
        name: "Categoria arquivada",
        kind: "PIZZA",
      }),
    );
    const ingredient = await json(
      await call("/ingredients", "POST", { name: "Receita histórica" }),
    );
    const flavor = await json(
      await call("/flavors", "POST", {
        categoryId: category.id,
        name: "Receita histórica",
        ingredientIds: [ingredient.id],
      }),
    );
    assert.equal(
      (await call(`/categories/${category.id}`, "DELETE")).status,
      204,
    );
    const catalog = await json(await call("/items"));
    assert.equal(
      catalog.categories.find((row: { id: string }) => row.id === category.id)
        .archived,
      true,
    );
    const archivedFlavor = catalog.flavors.find(
      (row: { id: string }) => row.id === flavor.id,
    );
    assert.equal(archivedFlavor.archived, true);
    assert.deepEqual(archivedFlavor.ingredientIds, [ingredient.id]);
  });

  it("rejects duplicate names, prices for unavailable sizes, STAFF writes, and suspended tenant writes", async () => {
    const category = await json(
      await call("/categories", "POST", { name: "Única", kind: "PIZZA" }),
    );
    assert.equal(
      (await call("/categories", "POST", { name: "Única", kind: "PRODUCT" }))
        .status,
      409,
    );
    const size = await json(
      await call("/sizes", "POST", {
        name: "Indisponível",
        slices: 8,
        maxFlavors: 2,
      }),
    );
    const ingredient = await json(
      await call("/ingredients", "POST", { name: "Ingrediente único" }),
    );
    const flavor = await json(
      await call("/flavors", "POST", {
        categoryId: category.id,
        name: "Flavor único",
        ingredientIds: [ingredient.id],
      }),
    );
    assert.equal(
      (await call(`/sizes/${size.id}`, "PATCH", { available: false })).status,
      200,
    );
    assert.equal(
      (
        await call(`/flavors/${flavor.id}/prices/${size.id}`, "PUT", {
          priceCents: 5000,
        })
      ).status,
      404,
    );

    const staffEmail = `catalog-staff-${randomUUID()}@test.invalid`;
    const staffId = await insertStaffUser(
      owner,
      staffEmail,
      "catalog-test-password",
    );
    await insertMembership(owner, tenantId, staffId, "STAFF");
    const staffLoginResult = await staffLogin(
      server.baseUrl,
      staffEmail,
      "catalog-test-password",
    );
    const staffTenant = await json(
      await switchTenant(
        server.baseUrl,
        staffLoginResult.accessToken,
        tenantId,
      ),
    );
    const staffResponse = await fetch(
      `${server.baseUrl}/v1/admin/catalog/items`,
      { headers: { authorization: `Bearer ${staffTenant.accessToken}` } },
    );
    assert.equal(staffResponse.status, 403);

    const suspended = await insertTenant(
      owner,
      `suspended-${randomUUID().slice(0, 8)}`,
      "SUSPENDED",
    );
    const suspendedEmail = `catalog-suspended-${randomUUID()}@test.invalid`;
    const suspendedUser = await insertStaffUser(
      owner,
      suspendedEmail,
      "catalog-test-password",
    );
    await insertMembership(owner, suspended, suspendedUser, "OWNER");
    const suspendedLogin = await staffLogin(
      server.baseUrl,
      suspendedEmail,
      "catalog-test-password",
    );
    const suspendedTenant = await json(
      await switchTenant(server.baseUrl, suspendedLogin.accessToken, suspended),
    );
    const suspendedResponse = await fetch(
      `${server.baseUrl}/v1/admin/catalog/categories`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${suspendedTenant.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Bloqueada", kind: "PIZZA" }),
      },
    );
    assert.equal(suspendedResponse.status, 403);
    assert.equal(
      (await json(suspendedResponse)).code,
      "CATALOG_WRITE_FORBIDDEN",
    );
  });

  it("only writes audit events from catalog mutations with the actor's live session", async () => {
    const app = await database.connect(database.appUrl);
    try {
      const [session] = await owner.em
        .getConnection()
        .execute<{ id: string }[]>(
          "select id from staff_sessions where staff_user_id=? and revoked_at is null order by created_at desc limit 1",
          [staffUserId],
        );
      assert.ok(session);
      const activeSessionId = session.id!;
      const arbitraryWriter = await (async () => {
        try {
          await runInTenant(app, tenantId, (em) =>
            em.execute(
              "select whiteoven_catalog_write_audit(?::uuid,?::uuid,'catalog.category.created','category',?::uuid,'{}'::jsonb,?::uuid)",
              [staffUserId, activeSessionId, randomUUID(), randomUUID()],
            ),
          );
          return undefined;
        } catch (error) {
          return (error as { code?: string }).code;
        }
      })();
      assert.equal(arbitraryWriter, "42883");
      const unauthorizedMutation = async (
        tenant: string,
        actorId: string,
        sessionId: string,
      ) => {
        try {
          await runInTenant(app, tenant, async (em) => {
            await em.execute(
              "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true)",
              [actorId, sessionId],
            );
            await em.execute(
              "insert into catalog_categories (tenant_id,name,kind) values (?,?,'PIZZA')",
              [tenant, `forbidden-${randomUUID()}`],
            );
          });
          return undefined;
        } catch (error) {
          return (error as { code?: string }).code;
        }
      };
      const mismatchedActors: [string, string][] = [
        [staffUserId, randomUUID()],
        [randomUUID(), activeSessionId],
      ];
      for (const [actorId, sessionId] of mismatchedActors) {
        const code = await unauthorizedMutation(tenantId, actorId, sessionId);
        assert.equal(code, "42501");
      }
      const otherTenant = await insertTenant(
        owner,
        `catalog-audit-${randomUUID().slice(0, 8)}`,
      );
      const mismatchedTenantCode = await unauthorizedMutation(
        otherTenant,
        staffUserId,
        activeSessionId,
      );
      assert.equal(mismatchedTenantCode, "42501");
      const directAuditInsert = await unauthorizedMutation(tenantId, "", "");
      assert.equal(directAuditInsert, "42501");
      const directEventWrite = await (async () => {
        try {
          await runInTenant(app, tenantId, (em) =>
            em.execute(
              "insert into audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id) values (?, 'STAFF', ?, 'fake', 'category', ?)",
              [tenantId, staffUserId, randomUUID()],
            ),
          );
          return undefined;
        } catch (error) {
          return (error as { code?: string }).code;
        }
      })();
      assert.equal(directEventWrite, "42501");
    } finally {
      await app.close();
    }
  });

  it("rejects a cross-tenant ingredient reference and preserves soft-archived items", async () => {
    const other = await insertTenant(
      owner,
      `catalog-${randomUUID().slice(0, 8)}`,
    );
    const otherIngredient = await runInTenant(owner, other, async (em) => {
      const [row] = await em.execute<{ id: string }[]>(
        "insert into catalog_ingredients (tenant_id,name) values (?,?) returning id",
        [other, "Foreign"],
      );
      return row!.id;
    });
    const categories = await call("/categories", "POST", {
      name: "Outra",
      kind: "PIZZA",
    });
    const category = await json(categories);
    const response = await call("/flavors", "POST", {
      categoryId: category.id,
      name: "Inválido",
      ingredientIds: [otherIngredient],
    });
    assert.equal(response.status, 409);
    const size = await json(
      await call("/sizes", "POST", {
        name: "Pequena",
        slices: 4,
        maxFlavors: 1,
      }),
    );
    assert.equal((await call(`/sizes/${size.id}`, "DELETE")).status, 204);
    const catalog = await json(await call("/items"));
    assert.equal(
      catalog.sizes.find((row: { id: string }) => row.id === size.id).archived,
      true,
    );
  });
});
