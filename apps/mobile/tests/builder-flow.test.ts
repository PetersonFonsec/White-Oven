import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  builderMenu,
  evaluateBuilder,
  setFlavor,
  setMode,
  startBuilder,
  toggleExtra,
} from "../src/builder/builder.ts";
import {
  builderChanged,
  editedSide,
  footerState,
  sideAfterFlavor,
} from "../src/builder/flow.ts";
import { parseMenu } from "../src/menu/menu.ts";
import { apiMenu } from "./menu-fixture.ts";

const builder = builderMenu(parseMenu(apiMenu())!);
const whole = startBuilder(builder, "calabresa")!;
const halves = setMode(whole, "HALVES");

describe("builder flow", () => {
  it("edits the whole pizza as LEFT and a chosen half otherwise", () => {
    assert.equal(editedSide(whole, "RIGHT"), "LEFT");
    assert.equal(editedSide(halves, "RIGHT"), "RIGHT");
  });

  it("moves to the right half once the left flavor is picked and the right is empty", () => {
    assert.equal(sideAfterFlavor(halves, "LEFT"), "RIGHT");
    const both = setFlavor(halves, "RIGHT", "marguerita");
    assert.equal(sideAfterFlavor(both, "LEFT"), "LEFT");
    assert.equal(sideAfterFlavor(whole, "LEFT"), "LEFT");
  });

  it("keeps the footer and says what is missing for a half-and-half without the second flavor", () => {
    const footer = footerState(evaluateBuilder(builder, halves), false);
    assert.equal(footer.ready, false);
    assert.equal(footer.reason, "Escolha o sabor da metade direita.");
    assert.equal(footer.totalCents, null);
  });

  it("enables the footer with the pizza-pricing total, unless adding is blocked", () => {
    const both = setFlavor(halves, "RIGHT", "marguerita");
    const result = evaluateBuilder(builder, both);
    assert.equal(result.kind, "priced");
    const footer = footerState(result, false);
    assert.equal(footer.ready, true);
    assert.equal(footer.reason, null);
    // HIGHEST strategy (5000 vs 4500) plus the 200 surcharge: the price comes from pizza-pricing.
    assert.equal(footer.totalCents, 5200);
    const blocked = footerState(result, true);
    assert.equal(blocked.ready, false);
    assert.match(blocked.reason!, /Aguarde/);
  });

  it("asks before leaving only when something changed", () => {
    assert.equal(builderChanged(whole, whole), false);
    assert.equal(
      builderChanged(whole, toggleExtra(whole, "LEFT", "bacon")),
      true,
    );
    assert.equal(builderChanged(null, whole), false);
  });
});
