import { type BrandColors, parseBrandColors } from "./colors.ts";

/** `GET /v1/public/stores/{slug}` (ADR 0020; the logo since ADR 0021). */
export interface PublicStoreProfile {
  slug: string;
  name: string;
  brand: { version: number; colors: BrandColors; logoImageId: string | null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A public image id, or null for anything else: the app builds a URL with it. */
export const imageIdOf = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value : null;

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
  /** The brand logo, from the same source as `colors`; null when the store has none. */
  logoImageId: string | null;
  brandVersion: number;
  brandSource: BrandSource;
  /**
   * The profile request failed (network, timeout, 429, 5xx or an invalid body) while the store
   * still answers: the brand on screen is the cached or manifest one and may be out of date.
   * Independent of `availability`, so a valid status is still shown as it is.
   */
  brandStale: boolean;
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
  /**
   * Cancels the load: requests are aborted and, once aborted, nothing is written to the cache,
   * so an abandoned load never replaces what a later one saved.
   */
  signal?: AbortSignal;
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
  // A cache written before the logo existed has no logoImageId: the same as no logo.
  const logo = brand!.logoImageId ?? null;
  if (logo !== null && !imageIdOf(logo)) return null;
  return {
    slug: profile.slug,
    name: profile.name,
    brand: { version: brand!.version!, colors, logoImageId: logo },
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
): Promise<{
  name: string;
  colors: BrandColors;
  logoImageId: string | null;
  version: number;
} | null> {
  const profile = await readCache(cache, storeSlug);
  return profile
    ? {
        name: profile.name,
        colors: profile.brand.colors,
        logoImageId: profile.brand.logoImageId,
        version: profile.brand.version,
      }
    : null;
}

export type Answer<T> =
  { kind: "ok"; body: T } | { kind: "unavailable" } | { kind: "failed" };

export type PublicGetOptions = Pick<
  LoadStoreOptions,
  "apiUrl" | "storeSlug" | "fetch" | "timeoutMs" | "signal"
>;

/**
 * GET of a public store route. 403 and 404 mean the store is not serving; anything else that is
 * not a valid body (network, timeout, 429, 5xx) is a failure the user can retry.
 */
export async function publicGet<T>(
  options: PublicGetOptions,
  path: string,
  parse: (body: unknown) => T | null,
): Promise<Answer<T>> {
  // AbortController and a timer, not AbortSignal.timeout, which React Native does not provide.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel);
  if (options.signal?.aborted) controller.abort();
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
    options.signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Brand and status of the app's store, from two independent requests:
 *
 * - 403 or 404 on either one: the store is unavailable.
 * - Otherwise the status alone decides open or closed; without a valid status the app is offline
 *   and never claims the store is open.
 * - A valid profile replaces the cache and is shown at once. Any other profile answer keeps the
 *   cached brand (or the manifest's) and sets `brandStale`, whatever the status said.
 *
 * The status is never cached: an old "open" could take an order to a closed store. Nothing is
 * written once `signal` is aborted.
 */
export async function loadStore(options: LoadStoreOptions): Promise<StoreView> {
  const [profile, status] = await Promise.all([
    publicGet(options, "", (body) => parseProfile(body, options.storeSlug)),
    publicGet(options, "/status", parseStatus),
  ]);
  if (profile.kind === "ok" && !options.signal?.aborted) {
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
    logoImageId: brand?.profile.brand.logoImageId ?? null,
    brandVersion: brand?.profile.brand.version ?? 0,
    brandSource: brand?.source ?? "manifest",
    brandStale:
      profile.kind === "failed" && availability.kind !== "unavailable",
    availability,
  };
}

export interface StoreRefresher {
  /**
   * Loads the store once at a time: a call while a load runs gets that same load, so repeated
   * taps never send duplicate requests and an older answer can never land after a newer one.
   * Resolves null once disposed.
   */
  refresh(): Promise<StoreView | null>;
  /** True while a load runs. */
  readonly refreshing: boolean;
  /** Aborts the running load; it writes nothing to the cache and resolves null. */
  dispose(): void;
}

export function createStoreRefresher(
  options: LoadStoreOptions,
): StoreRefresher {
  const lifetime = new AbortController();
  let running: Promise<StoreView | null> | null = null;
  const offline = (): StoreView => ({
    name: options.fallback.name,
    colors: options.fallback.colors,
    logoImageId: null,
    brandVersion: 0,
    brandSource: "manifest",
    brandStale: true,
    availability: { kind: "offline" },
  });
  return {
    refresh() {
      if (lifetime.signal.aborted) return Promise.resolve(null);
      running ??= loadStore({ ...options, signal: lifetime.signal })
        // loadStore catches what it expects; anything else still ends the load, so the user can
        // try again instead of waiting forever.
        .catch(offline)
        .then((view) => (lifetime.signal.aborted ? null : view))
        .finally(() => {
          running = null;
        });
      return running;
    },
    get refreshing() {
      return running !== null;
    },
    dispose() {
      lifetime.abort();
    },
  };
}
