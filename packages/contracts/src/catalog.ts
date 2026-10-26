/**
 * Catalog snapshot consumed by the pizza pricing engine (docs/architecture/domain-model.md#catálogo).
 * The API builds it from the tenant's tables, including archived and unavailable items, so the
 * engine can tell "archived" from "unknown". Public menus omit those items before sending.
 */
import { isCents, isId, keyIssues, plain } from "./shape.ts";
import { validatePricingPolicy, type PricingPolicy } from "./pizza.ts";

export const CATEGORY_KINDS = ["PIZZA", "PRODUCT"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export interface CatalogCategory {
  id: string;
  kind: CategoryKind;
  archived: boolean;
}

export interface CatalogPizzaSize {
  id: string;
  name: string;
  slices: number;
  maxFlavors: 1 | 2;
  available: boolean;
  archived: boolean;
}

export interface CatalogIngredient {
  id: string;
  name: string;
  removable: boolean;
  archived: boolean;
}

export interface CatalogFlavor {
  id: string;
  categoryId: string;
  name: string;
  ingredientIds: string[];
  available: boolean;
  archived: boolean;
}

export interface CatalogFlavorPrice {
  flavorId: string;
  sizeId: string;
  priceCents: number;
}

export interface CatalogCrust {
  id: string;
  name: string;
  available: boolean;
  archived: boolean;
}

export interface CatalogCrustPrice {
  crustId: string;
  sizeId: string;
  priceCents: number;
}

export interface CatalogExtra {
  id: string;
  name: string;
  available: boolean;
  archived: boolean;
}

/** halfPriceCents ≤ wholePriceCents ≤ 2 × halfPriceCents, so LEFT+RIGHT → WHOLE never costs more. */
export interface CatalogExtraPrice {
  extraId: string;
  sizeId: string;
  wholePriceCents: number;
  halfPriceCents: number;
}

export interface CatalogSimpleProduct {
  id: string;
  categoryId: string;
  name: string;
  priceCents: number;
  available: boolean;
  archived: boolean;
}

export interface PizzaCatalog {
  categories: CatalogCategory[];
  sizes: CatalogPizzaSize[];
  ingredients: CatalogIngredient[];
  flavors: CatalogFlavor[];
  flavorPrices: CatalogFlavorPrice[];
  crusts: CatalogCrust[];
  crustPrices: CatalogCrustPrice[];
  extras: CatalogExtra[];
  extraPrices: CatalogExtraPrice[];
}

/** Full management response for /admin/catalog/items, including M2.4 data. */
export interface CatalogManagementSnapshot extends PizzaCatalog {
  simpleProducts: CatalogSimpleProduct[];
  pricingPolicy: PricingPolicy | null;
}

export const CATALOG_ERROR = "CATALOG_INVALID";
export interface CatalogError {
  code: typeof CATALOG_ERROR;
  path: string;
}

export type CatalogResult =
  { ok: true; value: PizzaCatalog } | { ok: false; errors: CatalogError[] };

export const CATALOG_NAME_MAX_LENGTH = 120;

const isName = (value: unknown) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= CATALOG_NAME_MAX_LENGTH;
const isFlag = (value: unknown) => typeof value === "boolean";

type FieldCheck = (value: unknown) => boolean;

const SECTIONS = {
  categories: {
    id: isId,
    kind: (value: unknown) => CATEGORY_KINDS.includes(value as CategoryKind),
    archived: isFlag,
  },
  sizes: {
    id: isId,
    name: isName,
    slices: (value: unknown) =>
      Number.isSafeInteger(value) && (value as number) >= 1,
    maxFlavors: (value: unknown) => value === 1 || value === 2,
    available: isFlag,
    archived: isFlag,
  },
  ingredients: { id: isId, name: isName, removable: isFlag, archived: isFlag },
  flavors: {
    id: isId,
    categoryId: isId,
    name: isName,
    ingredientIds: (value: unknown) =>
      Array.isArray(value) &&
      value.every(isId) &&
      new Set(value).size === value.length,
    available: isFlag,
    archived: isFlag,
  },
  flavorPrices: {
    flavorId: isId,
    sizeId: isId,
    priceCents: (value: unknown) => isCents(value, 1),
  },
  crusts: { id: isId, name: isName, available: isFlag, archived: isFlag },
  crustPrices: {
    crustId: isId,
    sizeId: isId,
    priceCents: (value: unknown) => isCents(value),
  },
  extras: { id: isId, name: isName, available: isFlag, archived: isFlag },
  extraPrices: {
    extraId: isId,
    sizeId: isId,
    wholePriceCents: (value: unknown) => isCents(value),
    halfPriceCents: (value: unknown) => isCents(value),
  },
} satisfies Record<keyof PizzaCatalog, Record<string, FieldCheck>>;

type Section = keyof typeof SECTIONS;
const SECTION_NAMES = Object.keys(SECTIONS) as Section[];

/**
 * Validates shape, value ranges, unique identifiers, unique price pairs, the extra price
 * restriction and references between sections. Unknown fields are rejected everywhere.
 */
export function validatePizzaCatalog(raw: unknown): CatalogResult {
  if (!plain(raw)) return catalogErrors([""]);
  const paths = keyIssues(raw, SECTION_NAMES, "");
  for (const section of SECTION_NAMES) {
    const list = raw[section];
    if (!Object.hasOwn(raw, section)) continue;
    if (!Array.isArray(list)) {
      paths.push(section);
      continue;
    }
    const checks: Record<string, FieldCheck> = SECTIONS[section];
    const fields = Object.keys(checks);
    list.forEach((entry, index) => {
      const path = `${section}[${index}]`;
      if (!plain(entry)) return void paths.push(path);
      paths.push(...keyIssues(entry, fields, path));
      for (const field of fields)
        if (Object.hasOwn(entry, field) && !checks[field]!(entry[field]))
          paths.push(`${path}.${field}`);
    });
  }
  // Cross-entry rules only make sense on well-formed entries.
  if (paths.length) return catalogErrors(paths);

  const catalog = raw as unknown as PizzaCatalog;
  const ids = {} as Record<Section, Set<string>>;
  for (const section of [
    "categories",
    "sizes",
    "ingredients",
    "flavors",
    "crusts",
    "extras",
  ] as const) {
    ids[section] = new Set();
    catalog[section].forEach((entry, index) => {
      if (ids[section].has(entry.id)) paths.push(`${section}[${index}].id`);
      ids[section].add(entry.id);
    });
  }
  const categoryKind = new Map(
    catalog.categories.map((category) => [category.id, category.kind]),
  );
  catalog.flavors.forEach((flavor, index) => {
    if (categoryKind.get(flavor.categoryId) !== "PIZZA")
      paths.push(`flavors[${index}].categoryId`);
    flavor.ingredientIds.forEach((ingredientId, position) => {
      if (!ids.ingredients.has(ingredientId))
        paths.push(`flavors[${index}].ingredientIds[${position}]`);
    });
  });
  const priced = <K extends string>(
    section: Section,
    owner: Section,
    ownerKey: K,
    list: readonly (Record<K | "sizeId", string> & object)[],
  ) => {
    const pairs = new Set<string>();
    list.forEach((entry, index) => {
      const path = `${section}[${index}]`;
      if (!ids[owner].has(entry[ownerKey])) paths.push(`${path}.${ownerKey}`);
      if (!ids.sizes.has(entry.sizeId)) paths.push(`${path}.sizeId`);
      const pair = JSON.stringify([entry[ownerKey], entry.sizeId]);
      if (pairs.has(pair)) paths.push(path);
      pairs.add(pair);
    });
  };
  priced("flavorPrices", "flavors", "flavorId", catalog.flavorPrices);
  priced("crustPrices", "crusts", "crustId", catalog.crustPrices);
  priced("extraPrices", "extras", "extraId", catalog.extraPrices);
  catalog.extraPrices.forEach((price, index) => {
    if (
      price.halfPriceCents > price.wholePriceCents ||
      price.wholePriceCents > 2 * price.halfPriceCents
    )
      paths.push(`extraPrices[${index}].wholePriceCents`);
  });
  if (paths.length) return catalogErrors(paths);
  return { ok: true, value: structuredClone(catalog) };
}

export function validateCatalogManagementSnapshot(
  raw: unknown,
):
  | { ok: true; value: CatalogManagementSnapshot }
  | { ok: false; errors: CatalogError[] } {
  if (!plain(raw)) return catalogErrors([""]);
  const keys = [...SECTION_NAMES, "simpleProducts", "pricingPolicy"];
  const paths = keyIssues(raw, keys, "");
  for (const key of keys) if (!Object.hasOwn(raw, key)) paths.push(key);
  const pizzaCatalog = Object.fromEntries(
    SECTION_NAMES.map((section) => [section, raw[section]]),
  );
  const catalog = validatePizzaCatalog(pizzaCatalog);
  if (!catalog.ok) paths.push(...catalog.errors.map((entry) => entry.path));

  const products = raw.simpleProducts;
  if (!Array.isArray(products)) paths.push("simpleProducts");
  else
    products.forEach((entry, index) => {
      const path = `simpleProducts[${index}]`;
      if (!plain(entry)) return void paths.push(path);
      const fields = [
        "id",
        "categoryId",
        "name",
        "priceCents",
        "available",
        "archived",
      ];
      paths.push(...keyIssues(entry, fields, path));
      if (Object.hasOwn(entry, "id") && !isId(entry.id))
        paths.push(`${path}.id`);
      if (Object.hasOwn(entry, "categoryId") && !isId(entry.categoryId))
        paths.push(`${path}.categoryId`);
      if (Object.hasOwn(entry, "name") && !isName(entry.name))
        paths.push(`${path}.name`);
      if (Object.hasOwn(entry, "priceCents") && !isCents(entry.priceCents))
        paths.push(`${path}.priceCents`);
      if (Object.hasOwn(entry, "available") && !isFlag(entry.available))
        paths.push(`${path}.available`);
      if (Object.hasOwn(entry, "archived") && !isFlag(entry.archived))
        paths.push(`${path}.archived`);
    });

  if (raw.pricingPolicy !== null) {
    const policy = validatePricingPolicy(raw.pricingPolicy);
    if (!policy.ok)
      paths.push(
        ...policy.errors.map((entry) => `pricingPolicy.${entry.path}`),
      );
  }
  if (catalog.ok && Array.isArray(products)) {
    const ids = new Set<string>();
    const productCategories = new Set(
      catalog.value.categories
        .filter((category) => category.kind === "PRODUCT")
        .map((category) => category.id),
    );
    products.forEach((product, index) => {
      if (!plain(product) || !isId(product.id) || !isId(product.categoryId))
        return;
      if (typeof product.name !== "string") return;
      const normalizedName = product.name.toLocaleLowerCase();
      if (ids.has(product.id)) paths.push(`simpleProducts[${index}].id`);
      ids.add(product.id);
      if (
        products.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            plain(other) &&
            other.categoryId === product.categoryId &&
            typeof other.name === "string" &&
            other.name.toLocaleLowerCase() === normalizedName,
        )
      )
        paths.push(`simpleProducts[${index}].name`);
      if (!productCategories.has(product.categoryId))
        paths.push(`simpleProducts[${index}].categoryId`);
    });
  }
  if (paths.length) return catalogErrors(paths);
  if (!catalog.ok)
    return catalogErrors(catalog.errors.map((entry) => entry.path));
  const policy =
    raw.pricingPolicy === null
      ? null
      : validatePricingPolicy(raw.pricingPolicy);
  return {
    ok: true,
    value: {
      ...catalog.value,
      simpleProducts: structuredClone(products as CatalogSimpleProduct[]),
      pricingPolicy: policy && policy.ok ? policy.value : null,
    },
  };
}

const catalogErrors = (
  paths: string[],
): { ok: false; errors: CatalogError[] } => ({
  ok: false,
  errors: [...new Set(paths)].map((path) => ({ code: CATALOG_ERROR, path })),
});
