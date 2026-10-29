import type { PizzaConfiguration } from "@whiteoven/contracts";

export type CartLine =
  | { id: string; kind: "PIZZA"; name: string; pizza: PizzaConfiguration }
  | {
      id: string;
      kind: "PRODUCT";
      name: string;
      productId: string;
      quantity: number;
    };

export interface CheckoutDetails {
  fulfillment: "PICKUP" | "DELIVERY";
  addressId: string | null;
  paymentMethod: "CASH" | "PIX_ON_DELIVERY" | "CARD_ON_DELIVERY";
  changeForCents: number | null;
  notes: string | null;
}

export function addPizza(
  lines: CartLine[],
  line: Extract<CartLine, { kind: "PIZZA" }>,
): CartLine[] {
  if (lines.length >= 30) throw new Error("O carrinho permite até 30 itens.");
  return [...lines, JSON.parse(JSON.stringify(line)) as CartLine];
}

export function addProduct(
  lines: CartLine[],
  product: { id: string; name: string; productId: string },
): CartLine[] {
  const existing = lines.find(
    (line) => line.kind === "PRODUCT" && line.productId === product.productId,
  );
  if (!existing && lines.length >= 30)
    throw new Error("O carrinho permite até 30 itens.");
  if (existing && existing.kind === "PRODUCT" && existing.quantity >= 20)
    throw new Error("Limite de 20 unidades por produto.");
  if (!existing)
    return [...lines, { ...product, kind: "PRODUCT", quantity: 1 }];
  return lines.map((line) =>
    line.id === existing.id && line.kind === "PRODUCT"
      ? { ...line, quantity: line.quantity + 1 }
      : line,
  );
}

export function removeLine(lines: CartLine[], id: string): CartLine[] {
  return lines.filter((line) => line.id !== id);
}

export function orderBody(lines: CartLine[], details: CheckoutDetails) {
  return {
    fulfillment: details.fulfillment,
    addressId: details.fulfillment === "DELIVERY" ? details.addressId : null,
    paymentMethod: details.paymentMethod,
    changeForCents:
      details.paymentMethod === "CASH" ? details.changeForCents : null,
    notes: details.notes?.trim() || null,
    items: lines.map((line) =>
      line.kind === "PIZZA"
        ? { kind: "PIZZA", pizza: line.pizza }
        : {
            kind: "PRODUCT",
            productId: line.productId,
            quantity: line.quantity,
          },
    ),
  };
}

export function changeQuantity(
  lines: CartLine[],
  id: string,
  quantity: number,
): CartLine[] {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20)
    throw new Error("Escolha entre 1 e 20 unidades.");
  return lines.map((line) =>
    line.id !== id
      ? line
      : line.kind === "PRODUCT"
        ? { ...line, quantity }
        : { ...line, pizza: { ...line.pizza, quantity } },
  );
}
