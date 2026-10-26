import { createContext, useContext } from "react";
import {
  type BrandColors,
  DEFAULT_BRAND_COLORS,
  FIXED_COLORS,
} from "./colors.ts";

export interface AppTheme {
  colors: BrandColors & typeof FIXED_COLORS;
  spacing: (step: 1 | 2 | 3 | 4 | 5 | 6) => number;
  radius: { small: number; card: number; pill: number };
}

const SPACING = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 } as const;

/** The store's brand over the fixed WhiteOven tokens (design-system.md). */
export function themeFor(colors: BrandColors): AppTheme {
  return {
    colors: { ...FIXED_COLORS, ...colors },
    spacing: (step) => SPACING[step],
    radius: { small: 12, card: 24, pill: 999 },
  };
}

const ThemeContext = createContext<AppTheme>(themeFor(DEFAULT_BRAND_COLORS));
export const ThemeProvider = ThemeContext.Provider;
export const useTheme = () => useContext(ThemeContext);
