import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_BOTTOM_GAP,
  badgeText,
  bottomBarPadding,
  plural,
  scrollBottomPadding,
  tabAccessibilityLabel,
} from "../src/components/layout.ts";

const notch = { top: 59, bottom: 34, left: 0, right: 0 };
const se = { top: 20, bottom: 0, left: 0, right: 0 };

describe("safe area layout", () => {
  it("clears the home indicator with the device inset, never a fixed number", () => {
    assert.equal(bottomBarPadding(notch, false), 34);
    // No home indicator (iPhone SE): a small gap only.
    assert.equal(bottomBarPadding(se, false), MIN_BOTTOM_GAP);
    // Above the tab bar the bar owns the indicator.
    assert.equal(bottomBarPadding(notch, true), MIN_BOTTOM_GAP);
  });

  it("lets the last item of a scroll clear the home indicator when nothing is fixed below", () => {
    assert.equal(scrollBottomPadding(notch, false, 32), 66);
    assert.equal(scrollBottomPadding(notch, true, 32), 32);
    assert.equal(scrollBottomPadding(se, false, 32), 32);
  });
});

describe("tab bar", () => {
  it("speaks the tab, its count and its position", () => {
    assert.equal(
      tabAccessibilityLabel("Cardápio", 0, 1, 4),
      "Cardápio, aba 1 de 4",
    );
    assert.equal(
      tabAccessibilityLabel("Sacola", 1, 2, 4),
      "Sacola, 1 item, aba 2 de 4",
    );
    assert.equal(
      tabAccessibilityLabel("Sacola", 3, 2, 4),
      "Sacola, 3 itens, aba 2 de 4",
    );
  });

  it("keeps the badge short and hides it when empty", () => {
    assert.equal(badgeText(0), null);
    assert.equal(badgeText(7), "7");
    assert.equal(badgeText(120), "99+");
  });

  it("writes Portuguese plurals", () => {
    assert.equal(plural(1, "item", "itens"), "1 item");
    assert.equal(plural(2, "item", "itens"), "2 itens");
    assert.equal(plural(0, "item", "itens"), "0 itens");
  });
});
