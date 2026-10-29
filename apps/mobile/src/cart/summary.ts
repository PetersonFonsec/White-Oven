import { evaluatePizza } from "@whiteoven/pizza-pricing";
import {
  builderMenu,
  describeOrderLine,
  describePizza,
} from "../builder/builder.ts";
import type { PublicMenu } from "../menu/menu.ts";
import type { CartLine, CheckoutDetails } from "./cart.ts";

export interface CheckoutSettings {
  fulfillmentModes: CheckoutDetails["fulfillment"][];
  acceptedPaymentMethods: CheckoutDetails["paymentMethod"][];
  deliveryFeeCents: number;
  minimumOrderCents: number;
  deliveryAreaDescription: string | null;
  pickupAddress: string | null;
}
export function parseCheckoutSettings(raw: unknown): CheckoutSettings | null {
  const value = raw as Partial<CheckoutSettings> | null;
  if (
    !value ||
    !Array.isArray(value.fulfillmentModes) ||
    !value.fulfillmentModes.length ||
    value.fulfillmentModes.some((v) => !["DELIVERY", "PICKUP"].includes(v)) ||
    !Array.isArray(value.acceptedPaymentMethods) ||
    !value.acceptedPaymentMethods.length ||
    value.acceptedPaymentMethods.some(
      (v) => !["CASH", "CARD_ON_DELIVERY", "PIX_ON_DELIVERY"].includes(v),
    ) ||
    ![value.deliveryFeeCents, value.minimumOrderCents].every(
      (v) => Number.isSafeInteger(v) && v! >= 0,
    ) ||
    ![value.deliveryAreaDescription, value.pickupAddress].every(
      (v) => v === null || typeof v === "string",
    )
  )
    return null;
  return value as CheckoutSettings;
}
export function cartSummary(lines: CartLine[], menu: PublicMenu | null) {
  const builder = menu ? builderMenu(menu) : null;
  return lines.map((line) => {
    if (line.kind === "PRODUCT") {
      const product = menu?.simpleProducts.find((p) => p.id === line.productId);
      return {
        id: line.id,
        name: product?.name ?? line.name,
        quantity: line.quantity,
        details: [],
        totalCents: product ? product.priceCents * line.quantity : null,
      };
    }
    const result =
      builder && menu?.pricingPolicy
        ? evaluatePizza(line.pizza, builder.index, menu.pricingPolicy)
        : null;
    return {
      id: line.id,
      name: line.name,
      quantity: line.pizza.quantity,
      details: builder
        ? [
            ...describePizza(builder, line.pizza).map((half) => half.text),
            describeOrderLine(builder, line.pizza),
          ]
        : [],
      totalCents: result?.ok ? result.price.totalCents : null,
    };
  });
}
export function moneyInput(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^\d{1,6}([,.]\d{1,2})?$/.test(value.trim()))
    throw new Error("Informe o troco em reais, por exemplo 100,00.");
  const cents = Math.round(Number(value.trim().replace(",", ".")) * 100);
  if (cents > 10_000_000) throw new Error("O valor do troco é muito alto.");
  return cents;
}
