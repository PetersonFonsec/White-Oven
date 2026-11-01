import { createContext, useContext } from "react";
import {
  type BrandColors,
  DEFAULT_BRAND_COLORS,
  FIXED_COLORS,
} from "./colors.ts";

export interface AppTheme {
  colors: BrandColors &
    typeof FIXED_COLORS & {
      primaryLight: string;
      accent: string;
      surfaceSecondary: string;
      background: string;
      textPrimary: string;
      textSecondary: string;
      textMuted: string;
      warning: string;
      /** Placeholder text: `textMuted` fails 4.5:1, so placeholders use the secondary text. */
      placeholder: string;
    };
  /** One soft shadow for raised cards and bars (tokens.json `shadow.card`). */
  shadow: {
    shadowColor: string;
    shadowOpacity: number;
    shadowOffset: { width: number; height: number };
    shadowRadius: number;
    elevation: number;
  };
  spacing: (step: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8) => number;
  radius: {
    small: number;
    medium: number;
    large: number;
    card: number;
    xl: number;
    pill: number;
  };
  typography: {
    display: { fontSize: number; lineHeight: number; fontWeight: "800" };
    h1: { fontSize: number; lineHeight: number; fontWeight: "700" };
    h2: { fontSize: number; lineHeight: number; fontWeight: "700" };
    h3: { fontSize: number; lineHeight: number; fontWeight: "700" };
    title: { fontSize: number; lineHeight: number; fontWeight: "600" };
    body: { fontSize: number; lineHeight: number; fontWeight: "400" };
    bodySmall: { fontSize: number; lineHeight: number; fontWeight: "400" };
    caption: { fontSize: number; lineHeight: number; fontWeight: "500" };
    button: { fontSize: number; lineHeight: number; fontWeight: "700" };
    price: { fontSize: number; lineHeight: number; fontWeight: "700" };
  };
}

const SPACING = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
  8: 64,
} as const;

const TYPOGRAPHY = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: "800" },
  h1: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  h2: { fontSize: 24, lineHeight: 30, fontWeight: "700" },
  h3: { fontSize: 20, lineHeight: 26, fontWeight: "700" },
  title: { fontSize: 18, lineHeight: 24, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  bodySmall: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" },
  button: { fontSize: 16, lineHeight: 20, fontWeight: "700" },
  price: { fontSize: 20, lineHeight: 26, fontWeight: "700" },
} as const;

/** The store's brand over the fixed WhiteOven tokens (design-system.md). */
export function themeFor(colors: BrandColors): AppTheme {
  const fixed = { ...FIXED_COLORS, ...colors };
  return {
    colors: {
      ...fixed,
      primaryLight: fixed.orangeSoft,
      accent: fixed.primaryHover,
      surfaceSecondary: fixed.surfaceSecondary,
      background: fixed.cream,
      textPrimary: fixed.text,
      textSecondary: fixed.muted,
      textMuted: fixed.textMuted,
      warning: fixed.warning,
      placeholder: fixed.muted,
    },
    shadow: {
      shadowColor: "#252525",
      shadowOpacity: 0.07,
      shadowOffset: { width: 0, height: 8 },
      shadowRadius: 14,
      elevation: 3,
    },
    spacing: (step) => SPACING[step],
    radius: { small: 8, medium: 12, large: 16, card: 16, xl: 24, pill: 999 },
    typography: TYPOGRAPHY,
  };
}

const ThemeContext = createContext<AppTheme>(themeFor(DEFAULT_BRAND_COLORS));
export const ThemeProvider = ThemeContext.Provider;
export const useTheme = () => useContext(ThemeContext);
