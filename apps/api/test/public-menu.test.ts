import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { get } from "node:http";
import { after, before, describe, it } from "node:test";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { json, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import { insertTenant } from "./staff-fixtures";
import { PublicMenuService } from "../src/catalog/public-menu.service";
import { currentTenantContext } from "../src/tenancy/tenant-context";
import { runInTenant } from "../src/tenancy/tenant-transaction";

type Sql = (query: string, params?: unknown[]) => Promise<string>;

/** Inserts with `returning id` inside the tenant transaction (FORCE RLS applies to the owner). */
const seed = (
  owner: MikroORM,
  tenantId: string,
  work: (sql: Sql) => Promise<void>,
) =>
  runInTenant(owner, tenantId, (em: EntityManager) =>
    work(async (query, params = []) => {
      const [row] = await em.execute<{ id: string }[]>(query, params);
      return row?.id ?? "";
    }),
  );

describe("M2.6 public menu", databaseSuite, () => {
  let database: TestDatabase;
  let owner: MikroORM;
  let server: TestServer;
  const stores: Record<"a" | "b", { id: string; slug: string }> = {
    a: { id: "", slug: `menu-a-${randomUUID().slice(0, 8)}` },
    b: { id: "", slug: `menu-b-${randomUUID().slice(0, 8)}` },
  };
  let priceId = "";

  /** One orderable pizza, crust, extra and product per store, named after the store. */
  const seedSimpleStore = (tenantId: string, label: string) =>
    seed(owner, tenantId, async (sql) => {
      const category = await sql(
        "insert into catalog_categories (tenant_id,name,kind) values (?,?,'PIZZA') returning id",
        [tenantId, `Pizzas ${label}`],
      );
      const size = await sql(
        "insert into pizza_sizes (tenant_id,name,slices,max_flavors) values (?,'Grande',8,2) returning id",
        [tenantId],
      );
      const flavor = await sql(
        "insert into catalog_flavors (tenant_id,category_id,name) values (?,?,?) returning id",
        [tenantId, category, `Sabor ${label}`],
      );
      const price = await sql(
        "insert into catalog_flavor_prices (tenant_id,flavor_id,size_id,price_cents) values (?,?,?,4000) returning id",
        [tenantId, flavor, size],
      );
      if (tenantId === stores.a.id) priceId = price;
    });

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    stores.a.id = await insertTenant(owner, stores.a.slug);
    stores.b.id = await insertTenant(owner, stores.b.slug);
    await seedSimpleStore(stores.a.id, "A");
    await seedSimpleStore(stores.b.id, "B");
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

  const menu = (slug: string) =>
    fetch(`${server.baseUrl}/v1/public/stores/${slug}/menu`);

  it("lists only orderable items, never archived, unavailable or unpriced ones", async () => {
    const slug = `menu-full-${randomUUID().slice(0, 8)}`;
    const tenantId = await insertTenant(owner, slug);
    await seed(owner, tenantId, async (sql) => {
      const pizzas = await sql(
        "insert into catalog_categories (tenant_id,name,kind,sort_order) values (?,'Pizzas','PIZZA',1) returning id",
        [tenantId],
      );
      const oldPizzas = await sql(
        "insert into catalog_categories (tenant_id,name,kind) values (?,'Antigas','PIZZA') returning id",
        [tenantId],
      );
      const drinks = await sql(
        "insert into catalog_categories (tenant_id,name,kind,sort_order) values (?,'Bebidas','PRODUCT',2) returning id",
        [tenantId],
      );
      await sql(
        "insert into catalog_categories (tenant_id,name,kind) values (?,'Vazia','PRODUCT') returning id",
        [tenantId],
      );
      const large = await sql(
        "insert into pizza_sizes (tenant_id,name,slices,max_flavors) values (?,'Grande',8,2) returning id",
        [tenantId],
      );
      const small = await sql(
        "insert into pizza_sizes (tenant_id,name,slices,max_flavors) values (?,'Broto',4,1) returning id",
        [tenantId],
      );
      const medium = await sql(
        "insert into pizza_sizes (tenant_id,name,slices,max_flavors,available) values (?,'Média',6,2,false) returning id",
        [tenantId],
      );
      const tomato = await sql(
        "insert into catalog_ingredients (tenant_id,name) values (?,'Tomate') returning id",
        [tenantId],
      );
      const oldIngredient = await sql(
        "insert into catalog_ingredients (tenant_id,name) values (?,'Antigo') returning id",
        [tenantId],
      );
      await sql(
        "insert into catalog_ingredients (tenant_id,name) values (?,'Sem uso') returning id",
        [tenantId],
      );
      const flavor = async (name: string, category: string, available = true) =>
        sql(
          "insert into catalog_flavors (tenant_id,category_id,name,description,available) values (?,?,?,?,?) returning id",
          [tenantId, category, name, `${name} descrição`, available],
        );
      const price = (flavorId: string, sizeId: string, cents: number) =>
        sql(
          "insert into catalog_flavor_prices (tenant_id,flavor_id,size_id,price_cents) values (?,?,?,?) returning id",
          [tenantId, flavorId, sizeId, cents],
        );
      const margherita = await flavor("Marguerita", pizzas);
      await price(margherita, large, 4500);
      await price(margherita, medium, 3900);
      for (const ingredient of [tomato, oldIngredient])
        await sql(
          "insert into catalog_flavor_ingredients (tenant_id,flavor_id,ingredient_id) values (?,?,?) returning flavor_id as id",
          [tenantId, margherita, ingredient],
        );
      await price(await flavor("Esgotada", pizzas, false), large, 4000);
      await flavor("Sem preço", pizzas);
      await price(await flavor("Só média", pizzas), medium, 3000);
      await price(await flavor("Arquivada", pizzas), large, 4000);
      await price(await flavor("Na categoria antiga", oldPizzas), large, 4000);
      await sql(
        "update catalog_flavors set archived_at=now(),available=false where name='Arquivada' returning id",
      );
      await sql(
        "update catalog_categories set archived_at=now() where id=? returning id",
        [oldPizzas],
      );
      await sql(
        "update catalog_ingredients set archived_at=now() where id=? returning id",
        [oldIngredient],
      );

      const crust = async (name: string, sizeId?: string, available = true) => {
        const id = await sql(
          "insert into catalog_crusts (tenant_id,name,available) values (?,?,?) returning id",
          [tenantId, name, available],
        );
        if (sizeId)
          await sql(
            "insert into catalog_crust_prices (tenant_id,crust_id,size_id,price_cents) values (?,?,?,800) returning id",
            [tenantId, id, sizeId],
          );
      };
      await crust("Recheada", large);
      await crust("Só no broto", small);
      await crust("Sem preço");
      await crust("Esgotada", large, false);
      const olive = await sql(
        "insert into catalog_extras (tenant_id,name) values (?,'Azeitona') returning id",
        [tenantId],
      );
      await sql(
        "insert into catalog_extra_prices (tenant_id,extra_id,size_id,whole_price_cents,half_price_cents) values (?,?,?,600,300) returning id",
        [tenantId, olive, large],
      );
      await sql(
        "insert into catalog_extras (tenant_id,name) values (?,'Sem preço') returning id",
        [tenantId],
      );
      await sql(
        "insert into catalog_simple_products (tenant_id,category_id,name,price_cents) values (?,?,'Refrigerante',800) returning id",
        [tenantId, drinks],
      );
      await sql(
        "insert into catalog_simple_products (tenant_id,category_id,name,price_cents,available) values (?,?,'Suco',900,false) returning id",
        [tenantId, drinks],
      );
      await sql(
        "insert into catalog_pricing_policies (tenant_id,half_and_half_strategy,half_and_half_surcharge_cents,max_extras_per_half) values (?,'HIGHEST',0,3) returning tenant_id as id",
        [tenantId],
      );
    });

    const response = await menu(slug);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    const etag = response.headers.get("etag");
    assert.ok(etag);
    // fetch() adds `cache-control: no-cache` to conditional requests, which disables 304s.
    const revalidated = await new Promise<number | undefined>(
      (resolve, reject) =>
        get(
          `${server.baseUrl}/v1/public/stores/${slug}/menu`,
          { headers: { "if-none-match": etag } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        ).on("error", reject),
    );
    assert.equal(revalidated, 304);
    const body = await json(response);
    const names = (items: { name: string }[]) => items.map((item) => item.name);
    assert.deepEqual(body.store, { slug, name: `Pizzaria ${slug}` });
    assert.ok(Number.isSafeInteger(body.version) && body.version > 0);
    assert.deepEqual(names(body.categories), ["Pizzas", "Bebidas"]);
    assert.deepEqual(names(body.sizes), ["Grande"]);
    assert.deepEqual(body.sizes[0], {
      id: body.sizes[0].id,
      name: "Grande",
      slices: 8,
      maxFlavors: 2,
    });
    assert.deepEqual(names(body.flavors), ["Marguerita"]);
    assert.equal(body.flavors[0].description, "Marguerita descrição");
    assert.equal(body.flavors[0].imageId, null);
    assert.deepEqual(names(body.ingredients), ["Tomate"]);
    assert.deepEqual(body.flavors[0].ingredientIds, [body.ingredients[0].id]);
    assert.deepEqual(body.flavorPrices, [
      {
        flavorId: body.flavors[0].id,
        sizeId: body.sizes[0].id,
        priceCents: 4500,
      },
    ]);
    assert.deepEqual(names(body.crusts), ["Recheada"]);
    assert.deepEqual(body.crustPrices, [
      {
        crustId: body.crusts[0].id,
        sizeId: body.sizes[0].id,
        priceCents: 800,
      },
    ]);
    assert.deepEqual(names(body.extras), ["Azeitona"]);
    assert.deepEqual(body.extraPrices, [
      {
        extraId: body.extras[0].id,
        sizeId: body.sizes[0].id,
        wholePriceCents: 600,
        halfPriceCents: 300,
      },
    ]);
    assert.deepEqual(names(body.simpleProducts), ["Refrigerante"]);
    assert.equal(body.simpleProducts[0].imageId, null);
    assert.deepEqual(body.pricingPolicy, {
      halfAndHalfStrategy: "HIGHEST",
      halfAndHalfSurchargeCents: 0,
      maxExtrasPerHalf: 3,
    });
    assert.doesNotMatch(
      JSON.stringify(body),
      /archived|available|sortOrder|tenantId|Esgotad|Suco|Antig/,
    );
  });

  it("answers an empty menu for a store without catalog", async () => {
    const slug = `menu-empty-${randomUUID().slice(0, 8)}`;
    await insertTenant(owner, slug);
    const body = await json(await menu(slug));
    assert.equal(body.version, 0);
    assert.deepEqual(body.flavors, []);
    assert.equal(body.pricingPolicy, null);
  });

  it("answers 403 without status or catalog for a store that is not ACTIVE", async () => {
    for (const status of ["ONBOARDING", "SUSPENDED", "CLOSED"]) {
      const slug = `menu-${status.toLowerCase()}-${randomUUID().slice(0, 8)}`;
      const tenantId = await insertTenant(owner, slug, status);
      await seedSimpleStore(tenantId, status);
      const response = await menu(slug);
      assert.equal(response.status, 403, status);
      const body = await json(response);
      assert.equal(body.code, "TENANT_NOT_ACTIVE");
      assert.doesNotMatch(JSON.stringify(body), new RegExp(`${status}|Sabor`));
    }
  });

  it("suspending a store stops a cached menu at once", async () => {
    const slug = `menu-suspend-${randomUUID().slice(0, 8)}`;
    const tenantId = await insertTenant(owner, slug);
    await seedSimpleStore(tenantId, "Suspensa");
    assert.equal((await menu(slug)).status, 200);
    await owner.em
      .getConnection()
      .execute("update tenants set status='SUSPENDED' where id=?", [tenantId]);
    const response = await menu(slug);
    assert.equal(response.status, 403);
    assert.equal((await json(response)).code, "TENANT_NOT_ACTIVE");
  });

  it("caches per tenant and invalidates only the tenant whose catalog changed", async () => {
    const service = server.app.get(PublicMenuService);
    const built: string[] = [];
    const build = (
      service as unknown as { build: (em: EntityManager) => unknown }
    ).build;
    (service as unknown as { build: (em: EntityManager) => unknown }).build =
      function (this: PublicMenuService, em: EntityManager) {
        built.push(currentTenantContext().tenantId);
        return build.call(this, em);
      };
    try {
      const read = async (store: "a" | "b") => {
        const response = await menu(stores[store].slug);
        assert.equal(response.status, 200);
        return json(response);
      };
      const firstA = await read("a");
      const firstB = await read("b");
      assert.equal(firstA.flavors[0].name, "Sabor A");
      assert.equal(firstB.flavors[0].name, "Sabor B");
      const afterWarmup = built.length;

      assert.deepEqual(await read("a"), firstA);
      assert.deepEqual(await read("b"), firstB);
      assert.equal(built.length, afterWarmup, "warm menus come from cache");

      // Writes from any connection (another API instance, the admin API) bump the version.
      await runInTenant(owner, stores.a.id, (em) =>
        em.execute(
          "update catalog_flavor_prices set price_cents=4200 where id=?",
          [priceId],
        ),
      );
      const changedA = await read("a");
      assert.equal(changedA.flavorPrices[0].priceCents, 4200);
      assert.ok(changedA.version > firstA.version);
      assert.deepEqual(built.slice(afterWarmup), [stores.a.id]);

      assert.deepEqual(await read("b"), firstB);
      assert.deepEqual(await read("a"), changedA);
      assert.deepEqual(built.slice(afterWarmup), [stores.a.id]);

      // Availability changes invalidate too.
      await runInTenant(owner, stores.a.id, (em) =>
        em.execute("update catalog_flavors set available=false"),
      );
      assert.deepEqual((await read("a")).flavors, []);
      assert.deepEqual(await read("b"), firstB);
    } finally {
      (service as unknown as { build: unknown }).build = build;
    }
  });

  it("builds the menu from the snapshot of the version it is cached under", async () => {
    const slug = `menu-snapshot-${randomUUID().slice(0, 8)}`;
    const tenantId = await insertTenant(owner, slug);
    await seedSimpleStore(tenantId, "Snapshot");
    type Build = (em: EntityManager) => unknown;
    const service = server.app.get(PublicMenuService) as unknown as {
      build: Build;
    };
    const build = service.build;
    // The write runs from the test, outside the request's async context, so it commits on its
    // own connection after the request read the version and before the catalog queries run.
    let buildStarted!: () => void;
    const started = new Promise<void>((resolve) => (buildStarted = resolve));
    let releaseBuild!: () => void;
    const released = new Promise<void>((resolve) => (releaseBuild = resolve));
    service.build = async function (this: unknown, em: EntityManager) {
      buildStarted();
      await released;
      return build.call(this, em);
    };
    try {
      const pending = menu(slug);
      await started;
      await runInTenant(owner, tenantId, async (tx) => {
        await tx.execute("update catalog_flavor_prices set price_cents=4400");
        await tx.execute("update catalog_flavors set name='Sabor novo'");
      });
      releaseBuild();
      const first = await json(await pending);
      assert.equal(first.flavors[0].name, "Sabor Snapshot");
      assert.equal(first.flavorPrices[0].priceCents, 4000);
      service.build = build;
      const second = await json(await menu(slug));
      assert.ok(second.version > first.version);
      assert.equal(second.flavors[0].name, "Sabor novo");
      assert.equal(second.flavorPrices[0].priceCents, 4400);
    } finally {
      service.build = build;
    }
  });

  it("bumps the version once per statement, also for batch writes", async () => {
    const tenantId = await insertTenant(
      owner,
      `menu-batch-${randomUUID().slice(0, 8)}`,
    );
    const version = async () => {
      const [row] = await runInTenant(owner, tenantId, (em) =>
        em.execute<{ version: string }[]>(
          "select coalesce((select version from catalog_versions), 0) as version",
        ),
      );
      return Number(row!.version);
    };
    assert.equal(await version(), 0);
    await runInTenant(owner, tenantId, (em) =>
      em.execute(
        "insert into catalog_categories (tenant_id,name,kind) values (?,'Um','PIZZA'),(?,'Dois','PIZZA'),(?,'Três','PRODUCT')",
        [tenantId, tenantId, tenantId],
      ),
    );
    assert.equal(await version(), 1);
    await runInTenant(owner, tenantId, async (em) => {
      await em.execute("update catalog_categories set sort_order = 5");
      await em.execute(
        "update catalog_categories set archived_at = now() where kind = 'PRODUCT'",
      );
    });
    assert.equal(await version(), 3);
  });

  it("refuses to move catalog rows to another tenant", async () => {
    for (const table of [
      "catalog_categories",
      "pizza_sizes",
      "catalog_flavors",
      "catalog_flavor_prices",
    ]) {
      const error = await runInTenant(owner, stores.a.id, (em) =>
        em.execute(`update ${table} set tenant_id = ?`, [stores.b.id]),
      ).then(
        () => null,
        (error: { code?: string; constraint?: string }) => error,
      );
      assert.equal(error?.code, "23514", table);
      assert.equal(error?.constraint, "catalog_tenant_immutable", table);
    }
  });

  it("every catalog table bumps the version and keeps its tenant", async () => {
    const rows = await owner.em
      .getConnection()
      .execute<{ table: string; bump: boolean; guard: boolean }[]>(
        `select c.relname as "table",
              coalesce(bool_or(t.tgname = c.relname || '_bump_version'), false) as bump,
              coalesce(bool_or(t.tgname = c.relname || '_guard_tenant'), false) as guard
         from pg_class c left join pg_trigger t on t.tgrelid = c.oid
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
          and (c.relname like 'catalog\\_%' or c.relname = 'pizza_sizes')
          and c.relname <> 'catalog_versions'
        group by c.relname order by 1`,
      );
    assert.equal(rows.length, 12);
    for (const row of rows)
      assert.deepEqual(row, { table: row.table, bump: true, guard: true });
  });

  it("keeps the catalog version read-only for the app role", async () => {
    const app = await database.connect(database.appUrl);
    try {
      for (const statement of [
        "insert into catalog_versions (tenant_id) values (?)",
        "update catalog_versions set version = version + 1 where tenant_id = ?",
        "delete from catalog_versions where tenant_id = ?",
      ]) {
        const code = await runInTenant(app, stores.a.id, (em) =>
          em.execute(statement, [stores.a.id]),
        ).then(
          () => null,
          (error: { code?: string }) => error.code,
        );
        assert.equal(code, "42501", statement);
      }
    } finally {
      await app.close();
    }
  });
});
