/**
 * Validation, normalization and pricing pipeline from
 * docs/product/pizza-builder-rules.md#pipeline-de-validação-e-normalização.
 * Pure and synchronous: the same function runs in the app, the panel and the API.
 */
import {
  PLACEMENTS,
  validatePizzaConfiguration,
  type CatalogExtraPrice,
  type HalfAndHalfStrategy,
  type HalfSide,
  type PizzaCatalog,
  type PizzaConfiguration,
  type PizzaError,
  type PizzaErrorCode,
  type PizzaExtraSelection,
  type PizzaRemovalSelection,
  type Placement,
  type PricingPolicy,
} from "@whiteoven/contracts";
import { indexCatalog, type CatalogIndex } from "./catalog-index.ts";

/** Stage numbers as in the rules document. Stages 4–6 never fail. */
export const PIPELINE_STAGES = {
  STRUCTURE: 1,
  REFERENCES: 2,
  PLACEMENTS: 3,
  NORMALIZE_EXTRAS: 4,
  NORMALIZE_FLAVORS: 5,
  CANONICAL_ORDER: 6,
  LIMITS: 7,
  PRICE: 8,
} as const;
export type FailingStage = 1 | 2 | 3 | 7;

export interface PricedExtra {
  extraId: string;
  placement: Placement;
  priceCents: number;
}

export interface PizzaPriceBreakdown {
  /** Strategy applied to the base; null when the normalized pizza is WHOLE. */
  strategy: HalfAndHalfStrategy | null;
  flavorPrices: { LEFT: number; RIGHT?: number };
  baseCents: number;
  surchargeCents: number;
  crustCents: number;
  extras: PricedExtra[];
  extrasCents: number;
  unitPriceCents: number;
  quantity: number;
  totalCents: number;
}

export type PizzaEvaluation =
  | {
      ok: true;
      /** Canonical form used by the cart, the order snapshot and line comparison. */
      configuration: PizzaConfiguration;
      price: PizzaPriceBreakdown;
    }
  | { ok: false; stage: FailingStage; errors: PizzaError[] };

/**
 * Runs stages 1–8 in order and stops at the first stage with errors, returning all of
 * that stage's errors in field and index order. Stages 1–3 only read the original input.
 */
export function evaluatePizza(
  input: unknown,
  catalog: PizzaCatalog | CatalogIndex,
  policy: PricingPolicy,
): PizzaEvaluation {
  const structure = validatePizzaConfiguration(input);
  if (!structure.ok) return { ok: false, stage: 1, errors: structure.errors };
  const original = structure.value;
  const index = "flavorPrice" in catalog ? catalog : indexCatalog(catalog);

  const referenceErrors = checkReferences(original, index);
  if (referenceErrors.length)
    return { ok: false, stage: 2, errors: referenceErrors };

  const placementErrors = checkPlacements(original, index);
  if (placementErrors.length)
    return { ok: false, stage: 3, errors: placementErrors };

  const configuration = canonicalOrder(
    normalizeFlavors(normalizeExtras(original)),
  );

  const limitErrors = checkLimits(configuration, policy);
  if (limitErrors.length) return { ok: false, stage: 7, errors: limitErrors };

  return {
    ok: true,
    configuration,
    price: calculatePizzaPrice(configuration, index, policy),
  };
}

const error = (code: PizzaErrorCode, path: string): PizzaError => ({
  code,
  path,
});
const sidesOf = (configuration: PizzaConfiguration): HalfSide[] =>
  configuration.mode === "HALVES" ? ["LEFT", "RIGHT"] : ["LEFT"];
const offered = (item: { available: boolean; archived: boolean } | undefined) =>
  item !== undefined && item.available && !item.archived;

/** Stage 2: PB-01 to PB-03, PB-07 and PB-09 (price for the size). */
function checkReferences(
  configuration: PizzaConfiguration,
  index: CatalogIndex,
): PizzaError[] {
  const errors: PizzaError[] = [];
  const size = index.sizes.get(configuration.sizeId);
  // Without a usable size, per-size prices are not checked: the size error comes first.
  const sizeId = offered(size) ? configuration.sizeId : null;
  if (!sizeId) errors.push(error("PIZZA_SIZE_UNAVAILABLE", "sizeId"));
  if (configuration.mode === "HALVES" && size && sizeId && size.maxFlavors < 2)
    errors.push(error("PIZZA_HALVES_NOT_ALLOWED", "mode"));

  for (const side of sidesOf(configuration)) {
    const flavorId = configuration.flavors[side] as string;
    const flavor = index.flavors.get(flavorId);
    const category = flavor && index.categories.get(flavor.categoryId);
    if (
      !offered(flavor) ||
      !category ||
      category.kind !== "PIZZA" ||
      category.archived ||
      (sizeId && index.flavorPrice(flavorId, sizeId) === undefined)
    )
      errors.push(error("PIZZA_FLAVOR_UNAVAILABLE", `flavors.${side}`));
  }

  if (configuration.crustId !== null) {
    const { crustId } = configuration;
    if (
      !offered(index.crusts.get(crustId)) ||
      (sizeId && index.crustPrice(crustId, sizeId) === undefined)
    )
      errors.push(error("PIZZA_CRUST_UNAVAILABLE", "crustId"));
  }

  configuration.extras.forEach(({ extraId }, position) => {
    if (
      !offered(index.extras.get(extraId)) ||
      (sizeId && index.extraPrice(extraId, sizeId) === undefined)
    )
      errors.push(
        error("PIZZA_EXTRA_UNAVAILABLE", `extras[${position}].extraId`),
      );
  });

  configuration.removals.forEach(({ ingredientId }, position) => {
    if (!index.ingredients.has(ingredientId))
      errors.push(
        error("PIZZA_REMOVAL_INVALID", `removals[${position}].ingredientId`),
      );
  });
  return errors;
}

/** Stage 3: PB-08, PB-09, PB-10 (WHOLE plus half is invalid), PB-12 and PB-13. */
function checkPlacements(
  configuration: PizzaConfiguration,
  index: CatalogIndex,
): PizzaError[] {
  const errors: PizzaError[] = [];
  const halves = configuration.mode === "HALVES";

  const extraPlacements = new Map<string, Set<Placement>>();
  configuration.extras.forEach(({ extraId, placement }, position) => {
    const path = `extras[${position}]`;
    if (!halves && placement !== "WHOLE")
      return void errors.push(
        error("PIZZA_EXTRA_PLACEMENT_INVALID", `${path}.placement`),
      );
    const seen = extraPlacements.get(extraId) ?? new Set<Placement>();
    const conflicts =
      seen.has(placement) ||
      (placement === "WHOLE" ? seen.size > 0 : seen.has("WHOLE"));
    if (conflicts) errors.push(error("PIZZA_EXTRA_DUPLICATED", path));
    seen.add(placement);
    extraPlacements.set(extraId, seen);
  });

  const removed = new Set<string>();
  configuration.removals.forEach(({ ingredientId, placement }, position) => {
    const path = `removals[${position}]`;
    if (halves === (placement === "WHOLE"))
      return void errors.push(
        error("PIZZA_REMOVAL_PLACEMENT_INVALID", `${path}.placement`),
      );
    const flavorId = configuration.flavors[
      placement === "WHOLE" ? "LEFT" : placement
    ] as string;
    const flavor = index.flavors.get(flavorId);
    if (
      !index.ingredients.get(ingredientId)?.removable ||
      !flavor?.ingredientIds.includes(ingredientId)
    )
      return void errors.push(
        error("PIZZA_REMOVAL_INVALID", `${path}.ingredientId`),
      );
    const key = `${placement}:${ingredientId}`;
    if (removed.has(key)) errors.push(error("PIZZA_REMOVAL_DUPLICATED", path));
    removed.add(key);
  });
  return errors;
}

/** Stage 4 (PB-10): in HALVES, an extra on both LEFT and RIGHT becomes one WHOLE entry. */
function normalizeExtras(
  configuration: PizzaConfiguration,
): PizzaConfiguration {
  if (configuration.mode !== "HALVES") return configuration;
  const onSide = (side: HalfSide) =>
    new Set(
      configuration.extras
        .filter((extra) => extra.placement === side)
        .map((extra) => extra.extraId),
    );
  const left = onSide("LEFT");
  const both = new Set([...onSide("RIGHT")].filter((id) => left.has(id)));
  const extras: PizzaExtraSelection[] = [];
  for (const extra of configuration.extras) {
    if (!both.has(extra.extraId)) extras.push(extra);
    else if (extra.placement === "LEFT")
      extras.push({ extraId: extra.extraId, placement: "WHOLE" });
  }
  return { ...configuration, extras };
}

/**
 * Stage 5 (PB-05): HALVES with the same flavor on both sides becomes WHOLE only when no
 * half extra remains and both sides remove the same ingredients.
 */
function normalizeFlavors(
  configuration: PizzaConfiguration,
): PizzaConfiguration {
  const { mode, flavors, extras, removals } = configuration;
  if (mode !== "HALVES" || flavors.LEFT !== flavors.RIGHT) return configuration;
  if (extras.some((extra) => extra.placement !== "WHOLE")) return configuration;
  const removedOn = (side: HalfSide) =>
    new Set(
      removals
        .filter((removal) => removal.placement === side)
        .map((removal) => removal.ingredientId),
    );
  const left = removedOn("LEFT");
  const right = removedOn("RIGHT");
  if (left.size !== right.size || [...left].some((id) => !right.has(id)))
    return configuration;
  return {
    ...configuration,
    mode: "WHOLE",
    flavors: { LEFT: flavors.LEFT },
    removals: [...left].map((ingredientId) => ({
      ingredientId,
      placement: "WHOLE" as const,
    })),
  };
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byPlacementThenId =
  <T extends { placement: Placement }>(id: (entry: T) => string) =>
  (a: T, b: T) =>
    PLACEMENTS.indexOf(a.placement) - PLACEMENTS.indexOf(b.placement) ||
    compareIds(id(a), id(b));

/** Stage 6 (PB-06): extras and removals ordered by placement (WHOLE, LEFT, RIGHT), then id. */
function canonicalOrder(configuration: PizzaConfiguration): PizzaConfiguration {
  return {
    sizeId: configuration.sizeId,
    mode: configuration.mode,
    flavors:
      configuration.mode === "HALVES"
        ? {
            LEFT: configuration.flavors.LEFT,
            RIGHT: configuration.flavors.RIGHT,
          }
        : { LEFT: configuration.flavors.LEFT },
    crustId: configuration.crustId,
    extras: configuration.extras
      .map(({ extraId, placement }) => ({ extraId, placement }))
      .sort(byPlacementThenId<PizzaExtraSelection>((extra) => extra.extraId)),
    removals: configuration.removals
      .map(({ ingredientId, placement }) => ({ ingredientId, placement }))
      .sort(
        byPlacementThenId<PizzaRemovalSelection>(
          (removal) => removal.ingredientId,
        ),
      ),
    quantity: configuration.quantity,
  };
}

/** Stage 7 (PB-11): each half counts its own extras plus the WHOLE extras. */
function checkLimits(
  configuration: PizzaConfiguration,
  policy: PricingPolicy,
): PizzaError[] {
  const count = (placement: Placement) =>
    configuration.extras.filter((extra) => extra.placement === placement)
      .length;
  const max = policy.maxExtrasPerHalf;
  if (configuration.mode === "WHOLE")
    return count("WHOLE") > max ? [error("PIZZA_EXTRA_LIMIT", "extras")] : [];
  return (["LEFT", "RIGHT"] as const)
    .filter((side) => count("WHOLE") + count(side) > max)
    .map((side) => error("PIZZA_EXTRA_LIMIT", `extras.${side}`));
}

/**
 * Stage 8. Prices any configuration that passed stages 1–3, normalized or not, which is
 * what lets tests prove that normalization never increases the total. Integer cents only;
 * the single rounding is the ceiling of the AVERAGE base (PB-Q3 recommendation).
 */
export function calculatePizzaPrice(
  configuration: PizzaConfiguration,
  catalog: PizzaCatalog | CatalogIndex,
  policy: PricingPolicy,
): PizzaPriceBreakdown {
  const index = "flavorPrice" in catalog ? catalog : indexCatalog(catalog);
  const { sizeId } = configuration;
  const priced = <T>(value: T | undefined, what: string): T => {
    // Reaching this means the caller skipped stages 1–3.
    if (value === undefined)
      throw new Error(`No price for ${what} in ${sizeId}`);
    return value;
  };
  const flavorPrice = (side: HalfSide) => {
    const flavorId = configuration.flavors[side] as string;
    return priced(index.flavorPrice(flavorId, sizeId), flavorId);
  };

  const left = flavorPrice("LEFT");
  let strategy: HalfAndHalfStrategy | null = null;
  let flavorPrices: PizzaPriceBreakdown["flavorPrices"] = { LEFT: left };
  let baseCents = left;
  let surchargeCents = 0;
  if (configuration.mode === "HALVES") {
    const right = flavorPrice("RIGHT");
    strategy = policy.halfAndHalfStrategy;
    flavorPrices = { LEFT: left, RIGHT: right };
    baseCents =
      strategy === "HIGHEST"
        ? Math.max(left, right)
        : Math.ceil((left + right) / 2);
    if (configuration.flavors.LEFT !== configuration.flavors.RIGHT)
      surchargeCents = policy.halfAndHalfSurchargeCents;
  }

  const crustCents =
    configuration.crustId === null
      ? 0
      : priced(
          index.crustPrice(configuration.crustId, sizeId),
          configuration.crustId,
        );

  const extras = configuration.extras.map(({ extraId, placement }) => {
    const price: CatalogExtraPrice = priced(
      index.extraPrice(extraId, sizeId),
      extraId,
    );
    return {
      extraId,
      placement,
      priceCents:
        placement === "WHOLE" ? price.wholePriceCents : price.halfPriceCents,
    };
  });
  const extrasCents = extras.reduce((sum, extra) => sum + extra.priceCents, 0);

  const unitPriceCents = baseCents + surchargeCents + crustCents + extrasCents;
  return {
    strategy,
    flavorPrices,
    baseCents,
    surchargeCents,
    crustCents,
    extras,
    extrasCents,
    unitPriceCents,
    quantity: configuration.quantity,
    totalCents: unitPriceCents * configuration.quantity,
  };
}
