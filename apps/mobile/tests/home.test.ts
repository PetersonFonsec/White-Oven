import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { categoryIcon, featuredPizzas } from "../src/menu/home.ts";
import type { MenuSection } from "../src/menu/menu.ts";

const pizza = (id: string, imageId: string | null) => ({
  kind: "PIZZA" as const,
  id,
  name: id,
  description: null,
  imageId,
  fromCents: 4990,
});
const product = (id: string) => ({
  kind: "PRODUCT" as const,
  id,
  name: id,
  imageId: null,
  priceCents: 990,
});

describe("home", () => {
  it("features pizzas with a photo first, in menu order", () => {
    const sections: MenuSection[] = [
      {
        id: "a",
        name: "Tradicionais",
        items: [pizza("a1", null), pizza("a2", "img")],
      },
      { id: "b", name: "Bebidas", items: [product("b1")] },
      {
        id: "c",
        name: "Doces",
        items: [pizza("c1", "img2"), pizza("c2", null)],
      },
    ];
    assert.deepEqual(
      featuredPizzas(sections, 3).map((item) => item.id),
      ["a2", "c1", "a1"],
    );
    assert.deepEqual(featuredPizzas([], 3), []);
  });

  it("gives each category an icon from what it sells", () => {
    const section = (name: string, items: MenuSection["items"]) => ({
      id: name,
      name,
      items,
    });
    assert.equal(
      categoryIcon(section("Doces", [pizza("x", null)])),
      "pizza-outline",
    );
    assert.equal(
      categoryIcon(section("Bebidas", [product("x")])),
      "wine-outline",
    );
    assert.equal(
      categoryIcon(section("Águas e sucos", [product("x")])),
      "wine-outline",
    );
    assert.equal(
      categoryIcon(section("Sobremesas", [product("x")])),
      "ice-cream-outline",
    );
    assert.equal(
      categoryIcon(section("Combos", [product("x")])),
      "fast-food-outline",
    );
    assert.equal(
      categoryIcon(section("Outros", [product("x")])),
      "restaurant-outline",
    );
  });
});
