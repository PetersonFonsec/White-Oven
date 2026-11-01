import type { HalfSide } from "@whiteoven/contracts";
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
 * Whether "Continuar" may leave a step, and why not. Only what the step itself asks for: prices
 * and every PB rule are still decided by `evaluateBuilder` before the pizza goes to the bag.
 */
export function stepReady(
  step: BuilderStep,
  state: BuilderState,
): string | null {
  if (step === "flavors" && state.mode === "HALVES" && !state.flavors.RIGHT)
    return "Escolha o sabor da metade direita.";
  return null;
}

/** A step can be opened from the stepper once every step before it is ready. */
export function canOpenStep(
  steps: readonly BuilderStep[],
  target: BuilderStep,
  state: BuilderState,
): boolean {
  const at = steps.indexOf(target);
  if (at < 0) return false;
  return steps.slice(0, at).every((step) => stepReady(step, state) === null);
}
