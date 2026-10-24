/**
 * Pizza configuration and pricing policy wire contracts (docs/product/pizza-builder-rules.md).
 * This module checks only the shape (pipeline stage 1); catalog rules live in @whiteoven/pizza-pricing.
 */
import { isCents, isId, join, keyIssues, plain } from "./shape.ts";

export const PIZZA_MODES = ["WHOLE", "HALVES"] as const;
export const HALVES_SIDES = ["LEFT", "RIGHT"] as const;
/** Canonical order: WHOLE first, then LEFT, then RIGHT (pipeline stage 6). */
export const PLACEMENTS = ["WHOLE", "LEFT", "RIGHT"] as const;
export const HALF_AND_HALF_STRATEGIES = ["HIGHEST", "AVERAGE"] as const;

export type PizzaMode = (typeof PIZZA_MODES)[number];
export type HalfSide = (typeof HALVES_SIDES)[number];
export type Placement = (typeof PLACEMENTS)[number];
export type HalfAndHalfStrategy = (typeof HALF_AND_HALF_STRATEGIES)[number];

export const PIZZA_QUANTITY_MIN = 1;
export const PIZZA_QUANTITY_MAX = 20;
/** Upper bound on list sizes accepted from clients; the business limit is maxExtrasPerHalf. */
export const PIZZA_LIST_MAX_LENGTH = 50;
export const MAX_EXTRAS_PER_HALF_LIMIT = 10;

export interface PizzaExtraSelection {
  extraId: string;
  placement: Placement;
}

export interface PizzaRemovalSelection {
  ingredientId: string;
  placement: Placement;
}

/** In WHOLE the single flavor is flavors.LEFT; RIGHT exists only in HALVES. */
export interface PizzaConfiguration {
  sizeId: string;
  mode: PizzaMode;
  flavors: { LEFT: string; RIGHT?: string };
  crustId: string | null;
  extras: PizzaExtraSelection[];
  removals: PizzaRemovalSelection[];
  quantity: number;
}

/**
 * The tenant's PricingPolicy. There is deliberately no default strategy here:
 * Q-06 (default for new pizzerias) is still open, so the tenant always supplies one.
 */
export interface PricingPolicy {
  halfAndHalfStrategy: HalfAndHalfStrategy;
  halfAndHalfSurchargeCents: number;
  maxExtrasPerHalf: number;
}

/** Stable codes the apps map to messages. One code per rule family, in pipeline order. */
export const PIZZA_ERROR_CODES = [
  "PIZZA_INVALID_STRUCTURE",
  "PIZZA_SIZE_UNAVAILABLE",
  "PIZZA_HALVES_NOT_ALLOWED",
  "PIZZA_FLAVOR_UNAVAILABLE",
  "PIZZA_CRUST_UNAVAILABLE",
  "PIZZA_EXTRA_UNAVAILABLE",
  "PIZZA_INGREDIENT_UNKNOWN",
  "PIZZA_EXTRA_PLACEMENT_INVALID",
  "PIZZA_EXTRA_DUPLICATED",
  "PIZZA_REMOVAL_PLACEMENT_INVALID",
  "PIZZA_REMOVAL_INVALID",
  "PIZZA_REMOVAL_DUPLICATED",
  "PIZZA_EXTRA_LIMIT",
] as const;
export type PizzaErrorCode = (typeof PIZZA_ERROR_CODES)[number];

/** `path` points at the offending input field, e.g. `extras[2].placement` or `extras.LEFT` for limits. */
export interface PizzaError {
  code: PizzaErrorCode;
  path: string;
}

export const PRICING_POLICY_ERROR = "PRICING_POLICY_INVALID";
export interface PricingPolicyError {
  code: typeof PRICING_POLICY_ERROR;
  path: string;
}

export type ContractResult<T, E> =
  { ok: true; value: T } | { ok: false; errors: E[] };

const CONFIGURATION_KEYS = [
  "sizeId",
  "mode",
  "flavors",
  "crustId",
  "extras",
  "removals",
  "quantity",
] as const;

/**
 * Pipeline stage 1: types, required and unknown fields, enums, quantity, and the
 * shape of `flavors` for the mode. Returns every structural error, in field order.
 * The returned value is a fresh copy and never shares references with the input.
 */
export function validatePizzaConfiguration(
  raw: unknown,
): ContractResult<PizzaConfiguration, PizzaError> {
  if (!plain(raw)) return structureErrors([""]);
  // Missing fields are reported where they would be (field order); unknown fields last.
  const paths: string[] = [];
  if (!isId(raw.sizeId)) paths.push("sizeId");
  const mode = PIZZA_MODES.includes(raw.mode as PizzaMode)
    ? (raw.mode as PizzaMode)
    : null;
  if (!mode) paths.push("mode");

  if (plain(raw.flavors)) {
    const sides = mode === "WHOLE" ? ["LEFT"] : ["LEFT", "RIGHT"];
    // With an invalid mode only LEFT is required; RIGHT may or may not be present.
    if (mode) paths.push(...keyIssues(raw.flavors, sides, "flavors"));
    else
      paths.push(
        ...keyIssues(raw.flavors, ["LEFT"], "flavors").filter(
          (path) => path !== "flavors.RIGHT",
        ),
      );
    for (const side of HALVES_SIDES)
      if (Object.hasOwn(raw.flavors, side) && !isId(raw.flavors[side]))
        paths.push(`flavors.${side}`);
  } else paths.push("flavors");

  if (
    !Object.hasOwn(raw, "crustId") ||
    (raw.crustId !== null && !isId(raw.crustId))
  )
    paths.push("crustId");

  paths.push(...selectionIssues(raw, "extras", "extraId"));
  paths.push(...selectionIssues(raw, "removals", "ingredientId"));

  if (!(
    Number.isSafeInteger(raw.quantity) &&
    (raw.quantity as number) >= PIZZA_QUANTITY_MIN &&
    (raw.quantity as number) <= PIZZA_QUANTITY_MAX
  ))
    paths.push("quantity");
  paths.push(...keyIssues(raw, CONFIGURATION_KEYS, ""));

  if (paths.length) return structureErrors(paths);

  const flavors = raw.flavors as Record<string, string>;
  const value: PizzaConfiguration = {
    sizeId: raw.sizeId as string,
    mode: mode as PizzaMode,
    flavors:
      mode === "HALVES"
        ? { LEFT: flavors.LEFT, RIGHT: flavors.RIGHT }
        : { LEFT: flavors.LEFT },
    crustId: raw.crustId as string | null,
    extras: (raw.extras as PizzaExtraSelection[]).map((entry) => ({
      extraId: entry.extraId,
      placement: entry.placement,
    })),
    removals: (raw.removals as PizzaRemovalSelection[]).map((entry) => ({
      ingredientId: entry.ingredientId,
      placement: entry.placement,
    })),
    quantity: raw.quantity as number,
  };
  return { ok: true, value };
}

function selectionIssues(
  raw: Record<string, unknown>,
  field: "extras" | "removals",
  idKey: "extraId" | "ingredientId",
): string[] {
  const list = raw[field];
  if (!Array.isArray(list) || list.length > PIZZA_LIST_MAX_LENGTH)
    return [field];
  return list.flatMap((entry, index) => {
    const path = `${field}[${index}]`;
    if (!plain(entry)) return [path];
    const issues = keyIssues(entry, [idKey, "placement"], path);
    if (Object.hasOwn(entry, idKey) && !isId(entry[idKey]))
      issues.push(join(path, idKey));
    if (
      Object.hasOwn(entry, "placement") &&
      !PLACEMENTS.includes(entry.placement as Placement)
    )
      issues.push(join(path, "placement"));
    return issues;
  });
}

const structureErrors = (
  paths: string[],
): { ok: false; errors: PizzaError[] } => ({
  ok: false,
  errors: [...new Set(paths)].map((path) => ({
    code: "PIZZA_INVALID_STRUCTURE",
    path,
  })),
});

const POLICY_KEYS = [
  "halfAndHalfStrategy",
  "halfAndHalfSurchargeCents",
  "maxExtrasPerHalf",
] as const;

export function validatePricingPolicy(
  raw: unknown,
): ContractResult<PricingPolicy, PricingPolicyError> {
  if (!plain(raw))
    return { ok: false, errors: [{ code: PRICING_POLICY_ERROR, path: "" }] };
  const paths = keyIssues(raw, POLICY_KEYS, "");
  if (
    Object.hasOwn(raw, "halfAndHalfStrategy") &&
    !HALF_AND_HALF_STRATEGIES.includes(
      raw.halfAndHalfStrategy as HalfAndHalfStrategy,
    )
  )
    paths.push("halfAndHalfStrategy");
  if (
    Object.hasOwn(raw, "halfAndHalfSurchargeCents") &&
    !isCents(raw.halfAndHalfSurchargeCents)
  )
    paths.push("halfAndHalfSurchargeCents");
  if (
    Object.hasOwn(raw, "maxExtrasPerHalf") &&
    !(
      Number.isSafeInteger(raw.maxExtrasPerHalf) &&
      (raw.maxExtrasPerHalf as number) >= 0 &&
      (raw.maxExtrasPerHalf as number) <= MAX_EXTRAS_PER_HALF_LIMIT
    )
  )
    paths.push("maxExtrasPerHalf");
  if (paths.length)
    return {
      ok: false,
      errors: [...new Set(paths)].map((path) => ({
        code: PRICING_POLICY_ERROR,
        path,
      })),
    };
  return {
    ok: true,
    value: {
      halfAndHalfStrategy: raw.halfAndHalfStrategy as HalfAndHalfStrategy,
      halfAndHalfSurchargeCents: raw.halfAndHalfSurchargeCents as number,
      maxExtrasPerHalf: raw.maxExtrasPerHalf as number,
    },
  };
}
