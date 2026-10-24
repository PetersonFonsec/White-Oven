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
  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    tenantId = await insertTenant(owner, `catalog-${randomUUID().slice(0, 8)}`);
    const email = `catalog-${randomUUID()}@test.invalid`;
    const userId = await insertStaffUser(owner, email, "catalog-test-password");
    await insertMembership(owner, tenantId, userId, "OWNER");
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
