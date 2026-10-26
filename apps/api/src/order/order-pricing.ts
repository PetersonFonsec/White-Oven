import type {
  CatalogManagementSnapshot,
  HalfAndHalfStrategy,
  Placement,
  PricingPolicy,
} from "@whiteoven/contracts";
import { evaluatePizza, indexCatalog } from "@whiteoven/pizza-pricing";
import type { CustomerAddress } from "../customer/customer-rules";
import type { Fulfillment, OrderRequest, PaymentMethod } from "./order-rules";

/** What the store's settings decide about an order (StoreSettings, ADR 0013). */
export interface OrderSettings {
  fulfillmentModes: Fulfillment[];
  deliveryFeeCents: number;
  minimumOrderCents: number;
  acceptedPaymentMethods: PaymentMethod[];
}

export interface PizzaLineSnapshot {
  size: { id: string; name: string };
  mode: "WHOLE" | "HALVES";
  flavors: {
    LEFT: { id: string; name: string; priceCents: number };
    RIGHT?: { id: string; name: string; priceCents: number };
  };
  crust: { id: string; name: string; priceCents: number } | null;
  extras: {
    id: string;
    name: string;
    placement: Placement;
    priceCents: number;
  }[];
  removals: { id: string; name: string; placement: Placement }[];
  /** Null when the pizza is WHOLE. */
  strategy: HalfAndHalfStrategy | null;
  baseCents: number;
  surchargeCents: number;
  crustCents: number;
  extrasCents: number;
}

export interface ProductLineSnapshot {
  product: { id: string; name: string; priceCents: number };
}

export type QuotedLine =
  | {
      kind: "PIZZA";
      quantity: number;
      unitPriceCents: number;
      totalCents: number;
      snapshot: PizzaLineSnapshot;
    }
  | {
      kind: "PRODUCT";
      quantity: number;
      unitPriceCents: number;
      totalCents: number;
      snapshot: ProductLineSnapshot;
    };

export interface OrderQuote {
  items: QuotedLine[];
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  /** Always 0 in the MVP (no coupons); the field keeps the contract stable. */
  discountCents: number;
  totalCents: number;
}

export interface OrderIssue {
  code: string;
  path: string;
}

export type PricingResult =
  | { ok: true; quote: OrderQuote }
  | { ok: false; issues: OrderIssue[]; minimumOrderCents?: number };

/**
 * Validations 3 to 7 of order-lifecycle.md#checkout, against the catalog and settings read in the
 * order's transaction. Pure: the same request, catalog and settings always give the same quote.
 * Prices come only from the catalog; the request carries none. `address` is the customer's saved
 * address the request names, or null when it does not exist (or is not theirs).
 */
export function priceOrder(
  request: OrderRequest,
  catalog: CatalogManagementSnapshot,
  policy: PricingPolicy | null,
  settings: OrderSettings,
  address: CustomerAddress | null,
): PricingResult {
  const issues: OrderIssue[] = [];
  if (!settings.fulfillmentModes.includes(request.fulfillment))
    issues.push({ code: "FULFILLMENT_UNAVAILABLE", path: "fulfillment" });
  if (request.fulfillment === "DELIVERY" && !address)
    issues.push({ code: "ADDRESS_NOT_FOUND", path: "addressId" });
  if (!settings.acceptedPaymentMethods.includes(request.paymentMethod))
    issues.push({ code: "PAYMENT_METHOD_UNAVAILABLE", path: "paymentMethod" });

  const index = indexCatalog(catalog);
  const products = new Map(catalog.simpleProducts.map((p) => [p.id, p]));
  const categories = new Map(catalog.categories.map((c) => [c.id, c]));
  const items: QuotedLine[] = [];
  request.items.forEach((line, position) => {
    const path = `items[${position}]`;
    if (line.kind === "PRODUCT") {
      const product = products.get(line.productId);
      const category = product && categories.get(product.categoryId);
      if (
        !product ||
        !product.available ||
        product.archived ||
        !category ||
        category.archived ||
        category.kind !== "PRODUCT"
      )
        return void issues.push({
          code: "PRODUCT_UNAVAILABLE",
          path: `${path}.productId`,
        });
      items.push({
        kind: "PRODUCT",
        quantity: line.quantity,
        unitPriceCents: product.priceCents,
        totalCents: product.priceCents * line.quantity,
        snapshot: {
          product: {
            id: product.id,
            name: product.name,
            priceCents: product.priceCents,
          },
        },
      });
      return;
    }
    if (!policy)
      return void issues.push({ code: "PIZZA_PRICING_UNAVAILABLE", path });
    const result = evaluatePizza(line.pizza, index, policy);
    if (!result.ok)
      return void issues.push(
        ...result.errors.map((error) => ({
          code: error.code,
          path: error.path ? `${path}.pizza.${error.path}` : `${path}.pizza`,
        })),
      );
    const { configuration, price } = result;
    const name = <T extends { name: string }>(item: T | undefined) =>
      item!.name;
    const flavor = (id: string, priceCents: number) => ({
      id,
      name: name(index.flavors.get(id)),
      priceCents,
    });
    items.push({
      kind: "PIZZA",
      quantity: price.quantity,
      unitPriceCents: price.unitPriceCents,
      totalCents: price.totalCents,
      snapshot: {
        size: {
          id: configuration.sizeId,
          name: name(index.sizes.get(configuration.sizeId)),
        },
        mode: configuration.mode,
        flavors: {
          LEFT: flavor(configuration.flavors.LEFT, price.flavorPrices.LEFT),
          ...(configuration.flavors.RIGHT !== undefined &&
          price.flavorPrices.RIGHT !== undefined
            ? {
                RIGHT: flavor(
                  configuration.flavors.RIGHT,
                  price.flavorPrices.RIGHT,
                ),
              }
            : {}),
        },
        crust:
          configuration.crustId === null
            ? null
            : {
                id: configuration.crustId,
                name: name(index.crusts.get(configuration.crustId)),
                priceCents: price.crustCents,
              },
        extras: price.extras.map((extra) => ({
          id: extra.extraId,
          name: name(index.extras.get(extra.extraId)),
          placement: extra.placement,
          priceCents: extra.priceCents,
        })),
        removals: configuration.removals.map((removal) => ({
          id: removal.ingredientId,
          name: name(index.ingredients.get(removal.ingredientId)),
          placement: removal.placement,
        })),
        strategy: price.strategy,
        baseCents: price.baseCents,
        surchargeCents: price.surchargeCents,
        crustCents: price.crustCents,
        extrasCents: price.extrasCents,
      },
    });
  });
  if (issues.length) return { ok: false, issues };

  const itemsSubtotalCents = items.reduce(
    (sum, item) => sum + item.totalCents,
    0,
  );
  if (itemsSubtotalCents < settings.minimumOrderCents)
    return {
      ok: false,
      issues: [{ code: "MINIMUM_ORDER_NOT_REACHED", path: "items" }],
      minimumOrderCents: settings.minimumOrderCents,
    };
  const deliveryFeeCents =
    request.fulfillment === "DELIVERY" ? settings.deliveryFeeCents : 0;
  const discountCents = 0;
  const totalCents = itemsSubtotalCents + deliveryFeeCents - discountCents;
  if (request.changeForCents !== null && request.changeForCents < totalCents)
    return {
      ok: false,
      issues: [{ code: "CHANGE_FOR_TOO_LOW", path: "changeForCents" }],
    };
  return {
    ok: true,
    quote: {
      items,
      itemsSubtotalCents,
      deliveryFeeCents,
      discountCents,
      totalCents,
    },
  };
}
