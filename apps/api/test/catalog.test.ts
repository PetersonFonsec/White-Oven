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

describe("M2.3–M2.4 tenant catalog API", databaseSuite, () => {
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

  it("manages crusts, extras, simple products, pricing policy and STAFF availability", async () => {
    const productCategory = await json(
      await call("/categories", "POST", { name: "Bebidas", kind: "PRODUCT" }),
    );
    const pizzaCategory = await json(
      await call("/categories", "POST", {
        name: "Pizza category",
        kind: "PIZZA",
      }),
    );
    const anotherProductCategory = await json(
      await call("/categories", "POST", {
        name: "Outra categoria de produto",
        kind: "PRODUCT",
      }),
    );
    const crust = await json(
      await call("/crusts", "POST", { name: "Recheada" }),
    );
    const extra = await json(
      await call("/extras", "POST", { name: "Azeitona" }),
    );
    const product = await json(
      await call("/products", "POST", {
        categoryId: productCategory.id,
        name: "Refrigerante",
        priceCents: 700,
      }),
    );
    assert.equal(
      (
        await call("/products", "POST", {
          categoryId: pizzaCategory.id,
          name: "Produto na categoria errada",
          priceCents: 700,
        })
      ).status,
      404,
    );
    const size = await json(
      await call("/sizes", "POST", { name: "M2.4", slices: 8, maxFlavors: 2 }),
    );
    assert.equal(
      (
        await call(`/crusts/${crust.id}/prices/${size.id}`, "PUT", {
          priceCents: 0,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(`/extras/${extra.id}/prices/${size.id}`, "PUT", {
          halfPriceCents: 500,
          wholePriceCents: 1200,
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await call(`/extras/${extra.id}/prices/${size.id}`, "PUT", {
          halfPriceCents: 500,
          wholePriceCents: 1000,
        })
      ).status,
      200,
    );
    const policy = {
      halfAndHalfStrategy: "HIGHEST",
      halfAndHalfSurchargeCents: 150,
      maxExtrasPerHalf: 4,
    };
    assert.equal((await call("/pricing-policy", "PUT", policy)).status, 200);

    const snapshot = await json(await call("/items"));
    assert.deepEqual(
      Object.keys(snapshot).sort(),
      [
        "categories",
        "crustPrices",
        "crusts",
        "extraPrices",
        "extras",
        "flavorPrices",
        "flavors",
        "ingredients",
        "pricingPolicy",
        "simpleProducts",
        "sizes",
      ].sort(),
    );
    assert.equal(snapshot.simpleProducts[0].id, product.id);
    assert.equal(snapshot.pricingPolicy.maxExtrasPerHalf, 4);
    const audit = await json(await call("/audit-events"));
    for (const action of [
      "catalog.crust.created",
      "catalog.crust.price_created",
      "catalog.extra.created",
      "catalog.extra.price_created",
      "catalog.product.created",
      "catalog.pricing_policy.created",
    ])
      assert.ok(
        audit.some((event: { action: string }) => event.action === action),
        action,
      );

    const staffEmail = `catalog-availability-${randomUUID()}@test.invalid`;
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
    const staffCall = (path: string, body: unknown) =>
      fetch(`${server.baseUrl}/v1/admin/catalog${path}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${staffTenant.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await staffCall(`/availability/products/${product.id}`, {
          available: false,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await staffCall(`/availability/products/${product.id}`, {
          available: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(
          `${server.baseUrl}/v1/admin/catalog/products/${product.id}`,
          {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${staffTenant.accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ name: "Staff tentando renomear" }),
          },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(
          `${server.baseUrl}/v1/admin/catalog/crusts/${crust.id}/prices/${size.id}`,
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${staffTenant.accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ priceCents: 1 }),
          },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${server.baseUrl}/v1/admin/catalog/pricing-policy`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${staffTenant.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(policy),
        })
      ).status,
      403,
    );
    const app = await database.connect(database.appUrl);
    try {
      const [session] = await owner.em
        .getConnection()
        .execute<{ id: string }[]>(
          "select id from staff_sessions where staff_user_id=? and revoked_at is null order by created_at desc limit 1",
          [staffId],
        );
      assert.ok(session);
      for (const [statement, params] of [
        [
          "update catalog_simple_products set price_cents=701 where id=?",
          [product.id],
        ],
        [
          "update catalog_simple_products set name='Staff renomeou' where id=?",
          [product.id],
        ],
        [
          "update catalog_simple_products set category_id=? where id=?",
          [anotherProductCategory.id, product.id],
        ],
      ] as [string, unknown[]][]) {
        let sqlCode: string | undefined;
        try {
          await runInTenant(app, tenantId, async (em) => {
            await em.execute(
              "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true), set_config('app.catalog_request_id', ?, true)",
              [staffId, session.id!, randomUUID()],
            );
            await em.execute(statement, params);
          });
        } catch (error) {
          sqlCode = (error as { code?: string }).code;
        }
        assert.equal(sqlCode, "42501");
      }
    } finally {
      await app.close();
    }

    const managerEmail = `catalog-policy-${randomUUID()}@test.invalid`;
    const managerId = await insertStaffUser(
      owner,
      managerEmail,
      "catalog-test-password",
    );
    await insertMembership(owner, tenantId, managerId, "MANAGER");
    const managerLogin = await staffLogin(
      server.baseUrl,
      managerEmail,
      "catalog-test-password",
    );
    const managerTenant = await json(
      await switchTenant(server.baseUrl, managerLogin.accessToken, tenantId),
    );
    assert.equal(
      (
        await fetch(`${server.baseUrl}/v1/admin/catalog/pricing-policy`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${managerTenant.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(policy),
        })
      ).status,
      403,
    );
    const [managerSession] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "select id from staff_sessions where staff_user_id=? and revoked_at is null order by created_at desc limit 1",
        [managerId],
      );
    assert.ok(managerSession);
    const managerApp = await database.connect(database.appUrl);
    let managerSqlCode: string | undefined;
    try {
      await runInTenant(managerApp, tenantId, async (em) => {
        await em.execute(
          "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true), set_config('app.catalog_request_id', ?, true)",
          [managerId, managerSession.id!, randomUUID()],
        );
        await em.execute(
          "update catalog_pricing_policies set max_extras_per_half=5 where tenant_id=?",
          [tenantId],
        );
      });
    } catch (error) {
      managerSqlCode = (error as { code?: string }).code;
    } finally {
      await managerApp.close();
    }
    assert.equal(managerSqlCode, "42501");
  });

  it("serializes add-on price writes and audits only persisted operations", async () => {
    const otherTenantId = await insertTenant(
      owner,
      `catalog-price-${randomUUID().slice(0, 8)}`,
    );
    const otherEmail = `catalog-price-${randomUUID()}@test.invalid`;
    const otherUserId = await insertStaffUser(
      owner,
      otherEmail,
      "catalog-test-password",
    );
    await insertMembership(owner, otherTenantId, otherUserId, "OWNER");
    const otherLogin = await staffLogin(
      server.baseUrl,
      otherEmail,
      "catalog-test-password",
    );
    const otherTenantToken = (
      await json(
        await switchTenant(
          server.baseUrl,
          otherLogin.accessToken,
          otherTenantId,
        ),
      )
    ).accessToken as string;
    const otherCall = (path: string, method = "GET", body?: unknown) =>
      fetch(`${server.baseUrl}/v1/admin/catalog${path}`, {
        method,
        headers: {
          authorization: `Bearer ${otherTenantToken}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    const crust = await json(
      await call("/crusts", "POST", { name: "Preço concorrente" }),
    );
    const size = await json(
      await call("/sizes", "POST", {
        name: "Preço concorrente",
        slices: 8,
        maxFlavors: 2,
      }),
    );
    const otherCrust = await json(
      await otherCall("/crusts", "POST", { name: "Preço concorrente" }),
    );
    const otherSize = await json(
      await otherCall("/sizes", "POST", {
        name: "Preço concorrente",
        slices: 8,
        maxFlavors: 2,
      }),
    );

    const concurrentCreates = await Promise.all(
      [700, 800].map((priceCents) =>
        call(`/crusts/${crust.id}/prices/${size.id}`, "PUT", { priceCents }),
      ),
    );
    assert.deepEqual(
      concurrentCreates.map((response) => response.status),
      [200, 200],
    );
    const concurrentUpdates = await Promise.all(
      [900, 1000].map((priceCents) =>
        call(`/crusts/${crust.id}/prices/${size.id}`, "PUT", { priceCents }),
      ),
    );
    assert.deepEqual(
      concurrentUpdates.map((response) => response.status),
      [200, 200],
    );

    const distinct = await json(
      await call("/crusts", "POST", { name: "Outro preço" }),
    );
    const distinctWrites = await Promise.all([
      call(`/crusts/${crust.id}/prices/${size.id}`, "PUT", {
        priceCents: 1100,
      }),
      call(`/crusts/${distinct.id}/prices/${size.id}`, "PUT", {
        priceCents: 1200,
      }),
    ]);
    assert.deepEqual(
      distinctWrites.map((response) => response.status),
      [200, 200],
    );

    const insertRaceCrust = await json(
      await call("/crusts", "POST", { name: "Criação e remoção concorrentes" }),
    );
    const [insertDeletePut, insertDelete] = await Promise.all([
      call(`/crusts/${insertRaceCrust.id}/prices/${size.id}`, "PUT", {
        priceCents: 1300,
      }),
      call(`/crusts/${insertRaceCrust.id}/prices/${size.id}`, "DELETE"),
    ]);
    assert.equal(insertDeletePut.status, 200);
    assert.ok([204, 404].includes(insertDelete.status));
    const insertRaceAudit = await json(await call("/audit-events"));
    const insertRaceEvents = insertRaceAudit.filter(
      (event: { entityType: string; entityId: string }) =>
        event.entityType === "crust_price" &&
        event.entityId === insertRaceCrust.id,
    );
    assert.equal(
      insertRaceEvents.length,
      1 + Number(insertDelete.status === 204),
    );
    assert.equal(
      insertRaceEvents.filter(
        (event: { action: string }) =>
          event.action === "catalog.crust.price_created",
      ).length,
      1,
    );
    assert.equal(
      insertRaceEvents.filter(
        (event: { action: string }) =>
          event.action === "catalog.crust.price_removed",
      ).length,
      Number(insertDelete.status === 204),
    );
    assert.equal(
      (await json(await call("/items"))).crustPrices.some(
        (price: { crustId: string; sizeId: string }) =>
          price.crustId === insertRaceCrust.id && price.sizeId === size.id,
      ),
      insertDelete.status === 404,
    );

    await call(`/crusts/${crust.id}/prices/${size.id}`, "PUT", {
      priceCents: 1250,
    });
    const [updateDeletePut, updateDelete] = await Promise.all([
      call(`/crusts/${crust.id}/prices/${size.id}`, "PUT", {
        priceCents: 1400,
      }),
      call(`/crusts/${crust.id}/prices/${size.id}`, "DELETE"),
    ]);
    assert.equal(updateDeletePut.status, 200);
    assert.ok([204, 404].includes(updateDelete.status));

    const crossTenantWrites = await Promise.all([
      call(`/crusts/${crust.id}/prices/${size.id}`, "PUT", {
        priceCents: 1500,
      }),
      otherCall(`/crusts/${otherCrust.id}/prices/${otherSize.id}`, "PUT", {
        priceCents: 1600,
      }),
    ]);
    assert.deepEqual(
      crossTenantWrites.map((response) => response.status),
      [200, 200],
    );

    const stored = await json(await call("/items"));
    const pairs = stored.crustPrices.filter(
      (price: { crustId: string; sizeId: string }) =>
        price.crustId === crust.id && price.sizeId === size.id,
    );
    assert.equal(pairs.length, 1);
    const audit = await json(await call("/audit-events"));
    const priceEvents = audit.filter(
      (event: { entityType: string; entityId: string }) =>
        event.entityType === "crust_price" && event.entityId === crust.id,
    );
    assert.equal(priceEvents.length, 9);
    assert.ok(
      priceEvents.filter(
        (event: { action: string }) =>
          event.action === "catalog.crust.price_created",
      ).length >= 1,
    );
    assert.equal(
      priceEvents.filter(
        (event: { action: string }) =>
          event.action === "catalog.crust.price_removed",
      ).length,
      1,
    );
    const createEventCount = priceEvents.filter(
      (event: { action: string }) =>
        event.action === "catalog.crust.price_created",
    ).length;
    assert.ok(createEventCount >= 1 && createEventCount <= 2);
    const otherAudit = await json(await otherCall("/audit-events"));
    assert.equal(
      otherAudit.filter(
        (event: { entityType: string; entityId: string }) =>
          event.entityType === "crust_price" &&
          event.entityId === otherCrust.id,
      ).length,
      1,
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

  it("archives all linked simple products atomically and leaves other categories and tenants untouched", async () => {
    const category = await json(
      await call("/categories", "POST", {
        name: "Bebidas para arquivar",
        kind: "PRODUCT",
      }),
    );
    const emptyCategory = await json(
      await call("/categories", "POST", {
        name: "Categoria vazia",
        kind: "PRODUCT",
      }),
    );
    const otherCategory = await json(
      await call("/categories", "POST", {
        name: "Outra categoria",
        kind: "PRODUCT",
      }),
    );
    const unaffectedProduct = await json(
      await call("/products", "POST", {
        categoryId: otherCategory.id,
        name: "Produto preservado",
        priceCents: 900,
      }),
    );
    const products = await Promise.all(
      ["Água", "Refrigerante"].map((name) =>
        call("/products", "POST", {
          categoryId: category.id,
          name,
          priceCents: 500,
        }),
      ),
    );
    assert.deepEqual(
      products.map((response) => response.status),
      [201, 201],
    );
    const productIds = await Promise.all(
      products.map(async (response) => (await json(response)).id),
    );
    const otherTenantId = await insertTenant(
      owner,
      `catalog-archive-${randomUUID().slice(0, 8)}`,
    );
    const foreignProductId = await runInTenant(
      owner,
      otherTenantId,
      async (em) => {
        const [foreignCategory] = await em.execute<{ id: string }[]>(
          "insert into catalog_categories (tenant_id,name,kind) values (?,?,'PRODUCT') returning id",
          [otherTenantId, "Categoria externa"],
        );
        const [foreignProduct] = await em.execute<{ id: string }[]>(
          "insert into catalog_simple_products (tenant_id,category_id,name,price_cents) values (?,?,?,500) returning id",
          [otherTenantId, foreignCategory!.id, "Produto externo"],
        );
        return foreignProduct!.id;
      },
    );

    assert.equal(
      (await call(`/categories/${emptyCategory.id}`, "DELETE")).status,
      204,
    );
    assert.equal(
      (await call(`/categories/${category.id}`, "DELETE")).status,
      204,
    );
    const snapshot = await json(await call("/items"));
    for (const id of productIds) {
      const product = snapshot.simpleProducts.find(
        (row: { id: string }) => row.id === id,
      );
      assert.equal(product.archived, true);
      assert.equal(product.available, false);
    }
    const unaffected = snapshot.simpleProducts.find(
      (row: { id: string }) => row.id === unaffectedProduct.id,
    );
    assert.equal(unaffected.archived, false);
    assert.equal(unaffected.available, true);

    const foreignState = await runInTenant(owner, otherTenantId, async (em) => {
      const [row] = await em.execute<
        { archived_at: Date | null; available: boolean }[]
      >(
        "select archived_at,available from catalog_simple_products where id=?",
        [foreignProductId],
      );
      return row;
    });
    assert.ok(foreignState);
    assert.equal(foreignState.archived_at, null);
    assert.equal(foreignState.available, true);
    const app = await database.connect(database.appUrl);
    try {
      const [session] = await owner.em
        .getConnection()
        .execute<{ id: string }[]>(
          "select id from staff_sessions where staff_user_id=? and revoked_at is null order by created_at desc limit 1",
          [staffUserId],
        );
      assert.ok(session);
      for (const statement of [
        "update catalog_simple_products set available=true where id=?",
        "update catalog_simple_products set archived_at=null where id=?",
      ]) {
        let sqlCode: string | undefined;
        try {
          await runInTenant(app, tenantId, async (em) => {
            await em.execute(
              "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true), set_config('app.catalog_request_id', ?, true)",
              [staffUserId, session.id!, randomUUID()],
            );
            await em.execute(statement, [productIds[0]]);
          });
        } catch (error) {
          sqlCode = (error as { code?: string }).code;
        }
        assert.equal(sqlCode, "23514");
      }
    } finally {
      await app.close();
    }
    const audit = await json(await call("/audit-events"));
    for (const id of productIds) {
      assert.equal(
        audit.filter(
          (event: { action: string; entityType: string; entityId: string }) =>
            event.action === "catalog.product.archived" &&
            event.entityType === "product" &&
            event.entityId === id,
        ).length,
        1,
      );
    }
  });

  it("rejects product category changes to missing, archived, pizza, or foreign categories", async () => {
    const category = await json(
      await call("/categories", "POST", {
        name: "Categoria válida",
        kind: "PRODUCT",
      }),
    );
    const archivedCategory = await json(
      await call("/categories", "POST", {
        name: "Categoria arquivada",
        kind: "PRODUCT",
      }),
    );
    const pizzaCategory = await json(
      await call("/categories", "POST", {
        name: "Categoria pizza",
        kind: "PIZZA",
      }),
    );
    const product = await json(
      await call("/products", "POST", {
        categoryId: category.id,
        name: "Produto para edição",
        priceCents: 500,
      }),
    );
    assert.equal(
      (await call(`/categories/${archivedCategory.id}`, "DELETE")).status,
      204,
    );
    const foreignTenantId = await insertTenant(
      owner,
      `catalog-category-${randomUUID().slice(0, 8)}`,
    );
    const foreignCategoryId = await runInTenant(
      owner,
      foreignTenantId,
      async (em) => {
        const [row] = await em.execute<{ id: string }[]>(
          "insert into catalog_categories (tenant_id,name,kind) values (?,?,'PRODUCT') returning id",
          [foreignTenantId, "Categoria externa"],
        );
        return row!.id;
      },
    );
    for (const categoryId of [
      randomUUID(),
      archivedCategory.id,
      pizzaCategory.id,
      foreignCategoryId,
    ]) {
      assert.equal(
        (await call(`/products/${product.id}`, "PATCH", { categoryId })).status,
        404,
        `category ${categoryId} must be rejected`,
      );
    }
    const catalog = await json(await call("/items"));
    assert.equal(
      catalog.simpleProducts.find(
        (row: { id: string }) => row.id === product.id,
      ).categoryId,
      category.id,
    );

    const app = await database.connect(database.appUrl);
    try {
      const [session] = await owner.em
        .getConnection()
        .execute<{ id: string }[]>(
          "select id from staff_sessions where staff_user_id=? and revoked_at is null order by created_at desc limit 1",
          [staffUserId],
        );
      assert.ok(session);
      let sqlCode: string | undefined;
      try {
        await runInTenant(app, tenantId, async (em) => {
          await em.execute(
            "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true), set_config('app.catalog_request_id', ?, true)",
            [staffUserId, session.id!, randomUUID()],
          );
          await em.execute(
            "update catalog_simple_products set category_id=? where id=?",
            [pizzaCategory.id, product.id],
          );
        });
      } catch (error) {
        sqlCode = (error as { code?: string }).code;
      }
      assert.equal(sqlCode, "23514");
    } finally {
      await app.close();
    }
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
