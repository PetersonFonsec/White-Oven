import { type BrandColors, parseBrandColors } from "./brand.ts";

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
