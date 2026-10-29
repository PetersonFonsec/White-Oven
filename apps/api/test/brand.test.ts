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
import { DEFAULT_BRAND_COLORS } from "../src/store/brand-rules";

const PASSWORD = "brand-test-password";
const RED = {
  primary: "#B3261E",
  primaryHover: "#8C1D18",
  primaryPressed: "#601410",
  onPrimary: "#FFFFFF",
};

describe("M3.5 brand theme", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let server: TestServer;
  let storageDirectory: string;
  let tenantA: string;
  let tenantB: string;
  let slugA: string;
  let slugB: string;
  const tokens: Record<string, string> = {};
  const images: Record<string, string> = {};

  const member = async (
    key: string,
    tenantId: string,
    role: "OWNER" | "MANAGER" | "STAFF",
  ) => {
    const email = `brand-${key.toLowerCase()}-${randomUUID()}@test.invalid`;
    const user = await insertStaffUser(owner, email, PASSWORD);
    await insertMembership(owner, tenantId, user, role);
    const login = await staffLogin(server.baseUrl, email, PASSWORD);
    tokens[key] = (
      await json(
        await switchTenant(server.baseUrl, login.accessToken, tenantId),
      )
    ).accessToken;
  };
  const upload = async (who: string, width: number, height: number) => {
    const png = await sharp({
      create: { width, height, channels: 3, background: "#b3261e" },
    })
      .png()
      .toBuffer();
    const response = await fetch(`${server.baseUrl}/v1/admin/catalog/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens[who]}`,
        "content-type": "image/png",
      },
      body: new Uint8Array(png),
    });
    assert.equal(response.status, 201);
    return (await json(response)).id as string;
  };

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    slugA = `brand-a-${randomUUID().slice(0, 8)}`;
    slugB = `brand-b-${randomUUID().slice(0, 8)}`;
    tenantA = await insertTenant(owner, slugA);
    tenantB = await insertTenant(owner, slugB);
    storageDirectory = await mkdtemp(join(tmpdir(), "whiteoven-brand-"));
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: "2",
      IMAGE_STORAGE_DIRECTORY: storageDirectory,
    });
    await member("ownerA", tenantA, "OWNER");
    await member("managerA", tenantA, "MANAGER");
    await member("staffA", tenantA, "STAFF");
    await member("ownerB", tenantB, "OWNER");
    images["logo"] = await upload("ownerA", 800, 300);
    images["icon"] = await upload("ownerA", 600, 600);
    images["smallIcon"] = await upload("ownerA", 256, 256);
    images["smallLogo"] = await upload("ownerA", 200, 80);
    images["otherStore"] = await upload("ownerB", 600, 600);
  });
  after(async () => {
    await server?.close();
    await owner?.close();
    await database?.drop();
    if (storageDirectory)
      await rm(storageDirectory, { recursive: true, force: true });
  });

  const call = (who: string, method = "GET", body?: unknown) =>
    fetch(`${server.baseUrl}/v1/admin/store/brand`, {
      method,
      headers: {
        authorization: `Bearer ${tokens[who]}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const auditActions = async (tenantId: string) =>
    (
      await owner.em
        .getConnection()
        .execute<{ action: string }[]>(
          "select action from audit_events where tenant_id = ? and action = 'store.brand.updated' order by at, id",
          [tenantId],
        )
    ).map((row) => row.action);
  const themeOf = async (who: string) => (await json(await call(who))).theme;
  const red = () => ({
    colorOverrides: RED,
    logoAssetId: images["logo"],
    iconAssetId: images["icon"],
  });

  it("starts from the WhiteOven defaults and publishes the rules the panel previews with", async () => {
    const response = await call("ownerA");
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.saved, false);
    assert.deepEqual(body.theme, {
      colorOverrides: {},
      logoAssetId: null,
      iconAssetId: null,
      version: 0,
    });
    assert.deepEqual(body.colors, DEFAULT_BRAND_COLORS);
    assert.deepEqual(body.defaults, DEFAULT_BRAND_COLORS);
    assert.deepEqual(body.fixedColors, {
      surface: "#FFFFFF",
      cream: "#FFF8F0",
    });
    assert.equal(body.contrastRules.length, 5);
    assert.deepEqual(body.imageRules, { logoMinSide: 256, iconMinSide: 512 });
  });

  it("publishes a theme for the owner's store only, versions and audits each save", async () => {
    const saved = await call("ownerA", "PUT", red());
    assert.equal(saved.status, 200);
    const body = await json(saved);
    assert.equal(body.saved, true);
    assert.deepEqual(body.theme, {
      colorOverrides: RED,
      logoAssetId: images["logo"],
      iconAssetId: images["icon"],
      version: 1,
    });
    assert.deepEqual(body.colors, { ...DEFAULT_BRAND_COLORS, ...RED });
    const again = await json(
      await call("ownerA", "PUT", { ...red(), iconAssetId: null }),
    );
    assert.equal(again.theme.version, 2);
    assert.equal(again.theme.iconAssetId, null);
    assert.deepEqual(await auditActions(tenantA), [
      "store.brand.updated",
      "store.brand.updated",
    ]);
    const other = await json(await call("ownerB"));
    assert.equal(other.saved, false);
    assert.deepEqual(other.colors, DEFAULT_BRAND_COLORS);
    assert.deepEqual(await auditActions(tenantB), []);
  });

  it("never publishes a theme with insufficient contrast or a locked token", async () => {
    const before = await themeOf("ownerA");
    const unreadable = await call("ownerA", "PUT", {
      ...red(),
      colorOverrides: { ...RED, primary: "#FFE066" },
    });
    assert.equal(unreadable.status, 422);
    const body = await json(unreadable);
    assert.equal(body.code, "BRAND_THEME_INVALID");
    assert.deepEqual(body.details.errors.length, 1);
    const [error] = body.details.errors;
    assert.equal(error.code, "BRAND_CONTRAST_INSUFFICIENT");
    assert.equal(error.path, "contrast.onPrimary/primary");
    assert.equal(error.minimum, 4.5);
    assert.ok(error.ratio < 4.5);

    const locked = await call("ownerA", "PUT", {
      ...red(),
      colorOverrides: { ...RED, focus: "#FF0000" },
    });
    assert.equal(locked.status, 422);
    assert.deepEqual((await json(locked)).details.errors, [
      { code: "BRAND_TOKEN_LOCKED", path: "colorOverrides.focus" },
    ]);
    assert.deepEqual(await themeOf("ownerA"), before);
    assert.equal((await auditActions(tenantA)).length, 2);
  });

  it("checks the logo and icon belong to the store and have the right size", async () => {
    const before = await themeOf("ownerA");
    const refused = async (
      body: Record<string, unknown>,
      errors: { code: string; path: string }[],
    ) => {
      const response = await call("ownerA", "PUT", { ...red(), ...body });
      assert.equal(response.status, 422, JSON.stringify(body));
      assert.deepEqual((await json(response)).details.errors, errors);
    };
    await refused({ iconAssetId: images["logo"] }, [
      { code: "BRAND_ICON_NOT_SQUARE", path: "iconAssetId" },
    ]);
    await refused(
      { logoAssetId: images["smallLogo"], iconAssetId: images["smallIcon"] },
      [
        { code: "BRAND_LOGO_TOO_SMALL", path: "logoAssetId" },
        { code: "BRAND_ICON_TOO_SMALL", path: "iconAssetId" },
      ],
    );
    // Another store's image does not exist here.
    await refused(
      { logoAssetId: images["otherStore"], iconAssetId: randomUUID() },
      [
        { code: "BRAND_IMAGE_NOT_FOUND", path: "logoAssetId" },
        { code: "BRAND_IMAGE_NOT_FOUND", path: "iconAssetId" },
      ],
    );
    assert.deepEqual(await themeOf("ownerA"), before);
  });

  it("lets managers read but not publish, keeps staff out and refuses suspended stores", async () => {
    assert.equal((await call("managerA")).status, 200);
    const manager = await call("managerA", "PUT", red());
    assert.equal(manager.status, 403);
    assert.equal((await json(manager)).code, "ROLE_FORBIDDEN");
    assert.equal((await call("staffA")).status, 403);
    assert.equal((await call("staffA", "PUT", red())).status, 403);

    const suspended = await insertTenant(
      owner,
      `brand-suspended-${randomUUID().slice(0, 8)}`,
      "SUSPENDED",
    );
    await member("ownerSuspended", suspended, "OWNER");
    const response = await call("ownerSuspended", "PUT", {
      colorOverrides: RED,
      logoAssetId: null,
      iconAssetId: null,
    });
    assert.equal(response.status, 403);
    assert.equal((await json(response)).code, "STORE_WRITE_FORBIDDEN");
  });

  it("serves the app the store's name, resolved colors and logo, never the icon", async () => {
    const profile = (slug: string) =>
      fetch(`${server.baseUrl}/v1/public/stores/${slug}`);
    const before = await profile(slugB);
    assert.equal(before.status, 200);
    assert.equal(before.headers.get("cache-control"), "no-cache");
    assert.deepEqual(await json(before), {
      checkout: null,
      slug: slugB,
      name: `Pizzaria ${slugB}`,
      brand: { version: 0, colors: DEFAULT_BRAND_COLORS, logoImageId: null },
    });

    assert.equal(
      (
        await call("ownerB", "PUT", {
          colorOverrides: RED,
          logoAssetId: null,
          iconAssetId: images["otherStore"],
        })
      ).status,
      200,
    );
    const saved = await json(await profile(slugB));
    assert.equal(saved.brand.version, 1);
    assert.deepEqual(saved.brand.colors, { ...DEFAULT_BRAND_COLORS, ...RED });
    assert.ok(!JSON.stringify(saved).includes(images["otherStore"]!));
    assert.equal(saved.brand.logoImageId, null);
    // Each store gets its own brand, whatever the other one saved.
    const storeA = await json(await profile(slugA));
    assert.equal(storeA.slug, slugA);
    assert.equal(storeA.brand.logoImageId, images["logo"]);
    // The logo is public through the store's own slug only; the icon never is.
    const image = (slug: string, id: string) =>
      fetch(`${server.baseUrl}/v1/public/stores/${slug}/images/${id}/menu`);
    const logo = await image(slugA, images["logo"]!);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/webp");
    assert.equal(logo.headers.get("cache-control"), "no-cache");
    assert.ok((await logo.arrayBuffer()).byteLength > 0);
    for (const [slug, id] of [
      [slugB, images["logo"]!],
      [slugB, images["otherStore"]!],
    ] as const) {
      const refused = await image(slug, id);
      assert.equal(refused.status, 404);
      assert.equal((await json(refused)).code, "IMAGE_NOT_FOUND");
    }

    const suspended = `brand-s-${randomUUID().slice(0, 8)}`;
    await insertTenant(owner, suspended, "SUSPENDED");
    const refused = await profile(suspended);
    assert.equal(refused.status, 403);
    assert.equal((await json(refused)).code, "TENANT_NOT_ACTIVE");
    for (const slug of ["nao-existe-loja", "UPPER"])
      assert.equal((await profile(slug)).status, 404);
  });

  it("refuses in the database a manager session, a locked token and another store's image", async () => {
    const app = await database.connect(database.appUrl);
    const sessionOf = async (role: string) => {
      const [session] = await runInTenant(owner, tenantA, (em) =>
        em.execute<{ id: string; staffUserId: string }[]>(
          `select s.id, s.staff_user_id as "staffUserId" from staff_sessions s
           join memberships m on m.staff_user_id = s.staff_user_id
           where m.tenant_id = ? and m.role = ? and s.revoked_at is null limit 1`,
          [tenantA, role],
        ),
      );
      assert.ok(session, `a live ${role} session`);
      return session!;
    };
    const as = (
      session: { id: string; staffUserId: string },
      sql: string,
      params: unknown[] = [],
    ) =>
      runInTenant(app, tenantA, async (em) => {
        await em.execute(
          "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true)",
          [session.staffUserId, session.id],
        );
        return em.execute(sql, params);
      });
    try {
      const manager = await sessionOf("MANAGER");
      await assert.rejects(
        as(manager, "update brand_themes set color_overrides = '{}'::jsonb"),
        (error: { code?: string }) => error.code === "42501",
      );
      const ownerSession = await sessionOf("OWNER");
      await assert.rejects(
        as(
          ownerSession,
          `update brand_themes set color_overrides = '{"focus":"#FF0000"}'::jsonb`,
        ),
        (error: { code?: string }) => error.code === "23514",
      );
      await assert.rejects(
        as(ownerSession, "update brand_themes set logo_asset_id = ?", [
          images["otherStore"],
        ]),
        (error: { code?: string }) => error.code === "23503",
      );
    } finally {
      await app.close();
    }
  });
});
