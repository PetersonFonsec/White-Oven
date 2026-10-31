import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import appConfig from "../app.config.ts";
import { ManifestError, parseManifest } from "../src/config/manifest.ts";
import {
  apiUrlReleaseProblems,
  easProfileName,
  manifestReleaseProblems,
  parseReleaseKind,
  pngImage,
  RELEASE_PROFILES,
} from "../src/config/release.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const read = (path: string) => readFileSync(join(root, path));
const manifestFile = (slug: string) =>
  JSON.parse(read(`manifests/${slug}.json`).toString("utf8"));
const slugs = readdirSync(join(root, "manifests"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))
  .sort();

interface Profile {
  extends?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}
const eas = JSON.parse(read("eas.json").toString("utf8")) as {
  cli: Record<string, unknown>;
  build: Record<string, Profile>;
  submit: Record<string, Profile>;
};

const chunk = (type: string, data: Uint8Array = new Uint8Array()) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
/**
 * A complete PNG (signature, IHDR, optional PLTE/tRNS, IDAT, IEND) with valid CRCs. The pixels
 * are not read by `pngImage`, so the IDAT holds one compressed byte.
 */
const png = (
  width: number,
  height: number,
  colorType: number,
  extra: { plte?: number[]; trns?: number[] } = {},
) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      ...(extra.plte ? [chunk("PLTE", Uint8Array.from(extra.plte))] : []),
      ...(extra.trns ? [chunk("tRNS", Uint8Array.from(extra.trns))] : []),
      chunk("IDAT", deflateSync(Buffer.from([0]))),
      chunk("IEND"),
    ]),
  );
};
const opaqueIcon = png(1024, 1024, 2);
const palette = [0xb3, 0x26, 0x1e, 0xff, 0xff, 0xff];

/** A store that finished M5.6 and M7.2: EAS project, organization, approved privacy text. */
const ready = parseManifest({
  ...manifestFile("pizzaria-bairro"),
  easProjectId: "0f3c1a52-6d2e-4b8f-9a77-3f1e2d4c5b6a",
  expoOwner: "whiteoven",
  privacyPolicy: { version: "2026-11-15", text: "Política aprovada." },
});

const withEnv = <T>(env: Record<string, string | undefined>, run: () => T) => {
  const before = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  set(env);
  try {
    return run();
  } finally {
    set(before);
  }
};

describe("store builds (ADR 0028)", () => {
  it("has a preview and a production profile for every manifest, and nothing else per store", () => {
    const perStore = Object.keys(eas.build).filter(
      (name) => !["base", "preview", "production"].includes(name),
    );
    assert.deepEqual(
      perStore.sort(),
      slugs.flatMap((slug) => [
        easProfileName(slug, "preview"),
        easProfileName(slug, "store"),
      ]),
    );
    for (const slug of slugs)
      for (const kind of ["preview", "store"] as const) {
        const profile = eas.build[easProfileName(slug, kind)]!;
        // Only the tenant changes; everything else comes from the shared profile.
        assert.deepEqual(profile, {
          extends: RELEASE_PROFILES[kind].base,
          env: { WHITEOVEN_TENANT: slug },
        });
      }
  });

  it("builds internal previews and auto-incremented store binaries from a commit", () => {
    assert.equal(eas.cli["appVersionSource"], "remote");
    assert.equal(eas.cli["requireCommit"], true);
    assert.deepEqual(eas.build["preview"], {
      extends: "base",
      distribution: "internal",
      environment: "preview",
      env: { WHITEOVEN_RELEASE: "preview" },
      android: { buildType: "apk" },
    });
    assert.deepEqual(eas.build["production"], {
      extends: "base",
      distribution: "store",
      environment: "production",
      autoIncrement: true,
      env: { WHITEOVEN_RELEASE: "store" },
      android: { buildType: "app-bundle" },
    });
  });

  it("pins the build toolchain to the repository's", () => {
    const rootPackage = JSON.parse(
      readFileSync(join(repo, "package.json"), "utf8"),
    );
    assert.equal(
      `pnpm@${eas.build["base"]!["pnpm"]}`,
      rootPackage.packageManager,
    );
    const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
    assert.ok(ci.includes(`node-version: ${eas.build["base"]!["node"]}`));
  });

  it("keeps credentials and the API address out of the repository", () => {
    const text = read("eas.json").toString("utf8");
    for (const forbidden of [
      "Path",
      "ascApiKey",
      "serviceAccount",
      "password",
      "token",
      "WHITEOVEN_API_URL",
    ])
      assert.equal(text.includes(forbidden), false, forbidden);
    const envKeys = new Set(
      Object.values(eas.build).flatMap((profile) =>
        Object.keys(profile.env ?? {}),
      ),
    );
    assert.deepEqual([...envKeys].sort(), [
      "WHITEOVEN_RELEASE",
      "WHITEOVEN_TENANT",
    ]);
    // Per-store submit profiles only add the store's App Store Connect app id.
    for (const [name, profile] of Object.entries(eas.submit))
      if (name !== "production") {
        assert.ok(slugs.includes(name), name);
        assert.equal(profile.extends, "production");
        assert.match(
          String((profile["ios"] as { ascAppId?: string })?.ascAppId),
          /^\d+$/,
        );
      }
  });

  it("reads the release kind from the profile and refuses unknown ones", () => {
    assert.equal(parseReleaseKind(undefined), null);
    assert.equal(parseReleaseKind(""), null);
    assert.equal(parseReleaseKind("store"), "store");
    assert.equal(parseReleaseKind("preview"), "preview");
    assert.throws(() => parseReleaseKind("production"), ManifestError);
  });

  it("reads PNG size and transparency from a complete, valid PNG", () => {
    const at = (bytes: Uint8Array) => pngImage(bytes);
    assert.deepEqual(at(opaqueIcon), {
      width: 1024,
      height: 1024,
      transparency: false,
    });
    // RGBA and gray + alpha have an alpha channel.
    assert.equal(at(png(1024, 1024, 6))?.transparency, true);
    assert.equal(at(png(1024, 1024, 4))?.transparency, true);
    // Indexed: opaque without tRNS or with every alpha at 255; transparent with any alpha < 255.
    assert.equal(
      at(png(1024, 1024, 3, { plte: palette }))?.transparency,
      false,
    );
    assert.equal(
      at(png(1024, 1024, 3, { plte: palette, trns: [255, 255] }))?.transparency,
      false,
    );
    assert.equal(
      at(png(1024, 1024, 3, { plte: palette, trns: [255, 0] }))?.transparency,
      true,
    );
    // A color key in gray or RGB makes the matching pixels clear.
    assert.equal(
      at(png(1024, 1024, 2, { trns: [0, 0, 0, 0, 0, 0] }))?.transparency,
      true,
    );
    assert.equal(
      pngImage(read("assets/tenants/pizzaria-centro/icon.png"))?.transparency,
      true,
    );
  });

  it("refuses truncated, corrupted and fake PNGs", () => {
    const valid = opaqueIcon;
    for (const [label, bytes] of [
      ["not a PNG", new TextEncoder().encode("not a png at all, sorry")],
      ["signature only", valid.subarray(0, 8)],
      ["truncated IHDR", valid.subarray(0, 20)],
      ["truncated before IEND", valid.subarray(0, valid.length - 12)],
      ["cut inside IEND", valid.subarray(0, valid.length - 1)],
      ["trailing bytes", Uint8Array.from([...valid, 0])],
      ["indexed without palette", png(1024, 1024, 3)],
      ["unknown color type", png(1024, 1024, 5)],
      ["zero width", png(0, 1024, 2)],
    ] as const)
      assert.equal(pngImage(bytes), null, label);
    const corrupted = Uint8Array.from(valid);
    corrupted[20] ^= 1; // height changes, CRC no longer matches
    assert.equal(pngImage(corrupted), null);
  });

  it("lists what a manifest still lacks for each kind of build", () => {
    assert.deepEqual(manifestReleaseProblems(ready, "store", opaqueIcon), []);
    assert.deepEqual(manifestReleaseProblems(ready, "preview", opaqueIcon), []);
    // The example manifests are demonstrations: no EAS project, demonstration privacy text.
    const example = parseManifest(manifestFile("pizzaria-bairro"));
    const icon = read(example.icon);
    assert.deepEqual(manifestReleaseProblems(example, "store", icon), [
      "easProjectId (EAS project)",
      "expoOwner (Expo organization)",
      "icon (transparency; the App Store refuses it)",
      "privacyPolicy (demonstration text, M7.2)",
    ]);
    // Testers can see the demonstration text and a transparent icon.
    assert.deepEqual(manifestReleaseProblems(example, "preview", icon), [
      "easProjectId (EAS project)",
      "expoOwner (Expo organization)",
    ]);
    const { privacyPolicy: _policy, ...withoutPolicy } = ready;
    assert.ok(_policy);
    assert.deepEqual(
      manifestReleaseProblems(withoutPolicy, "store", opaqueIcon),
      ["privacyPolicy (approved text, M7.2)"],
    );
    assert.deepEqual(
      manifestReleaseProblems(ready, "preview", png(512, 512, 2)),
      ["icon (PNG of 1024 x 1024 px)"],
    );
    assert.deepEqual(
      manifestReleaseProblems(ready, "preview", opaqueIcon.subarray(0, 40)),
      ["icon (PNG of 1024 x 1024 px)"],
    );
    // An indexed icon with a transparent palette entry passes for testers, not for the stores.
    const indexed = png(1024, 1024, 3, { plte: palette, trns: [0] });
    assert.deepEqual(manifestReleaseProblems(ready, "preview", indexed), []);
    assert.deepEqual(manifestReleaseProblems(ready, "store", indexed), [
      "icon (transparency; the App Store refuses it)",
    ]);
  });

  it("requires an HTTPS API that is not the developer's machine", () => {
    assert.deepEqual(apiUrlReleaseProblems("https://api.example.com"), []);
    assert.deepEqual(apiUrlReleaseProblems(undefined), [
      "WHITEOVEN_API_URL (missing on EAS)",
    ]);
    for (const refused of [
      "http://localhost:3000",
      "http://10.0.2.2:3000",
      "http://api.example.com",
      "https://api.example.com/v1",
    ])
      assert.deepEqual(
        apiUrlReleaseProblems(refused),
        ["WHITEOVEN_API_URL (HTTPS outside the developer's machine)"],
        refused,
      );
  });

  it("stops a store build of an unready manifest on the EAS worker only", () => {
    const config = (env: Record<string, string | undefined>) =>
      withEnv({ WHITEOVEN_TENANT: "pizzaria-bairro", ...env }, () =>
        appConfig({ projectRoot: root }),
      );
    // The CLI evaluates the config before it loads the variables kept on EAS.
    assert.equal(
      config({ WHITEOVEN_RELEASE: "store", EAS_BUILD: undefined }).name,
      "Forno do Bairro",
    );
    assert.throws(
      () =>
        config({
          WHITEOVEN_RELEASE: "store",
          EAS_BUILD: "true",
          WHITEOVEN_API_URL: "https://api.example.com",
        }),
      /not ready for a store build: easProjectId/,
    );
    assert.throws(
      () =>
        config({
          WHITEOVEN_RELEASE: "preview",
          EAS_BUILD: "true",
          WHITEOVEN_API_URL: undefined,
        }),
      /WHITEOVEN_API_URL \(missing on EAS\)/,
    );
    assert.throws(
      () => config({ WHITEOVEN_RELEASE: "beta", EAS_BUILD: "true" }),
      ManifestError,
    );
    // A development build on EAS (no release kind) keeps working as before.
    assert.equal(
      config({ WHITEOVEN_RELEASE: undefined, EAS_BUILD: "true" }).name,
      "Forno do Bairro",
    );
  });

  it("marks store builds as exempt from export compliance", () => {
    const built = withEnv({ WHITEOVEN_TENANT: "pizzaria-centro" }, () =>
      appConfig({ projectRoot: root }),
    );
    assert.deepEqual(built.ios.config, { usesNonExemptEncryption: false });
    assert.equal("owner" in built, false);
    const owned = parseManifest({
      ...manifestFile("pizzaria-centro"),
      easProjectId: "0f3c1a52-6d2e-4b8f-9a77-3f1e2d4c5b6a",
      expoOwner: "whiteoven",
    });
    assert.equal(owned.expoOwner, "whiteoven");
  });
});
