import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkBuildProfile,
  checkSubmitProfile,
} from "../scripts/eas-profiles.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const realEas = JSON.parse(readFileSync(join(root, "eas.json"), "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "whiteoven-eas-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let projects = 0;
/** A project folder whose eas.json is the repository's, changed by `edit`. */
const project = (edit: (eas: typeof realEas) => void = () => {}) => {
  const dir = join(scratch, `project-${projects++}`);
  const eas = structuredClone(realEas);
  edit(eas);
  cpSync(join(root, "eas.json"), join(dir, "eas.json"));
  writeFileSync(join(dir, "eas.json"), JSON.stringify(eas));
  return dir;
};
const both = ["android", "ios"] as const;
const centro = "pizzaria-centro";

describe("build profile of a store (ADR 0028)", () => {
  it("accepts the repository's profiles for both kinds and both platforms", async () => {
    for (const [kind, profile, environment] of [
      ["preview", `${centro}-preview`, "preview"],
      ["store", `${centro}-production`, "production"],
    ] as const)
      assert.deepEqual(
        await checkBuildProfile(project(), centro, kind, both, profile),
        { profile, environment, problems: [] },
      );
  });

  it("refuses a profile that builds another store or no store", async () => {
    const other = project((eas) => {
      eas.build[`${centro}-production`].env.WHITEOVEN_TENANT =
        "pizzaria-bairro";
    });
    const result = await checkBuildProfile(
      other,
      centro,
      "store",
      both,
      `${centro}-production`,
    );
    assert.deepEqual(result.problems, [
      `eas.json build profile ${centro}-production (android): WHITEOVEN_TENANT must be ${centro}, not pizzaria-bairro`,
      `eas.json build profile ${centro}-production (ios): WHITEOVEN_TENANT must be ${centro}, not pizzaria-bairro`,
    ]);
    const none = project((eas) => {
      delete eas.build[`${centro}-production`].env;
    });
    assert.match(
      (
        await checkBuildProfile(
          none,
          centro,
          "store",
          ["android"],
          `${centro}-production`,
        )
      ).problems.join("\n"),
      /WHITEOVEN_TENANT must be pizzaria-centro$/,
    );
    // A platform override counts: iOS alone would build another store.
    const iosOnly = project((eas) => {
      eas.build[`${centro}-production`].ios = {
        env: { WHITEOVEN_TENANT: "pizzaria-bairro" },
      };
    });
    const ios = await checkBuildProfile(
      iosOnly,
      centro,
      "store",
      both,
      `${centro}-production`,
    );
    assert.equal(ios.problems.length, 1);
    assert.match(ios.problems[0]!, /\(ios\): WHITEOVEN_TENANT/);
  });

  it("refuses the wrong base profile and a release kind that does not match", async () => {
    const wrongBase = project((eas) => {
      eas.build[`${centro}-production`].extends = "preview";
    });
    const base = await checkBuildProfile(
      wrongBase,
      centro,
      "store",
      ["android"],
      `${centro}-production`,
    );
    assert.deepEqual(base.problems, [
      `eas.json build profile ${centro}-production (must extend production)`,
      `eas.json build profile ${centro}-production (android): WHITEOVEN_RELEASE must be store`,
      `eas.json build profile ${centro}-production (android): distribution must be store`,
      `eas.json build profile ${centro}-production (android): environment must be production`,
    ]);
    const overridden = project((eas) => {
      eas.build[`${centro}-production`].env.WHITEOVEN_RELEASE = "preview";
    });
    assert.deepEqual(
      (
        await checkBuildProfile(
          overridden,
          centro,
          "store",
          ["ios"],
          `${centro}-production`,
        )
      ).problems,
      [
        `eas.json build profile ${centro}-production (ios): WHITEOVEN_RELEASE must be store`,
      ],
    );
  });

  it("refuses a missing profile and a malformed eas.json", async () => {
    assert.deepEqual(
      (
        await checkBuildProfile(
          project(),
          "pizzaria-nova",
          "store",
          both,
          "pizzaria-nova-production",
        )
      ).problems,
      ["eas.json build profile pizzaria-nova-production (missing)"],
    );
    const broken = project((eas) => {
      eas.build[`${centro}-production`].distribution = "everywhere";
    });
    const result = await checkBuildProfile(
      broken,
      centro,
      "store",
      ["android"],
      `${centro}-production`,
    );
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0]!, /\(android\): eas\.json is not valid/);
  });
});

describe("submit profile of a store (ADR 0028)", () => {
  const withAppId = (eas: typeof realEas) => {
    eas.submit[centro] = {
      extends: "production",
      ios: { ascAppId: "1234567890" },
    };
  };

  it("sends Android with the shared profile, without an App Store Connect app id", async () => {
    assert.deepEqual(
      await checkSubmitProfile(project(), centro, "store", ["android"]),
      { profile: "production", problems: [] },
    );
  });

  it("needs the store's ascAppId for iOS, and both platforms for all", async () => {
    assert.deepEqual(
      await checkSubmitProfile(project(withAppId), centro, "store", ["ios"]),
      { profile: centro, problems: [] },
    );
    assert.deepEqual(
      await checkSubmitProfile(project(withAppId), centro, "store", both),
      { profile: centro, problems: [] },
    );
    const missing = await checkSubmitProfile(project(), centro, "store", [
      "ios",
    ]);
    assert.deepEqual(missing.problems, [
      `eas.json submit profile production (ios): ascAppId missing; add the submit profile "${centro}" extending production with ios.ascAppId`,
    ]);
    // All with only the Android side ready: only iOS is reported.
    const partial = await checkSubmitProfile(project(), centro, "store", both);
    assert.equal(partial.problems.length, 1);
    assert.match(partial.problems[0]!, /\(ios\): ascAppId missing/);
  });

  it("refuses a preview submission and malformed or missing submit profiles", async () => {
    assert.deepEqual(
      await checkSubmitProfile(project(withAppId), centro, "preview", both),
      {
        profile: "",
        problems: ["submit (only a store build goes to the stores)"],
      },
    );
    // Without `extends`, Android loses the draft release on the internal track.
    const noExtends = project((eas) => {
      eas.submit[centro] = { ios: { ascAppId: "1234567890" } };
    });
    assert.deepEqual(
      (await checkSubmitProfile(noExtends, centro, "store", ["android"]))
        .problems,
      [
        `eas.json submit profile ${centro} (android): releaseStatus must be draft`,
      ],
    );
    const toProduction = project((eas) => {
      eas.submit.production.android.track = "production";
    });
    assert.match(
      (await checkSubmitProfile(toProduction, centro, "store", ["android"]))
        .problems[0]!,
      /track must be a testing track/,
    );
    const badAppId = project((eas) => {
      eas.submit[centro] = { extends: "production", ios: { ascAppId: "abc" } };
    });
    assert.match(
      (await checkSubmitProfile(badAppId, centro, "store", ["ios"]))
        .problems[0]!,
      /\(ios\): Invalid Apple App Store Connect App ID/,
    );
    const noProduction = project((eas) => {
      delete eas.submit.production;
    });
    assert.deepEqual(
      (await checkSubmitProfile(noProduction, centro, "store", ["android"]))
        .problems,
      ["eas.json submit profile production (missing)"],
    );
  });
});

describe("release-check command line", () => {
  /**
   * A copy of the app's config, scripts and a store ready for the stores, with a recording
   * double of the EAS CLI (like the ops tests' docker/gh/curl doubles). No EAS call is made.
   */
  const copy = join(scratch, "app");
  for (const path of [
    "scripts",
    "src",
    "manifests",
    "assets",
    "eas.json",
    "app.config.ts",
    "package.json",
  ])
    cpSync(join(root, path), join(copy, path), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");
  const ready = JSON.parse(
    readFileSync(join(root, "manifests", `${centro}.json`), "utf8"),
  );
  writeFileSync(
    join(copy, "manifests", `${centro}.json`),
    JSON.stringify({
      ...ready,
      easProjectId: "0f3c1a52-6d2e-4b8f-9a77-3f1e2d4c5b6a",
      expoOwner: "whiteoven",
      privacyPolicy: { version: "2026-11-15", text: "Política aprovada." },
    }),
  );
  // An opaque 1024 px icon: RGB, one IDAT, valid CRCs.
  const opaque = spawnSync(
    process.execPath,
    [
      "-e",
      `const z=require("node:zlib");const c=(t,d)=>{const o=Buffer.alloc(12+d.length);o.writeUInt32BE(d.length);o.write(t,4,"latin1");d.copy(o,8);o.writeUInt32BE(z.crc32(o.subarray(4,8+d.length)),8+d.length);return o};const h=Buffer.alloc(13);h.writeUInt32BE(1024,0);h.writeUInt32BE(1024,4);h[8]=8;h[9]=2;process.stdout.write(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),c("IHDR",h),c("IDAT",z.deflateSync(Buffer.from([0]))),c("IEND",Buffer.alloc(0))]))`,
    ],
    { encoding: "buffer" },
  ).stdout;
  writeFileSync(join(copy, ready.icon), opaque);

  const fake = join(copy, "fake-eas.mjs");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const [, , command, environment, inner, flag] = process.argv;
appendFileSync(process.env.FAKE_EAS_LOG, JSON.stringify({ command, environment, flag, tenant: process.env.WHITEOVEN_TENANT, shellUrl: process.env.WHITEOVEN_API_URL ?? null }) + "\\n");
if (process.env.FAKE_EAS_MODE === "auth") { console.error("Error: GraphQL request failed: Unauthorized (token " + process.env.EXPO_TOKEN + ")"); process.exit(1); }
if (process.env.FAKE_EAS_MODE === "no-environment") { console.error("Error: Environment not found"); process.exit(1); }
const env = { ...process.env };
if (process.env.FAKE_EAS_URL) env.WHITEOVEN_API_URL = process.env.FAKE_EAS_URL;
const run = spawnSync(inner, { shell: true, stdio: "inherit", env });
process.exit(run.status ?? 1);
`,
  );
  chmodSync(fake, 0o755);

  let runs = 0;
  const run = (args: string[], env: Record<string, string> = {}) => {
    const log = join(scratch, `eas-${runs}.log`);
    const output = join(scratch, `output-${runs++}`);
    writeFileSync(log, "");
    writeFileSync(output, "");
    const inherited = { ...process.env };
    delete inherited.WHITEOVEN_API_URL;
    delete inherited.GITHUB_OUTPUT;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        "scripts/release-check.ts",
        ...args,
      ],
      {
        cwd: copy,
        encoding: "utf8",
        env: {
          ...inherited,
          EAS_BIN: fake,
          FAKE_EAS_LOG: log,
          GITHUB_OUTPUT: output,
          ...env,
        },
      },
    );
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { ...result, calls, output: readFileSync(output, "utf8") };
  };
  const store = [centro, "store", "--platform", "android", "--eas"];

  it("checks the API address of the build's EAS environment, never the shell's", () => {
    const ok = run([...store, "--submit"], {
      FAKE_EAS_URL: "https://api.example.com",
      WHITEOVEN_API_URL: "http://shell-only.example",
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(ok.calls, [
      {
        command: "env:exec",
        environment: "production",
        flag: "--non-interactive",
        tenant: centro,
        shellUrl: null,
      },
    ]);
    assert.equal(
      ok.output,
      `build_profile=${centro}-production\nsubmit_profile=production\neas_environment=production\n`,
    );
    assert.doesNotMatch(ok.stdout + ok.stderr, /api\.example\.com/);
  });

  it("stops before the build when the address is missing, HTTP or malformed, without printing it", () => {
    for (const [url, rule] of [
      ["", /WHITEOVEN_API_URL \(missing on EAS\)/],
      ["http://api.example.com", /WHITEOVEN_API_URL \(HTTPS outside/],
      [
        "https://api.example.com/v1?x=secret-value",
        /WHITEOVEN_API_URL \(HTTPS outside/,
      ],
      ["não é url secret-value", /WHITEOVEN_API_URL \(HTTPS outside/],
    ] as const) {
      const refused = run(store, url ? { FAKE_EAS_URL: url } : {});
      assert.equal(refused.status, 1, url);
      assert.match(refused.stderr, rule, url);
      assert.match(refused.stderr, /EAS "production" environment/);
      assert.equal(refused.output, "", url);
      if (url)
        assert.equal(
          (refused.stdout + refused.stderr).includes(url),
          false,
          url,
        );
      assert.doesNotMatch(refused.stdout + refused.stderr, /secret-value/);
    }
  });

  it("fails with an operational message when EAS cannot be read", () => {
    for (const mode of ["auth", "no-environment"]) {
      const failed = run(store, {
        FAKE_EAS_MODE: mode,
        EXPO_TOKEN: "expo-token-secret",
      });
      assert.equal(failed.status, 1, mode);
      assert.match(
        failed.stderr,
        /EAS "production" environment could not be read \(check EXPO_TOKEN/,
      );
      assert.doesNotMatch(failed.stdout + failed.stderr, /expo-token-secret/);
      assert.equal(failed.output, "");
    }
  });

  it("does not call EAS when the repository already refuses the build", () => {
    const refused = run([centro, "preview", "--submit", "--eas"]);
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /submit \(only a store build goes to the stores\)/,
    );
    assert.deepEqual(refused.calls, []);
    const ios = run([centro, "store", "--platform", "ios", "--submit"]);
    assert.equal(ios.status, 1);
    assert.match(ios.stderr, /\(ios\): ascAppId missing/);
  });

  it("refuses bad arguments", () => {
    for (const args of [
      [centro],
      ["../x", "store"],
      [centro, "production"],
      [centro, "store", "--platform", "windows"],
      [centro, "store", "--publish"],
    ])
      assert.equal(run(args).status, 2, args.join(" "));
    assert.match(
      run(["pizzaria-nova", "store"]).stderr,
      /manifests\/pizzaria-nova\.json \(missing\)/,
    );
  });

  it("checks the repository's example stores without EAS and refuses them for the stores", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings=ExperimentalWarning",
        "scripts/release-check.ts",
        centro,
        "store",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /- easProjectId \(EAS project\)/);
    assert.match(result.stderr, /- privacyPolicy \(demonstration text/);
  });
});
