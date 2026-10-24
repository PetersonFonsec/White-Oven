import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePizzaCatalog } from "@whiteoven/contracts";

const catalog = () => ({
  categories: [
    { id: "pizzas", kind: "PIZZA", archived: false },
    { id: "bebidas", kind: "PRODUCT", archived: false },
  ],
  sizes: [
    {
      id: "grande",
      name: "Grande",
      slices: 8,
      maxFlavors: 2,
      available: true,
      archived: false,
    },
  ],
  ingredients: [
    { id: "cebola", name: "Cebola", removable: true, archived: false },
    { id: "mussarela", name: "Mussarela", removable: false, archived: false },
  ],
  flavors: [
    {
      id: "calabresa",
      categoryId: "pizzas",
      name: "Calabresa",
      ingredientIds: ["mussarela", "cebola"],
      available: true,
      archived: false,
    },
  ],
  flavorPrices: [{ flavorId: "calabresa", sizeId: "grande", priceCents: 4900 }],
  crusts: [
    { id: "catupiry", name: "Catupiry", available: true, archived: false },
  ],
  crustPrices: [{ crustId: "catupiry", sizeId: "grande", priceCents: 1000 }],
  extras: [{ id: "bacon", name: "Bacon", available: true, archived: false }],
  extraPrices: [
    {
      extraId: "bacon",
      sizeId: "grande",
      wholePriceCents: 800,
      halfPriceCents: 500,
    },
  ],
});
const paths = (raw) => {
  const result = validatePizzaCatalog(raw);
  assert.equal(result.ok, false);
  for (const error of result.errors)
    assert.equal(error.code, "CATALOG_INVALID");
  return result.errors.map((error) => error.path);
};

test("accepts a consistent catalog and returns a detached copy", () => {
  const input = catalog();
  const result = validatePizzaCatalog(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, input);
  assert.notEqual(result.value.flavors[0], input.flavors[0]);
});

test("rejects missing sections and unknown fields at every level", () => {
  const rest = catalog();
  delete rest.extraPrices;
  assert.deepEqual(paths({ ...rest, coupons: [] }), ["extraPrices", "coupons"]);
  const input = catalog();
  input.sizes[0].priceCents = 100;
  assert.deepEqual(paths(input), ["sizes[0].priceCents"]);
});

test("validates value ranges per field", () => {
  const input = catalog();
  input.sizes[0].maxFlavors = 3;
  input.flavorPrices[0].priceCents = 0;
  input.crustPrices[0].priceCents = -1;
  input.flavors[0].name = "  ";
  input.ingredients[0].removable = "yes";
  input.ingredients[1].archived = "yes";
  assert.deepEqual(paths(input), [
    "sizes[0].maxFlavors",
    "ingredients[0].removable",
    "ingredients[1].archived",
    "flavors[0].name",
    "flavorPrices[0].priceCents",
    "crustPrices[0].priceCents",
  ]);
});

test("a free crust or extra is allowed, a free flavor is not", () => {
  const input = catalog();
  input.crustPrices[0].priceCents = 0;
  input.extraPrices[0] = {
    ...input.extraPrices[0],
    wholePriceCents: 0,
    halfPriceCents: 0,
  };
  assert.equal(validatePizzaCatalog(input).ok, true);
});

test("enforces half ≤ whole ≤ 2 × half on extra prices", () => {
  for (const [wholePriceCents, halfPriceCents, ok] of [
    [800, 500, true],
    [800, 400, true],
    [500, 500, true],
    [800, 399, false],
    [400, 500, false],
  ]) {
    const input = catalog();
    Object.assign(input.extraPrices[0], { wholePriceCents, halfPriceCents });
    assert.equal(
      validatePizzaCatalog(input).ok,
      ok,
      `${wholePriceCents}/${halfPriceCents}`,
    );
  }
});

test("rejects duplicate identifiers and duplicate price pairs", () => {
  const input = catalog();
  input.extras.push({ ...input.extras[0] });
  input.flavorPrices.push({ ...input.flavorPrices[0], priceCents: 1 });
  assert.deepEqual(paths(input), ["extras[1].id", "flavorPrices[1]"]);
});

test("rejects dangling references and flavors outside pizza categories", () => {
  const input = catalog();
  input.flavors[0].categoryId = "bebidas";
  input.flavors[0].ingredientIds.push("tomate");
  input.crustPrices[0].sizeId = "broto";
  input.extraPrices[0].extraId = "cheddar";
  assert.deepEqual(paths(input), [
    "flavors[0].categoryId",
    "flavors[0].ingredientIds[2]",
    "crustPrices[0].sizeId",
    "extraPrices[0].extraId",
  ]);
});

test("rejects repeated ingredients in a flavor", () => {
  const input = catalog();
  input.flavors[0].ingredientIds = ["cebola", "cebola"];
  assert.deepEqual(paths(input), ["flavors[0].ingredientIds"]);
});
