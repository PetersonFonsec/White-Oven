/** An invalid PricingPolicy must never produce a price, through either public entry point. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePizza,
  calculatePizzaPrice,
  indexCatalog,
  InvalidPricingPolicyError,
} from "@whiteoven/pizza-pricing";
import { catalog, policy, halves, extra } from "./fixtures.mjs";

const input = halves("calabresa", "margherita", {
  extras: [extra("bacon", "LEFT"), extra("azeitona", "LEFT")],
});
const valid = evaluatePizza(input, catalog, policy());
assert.equal(valid.ok, true);

const rejects = (pricingPolicy, paths) => {
  const expected = (error) => {
    assert.ok(error instanceof InvalidPricingPolicyError);
    assert.deepEqual(
      error.errors,
      paths.map((path) => ({ code: "PRICING_POLICY_INVALID", path })),
    );
    return true;
  };
  assert.throws(() => evaluatePizza(input, catalog, pricingPolicy), expected);
  assert.throws(
    () => evaluatePizza(input, indexCatalog(catalog), pricingPolicy),
    expected,
  );
  assert.throws(
    () => calculatePizzaPrice(valid.configuration, catalog, pricingPolicy),
    expected,
  );
};

test("unknown or misspelled half-and-half strategies are rejected", () => {
  for (const halfAndHalfStrategy of [
    "LOWEST",
    "highest",
    "average",
    "",
    null,
    1,
    ["HIGHEST"],
  ])
    rejects(policy({ halfAndHalfStrategy }), ["halfAndHalfStrategy"]);
});

test("a missing strategy is rejected: there is no default while Q-06 is open", () => {
  const pricingPolicy = policy();
  delete pricingPolicy.halfAndHalfStrategy;
  rejects(pricingPolicy, ["halfAndHalfStrategy"]);
});

test("surcharge must be a non-negative integer number of cents", () => {
  for (const halfAndHalfSurchargeCents of [
    -1,
    -5000,
    0.5,
    "300",
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    null,
  ])
    rejects(policy({ halfAndHalfSurchargeCents }), [
      "halfAndHalfSurchargeCents",
    ]);
});

test("maxExtrasPerHalf must be an integer from 0 to 10", () => {
  for (const maxExtrasPerHalf of [-1, 11, 1.5, NaN, "5", null, Infinity])
    rejects(policy({ maxExtrasPerHalf }), ["maxExtrasPerHalf"]);
  for (const maxExtrasPerHalf of [0, 10])
    assert.doesNotThrow(() =>
      evaluatePizza(input, catalog, policy({ maxExtrasPerHalf })),
    );
});

test("non-object policies and unknown fields are rejected", () => {
  for (const pricingPolicy of [null, undefined, "HIGHEST", [], new Map()])
    rejects(pricingPolicy, [""]);
  rejects(policy({ rounding: "DOWN" }), ["rounding"]);
});

test("every invalid field is reported at once", () => {
  rejects(
    {
      halfAndHalfStrategy: "LOWEST",
      halfAndHalfSurchargeCents: -1,
      maxExtrasPerHalf: 11,
    },
    ["halfAndHalfStrategy", "halfAndHalfSurchargeCents", "maxExtrasPerHalf"],
  );
});

test("the policy is checked before the pizza, so a bad policy is never hidden by input errors", () => {
  assert.throws(
    () => evaluatePizza({}, catalog, policy({ halfAndHalfStrategy: "X" })),
    InvalidPricingPolicyError,
  );
});

test("the engine prices with the validated copy, not with later reads of the caller's object", () => {
  let reads = 0;
  const shifty = policy({ halfAndHalfStrategy: "AVERAGE" });
  Object.defineProperty(shifty, "halfAndHalfStrategy", {
    enumerable: true,
    get: () => (reads++ === 0 ? "AVERAGE" : "LOWEST"),
  });
  const result = evaluatePizza(input, catalog, shifty);
  assert.equal(result.ok, true);
  assert.equal(result.price.strategy, "AVERAGE");
  assert.equal(reads, 1);
});

test("the policy object is never mutated", () => {
  const pricingPolicy = policy({ halfAndHalfSurchargeCents: 300 });
  const before = structuredClone(pricingPolicy);
  evaluatePizza(input, catalog, pricingPolicy);
  calculatePizzaPrice(valid.configuration, catalog, pricingPolicy);
  assert.deepEqual(pricingPolicy, before);
});
