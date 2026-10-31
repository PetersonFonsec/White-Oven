import { type BrandColors, parseBrandColors } from "../brand/colors.ts";

/**
 * One manifest per store (ADR 0020): what changes between the binaries built from this single
 * code base. The binary knows only its store slug; name shown inside the app, colors and status
 * come from the API at runtime. Icon and bundle ids are build-time, as the stores require.
 */
export interface CustomerPrivacyPolicy {
  version: string;
  text: string;
}

function privacyPolicy(raw: unknown): CustomerPrivacyPolicy | undefined {
  if (raw === undefined) return undefined;
  const value = raw as Partial<CustomerPrivacyPolicy> | null;
  if (
    !value ||
    typeof value.version !== "string" ||
    !value.version.trim() ||
    value.version.length > 40 ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 20000
  )
    throw new ManifestError(["privacyPolicy"]);
  return { version: value.version, text: value.text };
}

export interface TenantManifest {
  privacyPolicy?: CustomerPrivacyPolicy;
  /** The store's slug in `/v1/public/stores/{slug}`. */
  slug: string;
  /** App name on the home screen and in the stores. */
  name: string;
  /** Application version shown in the stores. */
  version: string;
  ios: { bundleIdentifier: string };
  android: { package: string };
  /** Square PNG of at least 1024 px under `assets/tenants/{slug}/`. */
  icon: string;
  /** Behind the Android adaptive icon. */
  iconBackgroundColor: string;
  /** Brand colors until the first answer of the API; the API wins once it answers. */
  fallbackColors: BrandColors;
  /**
   * The store's EAS project id (ADR 0027). Without it the build has no push notifications and
   * the account screen says so.
   */
  easProjectId?: string;
  /**
   * The Expo account that owns `easProjectId` (ADR 0028): WhiteOven's organization. Only with a
   * project; a store build requires it, because EAS refuses a robot token without an owner.
   */
  expoOwner?: string;
}

/** What the running app reads from `expo-constants` (`extra.whiteoven`). */
export interface AppRuntimeConfig {
  privacyPolicy?: CustomerPrivacyPolicy;
  storeSlug: string;
  storeName: string;
  apiUrl: string;
  fallbackColors: BrandColors;
  /** Present only in builds with push notifications. */
  pushProjectId?: string;
}

export const STORE_SLUG = /^[a-z0-9-]{3,40}$/;
const BUNDLE_ID = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/;
const ANDROID_PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const HEX = /^#[0-9A-F]{6}$/;
const EAS_PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXPO_OWNER = /^[a-z0-9][a-z0-9_-]{0,38}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

export class ManifestError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid tenant manifest: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** Validates a parsed manifest file; throws `ManifestError` with every problem found. */
export function parseManifest(value: unknown): TenantManifest {
  const problems: string[] = [];
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const text = (key: string, pattern: RegExp, max = 80) => {
    const field = record[key];
    if (typeof field !== "string" || field.length > max || !pattern.test(field))
      problems.push(key);
    return typeof field === "string" ? field : "";
  };
  const slug = text("slug", STORE_SLUG);
  const name = text("name", /^\S(.*\S)?$/, 30);
  const version = text("version", VERSION);
  const iconBackgroundColor = text("iconBackgroundColor", HEX);
  const icon = text(
    "icon",
    /^\.\/assets\/tenants\/[a-z0-9-]+\/[a-z0-9-]+\.png$/,
  );
  if (
    !problems.includes("icon") &&
    !icon.startsWith(`./assets/tenants/${slug}/`)
  )
    problems.push("icon (outside the store's folder)");
  const nested = (key: string, field: string, pattern: RegExp) => {
    const group = record[key] as Record<string, unknown> | undefined;
    const item = group?.[field];
    if (typeof item !== "string" || item.length > 155 || !pattern.test(item))
      problems.push(`${key}.${field}`);
    return typeof item === "string" ? item : "";
  };
  const bundleIdentifier = nested("ios", "bundleIdentifier", BUNDLE_ID);
  const androidPackage = nested("android", "package", ANDROID_PACKAGE);
  const fallbackColors = parseBrandColors(record["fallbackColors"], true);
  if (!fallbackColors) problems.push("fallbackColors");
  const easProjectId = record["easProjectId"];
  if (
    easProjectId !== undefined &&
    (typeof easProjectId !== "string" || !EAS_PROJECT_ID.test(easProjectId))
  )
    problems.push("easProjectId");
  const expoOwner = record["expoOwner"];
  if (
    expoOwner !== undefined &&
    (typeof expoOwner !== "string" || !EXPO_OWNER.test(expoOwner))
  )
    problems.push("expoOwner");
  else if (expoOwner !== undefined && easProjectId === undefined)
    problems.push("expoOwner (without easProjectId)");
  const known = [
    "slug",
    "name",
    "version",
    "ios",
    "android",
    "icon",
    "iconBackgroundColor",
    "fallbackColors",
    "privacyPolicy",
    "easProjectId",
    "expoOwner",
  ];
  for (const key of Object.keys(record))
    if (!known.includes(key)) problems.push(`${key} (unknown)`);
  if (problems.length) throw new ManifestError(problems);
  return {
    ...(record["privacyPolicy"] === undefined
      ? {}
      : { privacyPolicy: privacyPolicy(record["privacyPolicy"]) }),
    slug,
    name,
    version,
    ios: { bundleIdentifier },
    android: { package: androidPackage },
    icon,
    iconBackgroundColor,
    fallbackColors: fallbackColors!,
    ...(typeof easProjectId === "string" ? { easProjectId } : {}),
    ...(typeof expoOwner === "string" ? { expoOwner } : {}),
  };
}

/**
 * The API base the app calls. HTTPS always, except plain HTTP to the developer's own machine
 * (`localhost`, `127.0.0.1`, or `10.0.2.2` from the Android emulator).
 */
export function parseApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ManifestError(["WHITEOVEN_API_URL"]);
  }
  const local = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (
    (url.protocol !== "https:" && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new ManifestError(["WHITEOVEN_API_URL"]);
  return url.origin;
}

/**
 * The Expo config of one store's binary: the shared base of `app.json`-like settings plus what
 * the manifest names. Two manifests give two apps with their own name, icon and bundle ids.
 */
export function buildAppConfig(manifest: TenantManifest, apiUrl: string) {
  const runtime: AppRuntimeConfig = {
    ...(manifest.privacyPolicy
      ? { privacyPolicy: manifest.privacyPolicy }
      : {}),
    storeSlug: manifest.slug,
    storeName: manifest.name,
    apiUrl: parseApiUrl(apiUrl),
    fallbackColors: manifest.fallbackColors,
    ...(manifest.easProjectId ? { pushProjectId: manifest.easProjectId } : {}),
  };
  return {
    // Only a build with an EAS project asks the stores for the push entitlement.
    plugins: manifest.easProjectId
      ? ["expo-secure-store", "expo-notifications"]
      : ["expo-secure-store"],
    name: manifest.name,
    slug: `whiteoven-${manifest.slug}`,
    ...(manifest.expoOwner ? { owner: manifest.expoOwner } : {}),
    version: manifest.version,
    orientation: "portrait" as const,
    userInterfaceStyle: "light" as const,
    icon: manifest.icon,
    ios: {
      bundleIdentifier: manifest.ios.bundleIdentifier,
      supportsTablet: false,
      // Only HTTPS through the system: exempt, so App Store Connect stops asking on every upload.
      config: { usesNonExemptEncryption: false },
    },
    android: {
      package: manifest.android.package,
      adaptiveIcon: {
        foregroundImage: manifest.icon,
        backgroundColor: manifest.iconBackgroundColor,
      },
    },
    extra: {
      whiteoven: runtime,
      ...(manifest.easProjectId
        ? { eas: { projectId: manifest.easProjectId } }
        : {}),
    },
  };
}

/** `extra.whiteoven` as the running app reads it; null when the build did not embed a valid one. */
export function parseRuntimeConfig(extra: unknown): AppRuntimeConfig | null {
  const value = (extra as { whiteoven?: Partial<AppRuntimeConfig> } | null)
    ?.whiteoven;
  if (!value || typeof value !== "object") return null;
  const fallbackColors = parseBrandColors(value.fallbackColors);
  try {
    privacyPolicy(value.privacyPolicy);
    if (
      typeof value.storeSlug !== "string" ||
      !STORE_SLUG.test(value.storeSlug) ||
      typeof value.storeName !== "string" ||
      !value.storeName.trim() ||
      typeof value.apiUrl !== "string" ||
      parseApiUrl(value.apiUrl) !== value.apiUrl ||
      !fallbackColors ||
      (value.pushProjectId !== undefined &&
        (typeof value.pushProjectId !== "string" ||
          !EAS_PROJECT_ID.test(value.pushProjectId)))
    )
      return null;
  } catch {
    return null;
  }
  return {
    ...(value.privacyPolicy
      ? { privacyPolicy: privacyPolicy(value.privacyPolicy) }
      : {}),
    storeSlug: value.storeSlug,
    storeName: value.storeName,
    apiUrl: value.apiUrl,
    fallbackColors,
    ...(value.pushProjectId ? { pushProjectId: value.pushProjectId } : {}),
  };
}
