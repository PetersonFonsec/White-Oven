import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { defineEntity, p } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  findUnprotectedTenantTables,
  tenantIsolationSql,
} from "../src/database/tenant-isolation-sql";
import { createOrm } from "../src/database/orm";
import { TENANT_SURFACE } from "../src/tenancy/store-tenant.guard";
import { Tenant } from "../src/tenancy/tenant.entity";
import { assertTenantFilters } from "../src/tenancy/tenant-filter";
import {
  TenantTransactions,
  runInTenant,
} from "../src/tenancy/tenant-transaction";
import { json, nextTick, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import {
  ProbeFlavor,
  TenantProbeModule,
  createProbeTables,
} from "./tenant-probes";
import {
  insertMembership,
  insertStaffUser,
  setMembershipStatus,
  staffLogin,
  switchTenant,
} from "./staff-fixtures";

const INSUFFICIENT_PRIVILEGE = "42501";
const FOREIGN_KEY_VIOLATION = "23503";

async function sqlState(
  work: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

interface Fixture {
  id: string;
  slug: string;
  flavorId: string;
  catalogFlavorId: string;
  categoryId: string;
  sizeId: string;
  ingredientId: string;
  productCategoryId: string;
  crustId: string;
  extraId: string;
  productId: string;
  imageAssetId: string;
  membershipId: string;
  inviteId: string;
  addressId: string;
  orderId: string;
  incidentId: string;
}

/** Staff membership cache TTL of this suite's server; production allows at most 60 s. */
const STAFF_PASSWORD = "isolamento-2026";

/**
 * Required tests of docs/architecture/tenant-isolation.md, against a real PostgreSQL. Tables
 * are the test-only probes of `tenant-probes.ts` plus every production tenant table.
 */
describe("tenant isolation", databaseSuite, () => {
  let database: TestDatabase;
  let owner: MikroORM;
  let app: MikroORM;
  let server: TestServer;
  let a: Fixture;
  let b: Fixture;

  const tenantRow = async (slug: string, status = "ACTIVE") => {
    const [row] = await owner.em
      .getConnection()
      .execute<{ id: string }[]>(
        "insert into tenants (slug, display_name, status) values (?, ?, ?) returning id",
        [slug, `Pizzaria ${slug}`, status],
      );
    return row!.id;
  };

  const fixture = async (slug: string, flavor: string): Promise<Fixture> => {
    const id = await tenantRow(slug);
    // FORCE RLS applies to the table owner too: even fixtures need the tenant context.
    const [row] = await runInTenant(owner, id, (em) =>
      em.execute<{ id: string }[]>(
        "insert into isolation_probe_flavors (tenant_id, name) values (?, ?) returning id",
        [id, flavor],
      ),
    );
    const catalog = await runInTenant(owner, id, async (em) => {
      const [category] = await em.execute<{ id: string }[]>(
        "insert into catalog_categories (tenant_id,name,kind) values (?,?,'PIZZA') returning id",
        [id, `${slug} category`],
      );
      const [productCategory] = await em.execute<{ id: string }[]>(
        "insert into catalog_categories (tenant_id,name,kind) values (?,?,'PRODUCT') returning id",
        [id, `${slug} product category`],
      );
      const [size] = await em.execute<{ id: string }[]>(
        "insert into pizza_sizes (tenant_id,name,slices,max_flavors) values (?,?,8,2) returning id",
        [id, `${slug} size`],
      );
      const [ingredient] = await em.execute<{ id: string }[]>(
        "insert into catalog_ingredients (tenant_id,name) values (?,?) returning id",
        [id, `${slug} ingredient`],
      );
      const [flavorRow] = await em.execute<{ id: string }[]>(
        "insert into catalog_flavors (tenant_id,category_id,name) values (?,?,?) returning id",
        [id, category!.id, `${slug} flavor`],
      );
      await em.execute(
        "insert into catalog_flavor_ingredients (tenant_id,flavor_id,ingredient_id) values (?,?,?)",
        [id, flavorRow!.id, ingredient!.id],
      );
      await em.execute(
        "insert into catalog_flavor_prices (tenant_id,flavor_id,size_id,price_cents) values (?,?,?,1000)",
        [id, flavorRow!.id, size!.id],
      );
      const [crust] = await em.execute<{ id: string }[]>(
        "insert into catalog_crusts (tenant_id,name) values (?,?) returning id",
        [id, `${slug} crust`],
      );
      await em.execute(
        "insert into catalog_crust_prices (tenant_id,crust_id,size_id,price_cents) values (?,?,?,0)",
        [id, crust!.id, size!.id],
      );
      const [extra] = await em.execute<{ id: string }[]>(
        "insert into catalog_extras (tenant_id,name) values (?,?) returning id",
        [id, `${slug} extra`],
      );
      await em.execute(
        "insert into catalog_extra_prices (tenant_id,extra_id,size_id,whole_price_cents,half_price_cents) values (?,?,?,1000,500)",
        [id, extra!.id, size!.id],
      );
      const [product] = await em.execute<{ id: string }[]>(
        "insert into catalog_simple_products (tenant_id,category_id,name,price_cents) values (?,?,?,500) returning id",
        [id, productCategory!.id, `${slug} product`],
      );
      await em.execute(
        "insert into catalog_pricing_policies (tenant_id,half_and_half_strategy,half_and_half_surcharge_cents,max_extras_per_half) values (?,'HIGHEST',0,4)",
        [id],
      );
      const [image] = await em.execute<{ id: string }[]>(
        "insert into image_assets (id,tenant_id,source_format,width,height) values (gen_random_uuid(),?,'webp',2,2) returning id",
        [id],
      );
      // Published on the menu, so the public image route would serve it to its own store.
      await em.execute(
        "update catalog_flavors set image_asset_id=? where id=?",
        [image!.id, flavorRow!.id],
      );
      return {
        categoryId: category!.id,
        productCategoryId: productCategory!.id,
        sizeId: size!.id,
        ingredientId: ingredient!.id,
        catalogFlavorId: flavorRow!.id,
        crustId: crust!.id,
        extraId: extra!.id,
        productId: product!.id,
        imageAssetId: image!.id,
      };
    });
    const memberId = await insertStaffUser(
      owner,
      `fixture-${slug}@isolamento.test`,
      STAFF_PASSWORD,
    );
    await insertMembership(owner, id, memberId, "STAFF");
    const team = await runInTenant(owner, id, async (em) => {
      const [membership] = await em.execute<{ id: string }[]>(
        "select id from memberships where staff_user_id = ?",
        [memberId],
      );
      const [invite] = await em.execute<{ id: string }[]>(
        `insert into staff_invites (tenant_id,email,role,token_hash,expires_at,created_by,idempotency_key_hash,request_hash)
         values (?,?,'STAFF',sha256(?::bytea),now() + interval '1 hour',?,sha256(?::bytea),sha256(?::bytea)) returning id`,
        [id, `convite-${slug}@isolamento.test`, slug, memberId, slug, slug],
      );
      return { membershipId: membership!.id, inviteId: invite!.id };
    });
    const customerFixture = await runInTenant(owner, id, async (em) => {
      const [customer] = await em.execute<{ id: string }[]>(
        `insert into customers (tenant_id,name,email,password_hash,privacy_policy_version,accepted_at)
         values (?,?,?,'x','2026-10',now()) returning id`,
        [id, `Cliente ${slug}`, `cliente-${slug}@isolamento.test`],
      );
      const [address] = await em.execute<{ id: string }[]>(
        `insert into customer_addresses (tenant_id,customer_id,label,postal_code,street,number,district,city,state)
         values (?,?,'Casa','01310100','Rua A','1','Centro','São Paulo','SP') returning id`,
        [id, customer!.id],
      );
      const [order] = await em.execute<{ id: string }[]>(
        `insert into orders (tenant_id,number,customer_id,customer_name,fulfillment,payment_method,
          items_subtotal_cents,delivery_fee_cents,discount_cents,total_cents)
         values (?,1,?,?,'PICKUP','PIX_ON_DELIVERY',1000,0,0,1000) returning id`,
        [id, customer!.id, `Cliente ${slug}`],
      );
      // The incident is recorded through the API once the server runs (its author must be a
      // live staff session, checked by the database).
      return { addressId: address!.id, orderId: order!.id, incidentId: "" };
    });
    return {
      id,
      slug,
      flavorId: row!.id,
      ...catalog,
      ...team,
      ...customerFixture,
    };
  };

  const appCount = async (sql: string, params: unknown[] = []) => {
    const [row] = await app.em
      .getConnection()
      .execute<{ count: number }[]>(sql, params);
    return row!.count;
  };

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    await createProbeTables(owner);
    a = await fixture("pizzaria-a", "Margherita A");
    b = await fixture("pizzaria-b", "Calabresa B");
    await tenantRow("pizzaria-suspensa", "SUSPENDED");
    app = await createOrm(
      { url: database.appUrl, poolMax: 1 },
      { entities: [Tenant, ProbeFlavor] },
    );
    server = await startTestServer(
      {
        DATABASE_URL: database.appUrl,
        DATABASE_POOL_MAX: "1",
      },
      { imports: [TenantProbeModule], entities: [ProbeFlavor] },
    );
    for (const store of [a, b]) {
      const created = await adminIncidentCall(
        store,
        `/admin/orders/${store.orderId}/incidents`,
        { type: "LATE_DELIVERY", description: "Atrasou", reportedBy: "STAFF" },
      );
      assert.equal(created.status, 201);
      store.incidentId = (await json(created)).id;
    }
  });
  after(async () => {
    await server?.close();
    await app?.close();
    await database?.drop();
  });

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.baseUrl}/v1${path}`, init);
  const adminCatalogCall = async (
    store: Fixture,
    path: string,
    method = "GET",
    requestBody?: unknown,
  ) => {
    const email = `matrix-${store.slug}-${randomUUID()}@isolamento.test`;
    const userId = await insertStaffUser(owner, email, STAFF_PASSWORD);
    await insertMembership(owner, store.id, userId, "OWNER");
    const login = await staffLogin(server.baseUrl, email, STAFF_PASSWORD);
    const switched = await switchTenant(
      server.baseUrl,
      login.accessToken,
      store.id,
    );
    const { accessToken } = await json(switched);
    const body =
      requestBody !== undefined
        ? requestBody
        : method === "PUT"
          ? { priceCents: 500 }
          : method === "POST"
            ? { name: "Nova", kind: "PIZZA" }
            : method === "PATCH"
              ? { name: "Nova" }
              : undefined;
    return call(path, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  };

  const adminOrderCall = async (
    store: Fixture,
    victim: Fixture,
  ): Promise<Response> => {
    const login = await staffLogin(
      server.baseUrl,
      `fixture-${store.slug}@isolamento.test`,
      STAFF_PASSWORD,
    );
    const switched = await switchTenant(
      server.baseUrl,
      login.accessToken,
      store.id,
    );
    const { accessToken } = await json(switched);
    return call(`/admin/orders/${victim.orderId}/transitions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ from: "PLACED", to: "PREPARING" }),
    });
  };

  const adminOrderReadCall = async (
    store: Fixture,
    victim: Fixture,
  ): Promise<Response> => {
    const login = await staffLogin(
      server.baseUrl,
      `fixture-${store.slug}@isolamento.test`,
      STAFF_PASSWORD,
    );
    const switched = await switchTenant(
      server.baseUrl,
      login.accessToken,
      store.id,
    );
    const { accessToken } = await json(switched);
    return call(`/admin/orders/${victim.orderId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  };

  /** A staff call of `store` to `path` (incidents of M4.6). */
  const adminIncidentCall = async (
    store: Fixture,
    path: string,
    body: unknown,
  ): Promise<Response> => {
    const login = await staffLogin(
      server.baseUrl,
      `fixture-${store.slug}@isolamento.test`,
      STAFF_PASSWORD,
    );
    const switched = await switchTenant(
      server.baseUrl,
      login.accessToken,
      store.id,
    );
    const { accessToken } = await json(switched);
    return call(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify(body),
    });
  };

  const incidentsOf = (store: Fixture) =>
    runInTenant(owner, store.id, (em) =>
      em.execute<{ count: number; open: number }[]>(
        `select count(*)::int as count, count(*) filter (where status = 'OPEN')::int as open
           from order_incidents`,
      ),
    ).then(([row]) => row!);

  /** A new customer of `store`, signed up through the API, calling `path` with its token. */
  const customerCall = async (
    store: Fixture,
    path: string,
    method: string,
    requestBody?: unknown,
    extraHeaders: Record<string, string> = {},
  ) => {
    const registered = await call(
      `/customer/stores/${store.slug}/auth/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Atacante",
          email: `atacante-${randomUUID()}@isolamento.test`,
          password: STAFF_PASSWORD,
          privacyPolicyVersion: "2026-10",
        }),
      },
    );
    const { accessToken } = await json(registered);
    return call(path, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...extraHeaders,
        ...(requestBody ? { "content-type": "application/json" } : {}),
      },
      ...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
    });
  };
  const addressLabel = async (store: Fixture) => {
    const [row] = await runInTenant(owner, store.id, (em) =>
      em.execute<{ label: string }[]>(
        "select label from customer_addresses where id = ?",
        [store.addressId],
      ),
    );
    return row?.label;
  };

  describe("1. isolation matrix", () => {
    /** Every tenant route, with how tenant A attacks tenant B's resource through it. */
    const MATRIX: Record<
      string,
      (attacker: Fixture, victim: Fixture) => Promise<Response>
    > = {
      "GET /public/stores/:storeSlug/isolation-probe/:id": (attacker, victim) =>
        call(
          `/public/stores/${attacker.slug}/isolation-probe/${victim.flavorId}`,
        ),
      "PATCH /public/stores/:storeSlug/isolation-probe/:id": (
        attacker,
        victim,
      ) =>
        call(
          `/public/stores/${attacker.slug}/isolation-probe/${victim.flavorId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "hijacked" }),
          },
        ),
      "GET /customer/stores/:storeSlug/isolation-probe/:id": (
        attacker,
        victim,
      ) =>
        call(
          `/customer/stores/${attacker.slug}/isolation-probe/${victim.flavorId}`,
          {
            headers: { "x-test-token-tid": attacker.id },
          },
        ),
      "PATCH /admin/catalog/categories/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/categories/${victim.categoryId}`,
          "PATCH",
        ),
      "DELETE /admin/catalog/categories/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/categories/${victim.categoryId}`,
          "DELETE",
        ),
      "PATCH /admin/catalog/sizes/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/sizes/${victim.sizeId}`,
          "PATCH",
        ),
      "DELETE /admin/catalog/sizes/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/sizes/${victim.sizeId}`,
          "DELETE",
        ),
      "PATCH /admin/catalog/ingredients/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/ingredients/${victim.ingredientId}`,
          "PATCH",
        ),
      "DELETE /admin/catalog/ingredients/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/ingredients/${victim.ingredientId}`,
          "DELETE",
        ),
      "PATCH /admin/catalog/flavors/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/flavors/${victim.catalogFlavorId}`,
          "PATCH",
        ),
      "DELETE /admin/catalog/flavors/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/flavors/${victim.catalogFlavorId}`,
          "DELETE",
        ),
      "PUT /admin/catalog/flavors/:id/prices/:sizeId": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/flavors/${victim.catalogFlavorId}/prices/${victim.sizeId}`,
          "PUT",
        ),
      "DELETE /admin/catalog/flavors/:id/prices/:sizeId": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/flavors/${victim.catalogFlavorId}/prices/${victim.sizeId}`,
          "DELETE",
        ),
      "PATCH /admin/catalog/availability/:itemType/:id": async (
        attacker,
        victim,
      ) => {
        const responses = await Promise.all(
          [
            ["flavors", victim.catalogFlavorId],
            ["crusts", victim.crustId],
            ["extras", victim.extraId],
            ["products", victim.productId],
          ].map(([type, id]) =>
            adminCatalogCall(
              attacker,
              `/admin/catalog/availability/${type}/${id}`,
              "PATCH",
              { available: false },
            ),
          ),
        );
        for (const response of responses)
          assert.equal(
            response.status,
            404,
            "availability must remain tenant-scoped",
          );
        return responses[0]!;
      },
      "PATCH /admin/catalog/crusts/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/crusts/${victim.crustId}`,
          "PATCH",
        ),
      "DELETE /admin/catalog/crusts/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/crusts/${victim.crustId}`,
          "DELETE",
        ),
      "PUT /admin/catalog/crusts/:id/prices/:sizeId": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/crusts/${victim.crustId}/prices/${victim.sizeId}`,
          "PUT",
          { priceCents: 500 },
        ),
      "DELETE /admin/catalog/crusts/:id/prices/:sizeId": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/crusts/${victim.crustId}/prices/${victim.sizeId}`,
          "DELETE",
        ),
      "PATCH /admin/catalog/extras/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/extras/${victim.extraId}`,
          "PATCH",
        ),
      "DELETE /admin/catalog/extras/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/extras/${victim.extraId}`,
          "DELETE",
        ),
      "PUT /admin/catalog/extras/:id/prices/:sizeId": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/extras/${victim.extraId}/prices/${victim.sizeId}`,
          "PUT",
          { halfPriceCents: 500, wholePriceCents: 1000 },
        ),
      "DELETE /admin/catalog/extras/:id/prices/:sizeId": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/extras/${victim.extraId}/prices/${victim.sizeId}`,
          "DELETE",
        ),
      "PATCH /admin/catalog/products/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/products/${victim.productId}`,
          "PATCH",
        ),
      "DELETE /admin/catalog/products/:id": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/products/${victim.productId}`,
          "DELETE",
        ),
      "GET /public/stores/:storeSlug/images/:id/:variant": (attacker, victim) =>
        call(
          `/public/stores/${attacker.slug}/images/${victim.imageAssetId}/menu`,
        ),
      "GET /admin/catalog/images/:id/:variant": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/catalog/images/${victim.imageAssetId}/menu`,
        ),
      "PATCH /admin/team/members/:membershipId": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/team/members/${victim.membershipId}`,
          "PATCH",
          { role: "OWNER" },
        ),
      "DELETE /admin/team/members/:membershipId": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/team/members/${victim.membershipId}`,
          "DELETE",
        ),
      "DELETE /admin/team/invites/:inviteId": (attacker, victim) =>
        adminCatalogCall(
          attacker,
          `/admin/team/invites/${victim.inviteId}`,
          "DELETE",
        ),
      "POST /admin/orders/:orderId/transitions": (attacker, victim) =>
        adminOrderCall(attacker, victim),
      "GET /admin/orders/:orderId": (attacker, victim) =>
        adminOrderReadCall(attacker, victim),
      "POST /admin/orders/:orderId/incidents": async (attacker, victim) => {
        const response = await adminIncidentCall(
          attacker,
          `/admin/orders/${victim.orderId}/incidents`,
          { type: "OTHER", description: "intrusão", reportedBy: "STAFF" },
        );
        assert.deepEqual(await incidentsOf(victim), { count: 1, open: 1 });
        return response;
      },
      "POST /admin/orders/:orderId/incidents/:incidentId/resolve": async (
        attacker,
        victim,
      ) => {
        const response = await adminIncidentCall(
          attacker,
          `/admin/orders/${victim.orderId}/incidents/${victim.incidentId}/resolve`,
          {},
        );
        assert.deepEqual(await incidentsOf(victim), { count: 1, open: 1 });
        return response;
      },
      "POST /customer/stores/:storeSlug/me/orders/:orderId/transitions": (
        attacker,
        victim,
      ) =>
        customerCall(
          attacker,
          `/customer/stores/${attacker.slug}/me/orders/${victim.orderId}/transitions`,
          "POST",
          { from: "PLACED", to: "CANCELED", reasonCode: "CUSTOMER_REQUEST" },
          { "idempotency-key": randomUUID() },
        ),
      "PUT /customer/stores/:storeSlug/me/addresses/:addressId": async (
        attacker,
        victim,
      ) => {
        const response = await customerCall(
          attacker,
          `/customer/stores/${attacker.slug}/me/addresses/${victim.addressId}`,
          "PUT",
          {
            label: "hijacked",
            postalCode: "01310100",
            street: "Rua B",
            number: "2",
            district: "Centro",
            city: "São Paulo",
            state: "SP",
          },
        );
        assert.equal(await addressLabel(victim), "Casa");
        return response;
      },
      "DELETE /customer/stores/:storeSlug/me/addresses/:addressId": async (
        attacker,
        victim,
      ) => {
        const response = await customerCall(
          attacker,
          `/customer/stores/${attacker.slug}/me/addresses/${victim.addressId}`,
          "DELETE",
        );
        assert.equal(await addressLabel(victim), "Casa");
        return response;
      },
    };

    it("lists every tenant route of the API (new routes must join the matrix)", () => {
      const discovery = server.app.get(DiscoveryService);
      const scanner = server.app.get(MetadataScanner);
      const routes: string[] = [];
      for (const wrapper of discovery.getControllers()) {
        const { instance, metatype } = wrapper;
        if (!instance || !metatype) continue;
        const prefix = Reflect.getMetadata(PATH_METADATA, metatype) as string;
        const prototype = Object.getPrototypeOf(instance) as object;
        for (const name of scanner.getAllMethodNames(prototype)) {
          const handler = (prototype as Record<string, object>)[name]!;
          if (!Reflect.getMetadata(TENANT_SURFACE, handler)) continue;
          const method =
            RequestMethod[
              Reflect.getMetadata(METHOD_METADATA, handler) as number
            ];
          const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
          routes.push(
            `${method} /${[prefix, path].filter((part) => part && part !== "/").join("/")}`,
          );
        }
      }
      // Read-only listings have no victim id; they are covered by the "own rows only" test.
      // `GET /admin/me` reads only the token's own membership; covered by test 7.
      const listings = [
        "GET /public/stores/:storeSlug/isolation-probe",
        "GET /public/stores/:storeSlug/menu",
        "GET /public/stores/:storeSlug/status",
        // The store in the URL only, no id; covered in brand.test.ts.
        "GET /public/stores/:storeSlug",
        "GET /admin/me",
        "GET /admin/catalog/items",
        "GET /admin/orders",
        // The store's own history and report, no id in the path; covered in order-history.test.ts.
        "GET /admin/orders/history",
        "GET /admin/reports/daily",
        // The store's own billing estimate, no id in the path; covered in billing-report.test.ts.
        "GET /admin/reports/billing",
        "GET /admin/catalog/audit-events",
        "POST /admin/catalog/categories",
        "POST /admin/catalog/sizes",
        "POST /admin/catalog/ingredients",
        "POST /admin/catalog/flavors",
        "POST /admin/catalog/crusts",
        "POST /admin/catalog/extras",
        "POST /admin/catalog/products",
        "POST /admin/catalog/images",
        "PUT /admin/catalog/pricing-policy",
        // One row per tenant, no id in the path; covered in store.test.ts.
        "GET /admin/store/settings",
        "PUT /admin/store/settings",
        "PUT /admin/store/opening-hours",
        "GET /admin/store/brand",
        "PUT /admin/store/brand",
        "GET /admin/store/pause",
        "PUT /admin/store/pause",
        "DELETE /admin/store/pause",
        // The store's own team and a new invite; covered in team.test.ts.
        "GET /admin/team",
        "POST /admin/team/invites",
        // The customer's own account, sessions and addresses; covered in customer.test.ts.
        "POST /customer/stores/:storeSlug/auth/register",
        "POST /customer/stores/:storeSlug/auth/login",
        "POST /customer/stores/:storeSlug/auth/refresh",
        "POST /customer/stores/:storeSlug/auth/logout",
        "GET /customer/stores/:storeSlug/me",
        "DELETE /customer/stores/:storeSlug/me",
        "GET /customer/stores/:storeSlug/me/addresses",
        "POST /customer/stores/:storeSlug/me/addresses",
        // Other stores' ids can only travel in the body (catalog items, address); covered in
        // order.test.ts, where they are unavailable and a token of A at B is a 404.
        "POST /customer/stores/:storeSlug/me/orders/quote",
        "POST /customer/stores/:storeSlug/me/orders",
        "GET /customer/stores/:storeSlug/me/orders",
        "GET /customer/stores/:storeSlug/me/orders/:orderId",
        // The session's own device, no id in the path; covered in push.test.ts.
        "GET /customer/stores/:storeSlug/me/push-device",
        "PUT /customer/stores/:storeSlug/me/push-device",
        "DELETE /customer/stores/:storeSlug/me/push-device",
      ];
      assert.deepEqual(
        routes.filter((route) => !listings.includes(route)).sort(),
        Object.keys(MATRIX).sort(),
      );
    });

    for (const [route, attack] of Object.entries(MATRIX)) {
      it(`${route}: tenant A gets 404 on tenant B's resource, without side effects`, async () => {
        for (const [attacker, victim] of [
          [a, b],
          [b, a],
        ] as const) {
          const response = await attack(attacker, victim);
          assert.equal(response.status, 404);
          assert.ok(
            [
              "NOT_FOUND",
              "CATALOG_RESOURCE_NOT_FOUND",
              "IMAGE_NOT_FOUND",
              "MEMBER_NOT_FOUND",
              "INVITE_NOT_FOUND",
            ].includes((await json(response)).code),
          );
          const [row] = await runInTenant(owner, victim.id, (em) =>
            em.execute<{ name: string }[]>(
              "select name from isolation_probe_flavors where id = ?",
              [victim.flavorId],
            ),
          );
          assert.notEqual(row!.name, "hijacked");
          const state = await runInTenant(owner, victim.id, async (em) => {
            const [category] = await em.execute<
              { name: string; archived_at: Date | null }[]
            >("select name,archived_at from catalog_categories where id=?", [
              victim.categoryId,
            ]);
            const [size] = await em.execute<
              { name: string; archived_at: Date | null }[]
            >("select name,archived_at from pizza_sizes where id=?", [
              victim.sizeId,
            ]);
            const [ingredient] = await em.execute<
              { name: string; archived_at: Date | null }[]
            >("select name,archived_at from catalog_ingredients where id=?", [
              victim.ingredientId,
            ]);
            const [flavor] = await em.execute<
              { name: string; archived_at: Date | null }[]
            >("select name,archived_at from catalog_flavors where id=?", [
              victim.catalogFlavorId,
            ]);
            const [price] = await em.execute<{ price_cents: number }[]>(
              "select price_cents from catalog_flavor_prices where flavor_id=? and size_id=?",
              [victim.catalogFlavorId, victim.sizeId],
            );
            const [link] = await em.execute<{ count: number }[]>(
              "select count(*)::int as count from catalog_flavor_ingredients where flavor_id=? and ingredient_id=?",
              [victim.catalogFlavorId, victim.ingredientId],
            );
            const [crust] = await em.execute<
              { name: string; available: boolean; archived_at: Date | null }[]
            >(
              "select name,available,archived_at from catalog_crusts where id=?",
              [victim.crustId],
            );
            const [extra] = await em.execute<
              { name: string; available: boolean; archived_at: Date | null }[]
            >(
              "select name,available,archived_at from catalog_extras where id=?",
              [victim.extraId],
            );
            const [product] = await em.execute<
              {
                name: string;
                price_cents: number;
                available: boolean;
                archived_at: Date | null;
              }[]
            >(
              "select name,price_cents,available,archived_at from catalog_simple_products where id=?",
              [victim.productId],
            );
            const [policy] = await em.execute<
              { max_extras_per_half: number }[]
            >(
              "select max_extras_per_half from catalog_pricing_policies where tenant_id=?",
              [victim.id],
            );
            const [crustPrice] = await em.execute<{ price_cents: number }[]>(
              "select price_cents from catalog_crust_prices where crust_id=? and size_id=?",
              [victim.crustId, victim.sizeId],
            );
            const [extraPrice] = await em.execute<
              { whole_price_cents: number; half_price_cents: number }[]
            >(
              "select whole_price_cents,half_price_cents from catalog_extra_prices where extra_id=? and size_id=?",
              [victim.extraId, victim.sizeId],
            );
            const [membership] = await em.execute<
              { role: string; status: string }[]
            >("select role,status from memberships where id=?", [
              victim.membershipId,
            ]);
            const [invite] = await em.execute<{ revoked_at: Date | null }[]>(
              "select revoked_at from staff_invites where id=?",
              [victim.inviteId],
            );
            return {
              membership: membership!,
              invite: invite!,
              category: category!,
              size: size!,
              ingredient: ingredient!,
              flavor: flavor!,
              price: price!,
              link: link!,
              crust: crust!,
              extra: extra!,
              product: product!,
              policy: policy!,
              crustPrice: crustPrice!,
              extraPrice: extraPrice!,
            };
          });
          assert.deepEqual(state.membership, {
            role: "STAFF",
            status: "ACTIVE",
          });
          assert.equal(state.invite.revoked_at, null);
          assert.equal(state.category.name, `${victim.slug} category`);
          assert.equal(state.category.archived_at, null);
          assert.equal(state.size.name, `${victim.slug} size`);
          assert.equal(state.size.archived_at, null);
          assert.equal(state.ingredient.name, `${victim.slug} ingredient`);
          assert.equal(state.ingredient.archived_at, null);
          assert.equal(state.flavor.name, `${victim.slug} flavor`);
          assert.equal(state.flavor.archived_at, null);
          assert.equal(state.price.price_cents, 1000);
          assert.equal(state.link.count, 1);
          assert.equal(state.crust.name, `${victim.slug} crust`);
          assert.equal(state.crust.available, true);
          assert.equal(state.crust.archived_at, null);
          assert.equal(state.extra.name, `${victim.slug} extra`);
          assert.equal(state.extra.available, true);
          assert.equal(state.extra.archived_at, null);
          assert.equal(state.product.name, `${victim.slug} product`);
          assert.equal(state.product.price_cents, 500);
          assert.equal(state.product.available, true);
          assert.equal(state.product.archived_at, null);
          assert.equal(state.policy.max_extras_per_half, 4);
          assert.equal(state.crustPrice.price_cents, 0);
          assert.deepEqual(state.extraPrice, {
            whole_price_cents: 1000,
            half_price_cents: 500,
          });
        }
      });
    }

    it("the same routes serve the tenant's own resource", async () => {
      const response = await call(
        `/public/stores/${a.slug}/isolation-probe/${a.flavorId}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await json(response), {
        id: a.flavorId,
        name: "Margherita A",
      });
    });

    it("a listing only returns the store's own rows", async () => {
      const response = await call(`/public/stores/${b.slug}/isolation-probe`);
      assert.deepEqual(await json(response), ["Calabresa B"]);
    });

    it("unknown or malformed slugs answer 404 and a store that is not ACTIVE answers 403 without its status", async () => {
      for (const slug of ["nao-existe", "UPPER", "a", "pizzaria-a%20"]) {
        const response = await call(`/public/stores/${slug}/isolation-probe`);
        assert.equal(response.status, 404, slug);
        assert.equal((await json(response)).code, "NOT_FOUND");
      }
      const suspended = await call(
        "/public/stores/pizzaria-suspensa/isolation-probe",
      );
      assert.equal(suspended.status, 403);
      const body = await json(suspended);
      assert.equal(body.code, "TENANT_NOT_ACTIVE");
      assert.doesNotMatch(JSON.stringify(body), /SUSPENDED/);
    });

    it("public checkout settings are selected only by the store slug", async () => {
      for (const [store, fee] of [
        [a, 111],
        [b, 222],
      ] as const) {
        await runInTenant(owner, store.id, (em) =>
          em.execute(
            `insert into store_settings (tenant_id, fulfillment_modes, delivery_fee_cents, minimum_order_cents, estimated_prep_minutes, estimated_delivery_minutes, accept_timeout_minutes, accepted_payment_methods, delivery_area_description)
           values (?, '{DELIVERY}', ?, 0, 30, 30, 10, '{CASH}', ?)`,
            [store.id, fee, `Área ${store.slug}`],
          ),
        );
      }
      try {
        for (const [store, other, fee] of [
          [a, b, 111],
          [b, a, 222],
        ] as const) {
          const response = await call(
            `/public/stores/${store.slug}?tenantId=${other.id}`,
            { headers: { "x-tenant-id": other.id } },
          );
          assert.equal(response.status, 200);
          const body = await json(response);
          assert.deepEqual(body.checkout, {
            fulfillmentModes: ["DELIVERY"],
            deliveryFeeCents: fee,
            minimumOrderCents: 0,
            deliveryAreaDescription: `Área ${store.slug}`,
            acceptedPaymentMethods: ["CASH"],
            pickupAddress: null,
          });
          assert.ok(!JSON.stringify(body).includes(other.slug));
        }
      } finally {
        for (const store of [a, b])
          await runInTenant(owner, store.id, (em) =>
            em.execute("delete from store_settings"),
          );
      }
    });

    it("the public menu lists only the store's own catalog", async () => {
      for (const [store, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const response = await call(`/public/stores/${store.slug}/menu`, {
          headers: { "x-tenant-id": other.id },
        });
        assert.equal(response.status, 200);
        const menu = JSON.stringify(await json(response));
        assert.match(menu, new RegExp(`${store.slug} flavor`));
        for (const id of [
          other.catalogFlavorId,
          other.sizeId,
          other.crustId,
          other.extraId,
          other.productId,
        ])
          assert.doesNotMatch(menu, new RegExp(id));
      }
    });

    it("ignores tenant hints in headers, query and body", async () => {
      const response = await call(
        `/public/stores/${a.slug}/isolation-probe?tenantId=${b.id}&tenant_id=${b.id}`,
        { headers: { "x-tenant-id": b.id } },
      );
      assert.deepEqual(await json(response), ["Margherita A"]);
    });

    it("logs the resolved tenantId with the request", async () => {
      await call(`/public/stores/${a.slug}/isolation-probe`);
      await nextTick();
      const line = server.logs.findLast(
        (log) => log.msg === "request completed",
      );
      assert.equal(line?.tenantId, a.id);
    });
  });

  describe("2. RLS coverage", () => {
    it("every table with tenant_id has RLS enabled, forced and only tenant-check policies", async () => {
      assert.deepEqual(await findUnprotectedTenantTables(owner), []);
    });

    it("covers every production tenant table", async () => {
      const rows = await owner.em
        .getConnection()
        .execute<{ table: string; forced: boolean }[]>(
          `select c.relname as "table", c.relforcerowsecurity as forced
           from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
            and c.relname not like 'isolation_probe_%'
            and c.relname <> 'audit_events'
          order by 1`,
        );
      assert.deepEqual(rows, [
        { table: "billing_entries", forced: true },
        { table: "brand_themes", forced: true },
        { table: "catalog_categories", forced: true },
        { table: "catalog_crust_prices", forced: true },
        { table: "catalog_crusts", forced: true },
        { table: "catalog_extra_prices", forced: true },
        { table: "catalog_extras", forced: true },
        { table: "catalog_flavor_ingredients", forced: true },
        { table: "catalog_flavor_prices", forced: true },
        { table: "catalog_flavors", forced: true },
        { table: "catalog_ingredients", forced: true },
        { table: "catalog_pricing_policies", forced: true },
        { table: "catalog_simple_products", forced: true },
        { table: "catalog_versions", forced: true },
        { table: "customer_addresses", forced: true },
        { table: "customer_push_devices", forced: true },
        { table: "customer_sessions", forced: true },
        { table: "customers", forced: true },
        { table: "image_assets", forced: true },
        { table: "memberships", forced: true },
        { table: "order_creation_keys", forced: true },
        { table: "order_incidents", forced: true },
        { table: "order_items", forced: true },
        { table: "order_status_changes", forced: true },
        { table: "orders", forced: true },
        { table: "owner_invites", forced: true },
        { table: "pizza_sizes", forced: true },
        { table: "plan_subscriptions", forced: true },
        { table: "push_deliveries", forced: true },
        { table: "staff_invites", forced: true },
        { table: "store_opening_hours", forced: true },
        { table: "store_pauses", forced: true },
        { table: "store_settings", forced: true },
        { table: "tenant_order_counters", forced: true },
      ]);
    });

    it("keeps the global append-only audit table inaccessible to the app role", async () => {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"])
        assert.equal(
          await owner.em
            .getConnection()
            .execute<{ allowed: boolean }[]>(
              "select has_table_privilege('whiteoven_app', 'audit_events', ?) as allowed",
              [privilege],
            )
            .then(([row]) => row!.allowed),
          false,
          privilege,
        );
      assert.deepEqual(await findUnprotectedTenantTables(owner), []);
    });

    /** Problems reported for `table`, or [] when it is considered protected. */
    const problemsOf = async (table: string) =>
      (await findUnprotectedTenantTables(owner)).find((t) => t.table === table)
        ?.problems ?? [];

    /** Creates a protected tenant table, runs `extra` statements on it, then `check`, then drops it. */
    const withCoverageTable = async (
      extra: string[],
      check: (table: string) => Promise<void>,
    ) => {
      const table = "coverage_probe";
      const sql = owner.em.getConnection();
      await sql.execute(
        `create table ${table} (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants (id))`,
      );
      try {
        for (const statement of [...tenantIsolationSql(table), ...extra])
          await sql.execute(statement);
        await check(table);
      } finally {
        await sql.execute(`drop table ${table}`);
      }
    };

    it("flags a new tenant table until it is fully protected", async () => {
      const sql = owner.em.getConnection();
      await sql.execute(
        "create table coverage_probe (id uuid primary key, tenant_id uuid not null references tenants (id))",
      );
      try {
        assert.deepEqual(await problemsOf("coverage_probe"), [
          "row level security disabled",
          "row level security not forced",
          "no permissive policy for whiteoven_app",
        ]);
        await sql.execute(
          "alter table coverage_probe enable row level security",
        );
        await sql.execute(
          "alter table coverage_probe force row level security",
        );
        // RLS without a policy denies everything, but is still flagged: the table is unusable.
        assert.deepEqual(await problemsOf("coverage_probe"), [
          "no permissive policy for whiteoven_app",
        ]);
        await sql.execute(
          "alter table coverage_probe no force row level security",
        );
        await sql.execute(
          "alter table coverage_probe disable row level security",
        );
        for (const statement of tenantIsolationSql("coverage_probe"))
          await sql.execute(statement);
        assert.deepEqual(await problemsOf("coverage_probe"), []);
      } finally {
        await sql.execute("drop table coverage_probe");
      }
    });

    it("flags a nullable tenant_id", async () => {
      const sql = owner.em.getConnection();
      await sql.execute(
        "create table nullable_probe (id uuid primary key, tenant_id uuid)",
      );
      try {
        for (const statement of tenantIsolationSql("nullable_probe"))
          await sql.execute(statement);
        assert.deepEqual(await problemsOf("nullable_probe"), [
          "tenant_id is nullable",
        ]);
      } finally {
        await sql.execute("drop table nullable_probe");
      }
    });

    it("flags an extra permissive policy that exposes every tenant without context", async () => {
      await withCoverageTable(
        [
          "create policy open_all on coverage_probe using (true) with check (true)",
        ],
        async (table) => {
          await runInTenant(owner, b.id, (em) =>
            em.execute(`insert into ${table} (tenant_id) values (?)`, [b.id]),
          );
          // The leak is real: whiteoven_app reads tenant B's row with no context at all.
          assert.equal(
            await appCount(`select count(*)::int as count from ${table}`),
            1,
          );
          assert.deepEqual(await problemsOf(table), [
            'permissive policy "open_all": USING is not the tenant check',
            'permissive policy "open_all": WITH CHECK is not the tenant check',
          ]);
        },
      );
    });

    const UNSAFE_POLICIES: [string, string, string[]][] = [
      [
        "a SELECT-only policy for whiteoven_app",
        "create policy app_reads on coverage_probe for select to whiteoven_app using (true)",
        ['permissive policy "app_reads": USING is not the tenant check'],
      ],
      [
        "an INSERT policy with an open WITH CHECK",
        "create policy app_inserts on coverage_probe for insert with check (true)",
        ['permissive policy "app_inserts": WITH CHECK is not the tenant check'],
      ],
      [
        "an UPDATE policy that lets rows move to another tenant",
        "create policy app_moves on coverage_probe for update using (tenant_id = whiteoven_current_tenant()) with check (tenant_id is not null)",
        ['permissive policy "app_moves": WITH CHECK is not the tenant check'],
      ],
      [
        "a DELETE policy wider than the tenant check",
        "create policy app_deletes on coverage_probe for delete using (tenant_id = whiteoven_current_tenant() or tenant_id is not null)",
        ['permissive policy "app_deletes": USING is not the tenant check'],
      ],
      [
        "a policy for whiteoven_platform reading without context",
        "create policy platform_reads on coverage_probe for select to whiteoven_platform using (true)",
        ['permissive policy "platform_reads": USING is not the tenant check'],
      ],
      [
        "a policy reading the setting without nullif (fails with an error, not closed)",
        "create policy raw_setting on coverage_probe using (tenant_id = current_setting('app.tenant_id', true)::uuid)",
        [
          'permissive policy "raw_setting": USING is not the tenant check',
          'permissive policy "raw_setting": WITH CHECK is not the tenant check',
        ],
      ],
    ];

    for (const [name, statement, expected] of UNSAFE_POLICIES) {
      it(`flags ${name}`, async () => {
        await withCoverageTable([statement], async (table) => {
          assert.deepEqual(await problemsOf(table), expected);
        });
      });
    }

    it("flags the tenant policy rewritten with an open WITH CHECK", async () => {
      await withCoverageTable(
        ["alter policy tenant_isolation on coverage_probe with check (true)"],
        async (table) => {
          assert.deepEqual(await problemsOf(table), [
            'permissive policy "tenant_isolation": WITH CHECK is not the tenant check',
          ]);
        },
      );
    });

    it("flags a look-alike tenant function from another schema", async () => {
      const sql = owner.em.getConnection();
      await sql.execute("create schema coverage_lookalike");
      try {
        await withCoverageTable(
          [
            "create function coverage_lookalike.whiteoven_current_tenant() returns uuid language sql stable as $$ select tenant_id from public.coverage_probe limit 1 $$",
            "alter policy tenant_isolation on coverage_probe using (tenant_id = coverage_lookalike.whiteoven_current_tenant()) with check (tenant_id = coverage_lookalike.whiteoven_current_tenant())",
          ],
          async (table) => {
            assert.deepEqual(await problemsOf(table), [
              'permissive policy "tenant_isolation": USING is not the tenant check',
              'permissive policy "tenant_isolation": WITH CHECK is not the tenant check',
            ]);
          },
        );
      } finally {
        await sql.execute("drop schema coverage_lookalike cascade");
      }
    });

    it("flags a table whose only permissive policy excludes whiteoven_app", async () => {
      await withCoverageTable(
        [
          "drop policy tenant_isolation on coverage_probe",
          "create policy platform_only on coverage_probe to whiteoven_platform using (tenant_id = whiteoven_current_tenant()) with check (tenant_id = whiteoven_current_tenant())",
        ],
        async (table) => {
          assert.deepEqual(await problemsOf(table), [
            "no permissive policy for whiteoven_app",
          ]);
        },
      );
    });

    it("accepts the tenant check without explicit WITH CHECK and extra restrictive policies, still failing closed", async () => {
      await withCoverageTable(
        [
          "drop policy tenant_isolation on coverage_probe",
          "create policy tenant_isolation on coverage_probe using (tenant_id = whiteoven_current_tenant())",
          "create policy only_named on coverage_probe as restrictive using (id is not null)",
        ],
        async (table) => {
          assert.deepEqual(await problemsOf(table), []);
          await runInTenant(owner, a.id, (em) =>
            em.execute(`insert into ${table} (tenant_id) values (?)`, [a.id]),
          );
          assert.equal(
            await appCount(`select count(*)::int as count from ${table}`),
            0,
          );
          assert.equal(
            await sqlState(() =>
              runInTenant(app, a.id, (em) =>
                em.execute(`insert into ${table} (tenant_id) values (?)`, [
                  b.id,
                ]),
              ),
            ),
            INSUFFICIENT_PRIVILEGE,
          );
        },
      );
    });

    it("refuses an ORM entity mapping tenant_id without the default tenant filter", async () => {
      const Unfiltered = defineEntity({
        name: "UnfilteredProbe",
        tableName: "isolation_probe_flavors",
        properties: { id: p.uuid().primary(), tenantId: p.uuid() },
      });
      await assert.rejects(
        createOrm(
          { url: database.appUrl, poolMax: 1 },
          { entities: [Tenant, Unfiltered] },
        ),
        /UnfilteredProbe/,
      );
      // `app` above was created with the probe entity and passed the same check.
      assert.doesNotThrow(() => assertTenantFilters(app));
    });

    it("closes the ORM it built when the tenant filter check fails", async () => {
      const Unfiltered = defineEntity({
        name: "UnfilteredProbe",
        tableName: "isolation_probe_flavors",
        properties: { id: p.uuid().primary(), tenantId: p.uuid() },
      });
      const closed: MikroORM[] = [];
      const close = MikroORM.prototype.close;
      MikroORM.prototype.close = function (this: MikroORM, ...args) {
        closed.push(this);
        return close.apply(this, args);
      };
      try {
        await assert.rejects(
          createOrm(
            { url: database.appUrl, poolMax: 1 },
            { entities: [Tenant, Unfiltered] },
          ),
          /UnfilteredProbe/,
        );
      } finally {
        MikroORM.prototype.close = close;
      }
      assert.equal(closed.length, 1);
      assert.equal(await closed[0]!.isConnected(), false);
    });
  });

  describe("3. fail closed without context", () => {
    it("whiteoven_app reads zero rows and cannot insert", async () => {
      assert.equal(
        await appCount(
          "select count(*)::int as count from isolation_probe_flavors",
        ),
        0,
      );
      assert.equal(
        await sqlState(() =>
          app.em
            .getConnection()
            .execute(
              "insert into isolation_probe_flavors (tenant_id, name) values (?, 'x')",
              [a.id],
            ),
        ),
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it("the owner is subject to the policies too (FORCE)", async () => {
      const [row] = await owner.em
        .getConnection()
        .execute<{ count: number }[]>(
          "select count(*)::int as count from isolation_probe_flavors",
        );
      assert.equal(row!.count, 0);
    });

    it("a context cannot write rows of another tenant", async () => {
      assert.equal(
        await sqlState(() =>
          runInTenant(app, a.id, (em) =>
            em.execute(
              "insert into isolation_probe_flavors (tenant_id, name) values (?, 'x')",
              [b.id],
            ),
          ),
        ),
        INSUFFICIENT_PRIVILEGE,
      );
      assert.equal(
        await runInTenant(app, a.id, async (em) => {
          const result = await em.execute<{ affectedRows: number }>(
            "update isolation_probe_flavors set tenant_id = ? where id = ?",
            [b.id, a.flavorId],
            "run",
          );
          return result.affectedRows;
        }).catch((error: { code?: string }) => error.code),
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it("the ORM refuses a tenant entity query without tenant parameters", async () => {
      await assert.rejects(
        app.em.fork().find(ProbeFlavor, {}),
        /No arguments provided for filter 'tenant'/,
      );
    });

    it("with the ORM filter explicitly disabled, RLS still returns only the context's rows", async () => {
      const names = await runInTenant(app, a.id, async (em) =>
        (await em.find(ProbeFlavor, {}, { filters: { tenant: false } })).map(
          (row) => row.name,
        ),
      );
      assert.deepEqual(names, ["Margherita A"]);
    });

    it("TenantTransactions refuses to run outside a request context", async () => {
      await assert.rejects(
        new TenantTransactions(app).run(async () => "unreachable"),
        /no tenant context/,
      );
    });

    it("whiteoven_app only reads tenants", async () => {
      assert.equal(
        await appCount("select count(*)::int as count from tenants"),
        3,
      );
      for (const statement of [
        "insert into tenants (slug, display_name) values ('intrusa', 'x')",
        "update tenants set status = 'ACTIVE'",
        "delete from tenants",
      ])
        assert.equal(
          await sqlState(() => app.em.getConnection().execute(statement)),
          INSUFFICIENT_PRIVILEGE,
          statement,
        );
    });
  });

  describe("4. pooled connection reuse", () => {
    const backend = (em: { execute: MikroORM["em"]["execute"] }) =>
      em.execute<{ pid: number; names: string[] }[]>(
        `select pg_backend_pid() as pid,
                coalesce(array_agg(name order by name) filter (where name is not null), '{}') as names
           from (select name from isolation_probe_flavors) f`,
      );

    it("sequential tenants on the same connection never share context", async () => {
      const [first] = await runInTenant(app, a.id, backend);
      const [second] = await runInTenant(app, b.id, backend);
      const [after] = await backend(app.em.fork());
      const [setting] = await app.em
        .getConnection()
        .execute<{ value: string | null }[]>(
          "select current_setting('app.tenant_id', true) as value",
        );
      assert.equal(first!.pid, second!.pid);
      assert.equal(second!.pid, after!.pid);
      assert.deepEqual(first!.names, ["Margherita A"]);
      assert.deepEqual(second!.names, ["Calabresa B"]);
      assert.deepEqual(after!.names, []);
      // The variable is defined but empty after the transaction; the policy treats it as no tenant.
      assert.ok(setting!.value === "" || setting!.value === null);
    });

    it("a failed tenant transaction does not leak its context either", async () => {
      await assert.rejects(
        runInTenant(app, a.id, async (em) => {
          await em.execute("select 1");
          throw new Error("boom");
        }),
        /boom/,
      );
      assert.equal(
        await appCount(
          "select count(*)::int as count from isolation_probe_flavors",
        ),
        0,
      );
    });

    it("sequential HTTP requests for different stores on a one-connection pool", async () => {
      for (const [store, expected] of [
        [a, ["Margherita A"]],
        [b, ["Calabresa B"]],
        [a, ["Margherita A"]],
      ] as const) {
        const response = await call(
          `/public/stores/${store.slug}/isolation-probe`,
        );
        assert.deepEqual(await json(response), expected);
      }
    });

    it("rejects a tenant id that is not a UUID before touching the database", async () => {
      await assert.rejects(
        runInTenant(app, "' or true --", async () => 1),
        /UUID/,
      );
    });
  });

  describe("5. composite foreign keys", () => {
    it("an item of tenant A cannot reference a flavor of tenant B", async () => {
      assert.equal(
        await sqlState(() =>
          runInTenant(owner, a.id, (em) =>
            em.execute(
              "insert into isolation_probe_items (tenant_id, flavor_id) values (?, ?)",
              [a.id, b.flavorId],
            ),
          ),
        ),
        FOREIGN_KEY_VIOLATION,
      );
      await runInTenant(owner, a.id, (em) =>
        em.execute(
          "insert into isolation_probe_items (tenant_id, flavor_id) values (?, ?)",
          [a.id, a.flavorId],
        ),
      );
    });

    it("holds even with RLS disabled (e.g. inside a migration)", async () => {
      const sql = owner.em.getConnection();
      await sql
        .transactional(async (trx) => {
          await sql.execute(
            "alter table isolation_probe_items no force row level security",
            [],
            "run",
            trx,
          );
          await sql.execute(
            "alter table isolation_probe_items disable row level security",
            [],
            "run",
            trx,
          );
          await sql.execute(
            "alter table isolation_probe_flavors no force row level security",
            [],
            "run",
            trx,
          );
          await sql.execute(
            "alter table isolation_probe_flavors disable row level security",
            [],
            "run",
            trx,
          );
          const error = await sql
            .execute(
              "insert into isolation_probe_items (tenant_id, flavor_id) values (?, ?)",
              [a.id, b.flavorId],
              "run",
              trx,
            )
            .then(
              () => undefined,
              (e: { code?: string }) => e.code,
            );
          assert.equal(error, FOREIGN_KEY_VIOLATION);
          throw new Error("rollback");
        })
        .catch((error: Error) => assert.equal(error.message, "rollback"));
      assert.deepEqual(await findUnprotectedTenantTables(owner), []);
    });
  });

  describe("6. cross-store token", () => {
    it("a token of tenant A on tenant B's store answers 404", async () => {
      const response = await call(
        `/customer/stores/${b.slug}/isolation-probe/${b.flavorId}`,
        {
          headers: { "x-test-token-tid": a.id },
        },
      );
      assert.equal(response.status, 404);
      assert.equal((await json(response)).code, "NOT_FOUND");
    });

    it("the same token works on its own store", async () => {
      const response = await call(
        `/customer/stores/${a.slug}/isolation-probe/${a.flavorId}`,
        {
          headers: { "x-test-token-tid": a.id },
        },
      );
      assert.equal(response.status, 200);
    });
  });

  describe("7. membership revocation", () => {
    it("a revoked member loses access on the very next request", async () => {
      const email = "revogada@isolamento.test";
      const userId = await insertStaffUser(owner, email, STAFF_PASSWORD);
      await insertMembership(owner, a.id, userId, "MANAGER");
      const login = await staffLogin(server.baseUrl, email, STAFF_PASSWORD);
      const switched = await switchTenant(
        server.baseUrl,
        login.accessToken,
        a.id,
      );
      const { accessToken } = await json(switched);
      const me = () =>
        call("/admin/me", {
          headers: { authorization: `Bearer ${accessToken}` },
        });
      assert.equal((await me()).status, 200);

      await setMembershipStatus(owner, a.id, userId, "REVOKED");
      const denied = await me();
      assert.equal(denied.status, 403);
      assert.equal((await json(denied)).code, "TENANT_ACCESS_DENIED");

      // The same token cannot pick the tenant again, and other stores stay invisible.
      for (const tenantId of [a.id, b.id]) {
        const retry = await switchTenant(server.baseUrl, accessToken, tenantId);
        assert.equal(retry.status, 404);
      }
    });

    it("a staff token of tenant A cannot act on tenant B", async () => {
      const email = "so-a@isolamento.test";
      const userId = await insertStaffUser(owner, email, STAFF_PASSWORD);
      await insertMembership(owner, a.id, userId, "OWNER");
      const login = await staffLogin(server.baseUrl, email, STAFF_PASSWORD);
      const response = await switchTenant(
        server.baseUrl,
        login.accessToken,
        b.id,
      );
      assert.equal(response.status, 404);
      assert.equal((await json(response)).code, "NOT_FOUND");
    });
  });
});
