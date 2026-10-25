/**
 * Brand theme rules (docs/architecture/domain-model.md#brandtheme, design-system.md). A store
 * overrides only the brand tokens; the accessibility and feedback tokens stay WhiteOven's. Every
 * saved theme passes the contrast rules, so an unreadable theme is never published.
 */

export type BrandResult<T, E> =
  { ok: true; value: T } | { ok: false; errors: E[] };

/** The tokens a store may override. */
export const BRAND_COLOR_TOKENS = [
  "primary",
  "primaryHover",
  "primaryPressed",
  "onPrimary",
  "accentText",
] as const;
export type BrandColorToken = (typeof BRAND_COLOR_TOKENS)[number];

/** WhiteOven defaults, equal to `packages/design-tokens/tokens.json` (a test keeps them equal). */
export const DEFAULT_BRAND_COLORS: Record<BrandColorToken, string> = {
  primary: "#FF922B",
  primaryHover: "#E87916",
  primaryPressed: "#E8750C",
  onPrimary: "#252525",
  accentText: "#9C4300",
};

/**
 * Backgrounds the brand is checked against; a store can never change them. The focus ring is not
 * a brand pair: it is drawn with an offset, over these surfaces, in WhiteOven's fixed color.
 */
export const FIXED_COLORS = {
  surface: "#FFFFFF",
  cream: "#FFF8F0",
} as const;
export type FixedColorToken = keyof typeof FIXED_COLORS;

export interface ContrastRule {
  foreground: BrandColorToken | FixedColorToken;
  background: BrandColorToken | FixedColorToken;
  /** WCAG 2.2: 4.5 for normal text (every pair here is text). */
  minimum: number;
  /** What the pair is used for, shown in the panel. */
  usage: string;
}

export const CONTRAST_RULES: readonly ContrastRule[] = [
  {
    foreground: "onPrimary",
    background: "primary",
    minimum: 4.5,
    usage: "Texto dos botões principais",
  },
  {
    foreground: "onPrimary",
    background: "primaryHover",
    minimum: 4.5,
    usage: "Texto dos botões ao passar o cursor",
  },
  {
    foreground: "onPrimary",
    background: "primaryPressed",
    minimum: 4.5,
    usage: "Texto dos botões pressionados",
  },
  {
    foreground: "accentText",
    background: "surface",
    minimum: 4.5,
    usage: "Textos de destaque sobre fundo branco",
  },
  {
    foreground: "accentText",
    background: "cream",
    minimum: 4.5,
    usage: "Textos de destaque sobre fundo creme",
  },
];

/** Smallest longest side of a logo, and smallest side of the square icon, in pixels. */
export const LOGO_MIN_SIDE = 256;
export const ICON_MIN_SIDE = 512;

export const BRAND_ERROR_CODES = [
  "BRAND_THEME_INVALID",
  "BRAND_TOKEN_LOCKED",
  "BRAND_COLOR_INVALID",
  "BRAND_CONTRAST_INSUFFICIENT",
  "BRAND_IMAGE_NOT_FOUND",
  "BRAND_LOGO_TOO_SMALL",
  "BRAND_ICON_NOT_SQUARE",
  "BRAND_ICON_TOO_SMALL",
] as const;
export type BrandErrorCode = (typeof BRAND_ERROR_CODES)[number];

export interface BrandError {
  code: BrandErrorCode;
  /** `colorOverrides.primary`, `logoAssetId`, or `contrast.onPrimary/primary` for a pair. */
  path: string;
  /** Contrast failures only: the measured ratio (rounded down) and the minimum. */
  ratio?: number;
  minimum?: number;
}

export interface BrandThemeInput {
  /** Only the overridden tokens, as `#RRGGBB` in upper case. */
  colorOverrides: Partial<Record<BrandColorToken, string>>;
  logoAssetId: string | null;
  iconAssetId: string | null;
}

const HEX = /^#[0-9a-f]{6}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = ["colorOverrides", "logoAssetId", "iconAssetId"];

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** WCAG relative luminance of `#RRGGBB`. */
export function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two `#RRGGBB` colors, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (light! + 0.05) / (dark! + 0.05);
}

/** The defaults with the overrides on top. */
export function resolveBrandColors(
  overrides: Partial<Record<BrandColorToken, string>>,
): Record<BrandColorToken, string> {
  return { ...DEFAULT_BRAND_COLORS, ...overrides };
}

/** Every contrast rule the colors fail, in rule order. */
export function contrastIssues(
  colors: Record<BrandColorToken, string>,
): BrandError[] {
  const all: Record<string, string> = { ...colors, ...FIXED_COLORS };
  return CONTRAST_RULES.flatMap(({ foreground, background, minimum }) => {
    const ratio = contrastRatio(all[foreground]!, all[background]!);
    return ratio >= minimum
      ? []
      : [
          {
            code: "BRAND_CONTRAST_INSUFFICIENT" as const,
            path: `contrast.${foreground}/${background}`,
            ratio: Math.floor(ratio * 100) / 100,
            minimum,
          },
        ];
  });
}

/**
 * Checks shape, locked tokens and contrast. Image ids are checked here only for shape; whether
 * they exist in the store and have the right size needs the database (StoreService).
 */
export function validateBrandTheme(
  raw: unknown,
): BrandResult<BrandThemeInput, BrandError> {
  const fail = (errors: BrandError[]) => ({ ok: false as const, errors });
  const invalid = (path: string): BrandError => ({
    code: "BRAND_THEME_INVALID",
    path,
  });
  if (!plain(raw)) return fail([invalid("")]);
  const errors: BrandError[] = [
    ...KEYS.filter((key) => !Object.hasOwn(raw, key)),
    ...Object.keys(raw)
      .filter((key) => !KEYS.includes(key))
      .sort(),
  ].map(invalid);
  const { colorOverrides, logoAssetId, iconAssetId } = raw;
  const overrides: Partial<Record<BrandColorToken, string>> = {};
  if (!plain(colorOverrides)) errors.push(invalid("colorOverrides"));
  else
    for (const [token, value] of Object.entries(colorOverrides)) {
      const path = `colorOverrides.${token}`;
      if (!(BRAND_COLOR_TOKENS as readonly string[]).includes(token))
        errors.push({ code: "BRAND_TOKEN_LOCKED", path });
      else if (typeof value !== "string" || !HEX.test(value))
        errors.push({ code: "BRAND_COLOR_INVALID", path });
      else overrides[token as BrandColorToken] = value.toUpperCase();
    }
  for (const [key, value] of [
    ["logoAssetId", logoAssetId],
    ["iconAssetId", iconAssetId],
  ] as const)
    if (
      Object.hasOwn(raw, key) &&
      !(value === null || (typeof value === "string" && UUID.test(value)))
    )
      errors.push(invalid(key));
  if (errors.length) return fail(errors);

  const contrast = contrastIssues(resolveBrandColors(overrides));
  if (contrast.length) return fail(contrast);
  // Keep only real overrides, in token order, so the stored theme is canonical.
  const canonical: Partial<Record<BrandColorToken, string>> = {};
  for (const token of BRAND_COLOR_TOKENS)
    if (overrides[token] && overrides[token] !== DEFAULT_BRAND_COLORS[token])
      canonical[token] = overrides[token];
  return {
    ok: true,
    value: {
      colorOverrides: canonical,
      logoAssetId: (logoAssetId as string | null)?.toLowerCase() ?? null,
      iconAssetId: (iconAssetId as string | null)?.toLowerCase() ?? null,
    },
  };
}
