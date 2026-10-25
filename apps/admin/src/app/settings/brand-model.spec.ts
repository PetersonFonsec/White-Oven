import {
  brandErrorMessage,
  contrastChecks,
  contrastRatio,
  normalizeHex,
  ratioText,
} from "./brand-model";
import type { ContrastRule } from "./store-api";

const DEFAULTS = {
  primary: "#FF922B",
  primaryHover: "#E87916",
  primaryPressed: "#E8750C",
  onPrimary: "#252525",
  accentText: "#9C4300",
};
const FIXED = { surface: "#FFFFFF", cream: "#FFF8F0" };
const RULES: ContrastRule[] = [
  {
    foreground: "onPrimary",
    background: "primary",
    minimum: 4.5,
    usage: "Botão",
  },
  {
    foreground: "accentText",
    background: "surface",
    minimum: 4.5,
    usage: "Destaque",
  },
];

describe("brand model", () => {
  it("normalizes hex colors and refuses anything else", () => {
    expect(normalizeHex(" #ff922b ")).toBe("#FF922B");
    expect(normalizeHex("b3261e")).toBe("#B3261E");
    for (const value of ["#FFF", "red", "#GG0000", "", "#FF922B0"])
      expect(normalizeHex(value)).toBeNull();
  });

  it("computes the WCAG ratio", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBe(21);
    expect(contrastRatio("#767676", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeLessThan(4.5);
  });

  it("checks each rule from the API and reports failures with their path", () => {
    expect(
      contrastChecks(DEFAULTS, FIXED, RULES).every((check) => check.ok),
    ).toBe(true);
    const [button, accent] = contrastChecks(
      { ...DEFAULTS, onPrimary: "#FFFFFF" },
      FIXED,
      RULES,
    );
    expect(button).toMatchObject({
      ok: false,
      path: "contrast.onPrimary/primary",
      minimum: 4.5,
    });
    expect(button!.ratio).toBe(
      Math.floor(contrastRatio("#FFFFFF", "#FF922B") * 100) / 100,
    );
    expect(accent!.ok).toBe(true);
  });

  it("writes ratios and API messages for people", () => {
    expect(ratioText(4.5)).toBe("4,50:1");
    const rules = { logoMinSide: 256, iconMinSide: 512 };
    expect(brandErrorMessage("BRAND_ICON_TOO_SMALL", rules)).toContain(
      "512 × 512",
    );
    expect(brandErrorMessage("BRAND_LOGO_TOO_SMALL", rules)).toContain(
      "256 px",
    );
    expect(brandErrorMessage("BRAND_ICON_NOT_SQUARE", rules)).toContain(
      "quadrado",
    );
    expect(brandErrorMessage("OTHER", rules)).toBe("Confira este campo.");
  });
});
