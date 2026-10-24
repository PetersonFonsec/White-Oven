import type {
  CatalogCategory,
  CatalogCrust,
  CatalogExtra,
  CatalogExtraPrice,
  CatalogFlavor,
  CatalogIngredient,
  CatalogPizzaSize,
  PizzaCatalog,
} from "@whiteoven/contracts";

/** Lookup tables over a catalog. Build once with indexCatalog to price a whole cart. */
export interface CatalogIndex {
  categories: ReadonlyMap<string, CatalogCategory>;
  sizes: ReadonlyMap<string, CatalogPizzaSize>;
  ingredients: ReadonlyMap<string, CatalogIngredient>;
  flavors: ReadonlyMap<string, CatalogFlavor>;
  crusts: ReadonlyMap<string, CatalogCrust>;
  extras: ReadonlyMap<string, CatalogExtra>;
  flavorPrice(flavorId: string, sizeId: string): number | undefined;
  crustPrice(crustId: string, sizeId: string): number | undefined;
  extraPrice(extraId: string, sizeId: string): CatalogExtraPrice | undefined;
}

const byId = <T extends { id: string }>(list: readonly T[]) =>
  new Map(list.map((item) => [item.id, item]));
const pairKey = (ownerId: string, sizeId: string) =>
  JSON.stringify([ownerId, sizeId]);

/**
 * Expects a catalog accepted by validatePizzaCatalog from @whiteoven/contracts;
 * the index does not re-check identifiers or price ranges.
 */
export function indexCatalog(catalog: PizzaCatalog): CatalogIndex {
  const flavorPrices = new Map(
    catalog.flavorPrices.map((price) => [
      pairKey(price.flavorId, price.sizeId),
      price.priceCents,
    ]),
  );
  const crustPrices = new Map(
    catalog.crustPrices.map((price) => [
      pairKey(price.crustId, price.sizeId),
      price.priceCents,
    ]),
  );
  const extraPrices = new Map(
    catalog.extraPrices.map((price) => [
      pairKey(price.extraId, price.sizeId),
      price,
    ]),
  );
  return {
    categories: byId(catalog.categories),
    sizes: byId(catalog.sizes),
    ingredients: byId(catalog.ingredients),
    flavors: byId(catalog.flavors),
    crusts: byId(catalog.crusts),
    extras: byId(catalog.extras),
    flavorPrice: (flavorId, sizeId) =>
      flavorPrices.get(pairKey(flavorId, sizeId)),
    crustPrice: (crustId, sizeId) => crustPrices.get(pairKey(crustId, sizeId)),
    extraPrice: (extraId, sizeId) => extraPrices.get(pairKey(extraId, sizeId)),
  };
}
