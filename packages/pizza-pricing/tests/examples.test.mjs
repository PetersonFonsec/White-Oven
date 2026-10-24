/** E1–E8 and N1–N11 from docs/product/pizza-builder-rules.md, one test each. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePizza } from "@whiteoven/pizza-pricing";
import { catalog, policy, whole, halves, extra, removal } from "./fixtures.mjs";

const priced = (input, pricingPolicy) => {
  const result = evaluatePizza(input, catalog, pricingPolicy);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
const failed = (input, pricingPolicy = policy()) => {
  const result = evaluatePizza(input, catalog, pricingPolicy);
  assert.equal(result.ok, false, JSON.stringify(result));
  return result;
};

test("E1: whole Calabresa costs 4.900 under any policy", () => {
  for (const halfAndHalfStrategy of ["HIGHEST", "AVERAGE"])
    for (const halfAndHalfSurchargeCents of [0, 300]) {
      const { price } = priced(
        whole("calabresa"),
        policy({ halfAndHalfStrategy, halfAndHalfSurchargeCents }),
      );
      assert.equal(price.totalCents, 4900);
      assert.equal(price.strategy, null);
      assert.equal(price.surchargeCents, 0);
    }
});

test("E2: Calabresa / Margherita with HIGHEST is max(4.900, 5.200) = 5.200", () => {
  const { price } = priced(halves("calabresa", "margherita"), policy());
  assert.equal(price.strategy, "HIGHEST");
  assert.deepEqual(price.flavorPrices, { LEFT: 4900, RIGHT: 5200 });
  assert.equal(price.baseCents, 5200);
  assert.equal(price.totalCents, 5200);
});

test("E3: Calabresa / Margherita with AVERAGE is (4.900 + 5.200) / 2 = 5.050", () => {
  const { price } = priced(
    halves("calabresa", "margherita"),
    policy({ halfAndHalfStrategy: "AVERAGE" }),
  );
  assert.equal(price.strategy, "AVERAGE");
  assert.equal(price.totalCents, 5050);
});

test("E4: Calabresa / Portuguesa with AVERAGE rounds 5.247,5 up to 5.248", () => {
  const { price } = priced(
    halves("calabresa", "portuguesa"),
    policy({ halfAndHalfStrategy: "AVERAGE" }),
  );
  assert.equal(price.baseCents, 5248);
  assert.equal(price.totalCents, 5248);
});

test("E5: (5.200 + 300 + 1.000 + 500) × 2 = 14.000", () => {
  const { price } = priced(
    halves("calabresa", "margherita", {
      crustId: "catupiry",
      extras: [extra("bacon", "LEFT")],
      quantity: 2,
    }),
    policy({ halfAndHalfSurchargeCents: 300 }),
  );
  assert.deepEqual(price, {
    strategy: "HIGHEST",
    flavorPrices: { LEFT: 4900, RIGHT: 5200 },
    baseCents: 5200,
    surchargeCents: 300,
    crustCents: 1000,
    extras: [{ extraId: "bacon", placement: "LEFT", priceCents: 500 }],
    extrasCents: 500,
    unitPriceCents: 7000,
    quantity: 2,
    totalCents: 14000,
  });
});

test("E6: Margherita / Margherita is normalized to whole 5.200, without surcharge", () => {
  const { configuration, price } = priced(
    halves("margherita", "margherita"),
    policy({ halfAndHalfSurchargeCents: 300 }),
  );
  assert.equal(configuration.mode, "WHOLE");
  assert.equal(price.surchargeCents, 0);
  assert.equal(price.totalCents, 5200);
});

test("E7: bacon on both halves becomes whole bacon: 6.200 + 800 = 7.000", () => {
  const { configuration, price } = priced(
    halves("calabresa", "quatro-queijos", {
      extras: [extra("bacon", "LEFT"), extra("bacon", "RIGHT")],
    }),
    policy(),
  );
  assert.deepEqual(configuration.extras, [extra("bacon", "WHOLE")]);
  assert.equal(price.extrasCents, 800);
  assert.equal(price.totalCents, 7000);
});

test("E8: swapping the sides of E7 without bacon costs 6.200", () => {
  const swapped = priced(halves("quatro-queijos", "calabresa"), policy());
  const original = priced(halves("calabresa", "quatro-queijos"), policy());
  assert.equal(swapped.price.totalCents, 6200);
  assert.equal(original.price.totalCents, 6200);
  assert.deepEqual(swapped.configuration.flavors, {
    LEFT: "quatro-queijos",
    RIGHT: "calabresa",
  });
});

test("N1: Calabresa on both halves with nothing else becomes whole Calabresa", () => {
  const { configuration, price } = priced(
    halves("calabresa", "calabresa"),
    policy(),
  );
  assert.deepEqual(configuration, whole("calabresa"));
  assert.equal(price.totalCents, 4900);
});

test("N2: Calabresa twice with bacon on LEFT and RIGHT becomes whole + whole bacon (4.900 + 800)", () => {
  const { configuration, price } = priced(
    halves("calabresa", "calabresa", {
      extras: [extra("bacon", "LEFT"), extra("bacon", "RIGHT")],
    }),
    policy(),
  );
  assert.deepEqual(
    configuration,
    whole("calabresa", { extras: [extra("bacon", "WHOLE")] }),
  );
  assert.equal(price.totalCents, 5700);
});

test("N3: Calabresa twice with bacon only on LEFT stays HALVES: 4.900 + 500, no surcharge", () => {
  const { configuration, price } = priced(
    halves("calabresa", "calabresa", { extras: [extra("bacon", "LEFT")] }),
    policy({ halfAndHalfSurchargeCents: 300 }),
  );
  assert.equal(configuration.mode, "HALVES");
  assert.equal(price.surchargeCents, 0);
  assert.equal(price.totalCents, 5400);
});

test("N4: removing onion from both halves becomes whole Calabresa without onion", () => {
  const { configuration, price } = priced(
    halves("calabresa", "calabresa", {
      removals: [removal("cebola", "LEFT"), removal("cebola", "RIGHT")],
    }),
    policy(),
  );
  assert.deepEqual(
    configuration,
    whole("calabresa", { removals: [removal("cebola", "WHOLE")] }),
  );
  assert.equal(price.totalCents, 4900);
});

test("N5: removing onion only on LEFT stays HALVES at 4.900", () => {
  const { configuration, price } = priced(
    halves("calabresa", "calabresa", {
      removals: [removal("cebola", "LEFT")],
    }),
    policy({ halfAndHalfSurchargeCents: 300 }),
  );
  assert.equal(configuration.mode, "HALVES");
  assert.deepEqual(configuration.removals, [removal("cebola", "LEFT")]);
  assert.equal(price.totalCents, 4900);
});

test("N6: bacon LEFT sent twice is PIZZA_EXTRA_DUPLICATED in stage 3", () => {
  assert.deepEqual(
    failed(
      halves("calabresa", "margherita", {
        extras: [extra("bacon", "LEFT"), extra("bacon", "LEFT")],
      }),
    ),
    {
      ok: false,
      stage: 3,
      errors: [{ code: "PIZZA_EXTRA_DUPLICATED", path: "extras[1]" }],
    },
  );
});

test("N7: bacon WHOLE and bacon LEFT is PIZZA_EXTRA_DUPLICATED in stage 3, in either order", () => {
  for (const extras of [
    [extra("bacon", "WHOLE"), extra("bacon", "LEFT")],
    [extra("bacon", "LEFT"), extra("bacon", "WHOLE")],
  ])
    assert.deepEqual(failed(halves("calabresa", "margherita", { extras })), {
      ok: false,
      stage: 3,
      errors: [{ code: "PIZZA_EXTRA_DUPLICATED", path: "extras[1]" }],
    });
});

test("N8: whole Calabresa with bacon LEFT is a placement error in stage 3 (PB-08)", () => {
  assert.deepEqual(
    failed(whole("calabresa", { extras: [extra("bacon", "LEFT")] })),
    {
      ok: false,
      stage: 3,
      errors: [
        { code: "PIZZA_EXTRA_PLACEMENT_INVALID", path: "extras[0].placement" },
      ],
    },
  );
});

test("N9: with maxExtrasPerHalf 1, bacon LEFT+RIGHT and olive LEFT exceeds LEFT in stage 7", () => {
  assert.deepEqual(
    failed(
      halves("calabresa", "margherita", {
        extras: [
          extra("bacon", "LEFT"),
          extra("bacon", "RIGHT"),
          extra("azeitona", "LEFT"),
        ],
      }),
      policy({ maxExtrasPerHalf: 1 }),
    ),
    {
      ok: false,
      stage: 7,
      errors: [{ code: "PIZZA_EXTRA_LIMIT", path: "extras.LEFT" }],
    },
  );
});

test("N10: archived flavor plus repeated extra reports only the stage 2 flavor error", () => {
  assert.deepEqual(
    failed(
      halves("frango", "margherita", {
        extras: [extra("bacon", "LEFT"), extra("bacon", "LEFT")],
      }),
    ),
    {
      ok: false,
      stage: 2,
      errors: [{ code: "PIZZA_FLAVOR_UNAVAILABLE", path: "flavors.LEFT" }],
    },
  );
});

test("N11: the same pizza with extras in different orders has the same canonical form and price", () => {
  const extras = [
    extra("milho", "RIGHT"),
    extra("bacon", "WHOLE"),
    extra("azeitona", "LEFT"),
    extra("milho", "LEFT"),
  ];
  const removals = [removal("tomate", "RIGHT"), removal("cebola", "LEFT")];
  const results = [
    { extras, removals },
    { extras: [...extras].reverse(), removals: [...removals].reverse() },
    { extras: [extras[2], extras[0], extras[3], extras[1]], removals },
  ].map((parts) => priced(halves("calabresa", "margherita", parts), policy()));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.deepEqual(results[0].configuration.extras, [
    extra("bacon", "WHOLE"),
    extra("milho", "WHOLE"),
    extra("azeitona", "LEFT"),
  ]);
  assert.deepEqual(results[0].configuration.removals, [
    removal("cebola", "LEFT"),
    removal("tomate", "RIGHT"),
  ]);
});
