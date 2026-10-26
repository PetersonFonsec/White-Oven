import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BRAND_COLOR_TOKENS,
  DEFAULT_BRAND_COLORS,
  FIXED_COLORS,
  contrastFailures,
  contrastRatio,
  parseBrandColors,
} from "../src/brand/colors.ts";

const tokens = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../packages/design-tokens/tokens.json",
    ),
    "utf8",
  ),
) as { color: Record<string, string> };

describe("brand colors", () => {
  it("copies the WhiteOven tokens exactly", () => {
    for (const token of BRAND_COLOR_TOKENS)
      assert.equal(DEFAULT_BRAND_COLORS[token], tokens.color[token], token);
    for (const [token, color] of Object.entries(FIXED_COLORS))
      assert.equal(color, tokens.color[token], token);
  });

  it("measures contrast with the WCAG formula", () => {
    assert.equal(contrastRatio("#FFFFFF", "#000000"), 21);
    assert.equal(contrastRatio("#777777", "#777777"), 1);
    assert.ok(Math.abs(contrastRatio("#252525", "#FF922B") - 6.86) < 0.01);
    assert.deepEqual(contrastFailures(DEFAULT_BRAND_COLORS), []);
    assert.deepEqual(
      contrastFailures({ ...DEFAULT_BRAND_COLORS, accentText: "#FFB000" }),
      ["accentText/surface", "accentText/cream"],
    );
  });

  it("accepts only the five brand tokens as #RRGGBB colors that pass contrast", () => {
    assert.deepEqual(
      parseBrandColors(DEFAULT_BRAND_COLORS),
      DEFAULT_BRAND_COLORS,
    );
    assert.deepEqual(parseBrandColors({}, true), DEFAULT_BRAND_COLORS);
    assert.equal(parseBrandColors({}), null);
    assert.deepEqual(
      parseBrandColors({ primary: "#ff922b" }, true),
      DEFAULT_BRAND_COLORS,
    );
    for (const broken of [
      null,
      [],
      "#FF922B",
      { ...DEFAULT_BRAND_COLORS, primary: "#FF922" },
      { ...DEFAULT_BRAND_COLORS, primary: "orange" },
      { ...DEFAULT_BRAND_COLORS, focus: "#000000" },
      { ...DEFAULT_BRAND_COLORS, onPrimary: "#FFFFFF" },
    ])
      assert.equal(parseBrandColors(broken), null, JSON.stringify(broken));
  });
});
