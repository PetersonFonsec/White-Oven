import { ManifestError, type TenantManifest, parseApiUrl } from "./manifest.ts";

/**
 * Store builds (ADR 0028). `WHITEOVEN_RELEASE` comes from the EAS profile: `preview` for internal
 * testers, `store` for App Store and Google Play. Node only: `app.config.ts` and the release
 * check script use it; the app bundle never imports it.
 */
export const RELEASE_KINDS = ["preview", "store"] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];

/** Unset means a development config; any other value than a known kind stops the config. */
export function parseReleaseKind(
  value: string | undefined,
): ReleaseKind | null {
  if (value === undefined || value === "") return null;
  if (!(RELEASE_KINDS as readonly string[]).includes(value))
    throw new ManifestError(["WHITEOVEN_RELEASE"]);
  return value as ReleaseKind;
}

/** The EAS build profile of one store and kind in `eas.json`. */
export function easProfileName(slug: string, kind: ReleaseKind): string {
  return `${slug}-${kind === "store" ? "production" : "preview"}`;
}

interface PngHeader {
  width: number;
  height: number;
  alpha: boolean;
}

/** Size and alpha channel from the IHDR chunk; null when the bytes are not a PNG. */
export function pngHeader(bytes: Uint8Array): PngHeader | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 26 || signature.some((byte, i) => bytes[i] !== byte))
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorType = bytes[25]!;
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    // Gray + alpha (4) and RGBA (6). A palette with a tRNS chunk is not inspected.
    alpha: colorType === 4 || colorType === 6,
  };
}

/**
 * What the manifest and its icon still lack for a build of this kind. Empty means ready.
 * The API URL is checked apart (`apiUrlReleaseProblems`) because it lives on EAS, not here.
 */
export function manifestReleaseProblems(
  manifest: TenantManifest,
  kind: ReleaseKind,
  icon: Uint8Array,
): string[] {
  const problems: string[] = [];
  if (!manifest.easProjectId) problems.push("easProjectId (EAS project)");
  if (!manifest.expoOwner) problems.push("expoOwner (Expo organization)");
  const header = pngHeader(icon);
  if (!header || header.width !== 1024 || header.height !== 1024)
    problems.push("icon (PNG of 1024 x 1024 px)");
  else if (kind === "store" && header.alpha)
    problems.push("icon (transparency; the App Store refuses it)");
  if (kind === "store") {
    if (!manifest.privacyPolicy)
      problems.push("privacyPolicy (approved text, M7.2)");
    else if (/^demo-/i.test(manifest.privacyPolicy.version))
      problems.push("privacyPolicy (demonstration text, M7.2)");
  }
  return problems;
}

/** A build that leaves the developer's machine calls the real API over HTTPS. */
export function apiUrlReleaseProblems(value: string | undefined): string[] {
  if (!value) return ["WHITEOVEN_API_URL (missing on EAS)"];
  try {
    if (parseApiUrl(value).startsWith("https://")) return [];
  } catch {
    // Reported below.
  }
  return ["WHITEOVEN_API_URL (HTTPS outside the developer's machine)"];
}
