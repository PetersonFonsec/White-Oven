/**
 * Brand colors the app wears (ADR 0014, ADR 0020). A store overrides only these tokens; every
 * other color stays WhiteOven's. Pure module: no React Native import, so Node runs its tests.
 */

export const BRAND_COLOR_TOKENS = [
  "primary",
  "primaryHover",
  "primaryPressed",
  "onPrimary",
  "accentText",
] as const;
export type BrandColorToken = (typeof BRAND_COLOR_TOKENS)[number];
export type BrandColors = Record<BrandColorToken, string>;

/** WhiteOven defaults, equal to `packages/design-tokens/tokens.json` (a test keeps them equal). */
export const DEFAULT_BRAND_COLORS: BrandColors = {
  primary: "#FF6B00",
  primaryHover: "#ED5F00",
  primaryPressed: "#E85D00",
  onPrimary: "#1A1512",
  accentText: "#9C4300",
};

/** Colors no store changes, from the same tokens. */
export const FIXED_COLORS = {
  surface: "#FFFFFF",
  cream: "#FFFAF6",
  text: "#241C19",
  muted: "#6F6864",
  textMuted: "#9E9690",
  border: "#EAE2DC",
  inputBorder: "#8B8178",
  focus: "#104987",
  error: "#D93B3B",
  errorSurface: "#FFF1F1",
  /** Error text: `error` reaches only 4.1:1 on `errorSurface`; this one passes 4.5:1 on every surface. */
  errorText: "#B42318",
  success: "#27834A",
  successSurface: "#EAF6EE",
  orangeSoft: "#FFF0E5",
  surfaceSecondary: "#FFF3E9",
  warning: "#E89A17",
} as const;

/** The text pairs the API checks before it saves a theme (ADR 0014), all at 4.5:1. */
export const CONTRAST_PAIRS: readonly [
  BrandColorToken,
  BrandColorToken | "surface" | "cream",
][] = [
  ["onPrimary", "primary"],
  ["onPrimary", "primaryHover"],
  ["onPrimary", "primaryPressed"],
  ["accentText", "surface"],
  ["accentText", "cream"],
];
export const MINIMUM_CONTRAST = 4.5;

/**
 * Fixed text pairs the app draws on its own surfaces (text, secondary text, error and success
 * messages, placeholders). A test keeps every pair at 4.5:1 (WCAG 2.2 AA, normal text).
 */
export const FIXED_TEXT_PAIRS: readonly [
  keyof typeof FIXED_COLORS,
  keyof typeof FIXED_COLORS,
][] = [
  ["text", "surface"],
  ["text", "cream"],
  ["text", "surfaceSecondary"],
  ["muted", "surface"],
  ["muted", "cream"],
  ["muted", "surfaceSecondary"],
  ["errorText", "surface"],
  ["errorText", "cream"],
  ["errorText", "errorSurface"],
  ["success", "surface"],
];

const HEX = /^#[0-9A-F]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.2 contrast ratio of two `#RRGGBB` colors. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** The pairs `colors` fails, as `onPrimary/primary`; empty when every pair passes. */
export function contrastFailures(colors: BrandColors): string[] {
  const all: Record<string, string> = { ...colors, ...FIXED_COLORS };
  return CONTRAST_PAIRS.filter(
    ([foreground, background]) =>
      contrastRatio(all[foreground]!, all[background]!) < MINIMUM_CONTRAST,
  ).map(([foreground, background]) => `${foreground}/${background}`);
}

/**
 * Brand colors from untrusted data (the API, the cache or a manifest): every token present is a
 * `#RRGGBB` color (kept in upper case, as the API saves it), nothing else is accepted, and the result passes contrast. Missing tokens take
 * the WhiteOven defaults when `partial` is set. Null when anything is wrong.
 */
export function parseBrandColors(
  value: unknown,
  partial = false,
): BrandColors | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !BRAND_COLOR_TOKENS.includes(key as BrandColorToken),
    )
  )
    return null;
  const colors = { ...DEFAULT_BRAND_COLORS };
  for (const token of BRAND_COLOR_TOKENS) {
    const color = record[token];
    if (color === undefined && partial) continue;
    if (!isHexColor(color)) return null;
    colors[token] = color.toUpperCase();
  }
  return contrastFailures(colors).length ? null : colors;
}
