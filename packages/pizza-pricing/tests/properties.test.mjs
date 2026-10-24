/**
 * Property tests over seeded random configurations (no extra dependency): determinism,
 * idempotence, equivalence, side symmetry, HALVES bounds and "normalization never costs more".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePizza, calculatePizzaPrice } from "@whiteoven/pizza-pricing";
import { catalog, policy } from "./fixtures.mjs";

const RUNS = 2000;

/** mulberry32: small deterministic PRNG so failures are reproducible from the seed. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (next, list) => list[Math.floor(next() * list.length)];
const shuffle = (next, list) => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const flavors = ["calabresa", "margherita", "portuguesa", "quatro-queijos"];
const extras = ["bacon", "azeitona", "milho"];
const removable = {
  calabresa: ["cebola"],
  margherita: ["tomate", "manjericao"],
  portuguesa: ["ovo", "cebola", "ervilha"],
  "quatro-queijos": [],
};
const policies = [
  policy(),
  policy({ halfAndHalfStrategy: "AVERAGE" }),
  policy({ halfAndHalfSurchargeCents: 300 }),
  policy({ halfAndHalfStrategy: "AVERAGE", halfAndHalfSurchargeCents: 199 }),
];

/** Valid-by-construction input (stages 1–3), not yet normalized; limits may still fail. */
function generate(next) {
  const mode = next() < 0.75 ? "HALVES" : "WHOLE";
  const left = pick(next, flavors);
  const right = next() < 0.3 ? left : pick(next, flavors);
  const placements = mode === "HALVES" ? ["WHOLE", "LEFT", "RIGHT"] : ["WHOLE"];
  const chosenExtras = [];
  for (const extraId of extras) {
    const roll = next();
    if (roll < 0.4) continue;
    if (mode === "HALVES" && roll > 0.85) {
      chosenExtras.push(
        { extraId, placement: "LEFT" },
        { extraId, placement: "RIGHT" },
      );
    } else chosenExtras.push({ extraId, placement: pick(next, placements) });
  }
  const removals = [];
  const sides =
    mode === "HALVES"
      ? [
          ["LEFT", left],
          ["RIGHT", right],
        ]
      : [["WHOLE", left]];
  for (const [placement, flavorId] of sides)
    for (const ingredientId of removable[flavorId])
      if (next() < 0.4) removals.push({ ingredientId, placement });
  return {
    sizeId: "grande",
    mode,
    flavors: mode === "HALVES" ? { LEFT: left, RIGHT: right } : { LEFT: left },
    crustId: pick(next, [null, "catupiry", "tradicional"]),
    extras: shuffle(next, chosenExtras),
    removals: shuffle(next, removals),
    quantity: 1 + Math.floor(next() * 20),
  };
}

const mirror = (input) => {
  const swap = (placement) =>
    ({ WHOLE: "WHOLE", LEFT: "RIGHT", RIGHT: "LEFT" })[placement];
  return {
    ...input,
    flavors:
      input.mode === "HALVES"
        ? { LEFT: input.flavors.RIGHT, RIGHT: input.flavors.LEFT }
        : input.flavors,
    extras: input.extras.map((entry) => ({
      ...entry,
      placement: swap(entry.placement),
    })),
    removals: input.removals.map((entry) => ({
      ...entry,
      placement: swap(entry.placement),
    })),
  };
};

function* cases() {
  for (let seed = 1; seed <= RUNS; seed += 1) {
    const next = random(seed);
    yield {
      seed,
      input: generate(next),
      pricingPolicy: pick(next, policies),
      next,
    };
  }
}

test("generated inputs are valid and exercise both normalizations", () => {
  let priced = 0;
  let collapsed = 0;
  let merged = 0;
  for (const { input, pricingPolicy } of cases()) {
    const result = evaluatePizza(input, catalog, pricingPolicy);
    assert.ok(result.ok || result.stage === 7, JSON.stringify(result));
    if (!result.ok) continue;
    priced += 1;
    if (input.mode === "HALVES" && result.configuration.mode === "WHOLE")
      collapsed += 1;
    if (result.configuration.extras.length < input.extras.length) merged += 1;
  }
  assert.ok(priced > RUNS * 0.9, `priced ${priced}`);
  assert.ok(collapsed > 50, `collapsed ${collapsed}`);
  assert.ok(merged > 100, `merged ${merged}`);
});

test("determinism: the same input yields the same result", () => {
  for (const { seed, input, pricingPolicy } of cases())
    assert.deepEqual(
      evaluatePizza(structuredClone(input), catalog, pricingPolicy),
      evaluatePizza(structuredClone(input), catalog, pricingPolicy),
      `seed ${seed}`,
    );
});

test("idempotence: evaluating the normalized output returns it unchanged", () => {
  for (const { seed, input, pricingPolicy } of cases()) {
    const first = evaluatePizza(input, catalog, pricingPolicy);
    if (!first.ok) continue;
    assert.deepEqual(
      evaluatePizza(first.configuration, catalog, pricingPolicy),
      first,
      `seed ${seed}`,
    );
  }
});

test("equivalence: order of extras and removals, and LEFT+RIGHT versus WHOLE, do not matter", () => {
  for (const { seed, input, pricingPolicy, next } of cases()) {
    const first = evaluatePizza(input, catalog, pricingPolicy);
    const reordered = {
      ...input,
      extras: shuffle(next, input.extras),
      removals: shuffle(next, input.removals),
    };
    assert.deepEqual(
      evaluatePizza(reordered, catalog, pricingPolicy),
      first,
      `seed ${seed} order`,
    );
    if (input.mode !== "HALVES") continue;
    const split = {
      ...input,
      extras: input.extras.flatMap((entry) =>
        entry.placement === "WHOLE"
          ? [
              { ...entry, placement: "LEFT" },
              { ...entry, placement: "RIGHT" },
            ]
          : [entry],
      ),
    };
    assert.deepEqual(
      evaluatePizza(split, catalog, pricingPolicy),
      first,
      `seed ${seed} split`,
    );
  }
});

test("symmetry: mirroring the sides keeps the price and validity", () => {
  for (const { seed, input, pricingPolicy } of cases()) {
    const original = evaluatePizza(input, catalog, pricingPolicy);
    const mirrored = evaluatePizza(mirror(input), catalog, pricingPolicy);
    assert.equal(mirrored.ok, original.ok, `seed ${seed}`);
    if (original.ok)
      assert.equal(
        mirrored.price.totalCents,
        original.price.totalCents,
        `seed ${seed}`,
      );
  }
});

test("bounds: a plain HALVES pizza without surcharge costs between its cheapest and dearest flavor", () => {
  for (const left of flavors)
    for (const right of flavors)
      for (const halfAndHalfStrategy of ["HIGHEST", "AVERAGE"]) {
        const input = {
          sizeId: "grande",
          mode: "HALVES",
          flavors: { LEFT: left, RIGHT: right },
          crustId: null,
          extras: [],
          removals: [],
          quantity: 1,
        };
        const { price } = evaluatePizza(
          input,
          catalog,
          policy({ halfAndHalfStrategy }),
        );
        const prices = [
          price.flavorPrices.LEFT,
          price.flavorPrices.RIGHT ?? price.flavorPrices.LEFT,
        ];
        assert.ok(
          price.totalCents >= Math.min(...prices) &&
            price.totalCents <= Math.max(...prices),
          `${left}/${right} ${halfAndHalfStrategy}`,
        );
      }
});

test("normalization never increases the total", () => {
  for (const { seed, input, pricingPolicy } of cases()) {
    const result = evaluatePizza(input, catalog, pricingPolicy);
    if (!result.ok) continue;
    const unnormalized = calculatePizzaPrice(input, catalog, pricingPolicy);
    assert.ok(
      result.price.totalCents <= unnormalized.totalCents,
      `seed ${seed}`,
    );
  }
});

test("money stays in integer cents", () => {
  for (const { input, pricingPolicy } of cases()) {
    const result = evaluatePizza(input, catalog, pricingPolicy);
    if (!result.ok) continue;
    for (const value of [
      result.price.baseCents,
      result.price.unitPriceCents,
      result.price.totalCents,
    ])
      assert.ok(Number.isSafeInteger(value) && value > 0);
  }
});
