import { validatePizzaConfiguration } from "@whiteoven/contracts";
import { evaluatePizza } from "@whiteoven/pizza-pricing";
import { builderMenu } from "../builder/builder.ts";
import type { CartLine } from "../cart/cart.ts";
import type { PublicMenu } from "../menu/menu.ts";

export const ORDER_STATUSES = [
  "PLACED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "COMPLETED",
  "REJECTED",
  "CANCELED",
] as const;
export type CustomerOrderStatus = (typeof ORDER_STATUSES)[number];
export type Fulfillment = "DELIVERY" | "PICKUP";

export interface CustomerOrderSummary {
  id: string;
  number: number;
  status: CustomerOrderStatus;
  placedAt: string;
  fulfillment: Fulfillment;
  totalCents: number;
}
export interface CustomerOrderPage {
  orders: CustomerOrderSummary[];
  nextCursor: number | null;
}
export interface CustomerOrderItem {
  kind: "PIZZA" | "PRODUCT";
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  snapshot: Record<string, unknown>;
}
export interface CustomerOrderChange {
  from: CustomerOrderStatus | null;
  to: CustomerOrderStatus;
  reasonCode: string | null;
  at: string;
}
export interface CustomerOrderDetail extends CustomerOrderSummary {
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  paymentMethod: "CASH" | "CARD_ON_DELIVERY" | "PIX_ON_DELIVERY";
  changeForCents: number | null;
  notes: string | null;
  items: CustomerOrderItem[];
  history: CustomerOrderChange[];
  estimate: { prepMinutes: number; deliveryMinutes: number } | null;
  contactPhone: string | null;
}

export class CustomerOrderError extends Error {
  constructor() {
    super("Não foi possível carregar este pedido.");
    this.name = "CustomerOrderError";
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const row = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const cents = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const instant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const status = (value: unknown): value is CustomerOrderStatus =>
  ORDER_STATUSES.includes(value as CustomerOrderStatus);

function summary(value: unknown): CustomerOrderSummary | null {
  const order = row(value);
  if (
    !order ||
    typeof order.id !== "string" ||
    !uuid.test(order.id) ||
    !Number.isSafeInteger(order.number) ||
    (order.number as number) < 1 ||
    !status(order.status) ||
    !instant(order.placedAt) ||
    (order.fulfillment !== "DELIVERY" && order.fulfillment !== "PICKUP") ||
    !cents(order.totalCents)
  )
    return null;
  return {
    id: order.id,
    number: order.number as number,
    status: order.status,
    placedAt: order.placedAt,
    fulfillment: order.fulfillment,
    totalCents: order.totalCents,
  };
}

export function parseCustomerOrderPage(value: unknown): CustomerOrderPage {
  const page = row(value);
  if (
    !page ||
    !Array.isArray(page.orders) ||
    page.orders.length > 50 ||
    !(
      page.nextCursor === null ||
      (Number.isSafeInteger(page.nextCursor) && (page.nextCursor as number) > 0)
    )
  )
    throw new CustomerOrderError();
  const orders = page.orders.map(summary);
  if (
    orders.some((order) => !order) ||
    orders.some(
      (order, index) => index > 0 && orders[index - 1]!.number <= order!.number,
    )
  )
    throw new CustomerOrderError();
  return {
    orders: orders as CustomerOrderSummary[],
    nextCursor: page.nextCursor as number | null,
  };
}

export function parseCustomerOrderDetail(value: unknown): CustomerOrderDetail {
  const order = row(value);
  const parsed = summary(value);
  const methods = ["CASH", "CARD_ON_DELIVERY", "PIX_ON_DELIVERY"];
  if (
    !order ||
    !parsed ||
    !cents(order.itemsSubtotalCents) ||
    !cents(order.deliveryFeeCents) ||
    !cents(order.discountCents) ||
    typeof order.paymentMethod !== "string" ||
    !methods.includes(order.paymentMethod) ||
    !(order.changeForCents === null || cents(order.changeForCents)) ||
    !(
      order.notes === null ||
      (typeof order.notes === "string" && order.notes.length <= 280)
    ) ||
    !Array.isArray(order.items) ||
    order.items.length > 30 ||
    !Array.isArray(order.history) ||
    order.history.length > 100 ||
    !(
      order.contactPhone === null ||
      (typeof order.contactPhone === "string" &&
        order.contactPhone.length <= 32)
    ) ||
    !(
      order.estimate === null ||
      (row(order.estimate) !== null &&
        Number.isSafeInteger(row(order.estimate)!.prepMinutes) &&
        Number.isSafeInteger(row(order.estimate)!.deliveryMinutes) &&
        (row(order.estimate)!.prepMinutes as number) >= 1 &&
        (row(order.estimate)!.prepMinutes as number) <= 240 &&
        (row(order.estimate)!.deliveryMinutes as number) >= 1 &&
        (row(order.estimate)!.deliveryMinutes as number) <= 240)
    )
  )
    throw new CustomerOrderError();
  const items = order.items.map((value) => {
    const item = row(value);
    if (
      !item ||
      (item.kind !== "PIZZA" && item.kind !== "PRODUCT") ||
      !Number.isSafeInteger(item.quantity) ||
      (item.quantity as number) < 1 ||
      (item.quantity as number) > 20 ||
      !cents(item.unitPriceCents) ||
      !cents(item.totalCents) ||
      !row(item.snapshot)
    )
      throw new CustomerOrderError();
    return item as unknown as CustomerOrderItem;
  });
  const history = order.history.map((value) => {
    const change = row(value);
    if (
      !change ||
      !(change.from === null || status(change.from)) ||
      !status(change.to) ||
      !(change.reasonCode === null || typeof change.reasonCode === "string") ||
      !instant(change.at)
    )
      throw new CustomerOrderError();
    return change as unknown as CustomerOrderChange;
  });
  return {
    ...parsed,
    itemsSubtotalCents: order.itemsSubtotalCents,
    deliveryFeeCents: order.deliveryFeeCents,
    discountCents: order.discountCents,
    paymentMethod: order.paymentMethod as CustomerOrderDetail["paymentMethod"],
    changeForCents: order.changeForCents as number | null,
    notes: order.notes as string | null,
    items,
    history,
    estimate: order.estimate as CustomerOrderDetail["estimate"],
    contactPhone: order.contactPhone as string | null,
  };
}

/** Rebuilds only lines still valid and priced by the current public menu. */
export function reorderLines(
  order: CustomerOrderDetail,
  menu: PublicMenu,
  uuidFactory: () => string,
): { lines: CartLine[]; skipped: number } {
  const built = builderMenu(menu);
  const lines: CartLine[] = [];
  let skipped = 0;
  for (const item of order.items) {
    const snapshot = item.snapshot;
    if (item.kind === "PRODUCT") {
      const product = row(snapshot["product"]);
      const current =
        product &&
        menu.simpleProducts.find((entry) => entry.id === product["id"]);
      if (!current || item.quantity > 20) {
        skipped++;
        continue;
      }
      const existing = lines.find(
        (line) => line.kind === "PRODUCT" && line.productId === current.id,
      );
      if (existing?.kind === "PRODUCT") {
        if (existing.quantity + item.quantity > 20) {
          skipped++;
          continue;
        }
        existing.quantity += item.quantity;
      } else {
        lines.push({
          id: uuidFactory(),
          kind: "PRODUCT",
          productId: current.id,
          name: current.name,
          quantity: item.quantity,
        });
      }
      continue;
    }
    const size = row(snapshot["size"]);
    const flavors = row(snapshot["flavors"]);
    const crust = row(snapshot["crust"]);
    if (!size || !flavors || !menu.pricingPolicy) {
      skipped++;
      continue;
    }
    const pizza = validatePizzaConfiguration({
      sizeId: size["id"],
      mode: snapshot["mode"],
      flavors: {
        LEFT: row(flavors["LEFT"])?.["id"],
        ...(flavors["RIGHT"] ? { RIGHT: row(flavors["RIGHT"])?.["id"] } : {}),
      },
      crustId: crust ? crust["id"] : null,
      extras: Array.isArray(snapshot["extras"])
        ? snapshot["extras"].map((entry) => ({
            extraId: row(entry)?.["id"],
            placement: row(entry)?.["placement"],
          }))
        : [],
      removals: Array.isArray(snapshot["removals"])
        ? snapshot["removals"].map((entry) => ({
            ingredientId: row(entry)?.["id"],
            placement: row(entry)?.["placement"],
          }))
        : [],
      quantity: item.quantity,
    });
    if (
      !pizza.ok ||
      !evaluatePizza(pizza.value, built.index, menu.pricingPolicy).ok
    ) {
      skipped++;
      continue;
    }
    const flavorNames = Object.values(pizza.value.flavors).map(
      (id) => menu.flavors.find((flavor) => flavor.id === id)?.name ?? "Pizza",
    );
    lines.push({
      id: uuidFactory(),
      kind: "PIZZA",
      name: flavorNames.join(" / "),
      pizza: pizza.value,
    });
  }
  return { lines, skipped };
}

export function statusLabel(
  status: CustomerOrderStatus,
  fulfillment: Fulfillment,
): string {
  switch (status) {
    case "PLACED":
      return "Aguardando confirmação";
    case "PREPARING":
      return "Em preparo";
    case "READY":
      return fulfillment === "PICKUP"
        ? "Pronto para retirada"
        : "Pedido pronto";
    case "OUT_FOR_DELIVERY":
      return "Saiu para entrega";
    case "COMPLETED":
      return fulfillment === "PICKUP" ? "Retirado" : "Entregue";
    case "REJECTED":
      return "Recusado pela pizzaria";
    case "CANCELED":
      return "Cancelado";
  }
}
