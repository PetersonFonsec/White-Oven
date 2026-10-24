/** PB-01 to PB-14 error paths and stage ordering. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePizza,
  calculatePizzaPrice,
  indexCatalog,
} from "@whiteoven/pizza-pricing";
import { catalog, policy, whole, halves, extra, removal } from "./fixtures.mjs";

const evaluate = (input, pricingPolicy = policy()) =>
  evaluatePizza(input, catalog, pricingPolicy);
const failure = (stage, ...errors) => ({
  ok: false,
  stage,
  errors: errors.map(([code, path]) => ({ code, path })),
});

test("stage 1: structure errors stop the pipeline before the catalog is read", () => {
  assert.deepEqual(
    evaluate({ ...whole("frango"), quantity: 21, priceCents: 1 }),
    failure(
      1,
      ["PIZZA_INVALID_STRUCTURE", "quantity"],
      ["PIZZA_INVALID_STRUCTURE", "priceCents"],
    ),
  );
});

test("PB-01: size must exist, be available and not archived", () => {
  for (const sizeId of ["familia", "gigante"])
    assert.deepEqual(
      evaluate(whole("calabresa", { sizeId })),
      failure(2, ["PIZZA_SIZE_UNAVAILABLE", "sizeId"]),
    );
});

test("PB-02: HALVES needs a size with maxFlavors = 2", () => {
  assert.deepEqual(
    evaluate(halves("calabresa", "margherita", { sizeId: "broto" })),
    failure(2, ["PIZZA_HALVES_NOT_ALLOWED", "mode"]),
  );
  assert.equal(evaluate(whole("calabresa", { sizeId: "broto" })).ok, true);
});

test("PB-03: flavors must be offered, in a pizza category and priced for the size", () => {
  assert.deepEqual(
    evaluate(halves("atum", "nao-existe")),
    failure(
      2,
      ["PIZZA_FLAVOR_UNAVAILABLE", "flavors.LEFT"],
      ["PIZZA_FLAVOR_UNAVAILABLE", "flavors.RIGHT"],
    ),
  );
  // No FlavorPrice for the size means unavailable in that size, never free.
  assert.deepEqual(
    evaluate(whole("sem-preco")),
    failure(2, ["PIZZA_FLAVOR_UNAVAILABLE", "flavors.LEFT"]),
  );
  assert.equal(evaluate(whole("sem-preco", { sizeId: "broto" })).ok, true);
  const productCategory = structuredClone(catalog);
  productCategory.flavors[0].categoryId = "bebidas";
  assert.deepEqual(
    evaluatePizza(whole("calabresa"), productCategory, policy()),
    failure(2, ["PIZZA_FLAVOR_UNAVAILABLE", "flavors.LEFT"]),
  );
  const archivedCategory = structuredClone(catalog);
  archivedCategory.categories[0].archived = true;
  assert.equal(
    evaluatePizza(whole("calabresa"), archivedCategory, policy()).ok,
    false,
  );
});

test("stage 2 reports every reference error in field and index order", () => {
  assert.deepEqual(
    evaluate(
      halves("frango", "atum", {
        crustId: "cheddar",
        extras: [
          extra("palmito", "LEFT"),
          extra("bacon", "LEFT"),
          extra("rucula", "RIGHT"),
        ],
        removals: [removal("cebola", "LEFT"), removal("alho", "RIGHT")],
      }),
    ),
    failure(
      2,
      ["PIZZA_FLAVOR_UNAVAILABLE", "flavors.LEFT"],
      ["PIZZA_FLAVOR_UNAVAILABLE", "flavors.RIGHT"],
      ["PIZZA_CRUST_UNAVAILABLE", "crustId"],
      ["PIZZA_EXTRA_UNAVAILABLE", "extras[0].extraId"],
      ["PIZZA_EXTRA_UNAVAILABLE", "extras[2].extraId"],
      ["PIZZA_REMOVAL_INVALID", "removals[1].ingredientId"],
    ),
  );
});

test("PB-07: crust must be offered and priced for the size; a free crust is allowed", () => {
  assert.deepEqual(
    evaluate(whole("calabresa", { crustId: "catupiry", sizeId: "broto" })),
    failure(2, ["PIZZA_CRUST_UNAVAILABLE", "crustId"]),
  );
  const result = evaluate(whole("calabresa", { crustId: "tradicional" }));
  assert.equal(result.ok, true);
  assert.equal(result.price.crustCents, 0);
});

test("PB-08: in HALVES, extras accept WHOLE, LEFT or RIGHT", () => {
  const result = evaluate(
    halves("calabresa", "margherita", {
      extras: [
        extra("bacon", "WHOLE"),
        extra("azeitona", "LEFT"),
        extra("milho", "RIGHT"),
      ],
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.price.extrasCents, 800 + 250 + 150);
});

test("PB-09: an extra needs a price for the size", () => {
  assert.deepEqual(
    evaluate(whole("calabresa", { extras: [extra("rucula", "WHOLE")] })),
    failure(2, ["PIZZA_EXTRA_UNAVAILABLE", "extras[0].extraId"]),
  );
});

test("PB-12: removals must be removable and present in the flavor at that position", () => {
  assert.deepEqual(
    evaluate(
      halves("calabresa", "margherita", {
        removals: [
          removal("mussarela", "LEFT"),
          removal("tomate", "LEFT"),
          removal("tomate", "RIGHT"),
          removal("cebola", "WHOLE"),
        ],
      }),
    ),
    failure(
      3,
      ["PIZZA_REMOVAL_INVALID", "removals[0].ingredientId"],
      ["PIZZA_REMOVAL_INVALID", "removals[1].ingredientId"],
      ["PIZZA_REMOVAL_PLACEMENT_INVALID", "removals[3].placement"],
    ),
  );
  assert.deepEqual(
    evaluate(whole("calabresa", { removals: [removal("cebola", "LEFT")] })),
    failure(3, ["PIZZA_REMOVAL_PLACEMENT_INVALID", "removals[0].placement"]),
  );
  const archivedIngredient = structuredClone(catalog);
  archivedIngredient.ingredients.find(
    (entry) => entry.id === "cebola",
  ).archived = true;
  assert.deepEqual(
    evaluatePizza(
      whole("calabresa", { removals: [removal("cebola", "WHOLE")] }),
      archivedIngredient,
      policy(),
    ),
    failure(3, ["PIZZA_REMOVAL_INVALID", "removals[0].ingredientId"]),
  );
});

test("PB-13: removals are free, unlimited, and rejected when repeated on the same position", () => {
  const free = evaluate(
    halves("portuguesa", "calabresa", {
      removals: [
        removal("ovo", "LEFT"),
        removal("ervilha", "LEFT"),
        removal("cebola", "LEFT"),
        removal("cebola", "RIGHT"),
      ],
    }),
  );
  assert.equal(free.ok, true);
  assert.equal(free.price.totalCents, 5595);
  assert.deepEqual(
    evaluate(
      whole("calabresa", {
        removals: [removal("cebola", "WHOLE"), removal("cebola", "WHOLE")],
      }),
    ),
    failure(3, ["PIZZA_REMOVAL_DUPLICATED", "removals[1]"]),
  );
});

test("stage 3 reports extra errors before removal errors, each in index order", () => {
  assert.deepEqual(
    evaluate(
      halves("calabresa", "margherita", {
        extras: [
          extra("bacon", "LEFT"),
          extra("bacon", "RIGHT"),
          extra("bacon", "WHOLE"),
        ],
        removals: [removal("tomate", "RIGHT"), removal("tomate", "RIGHT")],
      }),
    ),
    failure(
      3,
      ["PIZZA_EXTRA_DUPLICATED", "extras[2]"],
      ["PIZZA_REMOVAL_DUPLICATED", "removals[1]"],
    ),
  );
});

test("PB-11: maxExtrasPerHalf counts half extras plus WHOLE extras on each side", () => {
  const input = halves("calabresa", "margherita", {
    extras: [
      extra("bacon", "WHOLE"),
      extra("azeitona", "LEFT"),
      extra("milho", "RIGHT"),
    ],
  });
  assert.equal(evaluate(input, policy({ maxExtrasPerHalf: 2 })).ok, true);
  assert.deepEqual(
    evaluate(input, policy({ maxExtrasPerHalf: 1 })),
    failure(
      7,
      ["PIZZA_EXTRA_LIMIT", "extras.LEFT"],
      ["PIZZA_EXTRA_LIMIT", "extras.RIGHT"],
    ),
  );
  assert.deepEqual(
    evaluate(
      whole("calabresa", { extras: [extra("bacon", "WHOLE")] }),
      policy({ maxExtrasPerHalf: 0 }),
    ),
    failure(7, ["PIZZA_EXTRA_LIMIT", "extras"]),
  );
});

test("PB-11 after PB-05: a same-flavor pizza normalized to WHOLE is limited as WHOLE", () => {
  const input = halves("calabresa", "calabresa", {
    extras: [
      extra("bacon", "LEFT"),
      extra("bacon", "RIGHT"),
      extra("milho", "LEFT"),
      extra("milho", "RIGHT"),
    ],
  });
  assert.equal(evaluate(input, policy({ maxExtrasPerHalf: 2 })).ok, true);
  assert.deepEqual(
    evaluate(input, policy({ maxExtrasPerHalf: 1 })),
    failure(7, ["PIZZA_EXTRA_LIMIT", "extras"]),
  );
});

test("PB-14: quantity multiplies the unit price", () => {
  const result = evaluate(whole("margherita", { quantity: 20 }));
  assert.equal(result.price.unitPriceCents, 5200);
  assert.equal(result.price.totalCents, 104000);
});

test("surcharge applies only to HALVES with different flavors and is independent of strategy", () => {
  for (const halfAndHalfStrategy of ["HIGHEST", "AVERAGE"]) {
    const pricingPolicy = policy({
      halfAndHalfStrategy,
      halfAndHalfSurchargeCents: 250,
    });
    const different = evaluate(
      halves("calabresa", "margherita"),
      pricingPolicy,
    );
    assert.equal(different.price.surchargeCents, 250);
    const same = evaluate(
      halves("calabresa", "calabresa", { extras: [extra("bacon", "LEFT")] }),
      pricingPolicy,
    );
    assert.equal(same.price.surchargeCents, 0);
    assert.equal(same.price.baseCents, 4900);
  }
});

test("a prebuilt catalog index gives the same result as the raw catalog", () => {
  const input = halves("calabresa", "portuguesa", { crustId: "catupiry" });
  const pricingPolicy = policy({ halfAndHalfStrategy: "AVERAGE" });
  assert.deepEqual(
    evaluatePizza(input, indexCatalog(catalog), pricingPolicy),
    evaluatePizza(input, catalog, pricingPolicy),
  );
});

test("calculatePizzaPrice refuses configurations that skipped validation", () => {
  assert.throws(
    () => calculatePizzaPrice(whole("nao-existe"), catalog, policy()),
    /No price/,
  );
});

test("the input is never mutated", () => {
  const input = halves("calabresa", "calabresa", {
    extras: [extra("bacon", "RIGHT"), extra("bacon", "LEFT")],
    removals: [removal("cebola", "RIGHT"), removal("cebola", "LEFT")],
  });
  const before = structuredClone(input);
  const result = evaluate(input);
  assert.deepEqual(input, before);
  assert.notEqual(result.configuration.extras[0], input.extras[0]);
});
