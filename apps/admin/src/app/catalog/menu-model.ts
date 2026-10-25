import type { PizzaCatalog } from "@whiteoven/contracts";
import type { CatalogSnapshot } from "./catalog-api";

/** Largest amount the API stores (PostgreSQL `integer`), in cents. */
export const MAX_CENTS = 2_147_483_647;

/**
 * Smallest amount the API accepts for each price, in cents: a pizza flavor must cost something
 * (`catalog_flavor_prices_positive`); crusts, extras and products may be free.
 */
export const MIN_CENTS = {
  flavor: 1,
  crust: 0,
  extra: 0,
  product: 0,
} as const;

export type MoneyKind = keyof typeof MIN_CENTS;

export type Money =
  { ok: true; cents: number } | { ok: false; message: string };

const MONEY = /^(\d+)(?:[.,](\d{1,2}))?$/;

/**
 * Reads an amount typed in reais ("12", "12,5", "12.50") into cents with integer arithmetic, so
 * no floating-point rounding is involved. The API validates again; this only avoids sending
 * requests it would refuse and tells the person which field is wrong.
 */
export function parseMoney(input: string, kind: MoneyKind): Money {
  const text = input.trim();
  if (!text) return { ok: false, message: "Informe um valor." };
  if (text.startsWith("-"))
    return { ok: false, message: "O valor não pode ser negativo." };
  const match = MONEY.exec(text);
  if (!match)
    return {
      ok: false,
      message: "Use um valor em reais com até 2 casas, como 12,50.",
    };
  const [, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS)
    return { ok: false, message: "Valor acima do limite permitido." };
  if (cents < MIN_CENTS[kind])
    return { ok: false, message: "O preço do sabor deve ser maior que zero." };
  return { ok: true, cents };
}

/** Cents as the text a price field starts with ("12.50"). */
export function moneyText(cents: number | undefined): string {
  if (cents === undefined) return "";
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export interface PreviewSelection {
  sizeId: string;
  mode: "WHOLE" | "HALVES";
  left: string;
  right: string;
  crustId: string;
}

export const EMPTY_PREVIEW: PreviewSelection = {
  sizeId: "",
  mode: "WHOLE",
  left: "",
  right: "",
  crustId: "",
};

/** Sizes a customer could order now. */
export function previewSizes(data: CatalogSnapshot) {
  return data.sizes.filter((size) => size.available && !size.archived);
}

/** Orderable flavors with a price for the size, in an active pizza category. */
export function previewFlavors(data: CatalogSnapshot, sizeId: string) {
  const priced = new Set(
    data.flavorPrices
      .filter((price) => price.sizeId === sizeId)
      .map((price) => price.flavorId),
  );
  const categories = new Set(
    data.categories
      .filter((category) => category.kind === "PIZZA" && !category.archived)
      .map((category) => category.id),
  );
  return data.flavors.filter(
    (flavor) =>
      flavor.available &&
      !flavor.archived &&
      categories.has(flavor.categoryId) &&
      priced.has(flavor.id),
  );
}

/** Orderable crusts with a price for the size. */
export function previewCrusts(data: CatalogSnapshot, sizeId: string) {
  const priced = new Set(
    data.crustPrices
      .filter((price) => price.sizeId === sizeId)
      .map((price) => price.crustId),
  );
  return data.crusts.filter(
    (crust) => crust.available && !crust.archived && priced.has(crust.id),
  );
}

/**
 * Keeps a preview selection valid for the catalog: a size that is no longer orderable falls back
 * to the first one that is, and flavors and crust without a price for the chosen size are replaced
 * (flavors) or dropped (crust). Halves only stay on a size that allows two flavors.
 */
export function reconcilePreview(
  selection: PreviewSelection,
  data: CatalogSnapshot,
): PreviewSelection {
  const sizes = previewSizes(data);
  const size =
    sizes.find((item) => item.id === selection.sizeId) ?? sizes[0] ?? null;
  if (!size) return EMPTY_PREVIEW;
  const flavors = previewFlavors(data, size.id).map((flavor) => flavor.id);
  const keep = (id: string, fallback: string) =>
    flavors.includes(id) ? id : fallback;
  const left = keep(selection.left, flavors[0] ?? "");
  const right = keep(
    selection.right,
    flavors.find((id) => id !== left) ?? left,
  );
  const crusts = previewCrusts(data, size.id).map((crust) => crust.id);
  return {
    sizeId: size.id,
    mode: size.maxFlavors === 2 ? selection.mode : "WHOLE",
    left,
    right,
    crustId: crusts.includes(selection.crustId) ? selection.crustId : "",
  };
}

/** The pricing engine's view of a catalog snapshot. */
export function pricingCatalog(data: CatalogSnapshot): PizzaCatalog {
  return {
    categories: data.categories.map(({ id, kind, archived }) => ({
      id,
      kind,
      archived,
    })),
    sizes: data.sizes.map(
      ({ id, name, slices, maxFlavors, available, archived }) => ({
        id,
        name,
        slices,
        maxFlavors,
        available,
        archived,
      }),
    ),
    ingredients: data.ingredients.map(({ id, name, removable, archived }) => ({
      id,
      name,
      removable,
      archived,
    })),
    flavors: data.flavors.map(
      ({ id, categoryId, name, ingredientIds, available, archived }) => ({
        id,
        categoryId,
        name,
        ingredientIds,
        available,
        archived,
      }),
    ),
    flavorPrices: data.flavorPrices,
    crusts: data.crusts.map(({ id, name, available, archived }) => ({
      id,
      name,
      available,
      archived,
    })),
    crustPrices: data.crustPrices,
    extras: data.extras.map(({ id, name, available, archived }) => ({
      id,
      name,
      available,
      archived,
    })),
    extraPrices: data.extraPrices,
  };
}
