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
  easApiUrlProblem,
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

describe("result of the EAS environment check", () => {
  const run = (
    status: number | null,
    signal: NodeJS.Signals | null = null,
    error?: Error,
  ) =>
    easApiUrlProblem(
      { status, signal, ...(error ? { error } : {}) },
      "production",
    );

  it("passes only on exit 0 and keeps every other outcome to a fixed message", () => {
    assert.equal(run(0), null);
    assert.equal(
      run(3),
      'WHITEOVEN_API_URL is missing or invalid in the EAS "production" environment (set an HTTPS address, plain text or sensitive)',
    );
    const failure =
      'Could not validate the EAS "production" environment (check EXPO_TOKEN, access to the store\'s EAS project and the environment name)';
    for (const outcome of [
      run(1),
      run(2),
      run(null, "SIGKILL"),
      run(null, "SIGTERM"),
      run(
        null,
        null,
        Object.assign(new Error("spawn eas ENOENT"), { code: "ENOENT" }),
      ),
      // A start error wins over a status that looks like success.
      run(0, null, new Error("spawnSync eas ETIMEDOUT")),
      run(3, "SIGKILL"),
    ])
      assert.equal(outcome, failure);
    assert.match(
      easApiUrlProblem({ status: 3, signal: null }, "preview")!,
      /EAS "preview" environment/,
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
if (process.env.FAKE_EAS_MODE === "leak") { console.log("stdout: token " + process.env.EXPO_TOKEN + " url https://leak.example/api"); console.error("stderr: WHITEOVEN_API_URL=https://leak.example/api token " + process.env.EXPO_TOKEN); process.exit(Number(process.env.FAKE_EAS_EXIT)); }
if (process.env.FAKE_EAS_MODE === "signal") process.kill(process.pid, "SIGKILL");
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

  const missingOrInvalid =
    /- WHITEOVEN_API_URL is missing or invalid in the EAS "production" environment/;
  const couldNotValidate =
    /- Could not validate the EAS "production" environment \(check EXPO_TOKEN/;
  /** A refused pre-flight: exit 1, the fixed message, no outputs for the build step. */
  const assertRefused = (
    result: ReturnType<typeof run>,
    message: RegExp,
    secrets: string[],
  ) => {
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.equal(result.output, "", "no build profile for the build step");
    for (const secret of secrets)
      assert.equal(
        (result.stdout + result.stderr).includes(secret),
        false,
        secret,
      );
  };

  it("stops before the build when the address is missing, HTTP or malformed, without printing it", () => {
    for (const url of [
      "",
      "http://api.example.com",
      "https://api.example.com/v1?x=secret-value",
      "não é url secret-value",
    ]) {
      const refused = run(store, url ? { FAKE_EAS_URL: url } : {});
      assertRefused(
        refused,
        missingOrInvalid,
        url ? [url, "secret-value"] : [],
      );
      // Only the fixed message: the check's own lines never reach the log.
      assert.doesNotMatch(refused.stderr, /HTTPS outside|missing on EAS/);
    }
  });

  it("never forwards what the EAS CLI prints, whatever its exit status", () => {
    const secrets = ["expo-token-secret", "leak.example"];
    for (const [exit, message] of [
      ["3", missingOrInvalid],
      ["1", couldNotValidate],
      ["2", couldNotValidate],
      ["0", null],
    ] as const) {
      const result = run(store, {
        FAKE_EAS_MODE: "leak",
        FAKE_EAS_EXIT: exit,
        EXPO_TOKEN: "expo-token-secret",
      });
      if (message) assertRefused(result, message, secrets);
      else {
        // Exit 0 is the success path: the pre-flight continues to the build.
        assert.equal(result.status, 0, result.stderr);
        assert.match(
          result.output,
          /^build_profile=pizzaria-centro-production$/m,
        );
        for (const secret of secrets)
          assert.equal((result.stdout + result.stderr).includes(secret), false);
      }
    }
  });

  it("fails closed when EAS cannot be read, does not start or dies by a signal", () => {
    for (const env of [
      { FAKE_EAS_MODE: "auth" } as Record<string, string>,
      { FAKE_EAS_MODE: "no-environment" },
      { FAKE_EAS_MODE: "signal" },
      { EAS_BIN: join(scratch, "no-such-eas") },
    ])
      assertRefused(
        run(store, { ...env, EXPO_TOKEN: "expo-token-secret" }),
        couldNotValidate,
        ["expo-token-secret"],
      );
  });

  it("checks the preview environment for a preview build", () => {
    const ok = run([centro, "preview", "--eas"], {
      FAKE_EAS_URL: "https://api.example.com",
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.calls[0].environment, "preview");
    assert.match(ok.output, /^eas_environment=preview$/m);
    assertRefused(
      run([centro, "preview", "--eas"], { FAKE_EAS_URL: "http://x.example" }),
      /- WHITEOVEN_API_URL is missing or invalid in the EAS "preview" environment/,
      ["x.example"],
    );
  });

  it("starts the EAS build only after the pre-flight against EAS succeeded", () => {
    const workflow = readFileSync(
      join(root, "..", "..", ".github", "workflows", "mobile-build.yml"),
      "utf8",
    );
    assert.doesNotMatch(
      workflow,
      /continue-on-error|if: always\(\)|if: failure\(\)/,
    );
    const preflight = workflow.indexOf("id: preflight");
    const build = workflow.indexOf("eas build ");
    assert.ok(preflight > 0 && build > preflight);
    assert.match(
      workflow.slice(preflight, build),
      /--eas\)[\s\S]*pnpm release-check "\$\{args\[@\]\}"/,
    );
    // The build step takes its profile only from the pre-flight's outputs.
    assert.match(
      workflow.slice(build - 400, build),
      /BUILD_PROFILE: \$\{\{ steps\.preflight\.outputs\.build_profile \}\}/,
    );
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
