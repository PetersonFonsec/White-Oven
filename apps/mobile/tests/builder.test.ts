import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type BuilderState,
  builderMenu,
  describeOrderLine,
  describePizza,
  evaluateBuilder,
  extraLimitReached,
  previewConfiguration,
  priceLines,
  setCrust,
  setFlavor,
  setMode,
  setQuantity,
  setSize,
  startBuilder,
  toggleExtra,
  toggleRemoval,
} from "../src/builder/builder.ts";
import { parseMenu } from "../src/menu/menu.ts";
import { transitionMs } from "../src/a11y/motion.ts";
import { apiMenu } from "./menu-fixture.ts";

const builder = builderMenu(parseMenu(apiMenu())!);
const start = (flavorId = "calabresa") => startBuilder(builder, flavorId)!;
const priced = (state: BuilderState) => {
  const result = evaluateBuilder(builder, state);
  assert.equal(result.kind, "priced", JSON.stringify(result));
  return result as Extract<typeof result, { kind: "priced" }>;
};
const halves = (left: string, right: string) =>
  setFlavor(setMode(start(left), "HALVES"), "RIGHT", right);

describe("Pizza Builder", () => {
  it("starts a whole pizza on the first size the flavor has", () => {
    assert.deepEqual(start(), {
      sizeId: "grande",
      mode: "WHOLE",
      flavors: { LEFT: "calabresa", RIGHT: null },
      crustId: null,
      extras: { LEFT: [], RIGHT: [] },
      removals: { LEFT: [], RIGHT: [] },
      quantity: 1,
    });
    assert.equal(startBuilder(builder, "nao-existe"), null);
  });

  it("prices a whole pizza with crust, an extra and a removal through pizza-pricing", () => {
    let state = setCrust(start(), "catupiry");
    state = toggleExtra(state, "LEFT", "bacon");
    state = toggleRemoval(state, "LEFT", "cebola");
    state = setQuantity(state, 2);
    const result = priced(state);
    assert.deepEqual(result.configuration, {
      sizeId: "grande",
      mode: "WHOLE",
      flavors: { LEFT: "calabresa" },
      crustId: "catupiry",
      extras: [{ extraId: "bacon", placement: "WHOLE" }],
      removals: [{ ingredientId: "cebola", placement: "WHOLE" }],
      quantity: 2,
    });
    assert.equal(result.price.unitPriceCents, 5000 + 800 + 600);
    assert.equal(result.price.totalCents, 2 * 6400);
    assert.deepEqual(
      describePizza(builder, result.configuration).map((half) => half.text),
      ["Pizza inteira: Calabresa, sem Cebola, com Bacon."],
    );
    assert.equal(
      describeOrderLine(builder, result.configuration),
      "Tamanho Grande (8 fatias), borda Catupiry, 2 unidades",
    );
    assert.deepEqual(priceLines(builder, result), [
      { label: "Pizza", amount: "R$ 50,00" },
      { label: "Borda", amount: "R$ 8,00" },
      { label: "Bacon (pizza inteira)", amount: "R$ 6,00" },
      { label: "2 × R$ 64,00", amount: "R$ 128,00" },
    ]);
  });

  it("describes and prices each half on its own (PB-02, PB-06, PB-08, PB-12)", () => {
    let state = halves("calabresa", "marguerita");
    state = toggleRemoval(state, "LEFT", "cebola");
    state = toggleRemoval(state, "RIGHT", "tomate");
    state = toggleExtra(state, "RIGHT", "cheddar");
    const result = priced(state);
    assert.equal(result.price.strategy, "HIGHEST");
    assert.equal(result.price.baseCents, 5000);
    assert.equal(result.price.surchargeCents, 200);
    assert.deepEqual(result.price.extras, [
      { extraId: "cheddar", placement: "RIGHT", priceCents: 300 },
    ]);
    assert.deepEqual(
      describePizza(builder, result.configuration).map((half) => half.text),
      [
        "Metade esquerda: Calabresa, sem Cebola.",
        "Metade direita: Marguerita, sem Tomate, com Cheddar.",
      ],
    );
    // Swapping the halves changes neither validity nor price (PB-06).
    const swapped = priced(
      toggleExtra(
        toggleRemoval(
          toggleRemoval(halves("marguerita", "calabresa"), "LEFT", "tomate"),
          "RIGHT",
          "cebola",
        ),
        "LEFT",
        "cheddar",
      ),
    );
    assert.equal(swapped.price.totalCents, result.price.totalCents);
  });

  it("charges an extra on both halves once, as a whole extra (PB-10)", () => {
    let state = halves("calabresa", "marguerita");
    state = toggleExtra(toggleExtra(state, "LEFT", "bacon"), "RIGHT", "bacon");
    const result = priced(state);
    assert.deepEqual(result.configuration.extras, [
      { extraId: "bacon", placement: "WHOLE" },
    ]);
    assert.equal(result.price.extrasCents, 600);
    assert.deepEqual(
      describePizza(builder, result.configuration).map((half) => half.details),
      [["com Bacon"], ["com Bacon"]],
    );
  });

  it("turns the same flavor on both halves into a whole pizza without surcharge (PB-05)", () => {
    const same = priced(halves("calabresa", "calabresa"));
    assert.equal(same.configuration.mode, "WHOLE");
    assert.equal(same.price.surchargeCents, 0);
    assert.equal(same.price.totalCents, 5000);
    assert.equal(describePizza(builder, same.configuration).length, 1);

    // With bacon on one half only, it stays two halves.
    const different = priced(
      toggleExtra(halves("calabresa", "calabresa"), "LEFT", "bacon"),
    );
    assert.equal(different.configuration.mode, "HALVES");
    assert.equal(different.price.surchargeCents, 0);
  });

  it("asks for the right flavor before pricing, and describes it as still to choose", () => {
    const state = setMode(start(), "HALVES");
    assert.deepEqual(evaluateBuilder(builder, state), {
      kind: "incomplete",
      message: "Escolha o sabor da metade direita.",
    });
    assert.deepEqual(
      describePizza(builder, previewConfiguration(state)).map((h) => h.text),
      ["Metade esquerda: Calabresa.", "Metade direita: sabor a escolher."],
    );
  });

  it("reports the rules pizza-pricing enforces in Portuguese, naming the half", () => {
    // PB-02: the small size takes one flavor only.
    const small = setSize(builder, halves("calabresa", "marguerita"), "broto");
    const smallResult = evaluateBuilder(builder, small);
    assert.equal(smallResult.kind, "invalid");
    assert.deepEqual(smallResult.kind === "invalid" && smallResult.messages, [
      "O tamanho Broto não pode ser meio a meio.",
      "Marguerita não está disponível no tamanho Broto (metade direita).",
    ]);

    // PB-03: a flavor without a price in the size.
    const unpriced = evaluateBuilder(
      builder,
      setSize(builder, start("marguerita"), "broto"),
    );
    assert.deepEqual(unpriced.kind === "invalid" && unpriced.messages, [
      "Marguerita não está disponível no tamanho Broto.",
    ]);

    // PB-11: two extras per half at most, counting whole extras on each half.
    let state = halves("calabresa", "marguerita");
    for (const extra of ["bacon", "cheddar"])
      state = toggleExtra(state, "LEFT", extra);
    assert.equal(extraLimitReached(builder.menu, state, "LEFT"), true);
    assert.equal(extraLimitReached(builder.menu, state, "RIGHT"), false);
    const over = evaluateBuilder(builder, toggleExtra(state, "LEFT", "milho"));
    assert.deepEqual(over.kind === "invalid" && over.messages, [
      "Escolha no máximo 2 adicionais por metade (metade esquerda).",
    ]);

    // PB-12: only removable ingredients of that half's flavor.
    for (const removal of ["calabresa-fatiada", "tomate"]) {
      const invalid = evaluateBuilder(
        builder,
        toggleRemoval(start(), "LEFT", removal),
      );
      assert.deepEqual(invalid.kind === "invalid" && invalid.messages, [
        "Uma remoção escolhida não vale para este sabor.",
      ]);
    }
  });

  it("does not price pizzas while the store has no pricing policy", () => {
    const withoutPolicy = builderMenu(
      parseMenu({ ...apiMenu(), pricingPolicy: null })!,
    );
    assert.equal(
      evaluateBuilder(withoutPolicy, startBuilder(withoutPolicy, "calabresa")!)
        .kind,
      "unpriced",
    );
  });

  it("keeps choices consistent when the size, mode or a flavor changes", () => {
    let state = setCrust(toggleExtra(start(), "LEFT", "cheddar"), "catupiry");
    state = toggleExtra(state, "LEFT", "bacon");
    // The small size has no catupiry nor cheddar: both leave, bacon stays.
    const small = setSize(builder, state, "broto");
    assert.equal(small.crustId, null);
    assert.deepEqual(small.extras.LEFT, ["bacon"]);

    // Whole to halves: the whole extras cover both halves; the right flavor is still open.
    const split = setMode(toggleRemoval(state, "LEFT", "cebola"), "HALVES");
    assert.deepEqual(split.extras, {
      LEFT: ["cheddar", "bacon"],
      RIGHT: ["cheddar", "bacon"],
    });
    assert.deepEqual(split.removals, { LEFT: ["cebola"], RIGHT: [] });
    assert.equal(split.flavors.RIGHT, null);

    // A new flavor on a half drops the removals taken from the old one.
    const changed = setFlavor(split, "LEFT", "marguerita");
    assert.deepEqual(changed.removals.LEFT, []);
    // Halves to whole keeps the left half.
    const whole = setMode(setFlavor(changed, "RIGHT", "calabresa"), "WHOLE");
    assert.deepEqual(whole.flavors, { LEFT: "marguerita", RIGHT: null });
    assert.deepEqual(whole.extras.RIGHT, []);

    assert.equal(setQuantity(state, 0).quantity, 1);
    assert.equal(setQuantity(state, 99).quantity, 20);
  });

  it("drops animation time when the system asks for reduced motion", () => {
    assert.equal(transitionMs(false), 220);
    assert.equal(transitionMs(true), 0);
    assert.equal(transitionMs(false, 120), 120);
  });
});
