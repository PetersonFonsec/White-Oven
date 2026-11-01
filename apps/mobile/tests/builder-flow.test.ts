import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type BuilderState,
  builderMenu,
  changeSize,
  evaluateBuilder,
  setCrust,
  setFlavor,
  setMode,
  startBuilder,
  toggleExtra,
} from "../src/builder/builder.ts";
import {
  type BuilderBack,
  type BuilderStep,
  STEP_LABELS,
  blockerBefore,
  builderBack,
  builderChanged,
  builderSteps,
  canOpenStep,
  runBuilderBack,
  editedSide,
  footerState,
  sideAfterFlavor,
  stepReady,
} from "../src/builder/flow.ts";
import { parseMenu } from "../src/menu/menu.ts";
import { apiMenu } from "./menu-fixture.ts";

const builder = builderMenu(parseMenu(apiMenu())!);
const whole = startBuilder(builder, "calabresa")!;
const halves = setMode(whole, "HALVES");

describe("builder flow", () => {
  it("edits the whole pizza as LEFT and a chosen half otherwise", () => {
    assert.equal(editedSide(whole, "RIGHT"), "LEFT");
    assert.equal(editedSide(halves, "RIGHT"), "RIGHT");
  });

  it("moves to the right half once the left flavor is picked and the right is empty", () => {
    assert.equal(sideAfterFlavor(halves, "LEFT"), "RIGHT");
    const both = setFlavor(halves, "RIGHT", "marguerita");
    assert.equal(sideAfterFlavor(both, "LEFT"), "LEFT");
    assert.equal(sideAfterFlavor(whole, "LEFT"), "LEFT");
  });

  it("keeps the footer and says what is missing for a half-and-half without the second flavor", () => {
    const footer = footerState(evaluateBuilder(builder, halves), false);
    assert.equal(footer.ready, false);
    assert.equal(footer.reason, "Escolha o sabor da metade direita.");
    assert.equal(footer.totalCents, null);
  });

  it("enables the footer with the pizza-pricing total, unless adding is blocked", () => {
    const both = setFlavor(halves, "RIGHT", "marguerita");
    const result = evaluateBuilder(builder, both);
    assert.equal(result.kind, "priced");
    const footer = footerState(result, false);
    assert.equal(footer.ready, true);
    assert.equal(footer.reason, null);
    // HIGHEST strategy (5000 vs 4500) plus the 200 surcharge: the price comes from pizza-pricing.
    assert.equal(footer.totalCents, 5200);
    const blocked = footerState(result, true);
    assert.equal(blocked.ready, false);
    assert.match(blocked.reason!, /Aguarde/);
  });

  it("asks before leaving only when something changed", () => {
    assert.equal(builderChanged(whole, whole), false);
    assert.equal(
      builderChanged(whole, toggleExtra(whole, "LEFT", "bacon")),
      true,
    );
    assert.equal(builderChanged(null, whole), false);
  });
});

describe("builder steps", () => {
  const steps = builderSteps(true);
  const ready = (step: BuilderStep, state: BuilderState) =>
    stepReady(step, evaluateBuilder(builder, state));
  const open = (target: BuilderStep, state: BuilderState) =>
    canOpenStep(steps, target, evaluateBuilder(builder, state));
  /** The same menu reloaded while the builder is open, after the pizzeria changed it. */
  const reloaded = (change: (menu: ReturnType<typeof apiMenu>) => void) => {
    const menu = apiMenu();
    change(menu);
    return builderMenu(parseMenu(menu)!);
  };
  const both = setFlavor(halves, "RIGHT", "marguerita");

  it("skips the crust step when the menu has no crusts", () => {
    assert.deepEqual(steps, ["size", "flavors", "crust", "extras"]);
    assert.deepEqual(builderSteps(false), ["size", "flavors", "extras"]);
    assert.equal(STEP_LABELS.extras, "Extras");
  });

  it("lets a whole pizza go on: the builder always starts from a flavor priced in its size", () => {
    assert.equal(whole.flavors.LEFT, "calabresa");
    for (const step of steps) assert.equal(ready(step, whole), null);
    // A flavor without a price in the size never starts a builder.
    assert.equal(
      startBuilder(
        reloaded((menu) => {
          menu.flavorPrices = menu.flavorPrices.filter(
            (price) => price.flavorId !== "calabresa",
          );
        }),
        "calabresa",
      ),
      null,
    );
  });

  it("stops a whole pizza whose flavor is no longer sold, after a menu reload", () => {
    const later = reloaded((menu) => {
      menu.flavorPrices = menu.flavorPrices.filter(
        (price) =>
          !(price.flavorId === "calabresa" && price.sizeId === "grande"),
      );
    });
    const result = evaluateBuilder(later, whole);
    assert.equal(stepReady("size", result), null);
    assert.match(stepReady("flavors", result)!, /não está disponível/);
    assert.equal(canOpenStep(steps, "crust", result), false);
    // Pricing still comes from pizza-pricing: the footer says the same thing.
    assert.equal(footerState(result, false).ready, false);
  });

  it("asks for the right half and goes on once both halves have a flavor", () => {
    assert.match(ready("flavors", halves)!, /metade direita/);
    assert.equal(ready("size", halves), null);
    assert.equal(ready("flavors", both), null);
    // The left flavor moves the controls to the right half, as before.
    assert.equal(sideAfterFlavor(halves, "LEFT"), "RIGHT");
  });

  it("opens a step from the stepper only after the steps before it", () => {
    assert.equal(open("size", halves), true);
    assert.equal(open("flavors", halves), true);
    assert.equal(open("crust", halves), false);
    assert.equal(open("extras", halves), false);
    assert.deepEqual(
      blockerBefore(steps, "extras", evaluateBuilder(builder, halves)),
      { step: "flavors", message: "Escolha o sabor da metade direita." },
    );
    assert.equal(
      canOpenStep(
        builderSteps(false),
        "crust",
        evaluateBuilder(builder, whole),
      ),
      false,
    );
  });

  it("opens every step once the steps before it are complete", () => {
    for (const step of steps) assert.equal(open(step, both), true);
    assert.equal(
      blockerBefore(steps, "extras", evaluateBuilder(builder, both)),
      null,
    );
  });

  it("checks a size change through changeSize and blocks what the new size cannot take", () => {
    // Halves on a one-flavor size would lose the right half: blocked, state untouched.
    const blocked = changeSize(builder, both, "broto");
    assert.equal(blocked.kind, "blocked");
    // A crust the new size does not sell needs confirmation and is then removed.
    const withCrust = setCrust(whole, "catupiry");
    const change = changeSize(builder, withCrust, "broto");
    assert.equal(change.kind, "confirm");
    if (change.kind !== "confirm") return;
    assert.equal(change.state.crustId, null);
    for (const step of steps) assert.equal(ready(step, change.state), null);
    // A size dropped by a menu reload stops the size step itself.
    const later = reloaded((menu) => {
      menu.crustPrices = [];
      menu.sizes = menu.sizes.filter((size) => size.id !== "grande");
      menu.flavorPrices = menu.flavorPrices.filter(
        (price) => price.sizeId !== "grande",
      );
    });
    const result = evaluateBuilder(later, withCrust);
    assert.match(stepReady("size", result)!, /tamanho/i);
    assert.equal(blockerBefore(steps, "flavors", result)?.step, "size");
  });

  it("keeps the crust step from going on with a crust no longer sold", () => {
    const later = reloaded((menu) => {
      menu.crustPrices = [];
    });
    const result = evaluateBuilder(later, setCrust(whole, "catupiry"));
    assert.match(stepReady("crust", result)!, /borda/i);
    assert.equal(canOpenStep(steps, "extras", result), false);
  });
});

describe("builder back", () => {
  it("goes to the step before, keeping the pizza", () => {
    const steps = builderSteps(true);
    assert.deepEqual(builderBack(steps, "extras", true), {
      kind: "step",
      step: "crust",
    });
    assert.deepEqual(builderBack(builderSteps(false), "extras", true), {
      kind: "step",
      step: "flavors",
    });
    assert.deepEqual(builderBack(steps, "flavors", true), {
      kind: "step",
      step: "size",
    });
    // Going back changes only the step: the state is not part of it.
    const both = setFlavor(halves, "RIGHT", "marguerita");
    const before = JSON.stringify(both);
    builderBack(steps, "extras", builderChanged(whole, both));
    assert.equal(JSON.stringify(both), before);
  });

  it("leaves the first step at once when nothing changed, and asks otherwise", () => {
    const steps = builderSteps(true);
    assert.deepEqual(builderBack(steps, "size", builderChanged(whole, whole)), {
      kind: "leave",
    });
    assert.deepEqual(
      builderBack(
        steps,
        "size",
        builderChanged(whole, toggleExtra(whole, "LEFT", "bacon")),
      ),
      { kind: "confirm-leave" },
    );
    // Whole to halves and back to whole is the same pizza; halves alone is a change.
    assert.equal(builderChanged(whole, setMode(halves, "WHOLE")), false);
    assert.deepEqual(
      builderBack(steps, "size", builderChanged(whole, halves)),
      {
        kind: "confirm-leave",
      },
    );
  });

  const run = (back: BuilderBack, answer: "cancel" | "discard") => {
    const calls: string[] = [];
    runBuilderBack(back, {
      goTo: (step) => calls.push(`step:${step}`),
      leave: () => calls.push("leave"),
      confirm: (discard) => {
        calls.push("ask");
        if (answer === "discard") discard();
      },
    });
    return calls;
  };

  it("never leaves a changed pizza without the customer's confirmation", () => {
    assert.deepEqual(run({ kind: "confirm-leave" }, "cancel"), ["ask"]);
    assert.deepEqual(run({ kind: "confirm-leave" }, "discard"), [
      "ask",
      "leave",
    ]);
    assert.deepEqual(run({ kind: "leave" }, "cancel"), ["leave"]);
    assert.deepEqual(run({ kind: "step", step: "size" }, "cancel"), [
      "step:size",
    ]);
  });
});
