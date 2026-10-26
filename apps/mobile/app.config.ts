import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAppConfig, parseManifest } from "./src/config/manifest.ts";

/**
 * One binary per store (ADR 0020): `WHITEOVEN_TENANT` names the manifest in `manifests/` and
 * `WHITEOVEN_API_URL` the API the app calls (HTTPS; plain HTTP only to the developer machine).
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
  return buildAppConfig(
    manifest,
    process.env.WHITEOVEN_API_URL ?? "http://localhost:3000",
  );
}
