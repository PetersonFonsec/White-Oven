import tokens from "@whiteoven/design-tokens";

const PX_GROUPS = ["spacing", "radius", "fontSize", "breakpoint"];

/**
 * WhiteOven tokens (packages/design-tokens) as CSS custom properties, with the same names and
 * units the landing derives in BaseLayout.astro: `--wo-color-primary`, `--wo-spacing-4`,
 * `--wo-radius-card`, `--wo-shadow-card`...
 */
export function tokenProperties(): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const [group, values] of Object.entries(tokens))
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "object") continue;
      const unit = PX_GROUPS.includes(group)
        ? "px"
        : group === "interaction"
          ? key === "durationMs"
            ? "ms"
            : "px"
          : "";
      properties[`--wo-${group}-${key}`] = `${value}${unit}`;
    }
  for (const [name, shadow] of Object.entries(tokens.shadow))
    properties[`--wo-shadow-${name}`] =
      `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px rgb(37 37 37 / ${shadow.opacity})`;
  return properties;
}

export function applyDesignTokens(root: HTMLElement): void {
  for (const [name, value] of Object.entries(tokenProperties()))
    root.style.setProperty(name, value);
}
