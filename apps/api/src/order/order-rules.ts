import { createHash } from "node:crypto";
import {
  validatePizzaConfiguration,
  type PizzaConfiguration,
} from "@whiteoven/contracts";

/**
 * Order request rules (order-lifecycle.md#checkout, M4.3). Pure: the API checks the shape here and
 * reports the offending paths, never the values; prices and availability are checked against the
 * catalog by `priceOrder`.
 */

export const FULFILLMENTS = ["DELIVERY", "PICKUP"] as const;
export const PAYMENT_METHODS = [
  "CASH",
  "CARD_ON_DELIVERY",
  "PIX_ON_DELIVERY",
] as const;
export type Fulfillment = (typeof FULFILLMENTS)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ORDER_LINES_MAX = 30;
export const ORDER_LINE_QUANTITY_MAX = 20;
export const ORDER_NOTES_MAX_LENGTH = 280;
/**
 * Upper bound of every amount of an order, in cents (R$ 100.000,00): each line's unit price and
 * total, the items subtotal, the delivery fee and the total, and the amounts the app sends
 * (`changeForCents`, `expectedTotalCents`). Far below PostgreSQL's `integer` (2.147.483.647) and
 * JavaScript's safe integers, so no stored amount can overflow or lose precision.
 */
export const ORDER_CENTS_MAX = 10_000_000;

/** A whole, non-negative amount of cents within `ORDER_CENTS_MAX`. */
export const orderCents = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= ORDER_CENTS_MAX;

export type OrderLine =
  | { kind: "PIZZA"; pizza: PizzaConfiguration }
  | { kind: "PRODUCT"; productId: string; quantity: number };

export interface OrderRequest {
  fulfillment: Fulfillment;
  /** One of the customer's saved addresses; required for DELIVERY, null for PICKUP. */
  addressId: string | null;
  paymentMethod: PaymentMethod;
  /** Cash only: the bill the customer will pay with. */
  changeForCents: number | null;
  notes: string | null;
  items: OrderLine[];
  /**
   * The total the app showed and the customer confirmed. Never used to price. Optional in a quote
   * (it only sets `priceChanged`); required to create, where a different server total refuses the
   * order (`ORDER_PRICE_CHANGED`) so the customer confirms the new price first.
   */
  expectedTotalCents: number | null;
}

export type RuleResult<T> =
  { ok: true; value: T } | { ok: false; paths: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const unknownKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix = "",
) =>
  Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort()
    .map((key) => `${prefix}${key}`);

const REQUEST_KEYS = [
  "fulfillment",
  "addressId",
  "paymentMethod",
  "changeForCents",
  "notes",
  "items",
  "expectedTotalCents",
] as const;

/**
 * `requireExpectedTotal` is the creation's rule: the customer must have confirmed a total, so a
 * missing or null `expectedTotalCents` is invalid there.
 */
export function validateOrderRequest(
  raw: unknown,
  { requireExpectedTotal = false }: { requireExpectedTotal?: boolean } = {},
): RuleResult<OrderRequest> {
  if (!plain(raw)) return { ok: false, paths: [""] };
  const paths = unknownKeys(raw, REQUEST_KEYS);

  const fulfillment = raw["fulfillment"];
  if (!FULFILLMENTS.includes(fulfillment as Fulfillment))
    paths.push("fulfillment");
  const addressId = raw["addressId"] ?? null;
  if (
    fulfillment === "DELIVERY" &&
    !(typeof addressId === "string" && UUID.test(addressId))
  )
    paths.push("addressId");
  if (fulfillment === "PICKUP" && addressId !== null) paths.push("addressId");

  const paymentMethod = raw["paymentMethod"];
  if (!PAYMENT_METHODS.includes(paymentMethod as PaymentMethod))
    paths.push("paymentMethod");
  const changeForCents = raw["changeForCents"] ?? null;
  if (
    changeForCents !== null &&
    (paymentMethod !== "CASH" ||
      !orderCents(changeForCents) ||
      changeForCents === 0)
  )
    paths.push("changeForCents");

  const notesRaw = raw["notes"] ?? null;
  let notes: string | null = null;
  if (notesRaw !== null) {
    if (typeof notesRaw !== "string") paths.push("notes");
    else {
      notes = notesRaw.trim() || null;
      if (notes && [...notes].length > ORDER_NOTES_MAX_LENGTH)
        paths.push("notes");
    }
  }

  const expectedTotalCents = raw["expectedTotalCents"] ?? null;
  if (
    expectedTotalCents === null
      ? requireExpectedTotal
      : !orderCents(expectedTotalCents)
  )
    paths.push("expectedTotalCents");

  const items: OrderLine[] = [];
  const rawItems = raw["items"];
  if (
    !Array.isArray(rawItems) ||
    rawItems.length < 1 ||
    rawItems.length > ORDER_LINES_MAX
  )
    paths.push("items");
  else
    rawItems.forEach((entry, index) => {
      const line = validateLine(entry, `items[${index}]`);
      if (line.ok) items.push(line.value);
      else paths.push(...line.paths);
    });

  if (paths.length) return { ok: false, paths: [...new Set(paths)] };
  return {
    ok: true,
    value: {
      fulfillment: fulfillment as Fulfillment,
      addressId: addressId as string | null,
      paymentMethod: paymentMethod as PaymentMethod,
      changeForCents: changeForCents as number | null,
      notes,
      items,
      expectedTotalCents: expectedTotalCents as number | null,
    },
  };
}

function validateLine(raw: unknown, path: string): RuleResult<OrderLine> {
  if (!plain(raw)) return { ok: false, paths: [path] };
  if (raw["kind"] === "PIZZA") {
    const paths = unknownKeys(raw, ["kind", "pizza"], `${path}.`);
    const pizza = validatePizzaConfiguration(raw["pizza"]);
    if (!pizza.ok)
      paths.push(
        ...pizza.errors.map((error) =>
          error.path ? `${path}.pizza.${error.path}` : `${path}.pizza`,
        ),
      );
    if (paths.length || !pizza.ok) return { ok: false, paths };
    return { ok: true, value: { kind: "PIZZA", pizza: pizza.value } };
  }
  if (raw["kind"] === "PRODUCT") {
    const paths = unknownKeys(
      raw,
      ["kind", "productId", "quantity"],
      `${path}.`,
    );
    const productId = raw["productId"];
    if (!(typeof productId === "string" && UUID.test(productId)))
      paths.push(`${path}.productId`);
    const quantity = raw["quantity"];
    if (
      !Number.isSafeInteger(quantity) ||
      (quantity as number) < 1 ||
      (quantity as number) > ORDER_LINE_QUANTITY_MAX
    )
      paths.push(`${path}.quantity`);
    if (paths.length) return { ok: false, paths };
    return {
      ok: true,
      value: {
        kind: "PRODUCT",
        productId: productId as string,
        quantity: quantity as number,
      },
    };
  }
  return { ok: false, paths: [`${path}.kind`] };
}

/**
 * SHA-256 of the validated request, with keys in a fixed order: a retry of the same order hashes
 * the same however the app ordered the JSON keys, and any other content hashes differently.
 */
export function orderRequestHash(request: OrderRequest): Buffer {
  return createHash("sha256").update(JSON.stringify(request)).digest();
}
