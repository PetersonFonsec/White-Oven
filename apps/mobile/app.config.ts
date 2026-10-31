import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAppConfig, parseManifest } from "./src/config/manifest.ts";
import {
  apiUrlReleaseProblems,
  manifestReleaseProblems,
  parseReleaseKind,
} from "./src/config/release.ts";

/**
 * One binary per store (ADR 0020): `WHITEOVEN_TENANT` names the manifest in `manifests/` and
 * `WHITEOVEN_API_URL` the API the app calls (HTTPS; plain HTTP only to the developer machine).
 *
 * On an EAS build worker (`EAS_BUILD`), a store profile (`WHITEOVEN_RELEASE`, ADR 0028) refuses
 * to build a binary that is not ready: no EAS project, a bad icon
 * or an API that is not HTTPS. The CLI evaluates this file before it fetches the variables
 * kept on EAS, so the check waits for the worker, where every variable is present.
 */
export default function appConfig({ projectRoot }: { projectRoot: string }) {
  const tenant = process.env.WHITEOVEN_TENANT ?? "";
  if (!/^[a-z0-9-]{3,40}$/.test(tenant))
    throw new Error(
      "Set WHITEOVEN_TENANT to a manifest in apps/mobile/manifests (for example pizzaria-centro).",
    );
  const manifest = parseManifest(
    JSON.parse(
      readFileSync(join(projectRoot, "manifests", `${tenant}.json`), "utf8"),
    ),
  );
  if (manifest.slug !== tenant)
    throw new Error(`manifests/${tenant}.json names another store.`);
  const release = parseReleaseKind(process.env.WHITEOVEN_RELEASE);
  if (release && process.env.EAS_BUILD === "true") {
    const problems = [
      ...manifestReleaseProblems(
        manifest,
        release,
        readFileSync(join(projectRoot, manifest.icon)),
      ),
      ...apiUrlReleaseProblems(process.env.WHITEOVEN_API_URL),
    ];
    if (problems.length)
      throw new Error(
        `${tenant} is not ready for a ${release} build: ${problems.join("; ")}.`,
      );
  }
  return buildAppConfig(
    manifest,
    process.env.WHITEOVEN_API_URL ?? "http://localhost:3000",
  );
}
