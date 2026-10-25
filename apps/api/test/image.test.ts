import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
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

describe("M2.5 tenant catalog images", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let server: TestServer;
  let tenantId: string;
  let token: string;
  let staffId: string;
  let storageDirectory: string;

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    tenantId = await insertTenant(owner, `images-${randomUUID().slice(0, 8)}`);
    const email = `images-${randomUUID()}@test.invalid`;
    staffId = await insertStaffUser(owner, email, "image-test-password");
    await insertMembership(owner, tenantId, staffId, "OWNER");
    storageDirectory = await mkdtemp(join(tmpdir(), "whiteoven-image-api-"));
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: "2",
      IMAGE_STORAGE_DIRECTORY: storageDirectory,
    });
    const login = await staffLogin(
      server.baseUrl,
      email,
      "image-test-password",
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
    if (storageDirectory)
      await rm(storageDirectory, { recursive: true, force: true });
  });

  const imageCall = (path: string, init: RequestInit = {}) =>
    fetch(`${server.baseUrl}/v1/admin/catalog/images${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });

  it("validates, re-encodes, persists tenant metadata and audits an upload", async () => {
    const source = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#d87535" },
    })
      .png()
      .toBuffer();
    const uploaded = await imageCall("", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(source),
    });
    assert.equal(uploaded.status, 201);
    const asset = await json(uploaded);
    assert.match(asset.id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(
      [asset.width, asset.height, asset.sourceFormat],
      [800, 600, "png"],
    );
    assert.deepEqual(Object.keys(asset.variants).sort(), ["menu", "thumbnail"]);

    for (const variant of ["thumbnail", "menu"]) {
      const response = await imageCall(`/${asset.id}/${variant}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/webp");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(
        (await sharp(Buffer.from(await response.arrayBuffer())).metadata())
          .format,
        "webp",
      );
    }
    await rm(
      join(storageDirectory, "tenants", tenantId, asset.id, "thumbnail.webp"),
    );
    const missingVariant = await imageCall(`/${asset.id}/thumbnail`);
    assert.equal(missingVariant.status, 503);
    const missingBody = await json(missingVariant);
    assert.equal(missingBody.code, "IMAGE_STORAGE_MISSING");
    assert.equal(missingBody.message, "Image is temporarily unavailable.");
    assert.equal(JSON.stringify(missingBody).includes(storageDirectory), false);
    const metadata = await runInTenant(owner, tenantId, (em) =>
      em.execute<{ source_format: string; width: number; height: number }[]>(
        "select source_format,width,height from image_assets where id=?",
        [asset.id],
      ),
    );
    assert.deepEqual(metadata, [
      { source_format: "png", width: 800, height: 600 },
    ]);
    const events = await runInTenant(owner, tenantId, (em) =>
      em.execute<{ action: string; entity_type: string; entity_id: string }[]>(
        "select action,entity_type,entity_id from audit_events where entity_id=?",
        [asset.id],
      ),
    );
    assert.deepEqual(events, [
      {
        action: "catalog.image.created",
        entity_type: "image",
        entity_id: asset.id,
      },
    ]);
  });

  it("rejects unsupported media, corrupt files and oversized uploads", async () => {
    assert.equal(
      (
        await imageCall("", {
          method: "POST",
          headers: { "content-type": "image/svg+xml" },
          body: "<svg/>",
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await imageCall("", {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: "not-png",
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await imageCall("", {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: new Uint8Array(5 * 1024 * 1024 + 1),
        })
      ).status,
      413,
    );
  });

  it("requires an OWNER or MANAGER session and rejects uncredentialed SQL inserts", async () => {
    const staffEmail = `images-staff-${randomUUID()}@test.invalid`;
    const staffId = await insertStaffUser(
      owner,
      staffEmail,
      "image-test-password",
    );
    await insertMembership(owner, tenantId, staffId, "STAFF");
    const login = await staffLogin(
      server.baseUrl,
      staffEmail,
      "image-test-password",
    );
    const switched = await switchTenant(
      server.baseUrl,
      login.accessToken,
      tenantId,
    );
    const staffToken = (await json(switched)).accessToken;
    const source = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const denied = await fetch(`${server.baseUrl}/v1/admin/catalog/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${staffToken}`,
        "content-type": "image/png",
      },
      body: new Uint8Array(source),
    });
    assert.equal(denied.status, 403);

    const app = await database.connect(database.appUrl);
    try {
      let code: string | undefined;
      try {
        await runInTenant(app, tenantId, (em) =>
          em.execute(
            "insert into image_assets (id,tenant_id,source_format,width,height) values (?,?, 'png',2,2)",
            [randomUUID(), tenantId],
          ),
        );
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      assert.equal(code, "42501");
    } finally {
      await app.close();
    }
  });

  it("associates the tenant's own images to flavors and products, and nothing else (M3.3)", async () => {
    const catalog = (path: string, method = "GET", body?: unknown) =>
      fetch(`${server.baseUrl}/v1/admin/catalog${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    const upload = (accessToken: string) =>
      fetch(`${server.baseUrl}/v1/admin/catalog/images`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "image/png",
        },
        body: new Uint8Array(png),
      }).then(json);
    const asset = await upload(token);

    const pizzas = await json(
      await catalog("/categories", "POST", {
        name: "Pizzas M3.3",
        kind: "PIZZA",
      }),
    );
    const drinks = await json(
      await catalog("/categories", "POST", {
        name: "Bebidas M3.3",
        kind: "PRODUCT",
      }),
    );
    const flavor = await json(
      await catalog("/flavors", "POST", {
        categoryId: pizzas.id,
        name: "Margherita M3.3",
      }),
    );
    const product = await json(
      await catalog("/products", "POST", {
        categoryId: drinks.id,
        name: "Suco M3.3",
        priceCents: 900,
      }),
    );
    const items = async () => {
      const snapshot = await json(await catalog("/items"));
      return {
        flavor: snapshot.flavors.find(
          (item: { id: string }) => item.id === flavor.id,
        ).imageId,
        product: snapshot.simpleProducts.find(
          (item: { id: string }) => item.id === product.id,
        ).imageId,
      };
    };

    for (const path of [`/flavors/${flavor.id}`, `/products/${product.id}`])
      assert.equal(
        (await catalog(path, "PATCH", { imageId: asset.id })).status,
        200,
      );
    assert.deepEqual(await items(), { flavor: asset.id, product: asset.id });

    // An image of another store is refused by the composite foreign key, even with a valid id.
    const otherTenant = await insertTenant(
      owner,
      `images-other-${randomUUID().slice(0, 8)}`,
    );
    const otherEmail = `images-other-${randomUUID()}@test.invalid`;
    const otherStaff = await insertStaffUser(
      owner,
      otherEmail,
      "image-test-password",
    );
    await insertMembership(owner, otherTenant, otherStaff, "OWNER");
    const otherLogin = await staffLogin(
      server.baseUrl,
      otherEmail,
      "image-test-password",
    );
    const otherToken = (
      await json(
        await switchTenant(server.baseUrl, otherLogin.accessToken, otherTenant),
      )
    ).accessToken;
    const foreign = await upload(otherToken);
    for (const path of [`/flavors/${flavor.id}`, `/products/${product.id}`]) {
      const refused = await catalog(path, "PATCH", { imageId: foreign.id });
      assert.equal(refused.status, 409);
      assert.equal((await json(refused)).code, "RESOURCE_CONFLICT");
      const malformed = await catalog(path, "PATCH", { imageId: "nao-e-uuid" });
      assert.equal(malformed.status, 422);
    }
    assert.deepEqual(await items(), { flavor: asset.id, product: asset.id });

    for (const path of [`/flavors/${flavor.id}`, `/products/${product.id}`])
      assert.equal(
        (await catalog(path, "PATCH", { imageId: null })).status,
        200,
      );
    assert.deepEqual(await items(), { flavor: null, product: null });
  });
});
