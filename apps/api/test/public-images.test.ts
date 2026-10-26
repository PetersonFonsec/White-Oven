import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { EntityManager } from "@mikro-orm/postgresql";
import sharp from "sharp";
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

const PASSWORD = "public-images-password";

interface Store {
  id: string;
  slug: string;
  token: string;
  flavorId: string;
  productId: string;
}

/** M5.2 (ADR 0021): the menu and logo images the app reads without a session. */
describe("M5.2 public images", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let server: TestServer;
  let storageDirectory: string;
  let a: Store;
  let b: Store;

  const sql = (store: Store, query: string, params: unknown[] = []) =>
    runInTenant(owner, store.id, (em: EntityManager) =>
      em.execute<{ id: string }[]>(query, params),
    );

  /** A store with one orderable pizza and one product, and an OWNER session to upload. */
  const store = async (label: string): Promise<Store> => {
    const slug = `images-${label}-${randomUUID().slice(0, 8)}`;
    const id = await insertTenant(owner, slug);
    const email = `images-${label}-${randomUUID()}@test.invalid`;
    const user = await insertStaffUser(owner, email, PASSWORD);
    await insertMembership(owner, id, user, "OWNER");
    const login = await staffLogin(server.baseUrl, email, PASSWORD);
    const token = (
      await json(await switchTenant(server.baseUrl, login.accessToken, id))
    ).accessToken as string;
    const catalog = await runInTenant(owner, id, async (em) => {
      const row = async (query: string, params: unknown[]) =>
        (await em.execute<{ id: string }[]>(query, params))[0]!.id;
      const pizzas = await row(
        "insert into catalog_categories (tenant_id,name,kind) values (?,'Pizzas','PIZZA') returning id",
        [id],
      );
      const drinks = await row(
        "insert into catalog_categories (tenant_id,name,kind) values (?,'Bebidas','PRODUCT') returning id",
        [id],
      );
      const size = await row(
        "insert into pizza_sizes (tenant_id,name,slices,max_flavors) values (?,'Grande',8,2) returning id",
        [id],
      );
      const flavorId = await row(
        "insert into catalog_flavors (tenant_id,category_id,name) values (?,?,'Calabresa') returning id",
        [id, pizzas],
      );
      await em.execute(
        "insert into catalog_flavor_prices (tenant_id,flavor_id,size_id,price_cents) values (?,?,?,4000)",
        [id, flavorId, size],
      );
      const productId = await row(
        "insert into catalog_simple_products (tenant_id,category_id,name,price_cents) values (?,?,'Suco',900) returning id",
        [id, drinks],
      );
      return { flavorId, productId };
    });
    return { id, slug, token, ...catalog };
  };

  const upload = async (target: Store) => {
    const png = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "#d87535" },
    })
      .png()
      .toBuffer();
    const response = await fetch(`${server.baseUrl}/v1/admin/catalog/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.token}`,
        "content-type": "image/png",
      },
      body: new Uint8Array(png),
    });
    assert.equal(response.status, 201);
    return (await json(response)).id as string;
  };

  const image = (slug: string, id: string, variant = "menu") =>
    fetch(`${server.baseUrl}/v1/public/stores/${slug}/images/${id}/${variant}`);
  const refused = async (
    slug: string,
    id: string,
    status = 404,
    code = "IMAGE_NOT_FOUND",
    variant = "menu",
  ) => {
    const response = await image(slug, id, variant);
    assert.equal(response.status, status, `${slug} ${id} ${variant}`);
    const body = await json(response);
    assert.equal(body.code, code);
    return body;
  };
  const menu = async (target: Store) =>
    json(await fetch(`${server.baseUrl}/v1/public/stores/${target.slug}/menu`));

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    storageDirectory = await mkdtemp(
      join(tmpdir(), "whiteoven-public-images-"),
    );
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: "2",
      IMAGE_STORAGE_DIRECTORY: storageDirectory,
    });
    a = await store("a");
    b = await store("b");
  });
  after(async () => {
    await server?.close();
    await owner?.close();
    await database?.drop();
    if (storageDirectory)
      await rm(storageDirectory, { recursive: true, force: true });
  });

  it("serves the images the menu shows, with the menu's revalidation policy", async () => {
    const flavorImage = await upload(a);
    const productImage = await upload(a);
    await sql(a, "update catalog_flavors set image_asset_id=? where id=?", [
      flavorImage,
      a.flavorId,
    ]);
    await sql(
      a,
      "update catalog_simple_products set image_asset_id=? where id=?",
      [productImage, a.productId],
    );
    const listed = await menu(a);
    assert.equal(listed.flavors[0].imageId, flavorImage);
    assert.equal(listed.simpleProducts[0].imageId, productImage);

    for (const id of [flavorImage, productImage])
      for (const variant of ["thumbnail", "menu"]) {
        const response = await image(a.slug, id, variant);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/webp");
        assert.equal(response.headers.get("cache-control"), "no-cache");
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal((await sharp(bytes).metadata()).format, "webp");
        const etag = response.headers.get("etag");
        assert.ok(etag);
        // fetch() adds `cache-control: no-cache` to conditional requests, which disables 304s.
        const revalidated = await new Promise<number | undefined>(
          (resolve, reject) =>
            get(
              `${server.baseUrl}/v1/public/stores/${a.slug}/images/${id}/${variant}`,
              { headers: { "if-none-match": etag } },
              (res) => {
                res.resume();
                resolve(res.statusCode);
              },
            ).on("error", reject),
        );
        assert.equal(revalidated, 304);
      }
  });

  it("answers 404 for an image the store has not published, as for an unknown one", async () => {
    const draft = await upload(a);
    await refused(a.slug, draft);
    await refused(a.slug, randomUUID());
    await refused(a.slug, "nao-e-uuid");
    const [published] = (await menu(a)).flavors.map(
      (flavor: { imageId: string }) => flavor.imageId,
    );
    await refused(a.slug, published, 404, "IMAGE_NOT_FOUND", "original");
    // The icon belongs to the build: saved on the brand, still not public.
    const icon = await upload(a);
    await sql(
      a,
      "insert into brand_themes (tenant_id,color_overrides,icon_asset_id) values (?,'{}'::jsonb,?)",
      [a.id, icon],
    );
    await refused(a.slug, icon);
  });

  it("stops serving an image as soon as its item leaves the menu", async () => {
    const productImage = (await menu(a)).simpleProducts[0].imageId as string;
    assert.equal((await image(a.slug, productImage)).status, 200);
    await sql(
      a,
      "update catalog_simple_products set available=false where id=?",
      [a.productId],
    );
    await refused(a.slug, productImage);
    await sql(
      a,
      "update catalog_simple_products set available=true where id=?",
      [a.productId],
    );
    assert.equal((await image(a.slug, productImage)).status, 200);
    await sql(
      a,
      "update catalog_simple_products set archived_at=now(), available=false where id=?",
      [a.productId],
    );
    await refused(a.slug, productImage);
  });

  it("serves a store's images only under its own slug", async () => {
    const flavorImage = (await menu(a)).flavors[0].imageId as string;
    const own = await upload(b);
    await sql(b, "update catalog_flavors set image_asset_id=? where id=?", [
      own,
      b.flavorId,
    ]);
    assert.equal((await image(b.slug, own)).status, 200);
    await refused(b.slug, flavorImage);
    await refused(a.slug, own);
    const missing = await refused(
      "loja-que-nao-existe",
      flavorImage,
      404,
      "NOT_FOUND",
    );
    assert.doesNotMatch(JSON.stringify(missing), /images|tenant/i);
  });

  it("answers 503 when a published image lost its file, without storage paths", async () => {
    const flavorImage = (await menu(a)).flavors[0].imageId as string;
    await rm(
      join(storageDirectory, "tenants", a.id, flavorImage, "thumbnail.webp"),
    );
    const body = await refused(
      a.slug,
      flavorImage,
      503,
      "IMAGE_STORAGE_MISSING",
      "thumbnail",
    );
    assert.equal(JSON.stringify(body).includes(storageDirectory), false);
  });

  it("refuses a store that is not ACTIVE without saying why", async () => {
    const flavorImage = (await menu(b)).flavors[0].imageId as string;
    await owner.em
      .getConnection()
      .execute("update tenants set status='SUSPENDED' where id=?", [b.id]);
    const body = await refused(b.slug, flavorImage, 403, "TENANT_NOT_ACTIVE");
    assert.doesNotMatch(JSON.stringify(body), /SUSPENDED/);
  });
});
