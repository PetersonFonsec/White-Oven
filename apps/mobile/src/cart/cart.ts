import {
  validatePizzaConfiguration,
  type PizzaConfiguration,
} from "@whiteoven/contracts";

export const CART_LINE_LIMIT = 30;
export const CART_QUANTITY_LIMIT = 20;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

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

/** Validates and copies the structural invariants shared by cart entry points. */
export function validateCartLines(value: unknown): CartLine[] {
  if (!Array.isArray(value) || value.length > CART_LINE_LIMIT)
    throw new Error("O carrinho permite até 30 itens.");
  const lines = value.map((entry): CartLine => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Item inválido no carrinho.");
    const line = entry as Record<string, unknown>;
    if (
      typeof line.id !== "string" ||
      !uuidPattern.test(line.id) ||
      typeof line.name !== "string" ||
      !line.name.trim() ||
      line.name.length > 500
    )
      throw new Error("Item inválido no carrinho.");
    if (line.kind === "PRODUCT") {
      if (
        typeof line.productId !== "string" ||
        !line.productId.trim() ||
        line.productId.length > 64 ||
        !Number.isInteger(line.quantity) ||
        (line.quantity as number) < 1 ||
        (line.quantity as number) > CART_QUANTITY_LIMIT
      )
        throw new Error("Produto inválido no carrinho.");
      return {
        id: line.id,
        kind: "PRODUCT",
        productId: line.productId,
        name: line.name,
        quantity: line.quantity as number,
      };
    }
    if (line.kind === "PIZZA") {
      const pizza = validatePizzaConfiguration(line.pizza);
      if (!pizza.ok) throw new Error("Pizza inválida no carrinho.");
      return {
        id: line.id,
        kind: "PIZZA",
        name: line.name,
        pizza: pizza.value,
      };
    }
    throw new Error("Item inválido no carrinho.");
  });
  if (new Set(lines.map((line) => line.id)).size !== lines.length)
    throw new Error("Itens repetidos no carrinho.");
  const consolidated: CartLine[] = [];
  for (const line of lines) {
    const existing =
      line.kind === "PRODUCT"
        ? consolidated.find(
            (candidate) =>
              candidate.kind === "PRODUCT" &&
              candidate.productId === line.productId,
          )
        : undefined;
    if (existing?.kind === "PRODUCT" && line.kind === "PRODUCT") {
      if (existing.quantity + line.quantity > CART_QUANTITY_LIMIT)
        throw new Error("Limite de 20 unidades por produto.");
      existing.quantity += line.quantity;
    } else {
      consolidated.push(line);
    }
  }
  return consolidated;
}

export function addPizza(
  lines: CartLine[],
  line: Extract<CartLine, { kind: "PIZZA" }>,
): CartLine[] {
  return validateCartLines([...lines, line]);
}

export function addProduct(
  lines: CartLine[],
  product: { id: string; name: string; productId: string },
): CartLine[] {
  const existing = lines.find(
    (line) => line.kind === "PRODUCT" && line.productId === product.productId,
  );
  if (
    existing &&
    existing.kind === "PRODUCT" &&
    existing.quantity >= CART_QUANTITY_LIMIT
  )
    throw new Error("Limite de 20 unidades por produto.");
  if (!existing)
    return validateCartLines([
      ...lines,
      { ...product, kind: "PRODUCT", quantity: 1 },
    ]);
  return validateCartLines(
    lines.map((line) =>
      line.id === existing.id && line.kind === "PRODUCT"
        ? { ...line, quantity: line.quantity + 1 }
        : line,
    ),
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
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > CART_QUANTITY_LIMIT
  )
    throw new Error("Escolha entre 1 e 20 unidades.");
  return lines.map((line) =>
    line.id !== id
      ? line
      : line.kind === "PRODUCT"
        ? { ...line, quantity }
        : { ...line, pizza: { ...line.pizza, quantity } },
  );
}

/** Units in the bag (a line of 2 pizzas counts 2), for the tab badge and the bag title. */
export function cartUnits(lines: CartLine[]): number {
  return lines.reduce(
    (sum, line) =>
      sum + (line.kind === "PRODUCT" ? line.quantity : line.pizza.quantity),
    0,
  );
}
