import type { OrderItem, OrderStatus } from "./orders-api";

/** Labels shared by the order board and the history (order-lifecycle.md). */
export const PAYMENT_LABELS: Record<string, string> = {
  CASH: "Dinheiro",
  CARD_ON_DELIVERY: "Cartão na entrega ou retirada",
  PIX_ON_DELIVERY: "Pix presencial",
};

/** One order's status, in the singular. */
export const STATUS_LABELS: Record<OrderStatus, string> = {
  PLACED: "Aguardando aceite",
  PREPARING: "Em preparo",
  READY: "Pronto",
  OUT_FOR_DELIVERY: "Em entrega",
  COMPLETED: "Concluído",
  REJECTED: "Recusado",
  CANCELED: "Cancelado",
};

export const REASON_LABELS: Record<string, string> = {
  CUSTOMER_REQUEST: "Pedido do cliente",
  ITEM_UNAVAILABLE: "Item indisponível",
  STORE_TOO_BUSY: "Loja muito ocupada",
  OUT_OF_DELIVERY_AREA: "Fora da área de entrega",
  CUSTOMER_UNREACHABLE: "Cliente não localizado",
  NOT_PICKED_UP: "Não retirado",
  SUSPECTED_FRAUD: "Suspeita de fraude",
  ACCEPT_TIMEOUT: "Tempo de aceite esgotado",
  STORE_SUSPENDED: "Loja suspensa",
  OTHER: "Outro motivo",
};

export const FULFILLMENT_LABELS: Record<string, string> = {
  DELIVERY: "Entrega",
  PICKUP: "Retirada",
};

/** Size and flavors of a pizza line, or the product's name, from the order's snapshot. */
export function itemName(item: OrderItem): string {
  const snap = item.snapshot;
  if (item.kind === "PRODUCT") {
    const product = snap["product"] as { name?: unknown } | undefined;
    return typeof product?.name === "string" ? product.name : "Produto";
  }
  const size = snap["size"] as { name?: unknown } | undefined;
  const flavors = snap["flavors"] as
    Record<string, { name?: unknown } | undefined> | undefined;
  const names = [flavors?.["LEFT"]?.name, flavors?.["RIGHT"]?.name].filter(
    (name): name is string => typeof name === "string",
  );
  return `${typeof size?.name === "string" ? size.name : "Pizza"} · ${names.join(" / ") || "Sabores"}`;
}

/** Crust, extras and removals of a pizza line; empty for products. */
export function itemDetails(item: OrderItem): string {
  if (item.kind !== "PIZZA") return "";
  const snapshot = item.snapshot;
  const crust = snapshot["crust"] as { name?: unknown } | null;
  const extras = snapshot["extras"] as { name?: unknown }[] | undefined;
  const removals = snapshot["removals"] as { name?: unknown }[] | undefined;
  const names = (values: { name?: unknown }[]) =>
    values
      .map((value) => value.name)
      .filter((name): name is string => typeof name === "string")
      .join(", ");
  return [
    typeof crust?.name === "string" ? `Borda: ${crust.name}` : "",
    extras?.length ? `Adicionais: ${names(extras)}` : "",
    removals?.length ? `Sem: ${names(removals)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
