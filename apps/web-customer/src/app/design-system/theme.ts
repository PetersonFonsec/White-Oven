import tokens from "@whiteoven/design-tokens";
import { DEFAULT_BRAND_COLORS, type BrandColors } from "@whiteoven/contracts";
/** Scoped to each shell: leaving a store cannot leak its theme into the next one. */
export function themeProperties(
  colors: BrandColors = DEFAULT_BRAND_COLORS,
): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...tokens.color, ...colors }))
    properties[`--wo-${key}`] = value;
  return properties;
}
