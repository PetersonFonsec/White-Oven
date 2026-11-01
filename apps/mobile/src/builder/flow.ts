import type { HalfSide, PizzaErrorCode } from "@whiteoven/contracts";
import { type BuilderResult, type BuilderState } from "./builder.ts";

/**
 * Screen flow of the builder (UX refactor): which half the controls edit, what the footer says
 * and when leaving needs a confirmation. No pricing or PB rule here: those stay in
 * `evaluateBuilder`/`pizza-pricing`. Pure, for tests.
 */

/** The half that flavor, extras and removals edit; a whole pizza only has LEFT. */
export function editedSide(state: BuilderState, active: HalfSide): HalfSide {
  return state.mode === "HALVES" ? active : "LEFT";
}

/**
 * After a flavor is picked on the left half while the right one is still empty, the controls move
 * to the right half: the customer does not have to find the second list.
 */
export function sideAfterFlavor(state: BuilderState, side: HalfSide): HalfSide {
  return state.mode === "HALVES" && side === "LEFT" && !state.flavors.RIGHT
    ? "RIGHT"
    : side;
}

export interface FooterState {
  /** The add button can be pressed. */
  ready: boolean;
  /** Why it cannot, next to the button; null when ready. */
  reason: string | null;
  /** Total in cents when priced. */
  totalCents: number | null;
}

/** The footer is always on screen; when the pizza is not ready it says what is missing. */
export function footerState(
  result: BuilderResult,
  addingBlocked: boolean,
): FooterState {
  if (result.kind === "priced")
    return {
      ready: !addingBlocked,
      reason: addingBlocked
        ? "Aguarde: a sacola está sendo atualizada ou há um pedido pendente."
        : null,
      totalCents: result.price.totalCents,
    };
  return {
    ready: false,
    reason:
      result.kind === "invalid" ? (result.messages[0] ?? null) : result.message,
    totalCents: null,
  };
}

/** Leaving would lose choices the customer made after the builder opened. */
export function builderChanged(
  initial: BuilderState | null,
  current: BuilderState | null,
): boolean {
  if (!initial || !current) return false;
  return JSON.stringify(initial) !== JSON.stringify(current);
}

/** The builder's steps, one screen each. Without crusts on the menu, the crust step is skipped. */
export type BuilderStep = "size" | "flavors" | "crust" | "extras";

export const STEP_LABELS: Record<BuilderStep, string> = {
  size: "Tamanho",
  flavors: "Sabores",
  crust: "Borda",
  extras: "Extras",
};

export function builderSteps(hasCrusts: boolean): BuilderStep[] {
  return hasCrusts
    ? ["size", "flavors", "crust", "extras"]
    : ["size", "flavors", "extras"];
}

/**
 * The domain codes that belong to each step: a failure here means the customer has to change
 * something on that step. The rules themselves stay in `pizza-pricing`; this only says where
 * the fix is. Extras and removals are checked on the last step, by the add button.
 */
const STEP_CODES: Record<BuilderStep, readonly PizzaErrorCode[]> = {
  size: ["PIZZA_SIZE_UNAVAILABLE"],
  flavors: ["PIZZA_HALVES_NOT_ALLOWED", "PIZZA_FLAVOR_UNAVAILABLE"],
  crust: ["PIZZA_CRUST_UNAVAILABLE"],
  extras: [],
};

/**
 * Why a step cannot be left yet, or null. The builder always starts from a flavor priced in its
 * size and every tap keeps it so (`startBuilder`, `setFlavor` from the size's list, `changeSize`),
 * so the states that can really be incomplete are a half-and-half without its second flavor and a
 * menu reloaded while the builder is open (a size, a flavor or a crust no longer sold). Both come
 * from `evaluateBuilder`, so no rule is repeated here.
 */
export function stepReady(
  step: BuilderStep,
  result: BuilderResult,
): string | null {
  if (step === "flavors" && result.kind === "incomplete") return result.message;
  if (result.kind !== "invalid") return null;
  const codes = STEP_CODES[step];
  return (
    result.errors.find((error) => codes.includes(error.code))?.message ?? null
  );
}

/**
 * What still blocks reaching `target`: the first step before it that is not ready, with its
 * reason. Null when every step before it is ready. "Continuar" and the stepper both use it, so
 * a step changed after it was passed (a size tapped again, a menu reload) blocks the way forward
 * from wherever the customer is.
 */
export function blockerBefore(
  steps: readonly BuilderStep[],
  target: BuilderStep,
  result: BuilderResult,
): { step: BuilderStep; message: string } | null {
  const at = steps.indexOf(target);
  if (at < 0) return null;
  for (const step of steps.slice(0, at)) {
    const message = stepReady(step, result);
    if (message) return { step, message };
  }
  return null;
}

/** A step can be opened from the stepper once every step before it is ready. */
export function canOpenStep(
  steps: readonly BuilderStep[],
  target: BuilderStep,
  result: BuilderResult,
): boolean {
  return (
    steps.includes(target) && blockerBefore(steps, target, result) === null
  );
}

/**
 * What a back press does in the builder, the same for the header arrow and Android's button:
 * a later step goes to the one before it, keeping every choice; the first step leaves, asking
 * first when the pizza was changed.
 */
export type BuilderBack =
  | { kind: "step"; step: BuilderStep }
  | { kind: "confirm-leave" }
  | { kind: "leave" };

export function builderBack(
  steps: readonly BuilderStep[],
  step: BuilderStep,
  changed: boolean,
): BuilderBack {
  const at = steps.indexOf(step);
  if (at > 0) return { kind: "step", step: steps[at - 1]! };
  return changed ? { kind: "confirm-leave" } : { kind: "leave" };
}

/**
 * Runs a back press. `confirm` shows the question and calls its argument only when the customer
 * chooses to discard; cancelling leaves the pizza as it was.
 */
export function runBuilderBack(
  back: BuilderBack,
  actions: {
    goTo: (step: BuilderStep) => void;
    leave: () => void;
    confirm: (discard: () => void) => void;
  },
): void {
  if (back.kind === "step") actions.goTo(back.step);
  else if (back.kind === "leave") actions.leave();
  else actions.confirm(actions.leave);
}
