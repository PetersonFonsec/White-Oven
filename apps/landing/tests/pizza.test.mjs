import assert from "node:assert/strict";
import { test } from "node:test";
import {
  flavors,
  initialSelection,
  selectFlavor,
  selectMode,
  priceInCents,
  describePizza,
  formatPrice,
} from "../src/lib/pizza.ts";

test("every flavor pair charges the greater price, regardless of side", () => {
  for (const left of flavors)
    for (const right of flavors) {
      assert.equal(
        priceInCents({ mode: "halves", left: left.id, right: right.id }),
        Math.max(left.price, right.price),
      );
    }
});
test("a whole pizza uses only its selected flavor price", () => {
  for (const left of flavors) {
    assert.equal(
      priceInCents({ mode: "whole", left: left.id, right: "queijos" }),
      left.price,
    );
  }
});
test("selecting a flavor changes only the requested side without mutating the previous selection", () => {
  const next = selectFlavor(initialSelection, "right", "frango");
  assert.equal(next.left, "calabresa");
  assert.equal(next.right, "frango");
  assert.equal(initialSelection.right, "margherita");
  assert.equal(selectFlavor(next, "left", "queijos").left, "queijos");
});
test("switching to whole and back preserves the second flavor for the visitor", () => {
  const whole = selectMode(initialSelection, "whole");
  assert.equal(priceInCents(whole), 4900);
  assert.equal(whole.right, "margherita");
  const halves = selectMode(whole, "halves");
  assert.deepEqual(halves, initialSelection);
  assert.equal(priceInCents(halves), 5200);
});
test("invalid flavor IDs cannot enter selection or pricing", () => {
  assert.throws(
    () => selectFlavor(initialSelection, "left", "inexistente"),
    /Sabor inválido/,
  );
  assert.throws(
    () => priceInCents({ ...initialSelection, right: "inexistente" }),
    /Sabor inválido/,
  );
});
test("accessible summaries distinguish whole and half pizzas and prices are BRL", () => {
  assert.match(
    describePizza(initialSelection),
    /Metade esquerda: Calabresa.*Metade direita: Margherita/,
  );
  assert.equal(
    describePizza(selectMode(initialSelection, "whole")),
    "Pizza inteira de Calabresa",
  );
  assert.match(formatPrice(6200), /^R\$\s62,00$/u);
});
