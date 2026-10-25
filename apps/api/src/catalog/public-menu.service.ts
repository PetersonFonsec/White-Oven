import { Injectable } from "@nestjs/common";
import { IsolationLevel } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { currentTenantContext } from "../tenancy/tenant-context";
import { TenantTransactions } from "../tenancy/tenant-transaction";

/** Upper bound of cached tenant menus per API instance; the least recently used one leaves first. */
export const PUBLIC_MENU_CACHE_LIMIT = 500;

interface PublicMenuCatalog {
  categories: { id: string; name: string; kind: "PIZZA" | "PRODUCT" }[];
  sizes: { id: string; name: string; slices: number; maxFlavors: 1 | 2 }[];
  ingredients: { id: string; name: string; removable: boolean }[];
  flavors: {
    id: string;
    categoryId: string;
    name: string;
    description: string | null;
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
  }[];
  pricingPolicy: {
    halfAndHalfStrategy: "HIGHEST" | "AVERAGE";
    halfAndHalfSurchargeCents: number;
    maxExtrasPerHalf: number;
  } | null;
}

export interface PublicMenu extends PublicMenuCatalog {
  store: { slug: string; name: string };
  version: number;
}

/**
 * Public menu of `/v1/public/stores/{slug}/menu` (M2.6), derived from the catalog tables at read
 * time (domain-model.md#publicação-do-cardápio). Only orderable items appear: not archived,
 * available, in a non-archived category and with a price on an available size. Sizes without a
 * pizza, crusts and extras without a price on a listed size, empty categories and archived
 * ingredients are left out.
 *
 * Cache: one entry per tenant, keyed by `catalog_versions.version`, which a trigger bumps in the
 * same transaction as any catalog write. The version and every catalog query run in one
 * REPEATABLE READ transaction, so they all see the same snapshot: a menu is stored exactly under
 * the version of the data it was built from, never mixed with a write committed meanwhile, and
 * every API instance sees writes made through any other one. The store name and slug are read on
 * every request and never cached.
 */
@Injectable()
export class PublicMenuService {
  private readonly cache = new Map<
    string,
    { version: number; catalog: PublicMenuCatalog }
  >();

  constructor(private readonly transactions: TenantTransactions) {}

  get(): Promise<PublicMenu> {
    const { tenantId } = currentTenantContext();
    return this.transactions.run(
      async (em) => {
        const [head] = await em.execute<
          { slug: string; name: string; version: string }[]
        >(
          `select t.slug, t.display_name as name,
                coalesce((select v.version from catalog_versions v), 0) as version
           from tenants t where t.id = ?`,
          [tenantId],
        );
        const version = Number(head!.version);
        let catalog = this.cached(tenantId, version);
        if (!catalog) {
          catalog = await this.build(em);
          this.store(tenantId, version, catalog);
        }
        return {
          store: { slug: head!.slug, name: head!.name },
          version,
          ...catalog,
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ },
    );
  }

  private cached(tenantId: string, version: number) {
    const entry = this.cache.get(tenantId);
    if (!entry || entry.version !== version) return undefined;
    // Refresh the LRU position.
    this.cache.delete(tenantId);
    this.cache.set(tenantId, entry);
    return entry.catalog;
  }

  private store(tenantId: string, version: number, catalog: PublicMenuCatalog) {
    const current = this.cache.get(tenantId);
    // A slower request must not replace a newer menu built meanwhile.
    if (current && current.version > version) return;
    this.cache.delete(tenantId);
    this.cache.set(tenantId, { version, catalog });
    if (this.cache.size > PUBLIC_MENU_CACHE_LIMIT)
      this.cache.delete(this.cache.keys().next().value!);
  }

  private async build(em: EntityManager): Promise<PublicMenuCatalog> {
    const [
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
    ] = await Promise.all([
      em.execute<PublicMenuCatalog["categories"]>(
        `select id, name, kind from catalog_categories where archived_at is null order by sort_order, name`,
      ),
      em.execute<PublicMenuCatalog["sizes"]>(
        `select id, name, slices, max_flavors as "maxFlavors" from pizza_sizes
          where archived_at is null and available order by sort_order, slices`,
      ),
      em.execute<PublicMenuCatalog["ingredients"]>(
        `select id, name, removable from catalog_ingredients where archived_at is null order by name`,
      ),
      em.execute<PublicMenuCatalog["flavors"]>(
        `select f.id, f.category_id as "categoryId", f.name, f.description,
                coalesce(array_agg(i.id order by i.name) filter (where i.id is not null), '{}') as "ingredientIds"
           from catalog_flavors f
           join catalog_categories c on c.tenant_id = f.tenant_id and c.id = f.category_id and c.archived_at is null
           left join catalog_flavor_ingredients fi on fi.tenant_id = f.tenant_id and fi.flavor_id = f.id
           left join catalog_ingredients i on i.tenant_id = fi.tenant_id and i.id = fi.ingredient_id and i.archived_at is null
          where f.archived_at is null and f.available
          group by f.id order by f.name`,
      ),
      em.execute<PublicMenuCatalog["flavorPrices"]>(
        `select flavor_id as "flavorId", size_id as "sizeId", price_cents as "priceCents"
           from catalog_flavor_prices order by flavor_id, size_id`,
      ),
      em.execute<PublicMenuCatalog["crusts"]>(
        `select id, name from catalog_crusts where archived_at is null and available order by name`,
      ),
      em.execute<PublicMenuCatalog["crustPrices"]>(
        `select crust_id as "crustId", size_id as "sizeId", price_cents as "priceCents"
           from catalog_crust_prices order by crust_id, size_id`,
      ),
      em.execute<PublicMenuCatalog["extras"]>(
        `select id, name from catalog_extras where archived_at is null and available order by name`,
      ),
      em.execute<PublicMenuCatalog["extraPrices"]>(
        `select extra_id as "extraId", size_id as "sizeId", whole_price_cents as "wholePriceCents",
                half_price_cents as "halfPriceCents"
           from catalog_extra_prices order by extra_id, size_id`,
      ),
      em.execute<PublicMenuCatalog["simpleProducts"]>(
        `select p.id, p.category_id as "categoryId", p.name, p.price_cents as "priceCents"
           from catalog_simple_products p
           join catalog_categories c on c.tenant_id = p.tenant_id and c.id = p.category_id and c.archived_at is null
          where p.archived_at is null and p.available order by p.name`,
      ),
      em.execute<NonNullable<PublicMenuCatalog["pricingPolicy"]>[]>(
        `select half_and_half_strategy as "halfAndHalfStrategy",
                half_and_half_surcharge_cents as "halfAndHalfSurchargeCents",
                max_extras_per_half as "maxExtrasPerHalf"
           from catalog_pricing_policies limit 1`,
      ),
    ]);

    const flavorIds = new Set(flavors.map((flavor) => flavor.id));
    const availableSizeIds = new Set(sizes.map((size) => size.id));
    const visibleFlavorPrices = flavorPrices.filter(
      (price) =>
        flavorIds.has(price.flavorId) && availableSizeIds.has(price.sizeId),
    );
    const pricedFlavors = new Set(visibleFlavorPrices.map((p) => p.flavorId));
    const visibleFlavors = flavors.filter((flavor) =>
      pricedFlavors.has(flavor.id),
    );
    // A size without any pizza is not orderable, nor are its crust and extra prices.
    const sizeIds = new Set(visibleFlavorPrices.map((p) => p.sizeId));
    const pricedOnVisibleSize = <T extends { sizeId: string }>(
      prices: T[],
      ownerIds: Set<string>,
      ownerOf: (price: T) => string,
    ) =>
      prices.filter(
        (price) => sizeIds.has(price.sizeId) && ownerIds.has(ownerOf(price)),
      );

    const visibleCrustPrices = pricedOnVisibleSize(
      crustPrices,
      new Set(crusts.map((crust) => crust.id)),
      (price) => price.crustId,
    );
    const pricedCrusts = new Set(visibleCrustPrices.map((p) => p.crustId));
    const visibleExtraPrices = pricedOnVisibleSize(
      extraPrices,
      new Set(extras.map((extra) => extra.id)),
      (price) => price.extraId,
    );
    const pricedExtras = new Set(visibleExtraPrices.map((p) => p.extraId));
    const usedIngredients = new Set(
      visibleFlavors.flatMap((flavor) => flavor.ingredientIds),
    );
    const usedCategories = new Set([
      ...visibleFlavors.map((flavor) => flavor.categoryId),
      ...simpleProducts.map((product) => product.categoryId),
    ]);

    return {
      categories: categories.filter((category) =>
        usedCategories.has(category.id),
      ),
      sizes: sizes.filter((size) => sizeIds.has(size.id)),
      ingredients: ingredients.filter((ingredient) =>
        usedIngredients.has(ingredient.id),
      ),
      flavors: visibleFlavors,
      flavorPrices: visibleFlavorPrices,
      crusts: crusts.filter((crust) => pricedCrusts.has(crust.id)),
      crustPrices: visibleCrustPrices,
      extras: extras.filter((extra) => pricedExtras.has(extra.id)),
      extraPrices: visibleExtraPrices,
      simpleProducts,
      pricingPolicy: pricingPolicy[0] ?? null,
    };
  }
}
