import type {
  HalfAndHalfStrategy,
  PizzaCatalog,
  PricingPolicy,
} from "@whiteoven/contracts";
import {
  type Answer,
  type PublicGetOptions,
  imageIdOf,
  publicGet,
} from "../brand/store-loader.ts";

/** `GET /v1/public/stores/{slug}/menu` (M2.6, images since ADR 0021): orderable items only. */
export interface PublicMenu {
  version: number;
  categories: { id: string; name: string; kind: "PIZZA" | "PRODUCT" }[];
  sizes: { id: string; name: string; slices: number; maxFlavors: 1 | 2 }[];
  ingredients: { id: string; name: string; removable: boolean }[];
  flavors: {
    id: string;
    categoryId: string;
    name: string;
    description: string | null;
    imageId: string | null;
    ingredientIds: string[];
  }[];
  flavorPrices: { flavorId: string; sizeId: string; priceCents: number }[];
  crusts: { id: string; name: string }[];
  crustPrices: { crustId: string; sizeId: string; priceCents: number }[];
  extras: { id: string; name: string }[];
  extraPrices: {
    extraId: string;
    sizeId: string;
    wholePriceCents: number;
    halfPriceCents: number;
  }[];
  simpleProducts: {
    id: string;
    categoryId: string;
    name: string;
    priceCents: number;
    imageId: string | null;
  }[];
  /** null while the store has not set one: pizzas are listed but cannot be built. */
  pricingPolicy: PricingPolicy | null;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 120): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isId = (value: unknown): value is string => isText(value, 64);
const isCents = (value: unknown, min = 0): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= min &&
  (value as number) <= 2_147_483_647;

/** Each entry must pass `check`, or the whole list is refused. */
function list<T>(value: unknown, check: (row: Row) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = isRow(entry) ? check(entry) : null;
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

const STRATEGIES: readonly HalfAndHalfStrategy[] = ["HIGHEST", "AVERAGE"];

function parsePolicy(value: unknown): PricingPolicy | null | undefined {
  if (value === null) return null;
  if (!isRow(value)) return undefined;
  const { halfAndHalfStrategy, halfAndHalfSurchargeCents, maxExtrasPerHalf } =
    value;
  if (
    !STRATEGIES.includes(halfAndHalfStrategy as HalfAndHalfStrategy) ||
    !isCents(halfAndHalfSurchargeCents) ||
    !Number.isSafeInteger(maxExtrasPerHalf) ||
    (maxExtrasPerHalf as number) < 0 ||
    (maxExtrasPerHalf as number) > 10
  )
    return undefined;
  return {
    halfAndHalfStrategy: halfAndHalfStrategy as HalfAndHalfStrategy,
    halfAndHalfSurchargeCents,
    maxExtrasPerHalf: maxExtrasPerHalf as number,
  };
}

/**
 * Validates the menu the API sent and copies only the fields the app uses. Any malformed entry
 * refuses the whole menu: a partial menu could price a pizza without one of its parts. References
 * between sections are left to `pizza-pricing`, which reports them per pizza.
 */
export function parseMenu(value: unknown): PublicMenu | null {
  if (!isRow(value)) return null;
  const version = value.version;
  const categories = list(value.categories, (row) =>
    isId(row.id) &&
    isText(row.name) &&
    (row.kind === "PIZZA" || row.kind === "PRODUCT")
      ? { id: row.id, name: row.name, kind: row.kind as "PIZZA" | "PRODUCT" }
      : null,
  );
  const sizes = list(value.sizes, (row) =>
    isId(row.id) &&
    isText(row.name) &&
    Number.isSafeInteger(row.slices) &&
    (row.slices as number) >= 1 &&
    (row.maxFlavors === 1 || row.maxFlavors === 2)
      ? {
          id: row.id,
          name: row.name,
          slices: row.slices as number,
          maxFlavors: row.maxFlavors as 1 | 2,
        }
      : null,
  );
  const ingredients = list(value.ingredients, (row) =>
    isId(row.id) && isText(row.name) && typeof row.removable === "boolean"
      ? { id: row.id, name: row.name, removable: row.removable }
      : null,
  );
  const flavors = list(value.flavors, (row) =>
    isId(row.id) &&
    isId(row.categoryId) &&
    isText(row.name) &&
    (row.description === null || typeof row.description === "string") &&
    (row.imageId === null || imageIdOf(row.imageId)) &&
    Array.isArray(row.ingredientIds) &&
    row.ingredientIds.every(isId)
      ? {
          id: row.id,
          categoryId: row.categoryId,
          name: row.name,
          description: (row.description as string | null)?.trim() || null,
          imageId: row.imageId as string | null,
          ingredientIds: [...(row.ingredientIds as string[])],
        }
      : null,
  );
  const flavorPrices = list(value.flavorPrices, (row) =>
    isId(row.flavorId) && isId(row.sizeId) && isCents(row.priceCents, 1)
      ? {
          flavorId: row.flavorId,
          sizeId: row.sizeId,
          priceCents: row.priceCents,
        }
      : null,
  );
  const named = (row: Row) =>
    isId(row.id) && isText(row.name) ? { id: row.id, name: row.name } : null;
  const crusts = list(value.crusts, named);
  const crustPrices = list(value.crustPrices, (row) =>
    isId(row.crustId) && isId(row.sizeId) && isCents(row.priceCents)
      ? { crustId: row.crustId, sizeId: row.sizeId, priceCents: row.priceCents }
      : null,
  );
  const extras = list(value.extras, named);
  const extraPrices = list(value.extraPrices, (row) =>
    isId(row.extraId) &&
    isId(row.sizeId) &&
    isCents(row.wholePriceCents) &&
    isCents(row.halfPriceCents)
      ? {
          extraId: row.extraId,
          sizeId: row.sizeId,
          wholePriceCents: row.wholePriceCents,
          halfPriceCents: row.halfPriceCents,
        }
      : null,
  );
  const simpleProducts = list(value.simpleProducts, (row) =>
    isId(row.id) &&
    isId(row.categoryId) &&
    isText(row.name) &&
    isCents(row.priceCents) &&
    (row.imageId === null || imageIdOf(row.imageId))
      ? {
          id: row.id,
          categoryId: row.categoryId,
          name: row.name,
          priceCents: row.priceCents,
          imageId: row.imageId as string | null,
        }
      : null,
  );
  const pricingPolicy = parsePolicy(value.pricingPolicy);
  if (
    !Number.isSafeInteger(version) ||
    (version as number) < 0 ||
    !categories ||
    !sizes ||
    !ingredients ||
    !flavors ||
    !flavorPrices ||
    !crusts ||
    !crustPrices ||
    !extras ||
    !extraPrices ||
    !simpleProducts ||
    pricingPolicy === undefined
  )
    return null;
  return {
    version: version as number,
    categories,
    sizes,
    ingredients,
    flavors,
    flavorPrices,
    crusts,
    crustPrices,
    extras,
    extraPrices,
    simpleProducts,
    pricingPolicy,
  };
}

/**
 * The menu as the catalog `pizza-pricing` reads. The public menu lists only orderable items, so
 * every item is available and none is archived; the API prices the order again from its own
 * catalog and stays the authority.
 */
export function pizzaCatalog(menu: PublicMenu): PizzaCatalog {
  const live = { available: true, archived: false };
  return {
    categories: menu.categories.map(({ id, kind }) => ({
      id,
      kind,
      archived: false,
    })),
    sizes: menu.sizes.map((size) => ({ ...size, ...live })),
    ingredients: menu.ingredients.map(({ id, name, removable }) => ({
      id,
      name,
      removable,
      archived: false,
    })),
    flavors: menu.flavors.map(({ id, categoryId, name, ingredientIds }) => ({
      id,
      categoryId,
      name,
      ingredientIds,
      ...live,
    })),
    flavorPrices: menu.flavorPrices,
    crusts: menu.crusts.map((crust) => ({ ...crust, ...live })),
    crustPrices: menu.crustPrices,
    extras: menu.extras.map((extra) => ({ ...extra, ...live })),
    extraPrices: menu.extraPrices,
  };
}

export type MenuItem =
  | {
      kind: "PIZZA";
      id: string;
      name: string;
      description: string | null;
      imageId: string | null;
      /** Lowest price over the sizes the flavor has. */
      fromCents: number;
    }
  | {
      kind: "PRODUCT";
      id: string;
      name: string;
      imageId: string | null;
      priceCents: number;
    };

export interface MenuSection {
  id: string;
  name: string;
  items: MenuItem[];
}

/** Categories in the API's order, each with its items; empty categories are left out. */
export function menuSections(menu: PublicMenu): MenuSection[] {
  const lowest = new Map<string, number>();
  for (const price of menu.flavorPrices)
    lowest.set(
      price.flavorId,
      Math.min(lowest.get(price.flavorId) ?? Infinity, price.priceCents),
    );
  return menu.categories
    .map((category) => ({
      id: category.id,
      name: category.name,
      items:
        category.kind === "PIZZA"
          ? menu.flavors
              .filter(
                (flavor) =>
                  flavor.categoryId === category.id && lowest.has(flavor.id),
              )
              .map((flavor): MenuItem => ({
                kind: "PIZZA",
                id: flavor.id,
                name: flavor.name,
                description: flavor.description,
                imageId: flavor.imageId,
                fromCents: lowest.get(flavor.id)!,
              }))
          : menu.simpleProducts
              .filter((product) => product.categoryId === category.id)
              .map((product): MenuItem => ({
                kind: "PRODUCT",
                id: product.id,
                name: product.name,
                imageId: product.imageId,
                priceCents: product.priceCents,
              })),
    }))
    .filter((section) => section.items.length > 0);
}

/** `R$ 45,90`, without Intl, which not every Hermes build carries. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const value = Math.abs(cents);
  const reais = Math.floor(value / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}R$ ${reais},${(value % 100).toString().padStart(2, "0")}`;
}

/** The public image route of ADR 0021; the API serves only images the menu or brand shows. */
export function imageUrl(
  apiUrl: string,
  storeSlug: string,
  imageId: string,
  variant: "thumbnail" | "menu",
): string {
  return `${apiUrl}/v1/public/stores/${encodeURIComponent(storeSlug)}/images/${encodeURIComponent(imageId)}/${variant}`;
}

/** The menu is not cached: prices change, and an order is priced again by the API anyway. */
export function loadMenu(
  options: PublicGetOptions,
): Promise<Answer<PublicMenu>> {
  return publicGet(options, "/menu", parseMenu);
}
