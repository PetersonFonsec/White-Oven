/**
 * Pre-flight of one store's build (ADR 0028), before spending an EAS build:
 * `pnpm mobile:release-check <slug> <preview|store>`.
 * Without `WHITEOVEN_API_URL` in the environment, the URL is left to the check on the EAS worker.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STORE_SLUG, parseManifest } from "../src/config/manifest.ts";
import {
  apiUrlReleaseProblems,
  easProfileName,
  manifestReleaseProblems,
  parseReleaseKind,
} from "../src/config/release.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [slug = "", kindArg] = process.argv.slice(2);
const kind = parseReleaseKind(kindArg ?? "");
if (!STORE_SLUG.test(slug) || !kind) {
  console.error("Usage: release-check <store slug> <preview|store>");
  process.exit(2);
}

const problems: string[] = [];
const manifest = parseManifest(
  JSON.parse(readFileSync(join(root, "manifests", `${slug}.json`), "utf8")),
);
if (manifest.slug !== slug)
  problems.push(`manifests/${slug}.json names another store`);
problems.push(
  ...manifestReleaseProblems(
    manifest,
    kind,
    readFileSync(join(root, manifest.icon)),
  ),
);
const eas = JSON.parse(readFileSync(join(root, "eas.json"), "utf8")) as {
  build?: Record<string, unknown>;
};
const profile = easProfileName(slug, kind);
if (!eas.build?.[profile]) problems.push(`eas.json build profile ${profile}`);
const apiUrl = process.env.WHITEOVEN_API_URL;
if (apiUrl) problems.push(...apiUrlReleaseProblems(apiUrl));

if (problems.length) {
  console.error(`${slug} is not ready for a ${kind} build:`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(
  `${slug} is ready for a ${kind} build with the EAS profile ${profile}.` +
    (apiUrl ? "" : " WHITEOVEN_API_URL is checked on the EAS worker."),
);
