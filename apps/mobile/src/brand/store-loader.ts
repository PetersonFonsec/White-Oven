import { type BrandColors, parseBrandColors } from "./colors.ts";

/** `GET /v1/public/stores/{slug}` (ADR 0020). */
export interface PublicStoreProfile {
  slug: string;
  name: string;
  brand: { version: number; colors: BrandColors };
}

/** `GET /v1/public/stores/{slug}/status` (ADR 0016). */
export interface PublicStoreStatus {
  open: boolean;
  reason: string;
  pausedUntil: string | null;
  timezone: string;
}

/** Where the brand on screen came from. */
export type BrandSource = "api" | "cache" | "manifest";

export type Availability =
  | { kind: "open" }
  | {
      kind: "closed";
      reason: string;
      pausedUntil: string | null;
      timezone: string;
    }
  /** The API answered that the store is not serving (suspended, closed for good, unknown). */
  | { kind: "unavailable" }
  /** The API did not answer: offline, timeout or a server error. */
  | { kind: "offline" };

export interface StoreView {
  name: string;
  colors: BrandColors;
  brandVersion: number;
  brandSource: BrandSource;
  availability: Availability;
}

/** Last brand the API sent, kept on the device so the app opens offline with it. */
export interface BrandCache {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

const CACHE_VERSION = 1;
const MAX_CACHE_LENGTH = 16 * 1024;

export interface LoadStoreOptions {
  apiUrl: string;
  storeSlug: string;
  /** From the manifest: shown until the API or the cache has something better. */
  fallback: { name: string; colors: BrandColors };
  cache: BrandCache;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Validates a profile from the API or the cache; it must be of this app's store. */
export function parseProfile(
  value: unknown,
  storeSlug: string,
): PublicStoreProfile | null {
  if (!value || typeof value !== "object") return null;
  const profile = value as Partial<PublicStoreProfile>;
  const brand = profile.brand as
    Partial<PublicStoreProfile["brand"]> | undefined;
  const colors = parseBrandColors(brand?.colors);
  if (
    profile.slug !== storeSlug ||
    typeof profile.name !== "string" ||
    !profile.name.trim() ||
    profile.name.length > 120 ||
    !Number.isSafeInteger(brand?.version) ||
    brand!.version! < 0 ||
    !colors
  )
    return null;
  return {
    slug: profile.slug,
    name: profile.name,
    brand: { version: brand!.version!, colors },
  };
}

function parseStatus(value: unknown): PublicStoreStatus | null {
  if (!value || typeof value !== "object") return null;
  const status = value as Partial<PublicStoreStatus>;
  if (
    typeof status.open !== "boolean" ||
    typeof status.reason !== "string" ||
    typeof status.timezone !== "string" ||
    (status.pausedUntil !== null && typeof status.pausedUntil !== "string")
  )
    return null;
  return {
    open: status.open,
    reason: status.reason,
    pausedUntil: status.pausedUntil,
    timezone: status.timezone,
  };
}

async function readCache(
  cache: BrandCache,
  storeSlug: string,
): Promise<PublicStoreProfile | null> {
  try {
    const raw = await cache.read();
    if (!raw || raw.length > MAX_CACHE_LENGTH) return null;
    const stored = JSON.parse(raw) as { version?: unknown; profile?: unknown };
    return stored.version === CACHE_VERSION
      ? parseProfile(stored.profile, storeSlug)
      : null;
  } catch {
    // A broken cache is the same as no cache: the manifest colors still open the app.
    return null;
  }
}

/** The last brand the API sent, for the first frame while the API is asked again. */
export async function cachedBrand(
  cache: BrandCache,
  storeSlug: string,
): Promise<{ name: string; colors: BrandColors; version: number } | null> {
  const profile = await readCache(cache, storeSlug);
  return profile
    ? {
        name: profile.name,
        colors: profile.brand.colors,
        version: profile.brand.version,
      }
    : null;
}

type Answer<T> =
  { kind: "ok"; body: T } | { kind: "unavailable" } | { kind: "failed" };

async function get<T>(
  options: LoadStoreOptions,
  path: string,
  parse: (body: unknown) => T | null,
): Promise<Answer<T>> {
  // AbortController and a timer, not AbortSignal.timeout, which React Native does not provide.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const response = await options.fetch(
      `${options.apiUrl}/v1/public/stores/${encodeURIComponent(options.storeSlug)}${path}`,
      { headers: { accept: "application/json" }, signal: controller.signal },
    );
    // 404 (no such store) and 403 TENANT_NOT_ACTIVE: the API answered that it is not serving.
    if (response.status === 404 || response.status === 403)
      return { kind: "unavailable" };
    if (!response.ok) return { kind: "failed" };
    const body = parse(await response.json());
    return body ? { kind: "ok", body } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Brand and status of the app's store. The API is the authority: a valid profile replaces the
 * cache and is shown at once. Without an answer, the last cached brand (or the manifest's) opens
 * the app, marked offline. The status is never cached: an old "open" could take an order to a
 * closed store.
 */
export async function loadStore(options: LoadStoreOptions): Promise<StoreView> {
  const [profile, status] = await Promise.all([
    get(options, "", (body) => parseProfile(body, options.storeSlug)),
    get(options, "/status", parseStatus),
  ]);
  if (profile.kind === "ok") {
    try {
      await options.cache.write(
        JSON.stringify({ version: CACHE_VERSION, profile: profile.body }),
      );
    } catch {
      // The cache only helps the next offline start; failing to write it changes nothing now.
    }
  }
  const cached =
    profile.kind === "ok"
      ? null
      : await readCache(options.cache, options.storeSlug);
  const brand =
    profile.kind === "ok"
      ? { profile: profile.body, source: "api" as const }
      : cached
        ? { profile: cached, source: "cache" as const }
        : null;
  const availability: Availability =
    profile.kind === "unavailable" || status.kind === "unavailable"
      ? { kind: "unavailable" }
      : status.kind === "ok"
        ? status.body.open
          ? { kind: "open" }
          : {
              kind: "closed",
              reason: status.body.reason,
              pausedUntil: status.body.pausedUntil,
              timezone: status.body.timezone,
            }
        : { kind: "offline" };
  return {
    name: brand?.profile.name ?? options.fallback.name,
    colors: brand?.profile.brand.colors ?? options.fallback.colors,
    brandVersion: brand?.profile.brand.version ?? 0,
    brandSource: brand?.source ?? "manifest",
    availability,
  };
}
