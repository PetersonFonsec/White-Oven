import type { CatalogSnapshot } from "./catalog-api";

/** A catalog with orderable, unavailable, archived and unpriced entries, for tests. */
export function catalogFixture(): CatalogSnapshot {
  const size = (id: string, name: string, maxFlavors: 1 | 2, extra = {}) => ({
    id,
    name,
    slices: 8,
    maxFlavors,
    sortOrder: 0,
    available: true,
    archived: false,
    ...extra,
  });
  const flavor = (id: string, name: string, extra = {}) => ({
    id,
    categoryId: "pizzas",
    name,
    description: null,
    ingredientIds: [],
    imageId: null,
    available: true,
    archived: false,
    ...extra,
  });
  return {
    categories: [
      {
        id: "pizzas",
        name: "Pizzas",
        kind: "PIZZA",
        sortOrder: 0,
        archived: false,
      },
      {
        id: "old",
        name: "Antigas",
        kind: "PIZZA",
        sortOrder: 1,
        archived: true,
      },
      {
        id: "drinks",
        name: "Bebidas",
        kind: "PRODUCT",
        sortOrder: 2,
        archived: false,
      },
    ],
    sizes: [
      size("large", "Grande", 2),
      size("small", "Broto", 1),
      size("giant", "Gigante", 2, { available: false }),
      size("retired", "Família", 2, { archived: true }),
    ],
    ingredients: [],
    flavors: [
      flavor("calabresa", "Calabresa"),
      flavor("margherita", "Margherita"),
      flavor("portuguesa", "Portuguesa", { available: false }),
      flavor("atum", "Atum"),
      flavor("frango", "Frango", { archived: true }),
      flavor("antiga", "Antiga", { categoryId: "old" }),
    ],
    flavorPrices: [
      { flavorId: "calabresa", sizeId: "large", priceCents: 5000 },
      { flavorId: "calabresa", sizeId: "small", priceCents: 3000 },
      { flavorId: "margherita", sizeId: "large", priceCents: 6000 },
      { flavorId: "portuguesa", sizeId: "large", priceCents: 4000 },
      { flavorId: "frango", sizeId: "large", priceCents: 4000 },
      { flavorId: "antiga", sizeId: "large", priceCents: 4000 },
      { flavorId: "calabresa", sizeId: "giant", priceCents: 7000 },
    ],
    crusts: [
      { id: "catupiry", name: "Catupiry", available: true, archived: false },
      { id: "cheddar", name: "Cheddar", available: false, archived: false },
    ],
    crustPrices: [
      { crustId: "catupiry", sizeId: "large", priceCents: 1000 },
      { crustId: "cheddar", sizeId: "large", priceCents: 1000 },
    ],
    extras: [],
    extraPrices: [],
    simpleProducts: [
      {
        id: "soda",
        categoryId: "drinks",
        name: "Refrigerante",
        priceCents: 800,
        imageId: null,
        available: true,
        archived: false,
      },
    ],
    pricingPolicy: null,
  };
}
