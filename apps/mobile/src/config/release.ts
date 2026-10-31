import { ManifestError, type TenantManifest, parseApiUrl } from "./manifest.ts";

/**
 * Store builds (ADR 0028). `WHITEOVEN_RELEASE` comes from the EAS profile: `preview` for internal
 * testers, `store` for App Store and Google Play. `app.config.ts` and the release check script
 * use it; the app bundle never imports it.
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

/**
 * What each kind of build must inherit in `eas.json` (ADR 0028). The release check and the
 * tests read this one table, so a profile that drifts from it is refused.
 */
export const RELEASE_PROFILES = {
  preview: {
    base: "preview",
    environment: "preview",
    distribution: "internal",
  },
  store: {
    base: "production",
    environment: "production",
    distribution: "store",
  },
} as const satisfies Record<
  ReleaseKind,
  { base: string; environment: string; distribution: string }
>;

/** The EAS build profile of one store and kind in `eas.json`. */
export function easProfileName(slug: string, kind: ReleaseKind): string {
  return `${slug}-${RELEASE_PROFILES[kind].base}`;
}

interface PngImage {
  width: number;
  height: number;
  /** An alpha channel, or a `tRNS` chunk that makes some pixel transparent. */
  transparency: boolean;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Valid bit depths per PNG color type. */
const PNG_BIT_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/**
 * Size and transparency of a PNG, walking every chunk and its CRC; null when the bytes are not
 * a complete PNG (wrong signature, truncated, bad CRC, IHDR not first, no IDAT, nothing after
 * IEND). Pixels are not decoded: an alpha channel counts as transparency even if every pixel
 * is opaque, which only errs on the safe side for the App Store.
 */
export function pngImage(bytes: Uint8Array): PngImage | null {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte))
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header: { width: number; height: number; colorType: number } | null =
    null;
  let palette = false;
  let data = false;
  let transparency = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
      view.getUint32(end - 4)
    )
      return null;
    if (!header) {
      if (type !== "IHDR" || length !== 13) return null;
      const colorType = body[9]!;
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (
        !width ||
        !height ||
        !PNG_BIT_DEPTHS[colorType]?.includes(body[8]!) ||
        body[10] !== 0 ||
        body[11] !== 0 ||
        body[12]! > 1
      )
        return null;
      header = { width, height, colorType };
      transparency = colorType === 4 || colorType === 6;
    } else if (type === "IHDR") return null;
    else if (type === "PLTE") palette = true;
    else if (type === "tRNS") {
      if (data) return null;
      // Indexed: one alpha per palette entry. Gray and RGB: a color key, so some pixel is clear.
      if (header.colorType === 3) {
        if (!palette) return null;
        if (body.some((alpha) => alpha < 255)) transparency = true;
      } else if (header.colorType === 0 || header.colorType === 2)
        transparency = true;
      else return null;
    } else if (type === "IDAT") data = true;
    else if (type === "IEND") {
      if (end !== bytes.length || !data || (header.colorType === 3 && !palette))
        return null;
      return { width: header.width, height: header.height, transparency };
    }
    offset = end;
  }
  return null;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
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
  const image = pngImage(icon);
  if (!image || image.width !== 1024 || image.height !== 1024)
    problems.push("icon (PNG of 1024 x 1024 px)");
  else if (kind === "store" && image.transparency)
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
