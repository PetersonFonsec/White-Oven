import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRAND_COLOR_TOKENS,
  CONTRAST_RULES,
  DEFAULT_BRAND_COLORS,
  FIXED_COLORS,
  contrastIssues,
  contrastRatio,
  resolveBrandColors,
  validateBrandTheme,
} from "../src/store/brand-rules";

const theme = (colorOverrides: Record<string, unknown> = {}) => ({
  colorOverrides,
  logoAssetId: null,
  iconAssetId: null,
});
const errors = (raw: unknown) => {
  const result = validateBrandTheme(raw);
  return result.ok ? [] : result.errors;
};

test("brand defaults are the design tokens and pass every contrast rule", () => {
  // The compiled test runs from dist/tests/test, the source tree from test.
  const root = [
    join(__dirname, "../../../../.."),
    join(__dirname, "../../.."),
  ].find((dir) => {
    try {
      readFileSync(join(dir, "packages/design-tokens/tokens.json"));
      return true;
    } catch {
      return false;
    }
  })!;
  const tokens = JSON.parse(
    readFileSync(join(root, "packages/design-tokens/tokens.json"), "utf8"),
  ) as { color: Record<string, string> };
  for (const token of BRAND_COLOR_TOKENS)
    assert.equal(DEFAULT_BRAND_COLORS[token], tokens.color[token], token);
  for (const [token, value] of Object.entries(FIXED_COLORS))
    assert.equal(value, tokens.color[token], token);
  assert.deepEqual(contrastIssues(DEFAULT_BRAND_COLORS), []);
});

test("contrast ratio follows WCAG", () => {
  assert.equal(contrastRatio("#000000", "#FFFFFF"), 21);
  assert.equal(contrastRatio("#FFFFFF", "#000000"), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  // #767676 is the classic lightest grey that still reaches 4.5:1 on white.
  assert.ok(contrastRatio("#767676", "#FFFFFF") >= 4.5);
  assert.ok(contrastRatio("#777777", "#FFFFFF") < 4.5);
});

test("a valid theme keeps only real overrides, in upper case and token order", () => {
  const result = validateBrandTheme({
    colorOverrides: {
      onPrimary: "#ffffff",
      primary: "#b3261e",
      primaryHover: "#8c1d18",
      primaryPressed: "#601410",
      accentText: DEFAULT_BRAND_COLORS.accentText,
    },
    logoAssetId: "0B5E9C5A-1111-4222-8333-944455556666",
    iconAssetId: null,
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value, {
    colorOverrides: {
      primary: "#B3261E",
      primaryHover: "#8C1D18",
      primaryPressed: "#601410",
      onPrimary: "#FFFFFF",
    },
    logoAssetId: "0b5e9c5a-1111-4222-8333-944455556666",
    iconAssetId: null,
  });
  assert.deepEqual(Object.keys(result.value.colorOverrides), [
    "primary",
    "primaryHover",
    "primaryPressed",
    "onPrimary",
  ]);
});

test("refuses a theme with insufficient contrast, naming each pair and its ratio", () => {
  // A light yellow primary under the default dark text is fine, but white text on it is not.
  const found = errors(theme({ primary: "#FFE066", onPrimary: "#FFFFFF" }));
  assert.deepEqual(
    found.map((error) => error.path),
    [
      "contrast.onPrimary/primary",
      "contrast.onPrimary/primaryHover",
      "contrast.onPrimary/primaryPressed",
    ],
  );
  for (const error of found) {
    assert.equal(error.code, "BRAND_CONTRAST_INSUFFICIENT");
    assert.equal(error.minimum, 4.5);
    assert.ok(error.ratio! < 4.5);
  }
  assert.equal(
    found[0]!.ratio,
    Math.floor(contrastRatio("#FFE066", "#FFFFFF") * 100) / 100,
  );
  assert.deepEqual(
    errors(theme({ accentText: "#F0A050" })).map((error) => error.path),
    ["contrast.accentText/surface", "contrast.accentText/cream"],
  );
});

test("accessibility and feedback tokens cannot be overridden", () => {
  assert.deepEqual(
    errors(theme({ focus: "#FF0000", error: "#00FF00", surface: "#000000" })),
    [
      { code: "BRAND_TOKEN_LOCKED", path: "colorOverrides.focus" },
      { code: "BRAND_TOKEN_LOCKED", path: "colorOverrides.error" },
      { code: "BRAND_TOKEN_LOCKED", path: "colorOverrides.surface" },
    ],
  );
  for (const rule of CONTRAST_RULES)
    for (const token of [rule.foreground, rule.background])
      assert.ok(
        (BRAND_COLOR_TOKENS as readonly string[]).includes(token) ||
          Object.hasOwn(FIXED_COLORS, token),
        token,
      );
});

test("refuses malformed bodies, colors and image ids", () => {
  assert.deepEqual(errors([]), [{ code: "BRAND_THEME_INVALID", path: "" }]);
  assert.deepEqual(
    errors({
      colorOverrides: { primary: "red", onPrimary: "#FFF", primaryHover: 12 },
      logoAssetId: "logo.png",
      extra: true,
    }),
    [
      { code: "BRAND_THEME_INVALID", path: "iconAssetId" },
      { code: "BRAND_THEME_INVALID", path: "extra" },
      { code: "BRAND_COLOR_INVALID", path: "colorOverrides.primary" },
      { code: "BRAND_COLOR_INVALID", path: "colorOverrides.onPrimary" },
      { code: "BRAND_COLOR_INVALID", path: "colorOverrides.primaryHover" },
      { code: "BRAND_THEME_INVALID", path: "logoAssetId" },
    ],
  );
  assert.deepEqual(
    errors({ colorOverrides: [], logoAssetId: null, iconAssetId: null }),
    [{ code: "BRAND_THEME_INVALID", path: "colorOverrides" }],
  );
});

test("resolved colors are the defaults with the overrides on top", () => {
  assert.deepEqual(resolveBrandColors({ accentText: "#7A3300" }), {
    ...DEFAULT_BRAND_COLORS,
    accentText: "#7A3300",
  });
});
