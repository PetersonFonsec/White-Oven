import type {
  BrandColorToken,
  BrandColors,
  ContrastRule,
  FixedColorToken,
} from "./store-api";

export const BRAND_TOKEN_LABELS: Record<BrandColorToken, string> = {
  primary: "Cor principal",
  primaryHover: "Principal ao passar o cursor",
  primaryPressed: "Principal pressionada",
  onPrimary: "Texto sobre a cor principal",
  accentText: "Texto de destaque",
};

const HEX = /^#[0-9a-f]{6}$/i;

/** `#RRGGBB` in upper case, or null for anything else. */
export function normalizeHex(value: string): string | null {
  const text = value.trim();
  const hex = text.startsWith("#") ? text : `#${text}`;
  return HEX.test(hex) ? hex.toUpperCase() : null;
}

/**
 * WCAG contrast ratio, the standard formula. The rules (pairs and minimums) come from the API,
 * which checks them again before publishing; this only previews them while the owner types.
 */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channel = (offset: number) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

export interface ContrastCheck extends ContrastRule {
  /** Rounded down, as the API reports it. */
  ratio: number;
  ok: boolean;
  /** The API path of a failure: `contrast.onPrimary/primary`. */
  path: string;
}

export function contrastChecks(
  colors: BrandColors,
  fixed: Record<FixedColorToken, string>,
  rules: readonly ContrastRule[],
): ContrastCheck[] {
  const all: Record<string, string> = { ...colors, ...fixed };
  return rules.map((rule) => {
    const ratio = contrastRatio(all[rule.foreground]!, all[rule.background]!);
    return {
      ...rule,
      ratio: Math.floor(ratio * 100) / 100,
      ok: ratio >= rule.minimum,
      path: `contrast.${rule.foreground}/${rule.background}`,
    };
  });
}

/** Ratio for people: "4,52:1". */
export const ratioText = (ratio: number) =>
  `${ratio.toFixed(2).replace(".", ",")}:1`;

/** Messages for the API's brand error codes, shown next to the field. */
export function brandErrorMessage(
  code: string,
  rules: { logoMinSide: number; iconMinSide: number },
): string {
  switch (code) {
    case "BRAND_IMAGE_NOT_FOUND":
      return "Imagem não encontrada nesta loja. Envie de novo.";
    case "BRAND_LOGO_TOO_SMALL":
      return `O logotipo precisa ter ao menos ${rules.logoMinSide} px no lado maior.`;
    case "BRAND_ICON_NOT_SQUARE":
      return "O ícone precisa ser quadrado (largura igual à altura).";
    case "BRAND_ICON_TOO_SMALL":
      return `O ícone precisa ter ao menos ${rules.iconMinSide} × ${rules.iconMinSide} px.`;
    case "BRAND_COLOR_INVALID":
      return "Use uma cor no formato #RRGGBB.";
    case "BRAND_CONTRAST_INSUFFICIENT":
      return "Contraste insuficiente.";
    default:
      return "Confira este campo.";
  }
}
