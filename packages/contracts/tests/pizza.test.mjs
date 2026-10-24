import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validatePizzaConfiguration,
  validatePricingPolicy,
  validatePizzaCatalog,
  PIZZA_QUANTITY_MAX,
  PIZZA_LIST_MAX_LENGTH,
} from "@whiteoven/contracts";

const halves = () => ({
  sizeId: "grande",
  mode: "HALVES",
  flavors: { LEFT: "calabresa", RIGHT: "margherita" },
  crustId: "catupiry",
  extras: [{ extraId: "bacon", placement: "LEFT" }],
  removals: [{ ingredientId: "cebola", placement: "LEFT" }],
  quantity: 2,
});
const whole = () => ({
  sizeId: "grande",
  mode: "WHOLE",
  flavors: { LEFT: "calabresa" },
  crustId: null,
  extras: [],
  removals: [],
  quantity: 1,
});
const paths = (result) => {
  assert.equal(result.ok, false);
  return result.errors.map((error) => error.path);
};

test("accepts well-formed whole and half-and-half configurations as fresh copies", () => {
  for (const input of [whole(), halves()]) {
    const result = validatePizzaConfiguration(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, input);
    assert.notEqual(result.value.extras, input.extras);
    assert.notEqual(result.value.flavors, input.flavors);
  }
});

test("structure errors all use PIZZA_INVALID_STRUCTURE", () => {
  const result = validatePizzaConfiguration({ ...whole(), quantity: 0 });
  assert.deepEqual(result, {
    ok: false,
    errors: [{ code: "PIZZA_INVALID_STRUCTURE", path: "quantity" }],
  });
});

test("rejects non-objects, arrays and class instances", () => {
  for (const raw of [null, undefined, "pizza", 1, [], new Date(), new Map()])
    assert.deepEqual(paths(validatePizzaConfiguration(raw)), [""]);
});

test("rejects unknown fields at every level, including prices sent by the client", () => {
  assert.deepEqual(
    paths(validatePizzaConfiguration({ ...whole(), priceCents: 1 })),
    ["priceCents"],
  );
  assert.deepEqual(
    paths(
      validatePizzaConfiguration({
        ...halves(),
        extras: [{ extraId: "bacon", placement: "LEFT", priceCents: 0 }],
        removals: [{ ingredientId: "cebola", placement: "LEFT", note: "x" }],
      }),
    ),
    ["extras[0].priceCents", "removals[0].note"],
  );
  assert.deepEqual(
    paths(
      validatePizzaConfiguration({
        ...whole(),
        flavors: { LEFT: "calabresa", MIDDLE: "x" },
      }),
    ),
    ["flavors.MIDDLE"],
  );
});

test("reports every missing field in field order", () => {
  assert.deepEqual(paths(validatePizzaConfiguration({})), [
    "sizeId",
    "mode",
    "flavors",
    "crustId",
    "extras",
    "removals",
    "quantity",
  ]);
});

test("flavors must match the mode: WHOLE has only LEFT, HALVES needs both", () => {
  assert.deepEqual(
    paths(
      validatePizzaConfiguration({
        ...whole(),
        flavors: { LEFT: "calabresa", RIGHT: "margherita" },
      }),
    ),
    ["flavors.RIGHT"],
  );
  assert.deepEqual(
    paths(validatePizzaConfiguration({ ...halves(), flavors: { LEFT: "a" } })),
    ["flavors.RIGHT"],
  );
  assert.deepEqual(
    paths(validatePizzaConfiguration({ ...halves(), flavors: { RIGHT: "a" } })),
    ["flavors.LEFT"],
  );
  assert.deepEqual(
    paths(validatePizzaConfiguration({ ...halves(), flavors: ["a", "b"] })),
    ["flavors"],
  );
});

test("an invalid mode is reported without guessing which flavor shape was meant", () => {
  assert.deepEqual(
    paths(validatePizzaConfiguration({ ...halves(), mode: "THIRDS" })),
    ["mode"],
  );
  assert.deepEqual(
    paths(validatePizzaConfiguration({ ...whole(), mode: "whole" })),
    ["mode"],
  );
});

test("identifiers must be non-empty strings without control characters or spaces", () => {
  for (const sizeId of ["", " ", "a b", "x".repeat(65), "a\u0000", 1, null])
    assert.deepEqual(
      paths(validatePizzaConfiguration({ ...whole(), sizeId })),
      ["sizeId"],
    );
  assert.deepEqual(
    paths(validatePizzaConfiguration({ ...whole(), crustId: "" })),
    ["crustId"],
  );
});

test("crust is nullable but required", () => {
  const rest = whole();
  delete rest.crustId;
  assert.deepEqual(paths(validatePizzaConfiguration(rest)), ["crustId"]);
});

test("placements must be WHOLE, LEFT or RIGHT; mode rules belong to the pricing pipeline", () => {
  assert.deepEqual(
    paths(
      validatePizzaConfiguration({
        ...halves(),
        extras: [
          { extraId: "bacon", placement: "TOP" },
          { extraId: "bacon" },
          "bacon",
        ],
      }),
    ),
    ["extras[0].placement", "extras[1].placement", "extras[2]"],
  );
  // PB-08 (LEFT in WHOLE mode) is a stage 3 rule, so the shape is accepted here.
  assert.equal(
    validatePizzaConfiguration({
      ...whole(),
      extras: [{ extraId: "bacon", placement: "LEFT" }],
    }).ok,
    true,
  );
});

test("quantity must be an integer from 1 to 20 (PB-14)", () => {
  for (const quantity of [0, -1, 1.5, PIZZA_QUANTITY_MAX + 1, "2", NaN, null])
    assert.deepEqual(
      paths(validatePizzaConfiguration({ ...whole(), quantity })),
      ["quantity"],
    );
  assert.equal(
    validatePizzaConfiguration({ ...whole(), quantity: PIZZA_QUANTITY_MAX }).ok,
    true,
  );
});

test("lists are bounded so untrusted input cannot grow without limit", () => {
  const extras = Array.from({ length: PIZZA_LIST_MAX_LENGTH + 1 }, () => ({
    extraId: "bacon",
    placement: "WHOLE",
  }));
  assert.deepEqual(paths(validatePizzaConfiguration({ ...whole(), extras })), [
    "extras",
  ]);
});

test("duplicates are not a structural error: the pipeline reports them in stage 3", () => {
  const twice = { extraId: "bacon", placement: "LEFT" };
  assert.equal(
    validatePizzaConfiguration({ ...halves(), extras: [twice, twice] }).ok,
    true,
  );
});

test("is deterministic and leaves the input untouched", () => {
  const input = { ...halves(), mode: "X", quantity: 99, extra: true };
  const frozen = structuredClone(input);
  assert.deepEqual(
    validatePizzaConfiguration(input),
    validatePizzaConfiguration(input),
  );
  assert.deepEqual(input, frozen);
});

const policy = () => ({
  halfAndHalfStrategy: "AVERAGE",
  halfAndHalfSurchargeCents: 300,
  maxExtrasPerHalf: 5,
});

test("pricing policy accepts both strategies and has no implicit default (Q-06)", () => {
  for (const halfAndHalfStrategy of ["HIGHEST", "AVERAGE"]) {
    const input = { ...policy(), halfAndHalfStrategy };
    assert.deepEqual(validatePricingPolicy(input), { ok: true, value: input });
  }
  const rest = policy();
  delete rest.halfAndHalfStrategy;
  assert.deepEqual(validatePricingPolicy(rest), {
    ok: false,
    errors: [{ code: "PRICING_POLICY_INVALID", path: "halfAndHalfStrategy" }],
  });
});

test("pricing policy validates ranges and rejects unknown fields", () => {
  const bad = {
    halfAndHalfStrategy: "LOWEST",
    halfAndHalfSurchargeCents: -1,
    maxExtrasPerHalf: 11,
    rounding: "UP",
  };
  assert.deepEqual(
    validatePricingPolicy(bad).errors.map((error) => error.path),
    [
      "rounding",
      "halfAndHalfStrategy",
      "halfAndHalfSurchargeCents",
      "maxExtrasPerHalf",
    ],
  );
  for (const maxExtrasPerHalf of [0, 10])
    assert.equal(
      validatePricingPolicy({ ...policy(), maxExtrasPerHalf }).ok,
      true,
    );
  assert.equal(
    validatePricingPolicy({ ...policy(), halfAndHalfSurchargeCents: 0.5 }).ok,
    false,
  );
});

test("contracts are importable without any server dependency", async () => {
  const pkg = await import("../package.json", { with: { type: "json" } });
  assert.equal(pkg.default.dependencies, undefined);
  assert.equal(typeof validatePizzaCatalog, "function");
});

test("pricing policy reads each field once, so a changing value cannot pass the check and differ in the copy", () => {
  let reads = 0;
  const shifty = policy();
  Object.defineProperty(shifty, "halfAndHalfStrategy", {
    enumerable: true,
    get: () => (reads++ === 0 ? "HIGHEST" : "LOWEST"),
  });
  const result = validatePricingPolicy(shifty);
  assert.equal(reads, 1);
  assert.deepEqual(result, {
    ok: true,
    value: { ...policy(), halfAndHalfStrategy: "HIGHEST" },
  });
});
