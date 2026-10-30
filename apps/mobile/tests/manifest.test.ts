import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import appConfig from "../app.config.ts";
import { DEFAULT_BRAND_COLORS } from "../src/brand/colors.ts";
import {
  ManifestError,
  buildAppConfig,
  parseApiUrl,
  parseManifest,
  parseRuntimeConfig,
} from "../src/config/manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = (slug: string) =>
  JSON.parse(readFileSync(join(root, "manifests", `${slug}.json`), "utf8"));
const withTenant = <T>(tenant: string | undefined, run: () => T): T => {
  const before = process.env.WHITEOVEN_TENANT;
  if (tenant === undefined) delete process.env.WHITEOVEN_TENANT;
  else process.env.WHITEOVEN_TENANT = tenant;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.WHITEOVEN_TENANT;
    else process.env.WHITEOVEN_TENANT = before;
  }
};
/** Width and height from the IHDR chunk of a PNG file. */
const pngSize = (path: string) => {
  const bytes = readFileSync(join(root, path));
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", path);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
const problems = (value: unknown) => {
  try {
    parseManifest(value);
  } catch (error) {
    assert.ok(error instanceof ManifestError);
    return error.problems;
  }
  return [];
};

describe("tenant manifests and the Expo config", () => {
  it("builds two apps with their own name, icon and bundle ids from the two example manifests", () => {
    const [centro, bairro] = ["pizzaria-centro", "pizzaria-bairro"].map(
      (tenant) => withTenant(tenant, () => appConfig({ projectRoot: root })),
    );
    for (const key of ["name", "slug", "icon"] as const)
      assert.notEqual(centro![key], bairro![key], key);
    assert.notEqual(centro!.ios.bundleIdentifier, bairro!.ios.bundleIdentifier);
    assert.notEqual(centro!.android.package, bairro!.android.package);
    assert.notDeepEqual(
      readFileSync(join(root, centro!.icon)),
      readFileSync(join(root, bairro!.icon)),
    );
    for (const config of [centro!, bairro!]) {
      assert.deepEqual(pngSize(config.icon), { width: 1024, height: 1024 });
      assert.equal(config.android.adaptiveIcon.foregroundImage, config.icon);
    }
    assert.deepEqual(bairro!.extra.whiteoven, {
      privacyPolicy: manifestFile("pizzaria-bairro").privacyPolicy,
      storeSlug: "pizzaria-bairro",
      storeName: "Forno do Bairro",
      apiUrl: "http://localhost:3000",
      fallbackColors: manifestFile("pizzaria-bairro").fallbackColors,
    });
    // A manifest without colors falls back to WhiteOven's.
    assert.deepEqual(
      centro!.extra.whiteoven.fallbackColors,
      DEFAULT_BRAND_COLORS,
    );
  });

  it("requires a valid privacy version and text when configured", () => {
    const valid = manifestFile("pizzaria-bairro");
    for (const privacyPolicy of [
      null,
      {},
      { version: "", text: "Aviso" },
      { version: "v1", text: "" },
    ])
      assert.throws(
        () => parseManifest({ ...valid, privacyPolicy }),
        ManifestError,
      );
    const { privacyPolicy: _policy, ...withoutPolicy } = valid;
    assert.ok(_policy);
    assert.equal(parseManifest(withoutPolicy).privacyPolicy, undefined);
  });

  it("needs a tenant that has a manifest, naming the same store", () => {
    for (const tenant of [undefined, "", "../manifests/x", "UPPER"])
      assert.throws(
        () => withTenant(tenant, () => appConfig({ projectRoot: root })),
        /WHITEOVEN_TENANT/,
      );
    assert.throws(() =>
      withTenant("loja-sem-manifesto", () => appConfig({ projectRoot: root })),
    );
  });

  it("refuses manifests with bad ids, icons out of their folder, unreadable colors or unknown keys", () => {
    const valid = manifestFile("pizzaria-bairro");
    assert.deepEqual(problems(valid), []);
    assert.deepEqual(problems({ ...valid, slug: "Pizzaria Bairro" }), [
      "slug",
      "icon (outside the store's folder)",
    ]);
    assert.deepEqual(
      problems({
        ...valid,
        icon: "./assets/tenants/pizzaria-centro/icon.png",
      }),
      ["icon (outside the store's folder)"],
    );
    assert.deepEqual(problems({ ...valid, icon: "../secret.png" }), ["icon"]);
    assert.deepEqual(
      problems({ ...valid, ios: { bundleIdentifier: "semponto" } }),
      ["ios.bundleIdentifier"],
    );
    assert.deepEqual(
      problems({ ...valid, android: { package: "Br.Com.Loja" } }),
      ["android.package"],
    );
    // White text on the default orange fails 4.5:1, like the API refuses it.
    assert.deepEqual(
      problems({
        ...valid,
        fallbackColors: { onPrimary: "#FFFFFF", primary: "#FF922B" },
      }),
      ["fallbackColors"],
    );
    assert.deepEqual(
      problems({ ...valid, fallbackColors: { surface: "#000000" } }),
      ["fallbackColors"],
    );
    assert.deepEqual(problems({ ...valid, apiKey: "x" }), ["apiKey (unknown)"]);
    assert.deepEqual(problems({ ...valid, name: " " }), ["name"]);
    assert.ok(problems(null).length > 5);
  });

  it("calls the API over HTTPS, or plain HTTP only on the developer's machine", () => {
    assert.equal(
      parseApiUrl("https://api.whiteoven.com.br/"),
      "https://api.whiteoven.com.br",
    );
    for (const local of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://10.0.2.2:3000",
    ])
      assert.equal(parseApiUrl(local), local);
    for (const refused of [
      "http://api.whiteoven.com.br",
      "https://user:pass@api.whiteoven.com.br",
      "https://api.whiteoven.com.br/v1",
      "https://api.whiteoven.com.br?x=1",
      "ftp://api.whiteoven.com.br",
      "não é url",
    ])
      assert.throws(() => parseApiUrl(refused), ManifestError, refused);
  });

  it("enables push only in builds whose manifest names an EAS project", () => {
    const plain = buildAppConfig(
      parseManifest(manifestFile("pizzaria-centro")),
      "https://api.example.com",
    );
    assert.deepEqual(plain.plugins, ["expo-secure-store"]);
    assert.equal("eas" in plain.extra, false);
    assert.equal(plain.extra.whiteoven.pushProjectId, undefined);

    const projectId = "0f3c1a52-6d2e-4b8f-9a77-3f1e2d4c5b6a";
    const withPush = buildAppConfig(
      parseManifest({
        ...manifestFile("pizzaria-centro"),
        easProjectId: projectId,
      }),
      "https://api.example.com",
    );
    assert.deepEqual(withPush.plugins, [
      "expo-secure-store",
      "expo-notifications",
    ]);
    assert.deepEqual(withPush.extra.eas, { projectId });
    assert.equal(withPush.extra.whiteoven.pushProjectId, projectId);
    assert.deepEqual(
      parseRuntimeConfig(withPush.extra),
      withPush.extra.whiteoven,
    );

    for (const invalid of ["", "abc", projectId.toUpperCase(), 42])
      assert.deepEqual(
        problems({ ...manifestFile("pizzaria-centro"), easProjectId: invalid }),
        ["easProjectId"],
      );
    assert.equal(
      parseRuntimeConfig({
        whiteoven: { ...withPush.extra.whiteoven, pushProjectId: "x" },
      }),
      null,
    );
  });

  it("reads back only a complete, valid runtime config", () => {
    const built = buildAppConfig(
      parseManifest(manifestFile("pizzaria-centro")),
      "https://api.example.com",
    );
    assert.deepEqual(parseRuntimeConfig(built.extra), built.extra.whiteoven);
    const runtime = built.extra.whiteoven;
    for (const broken of [
      null,
      {},
      { whiteoven: { ...runtime, storeSlug: "../x" } },
      { whiteoven: { ...runtime, apiUrl: "http://evil.example" } },
      { whiteoven: { ...runtime, storeName: "" } },
      { whiteoven: { ...runtime, fallbackColors: { primary: "red" } } },
    ])
      assert.equal(parseRuntimeConfig(broken), null);
  });
});
