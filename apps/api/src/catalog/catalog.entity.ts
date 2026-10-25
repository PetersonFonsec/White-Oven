import { defineEntity, p } from "@mikro-orm/core";
import { tenantFilters } from "../tenancy/tenant-filter";

export const CatalogCategory = defineEntity({
  name: "CatalogCategory",
  tableName: "catalog_categories",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    name: p.text(),
    kind: p.enum(["PIZZA", "PRODUCT"]),
    sortOrder: p.integer(),
    archivedAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const PizzaSize = defineEntity({
  name: "PizzaSize",
  tableName: "pizza_sizes",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    name: p.text(),
    slices: p.integer(),
    maxFlavors: p.integer(),
    sortOrder: p.integer(),
    available: p.boolean(),
    archivedAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const CatalogIngredient = defineEntity({
  name: "CatalogIngredient",
  tableName: "catalog_ingredients",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    name: p.text(),
    removable: p.boolean(),
    archivedAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const CatalogFlavor = defineEntity({
  name: "CatalogFlavor",
  tableName: "catalog_flavors",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    categoryId: p.uuid(),
    name: p.text(),
    description: p.text().nullable(),
    available: p.boolean(),
    archivedAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const CatalogFlavorIngredient = defineEntity({
  name: "CatalogFlavorIngredient",
  tableName: "catalog_flavor_ingredients",
  filters: tenantFilters,
  properties: {
    tenantId: p.uuid(),
    flavorId: p.uuid().primary(),
    ingredientId: p.uuid().primary(),
  },
});

export const CatalogFlavorPrice = defineEntity({
  name: "CatalogFlavorPrice",
  tableName: "catalog_flavor_prices",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    flavorId: p.uuid(),
    sizeId: p.uuid(),
    priceCents: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const CatalogCrust = defineEntity({
  name: "CatalogCrust",
  tableName: "catalog_crusts",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    name: p.text(),
    available: p.boolean(),
    archivedAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const CatalogCrustPrice = defineEntity({
  name: "CatalogCrustPrice",
  tableName: "catalog_crust_prices",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    crustId: p.uuid(),
    sizeId: p.uuid(),
    priceCents: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const CatalogExtra = defineEntity({
  name: "CatalogExtra",
  tableName: "catalog_extras",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    name: p.text(),
    available: p.boolean(),
    archivedAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const CatalogExtraPrice = defineEntity({
  name: "CatalogExtraPrice",
  tableName: "catalog_extra_prices",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    extraId: p.uuid(),
    sizeId: p.uuid(),
    wholePriceCents: p.integer(),
    halfPriceCents: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const CatalogSimpleProduct = defineEntity({
  name: "CatalogSimpleProduct",
  tableName: "catalog_simple_products",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    categoryId: p.uuid(),
    name: p.text(),
    priceCents: p.integer(),
    available: p.boolean(),
    archivedAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const CatalogPricingPolicy = defineEntity({
  name: "CatalogPricingPolicy",
  tableName: "catalog_pricing_policies",
  filters: tenantFilters,
  properties: {
    tenantId: p.uuid().primary(),
    halfAndHalfStrategy: p.enum(["HIGHEST", "AVERAGE"]),
    halfAndHalfSurchargeCents: p.integer(),
    maxExtrasPerHalf: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
