import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CartLine } from "../src/cart/cart.ts";
import { cartUnits } from "../src/cart/cart.ts";
import type { MenuSection } from "../src/menu/menu.ts";
import { filterMenu, searchKey } from "../src/menu/search.ts";

const sections: MenuSection[] = [
  {
    id: "pizzas",
    name: "Pizzas",
    items: [
      {
        kind: "PIZZA",
        id: "f1",
        name: "Calabresa",
        description: "Calabresa fatiada e cebola roxa",
        imageId: null,
        fromCents: 4500,
      },
      {
        kind: "PIZZA",
        id: "f2",
        name: "Margherita",
        description: "Tomate, muçarela e manjericão",
        imageId: null,
        fromCents: 4200,
      },
    ],
  },
  {
    id: "drinks",
    name: "Bebidas",
    items: [
      {
        kind: "PRODUCT",
        id: "p1",
        name: "Suco de Açaí",
        imageId: null,
        priceCents: 900,
      },
    ],
  },
];

describe("menu search", () => {
  it("ignores case and accents", () => {
    assert.equal(searchKey("  Açaí "), "acai");
    assert.deepEqual(
      filterMenu(sections, "all", "acai").map((s) => s.items.map((i) => i.id)),
      [["p1"]],
    );
    assert.deepEqual(
      filterMenu(sections, "all", "MUCARELA").map((s) =>
        s.items.map((i) => i.id),
      ),
      [["f2"]],
    );
  });

  it("filters by category and drops empty sections", () => {
    assert.deepEqual(
      filterMenu(sections, "drinks", "").map((s) => s.id),
      ["drinks"],
    );
    assert.deepEqual(filterMenu(sections, "drinks", "calabresa"), []);
    assert.equal(filterMenu(sections, "all", "").length, 2);
  });
});

describe("bag units", () => {
  it("counts units, not lines", () => {
    const lines = [
      { id: "a", kind: "PRODUCT", name: "Suco", productId: "p1", quantity: 3 },
      {
        id: "b",
        kind: "PIZZA",
        name: "Calabresa",
        pizza: { quantity: 2 },
      },
    ] as unknown as CartLine[];
    assert.equal(cartUnits(lines), 5);
    assert.equal(cartUnits([]), 0);
  });
});
