import {
  PIZZA_QUANTITY_MAX,
  PIZZA_QUANTITY_MIN,
  type HalfSide,
  type PizzaConfiguration,
  type PizzaError,
  type PizzaMode,
} from "@whiteoven/contracts";
import {
  type CatalogIndex,
  type PizzaEvaluation,
  evaluatePizza,
  indexCatalog,
} from "@whiteoven/pizza-pricing";
import { type PublicMenu, formatCents, pizzaCatalog } from "../menu/menu.ts";

/**
 * What the customer picked, as the screen shows it (M5.2, ADR 0021). Extras and removals are kept
 * per half: in WHOLE only LEFT is used and means the whole pizza. An extra on both halves stays as
 * two entries here; `pizza-pricing` normalizes it to one WHOLE extra (PB-10), so the builder never
 * applies a PB rule of its own.
 */
export interface BuilderState {
  sizeId: string;
  mode: PizzaMode;
  flavors: { LEFT: string; RIGHT: string | null };
  crustId: string | null;
  extras: Record<HalfSide, string[]>;
  removals: Record<HalfSide, string[]>;
  quantity: number;
}

export const SIDE_NAMES: Record<HalfSide, string> = {
  LEFT: "Metade esquerda",
  RIGHT: "Metade direita",
};

/** The menu indexed once for every evaluation of the builder. */
export interface BuilderMenu {
  menu: PublicMenu;
  index: CatalogIndex;
}

export function builderMenu(menu: PublicMenu): BuilderMenu {
  return { menu, index: indexCatalog(pizzaCatalog(menu)) };
}

const without = (list: string[], id: string) => list.filter((x) => x !== id);

/** The first size, in menu order, where the flavor has a price. Null when it has none. */
export function startBuilder(
  { menu, index }: BuilderMenu,
  flavorId: string,
): BuilderState | null {
  const size = menu.sizes.find(
    (entry) => index.flavorPrice(flavorId, entry.id) !== undefined,
  );
  if (!size) return null;
  return {
    sizeId: size.id,
    mode: "WHOLE",
    flavors: { LEFT: flavorId, RIGHT: null },
    crustId: null,
    extras: { LEFT: [], RIGHT: [] },
    removals: { LEFT: [], RIGHT: [] },
    quantity: 1,
  };
}

const sidesOf = (state: Pick<BuilderState, "mode">): HalfSide[] =>
  state.mode === "HALVES" ? ["LEFT", "RIGHT"] : ["LEFT"];

export type SizeChange =
  /** Nothing the customer chose is lost. */
  | { kind: "applied"; state: BuilderState }
  /** The size cannot take the pizza as it is; the state stays as it was. */
  | { kind: "blocked"; message: string }
  /** The size drops a paid choice: `state` is applied only after the customer confirms. */
  | {
      kind: "confirm";
      state: BuilderState;
      message: string;
      removed: string[];
    };

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/**
 * A size change, checked before it is applied (ADR 0021), so no choice is dropped in silence:
 *
 * - A flavor without a price in the new size blocks the change; the flavor is never swapped.
 * - Halves on a one-flavor size become a whole pizza only when that loses nothing (the right
 *   flavor not chosen yet, or the same flavor and choices on both halves); otherwise blocked.
 * - A crust or extras without a price in the new size need the customer's confirmation.
 *
 * Flavors, removals, extras and quantity that fit the new size are kept. Prices and the PB rules
 * stay with `evaluatePizza`, which runs on the result like on any other state.
 */
export function changeSize(
  { menu, index }: BuilderMenu,
  state: BuilderState,
  sizeId: string,
): SizeChange {
  if (sizeId === state.sizeId) return { kind: "applied", state };
  const size = menu.sizes.find((entry) => entry.id === sizeId);
  if (!size)
    return {
      kind: "blocked",
      message: "Este tamanho não está mais disponível.",
    };
  const nameOf = <T extends { id: string; name: string }>(
    entries: T[],
    id: string,
  ) => entries.find((entry) => entry.id === id)?.name ?? "Um item";

  const chosen = [
    ...new Set(
      sidesOf(state)
        .map((side) => state.flavors[side])
        .filter((id): id is string => id !== null),
    ),
  ];
  const unpriced = chosen.filter(
    (id) => index.flavorPrice(id, sizeId) === undefined,
  );
  if (unpriced.length)
    return {
      kind: "blocked",
      message: `${listPt(unpriced.map((id) => nameOf(menu.flavors, id)))} ${
        unpriced.length === 1 ? "não está disponível" : "não estão disponíveis"
      } no tamanho ${size.name}. Escolha outro sabor antes de trocar o tamanho.`,
    };

  let next: BuilderState = { ...state, sizeId };
  if (state.mode === "HALVES" && size.maxFlavors < 2) {
    const { LEFT, RIGHT } = state.flavors;
    const lossless =
      (RIGHT === null &&
        sameSet(state.extras.RIGHT, state.extras.LEFT) &&
        state.removals.RIGHT.length === 0) ||
      (RIGHT === LEFT &&
        sameSet(state.extras.RIGHT, state.extras.LEFT) &&
        sameSet(state.removals.RIGHT, state.removals.LEFT));
    if (!lossless)
      return {
        kind: "blocked",
        message: `O tamanho ${size.name} aceita só um sabor. Escolha "Um sabor" antes de trocar, para decidir qual sabor fica.`,
      };
    next = setMode(next, "WHOLE");
  }

  const crustLost =
    next.crustId !== null &&
    index.crustPrice(next.crustId, sizeId) === undefined;
  const priced = (id: string) => index.extraPrice(id, sizeId) !== undefined;
  const extrasLost = [
    ...new Set([...next.extras.LEFT, ...next.extras.RIGHT]),
  ].filter((id) => !priced(id));
  if (!crustLost && extrasLost.length === 0)
    return { kind: "applied", state: next };

  const removed = [
    ...(crustLost ? [`borda ${nameOf(menu.crusts, next.crustId!)}`] : []),
    ...extrasLost.map((id) => nameOf(menu.extras, id)),
  ];
  return {
    kind: "confirm",
    state: {
      ...next,
      crustId: crustLost ? null : next.crustId,
      extras: {
        LEFT: next.extras.LEFT.filter(priced),
        RIGHT: next.extras.RIGHT.filter(priced),
      },
    },
    removed,
    message: `O tamanho ${size.name} não tem ${listPt(removed)}. Trocar o tamanho ${
      removed.length === 1 ? "remove esse item" : "remove esses itens"
    } da pizza.`,
  };
}

/**
 * WHOLE to HALVES: the whole pizza becomes the left half, its extras cover both halves and the
 * right flavor is still to be chosen. HALVES to WHOLE keeps the left half only.
 */
export function setMode(state: BuilderState, mode: PizzaMode): BuilderState {
  if (mode === state.mode) return state;
  if (mode === "HALVES")
    return {
      ...state,
      mode,
      flavors: { LEFT: state.flavors.LEFT, RIGHT: null },
      extras: { LEFT: state.extras.LEFT, RIGHT: [...state.extras.LEFT] },
      removals: { LEFT: state.removals.LEFT, RIGHT: [] },
    };
  return {
    ...state,
    mode,
    flavors: { LEFT: state.flavors.LEFT, RIGHT: null },
    extras: { LEFT: state.extras.LEFT, RIGHT: [] },
    removals: { LEFT: state.removals.LEFT, RIGHT: [] },
  };
}

/** Removals belong to the flavor they were taken from, so a new flavor starts without them. */
export function setFlavor(
  state: BuilderState,
  side: HalfSide,
  flavorId: string,
): BuilderState {
  if (state.flavors[side] === flavorId) return state;
  return {
    ...state,
    flavors: { ...state.flavors, [side]: flavorId },
    removals: { ...state.removals, [side]: [] },
  };
}

export function setCrust(
  state: BuilderState,
  crustId: string | null,
): BuilderState {
  return { ...state, crustId };
}

export function toggleExtra(
  state: BuilderState,
  side: HalfSide,
  extraId: string,
): BuilderState {
  const current = state.extras[side];
  return {
    ...state,
    extras: {
      ...state.extras,
      [side]: current.includes(extraId)
        ? without(current, extraId)
        : [...current, extraId],
    },
  };
}

export function toggleRemoval(
  state: BuilderState,
  side: HalfSide,
  ingredientId: string,
): BuilderState {
  const current = state.removals[side];
  return {
    ...state,
    removals: {
      ...state.removals,
      [side]: current.includes(ingredientId)
        ? without(current, ingredientId)
        : [...current, ingredientId],
    },
  };
}

export function setQuantity(
  state: BuilderState,
  quantity: number,
): BuilderState {
  return {
    ...state,
    quantity: Math.min(
      PIZZA_QUANTITY_MAX,
      Math.max(PIZZA_QUANTITY_MIN, Math.trunc(quantity)),
    ),
  };
}

/** The configuration the cart will send (M5.3); null until both halves have a flavor. */
export function toConfiguration(
  state: BuilderState,
): PizzaConfiguration | null {
  return state.mode === "HALVES" && !state.flavors.RIGHT
    ? null
    : previewConfiguration(state);
}

/** The choices as a configuration, the right flavor possibly still missing, for the preview. */
export function previewConfiguration(state: BuilderState): PizzaConfiguration {
  const placement = (side: HalfSide) =>
    state.mode === "WHOLE" ? ("WHOLE" as const) : side;
  return {
    sizeId: state.sizeId,
    mode: state.mode,
    flavors:
      state.mode === "HALVES"
        ? state.flavors.RIGHT
          ? { LEFT: state.flavors.LEFT, RIGHT: state.flavors.RIGHT }
          : { LEFT: state.flavors.LEFT }
        : { LEFT: state.flavors.LEFT },
    crustId: state.crustId,
    extras: sidesOf(state).flatMap((side) =>
      state.extras[side].map((extraId) => ({
        extraId,
        placement: placement(side),
      })),
    ),
    removals: sidesOf(state).flatMap((side) =>
      state.removals[side].map((ingredientId) => ({
        ingredientId,
        placement: placement(side),
      })),
    ),
    quantity: state.quantity,
  };
}

export type BuilderResult =
  | { kind: "incomplete"; message: string }
  /** The store has no pricing policy yet: pizzas are shown but cannot be priced. */
  | { kind: "unpriced"; message: string }
  | { kind: "invalid"; messages: string[] }
  | (Extract<PizzaEvaluation, { ok: true }> & { kind: "priced" });

/** Validation, normalization and price by `pizza-pricing`: the same pipeline as the API. */
export function evaluateBuilder(
  builder: BuilderMenu,
  state: BuilderState,
): BuilderResult {
  const configuration = toConfiguration(state);
  if (!configuration)
    return {
      kind: "incomplete",
      message: "Escolha o sabor da metade direita.",
    };
  const policy = builder.menu.pricingPolicy;
  if (!policy)
    return {
      kind: "unpriced",
      message:
        "A pizzaria ainda não configurou os preços de montagem. Tente mais tarde.",
    };
  const evaluation = evaluatePizza(configuration, builder.index, policy);
  if (!evaluation.ok)
    return {
      kind: "invalid",
      messages: [
        ...new Set(
          evaluation.errors.map((error) => errorMessage(builder, state, error)),
        ),
      ],
    };
  return { kind: "priced", ...evaluation };
}

function sideOfPath(path: string): HalfSide | null {
  if (path.endsWith("LEFT")) return "LEFT";
  if (path.endsWith("RIGHT")) return "RIGHT";
  return null;
}

/** Portuguese text for each PizzaError code, naming the half when the error has one. */
export function errorMessage(
  { menu }: BuilderMenu,
  state: BuilderState,
  error: PizzaError,
): string {
  const size = menu.sizes.find((entry) => entry.id === state.sizeId)?.name;
  // In WHOLE the single flavor is flavors.LEFT, which is not a half.
  const pathSide = sideOfPath(error.path);
  const side = state.mode === "HALVES" ? pathSide : null;
  const where = side ? ` (${SIDE_NAMES[side].toLowerCase()})` : "";
  switch (error.code) {
    case "PIZZA_SIZE_UNAVAILABLE":
      return "Este tamanho não está mais disponível. Escolha outro.";
    case "PIZZA_HALVES_NOT_ALLOWED":
      return `O tamanho ${size ?? "escolhido"} não pode ser meio a meio.`;
    case "PIZZA_FLAVOR_UNAVAILABLE": {
      const flavorId = state.flavors[pathSide ?? "LEFT"];
      const name = menu.flavors.find((entry) => entry.id === flavorId)?.name;
      return `${name ?? "Este sabor"} não está disponível no tamanho ${size ?? "escolhido"}${where}.`;
    }
    case "PIZZA_CRUST_UNAVAILABLE":
      return "Esta borda não está disponível neste tamanho.";
    case "PIZZA_EXTRA_UNAVAILABLE":
      return "Um adicional escolhido não está disponível neste tamanho.";
    case "PIZZA_EXTRA_LIMIT": {
      const max = menu.pricingPolicy?.maxExtrasPerHalf ?? 0;
      return `Escolha no máximo ${max} ${max === 1 ? "adicional" : "adicionais"} por ${side ? "metade" : "pizza"}${where}.`;
    }
    case "PIZZA_REMOVAL_INVALID":
    case "PIZZA_REMOVAL_PLACEMENT_INVALID":
    case "PIZZA_REMOVAL_DUPLICATED":
      return "Uma remoção escolhida não vale para este sabor.";
    default:
      return "Não foi possível montar esta pizza. Revise as escolhas.";
  }
}

/** Extras that can still be added to `side` without passing `maxExtrasPerHalf` (PB-11). */
export function extraLimitReached(
  menu: PublicMenu,
  state: BuilderState,
  side: HalfSide,
): boolean {
  const max = menu.pricingPolicy?.maxExtrasPerHalf;
  return max !== undefined && state.extras[side].length >= max;
}

export interface HalfDescription {
  /** null for a whole pizza. */
  side: HalfSide | null;
  title: string;
  flavor: string;
  details: string[];
  /** One sentence for screen readers and the summary. */
  text: string;
}

const listPt = (items: string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;

/**
 * The text of each half, from the configuration `pizza-pricing` normalized: what the pizzeria
 * will make, which can differ from the taps (the same flavor on both halves becomes one whole
 * pizza, PB-05). Before a valid evaluation, pass `previewConfiguration` to describe the choices
 * as they are.
 */
export function describePizza(
  { menu }: BuilderMenu,
  configuration: PizzaConfiguration,
): HalfDescription[] {
  const name = <T extends { id: string; name: string }>(
    entries: T[],
    id: string,
  ) => entries.find((entry) => entry.id === id)?.name ?? "item indisponível";
  const sides: (HalfSide | null)[] =
    configuration.mode === "HALVES" ? ["LEFT", "RIGHT"] : [null];
  return sides.map((side) => {
    const flavorId = configuration.flavors[side ?? "LEFT"];
    const flavor = flavorId ? name(menu.flavors, flavorId) : "sabor a escolher";
    const on = (placement: string) =>
      placement === "WHOLE" || placement === side;
    const extras = configuration.extras
      .filter((extra) => on(extra.placement))
      .map((extra) => name(menu.extras, extra.extraId));
    const removals = configuration.removals
      .filter((removal) => on(removal.placement))
      .map((removal) => name(menu.ingredients, removal.ingredientId));
    const details = [
      ...(removals.length ? [`sem ${listPt(removals)}`] : []),
      ...(extras.length ? [`com ${listPt(extras)}`] : []),
    ];
    const title = side ? SIDE_NAMES[side] : "Pizza inteira";
    return {
      side,
      title,
      flavor,
      details,
      text: `${title}: ${flavor}${details.length ? `, ${details.join(", ")}` : ""}.`,
    };
  });
}

/** Size, crust and quantity line under the halves. */
export function describeOrderLine(
  { menu }: BuilderMenu,
  configuration: PizzaConfiguration,
): string {
  const size = menu.sizes.find((entry) => entry.id === configuration.sizeId);
  const crust = configuration.crustId
    ? menu.crusts.find((entry) => entry.id === configuration.crustId)?.name
    : null;
  return [
    size
      ? `Tamanho ${size.name} (${size.slices} fatias)`
      : "Tamanho indisponível",
    crust ? `borda ${crust}` : "sem borda recheada",
    `${configuration.quantity} ${configuration.quantity === 1 ? "unidade" : "unidades"}`,
  ].join(", ");
}

/** Price lines for the summary; amounts come from `pizza-pricing`, never added up here. */
export function priceLines(
  { menu }: BuilderMenu,
  result: Extract<BuilderResult, { kind: "priced" }>,
): { label: string; amount: string }[] {
  const { price } = result;
  const lines = [
    {
      label:
        price.strategy === null
          ? "Pizza"
          : price.strategy === "HIGHEST"
            ? "Meio a meio (vale o maior preço)"
            : "Meio a meio (média dos preços)",
      amount: formatCents(price.baseCents),
    },
  ];
  if (price.surchargeCents)
    lines.push({
      label: "Taxa meio a meio",
      amount: formatCents(price.surchargeCents),
    });
  if (result.configuration.crustId)
    lines.push({ label: "Borda", amount: formatCents(price.crustCents) });
  for (const extra of price.extras)
    lines.push({
      label: `${menu.extras.find((entry) => entry.id === extra.extraId)?.name ?? "Adicional"} (${
        extra.placement === "WHOLE"
          ? "pizza inteira"
          : SIDE_NAMES[extra.placement].toLowerCase()
      })`,
      amount: formatCents(extra.priceCents),
    });
  if (price.quantity > 1)
    lines.push({
      label: `${price.quantity} × ${formatCents(price.unitPriceCents)}`,
      amount: formatCents(price.totalCents),
    });
  return lines;
}
