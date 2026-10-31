/**
 * Pre-flight of one store's build (ADR 0028), before spending an EAS build:
 * `pnpm mobile:release-check <slug> <preview|store> [--platform android|ios|all] [--submit] [--eas]`.
 *
 * - manifest and icon ready for the kind of build;
 * - the store's EAS build profile builds this store, this kind, from the kind's base profile;
 * - `--submit`: the submit profile has what each chosen platform needs;
 * - `--eas`: reads the EAS environment of the build through `eas env:exec` and checks
 *   `WHITEOVEN_API_URL` there (needs an EXPO_TOKEN or a logged-in EAS CLI). Without it, a
 *   `WHITEOVEN_API_URL` in the shell is checked instead, and otherwise only the worker checks.
 *
 * With `GITHUB_OUTPUT` set, writes `build_profile`, `submit_profile` and `eas_environment`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STORE_SLUG, parseManifest } from "../src/config/manifest.ts";
import {
  apiUrlReleaseProblems,
  easProfileName,
  manifestReleaseProblems,
  parseReleaseKind,
} from "../src/config/release.ts";
import {
  PLATFORM_CHOICES,
  checkBuildProfile,
  checkSubmitProfile,
  parsePlatformChoice,
} from "./eas-profiles.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const usage = () => {
  console.error(
    "Usage: release-check <store slug> <preview|store> [--platform android|ios|all] [--submit] [--eas]",
  );
  process.exit(2);
};

const args = process.argv.slice(2);
const [slug = "", kindArg = ""] = args;
const flags = args.slice(2);
let platformArg = "all";
let submit = false;
let eas = false;
for (let i = 0; i < flags.length; i++) {
  const flag = flags[i];
  if (flag === "--submit") submit = true;
  else if (flag === "--eas") eas = true;
  else if (flag === "--platform" && flags[i + 1] !== undefined)
    platformArg = flags[++i]!;
  else usage();
}
let kind: ReturnType<typeof parseReleaseKind> = null;
try {
  kind = parseReleaseKind(kindArg);
} catch {
  usage();
}
const platform = parsePlatformChoice(platformArg);
if (!STORE_SLUG.test(slug) || !kind || !platform) usage();
const platforms = PLATFORM_CHOICES[platform!];

const problems: string[] = [];
let manifestText: string | null = null;
try {
  manifestText = readFileSync(join(root, "manifests", `${slug}.json`), "utf8");
} catch {
  problems.push(`manifests/${slug}.json (missing)`);
}
if (manifestText !== null) {
  const manifest = parseManifest(JSON.parse(manifestText));
  if (manifest.slug !== slug)
    problems.push(`manifests/${slug}.json names another store`);
  problems.push(
    ...manifestReleaseProblems(
      manifest,
      kind!,
      readFileSync(join(root, manifest.icon)),
    ),
  );
}
const build = await checkBuildProfile(
  root,
  slug,
  kind!,
  platforms,
  easProfileName(slug, kind!),
);
problems.push(...build.problems);
const submission = submit
  ? await checkSubmitProfile(root, slug, kind!, platforms)
  : null;
if (submission) problems.push(...submission.problems);

let apiChecked = false;
if (eas && !problems.length) {
  // A URL in the shell must not stand in for the one on EAS.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WHITEOVEN_TENANT: slug,
  };
  delete env["WHITEOVEN_API_URL"];
  const inner =
    "node --experimental-strip-types --no-warnings=ExperimentalWarning scripts/api-url-check.ts";
  const run = spawnSync(
    process.env.EAS_BIN || "eas",
    ["env:exec", build.environment, inner, "--non-interactive"],
    { cwd: root, env, encoding: "utf8" },
  );
  if (run.status === 0) apiChecked = true;
  else if (run.status === 3)
    problems.push(
      `WHITEOVEN_API_URL in the EAS "${build.environment}" environment:\n${run.stderr.trim()}`,
    );
  else
    problems.push(
      `EAS "${build.environment}" environment could not be read (check EXPO_TOKEN, access to the store's EAS project and the environment name)`,
    );
} else if (!eas && process.env.WHITEOVEN_API_URL) {
  problems.push(...apiUrlReleaseProblems(process.env.WHITEOVEN_API_URL));
  apiChecked = !problems.length;
}

if (problems.length) {
  console.error(`${slug} is not ready for a ${kind} build:`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `build_profile=${build.profile}\nsubmit_profile=${submission?.profile ?? ""}\neas_environment=${build.environment}\n`,
  );
console.log(
  `${slug} is ready for a ${kind} build (${platform}) with the EAS profile ${build.profile}` +
    (submission ? ` and the submit profile ${submission.profile}` : "") +
    "." +
    (apiChecked ? "" : " WHITEOVEN_API_URL is checked on the EAS worker."),
);
