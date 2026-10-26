export const ORDER_STATUSES = [
  "PLACED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "COMPLETED",
  "REJECTED",
  "CANCELED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const REJECTION_REASONS = [
  "CUSTOMER_REQUEST",
  "ITEM_UNAVAILABLE",
  "STORE_TOO_BUSY",
  "OUT_OF_DELIVERY_AREA",
  "CUSTOMER_UNREACHABLE",
  "NOT_PICKED_UP",
  "SUSPECTED_FRAUD",
  "ACCEPT_TIMEOUT",
  "STORE_SUSPENDED",
  "OTHER",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export function transitionAllowed(
  from: OrderStatus,
  to: OrderStatus,
  fulfillment: "DELIVERY" | "PICKUP",
  actor: "CUSTOMER" | "STAFF" | "SYSTEM",
): boolean {
  if (actor === "CUSTOMER") return from === "PLACED" && to === "CANCELED";
  if (actor === "SYSTEM") return from === "PLACED" && to === "REJECTED";
  return (
    (from === "PLACED" && ["PREPARING", "REJECTED"].includes(to)) ||
    (from === "PREPARING" && ["READY", "CANCELED"].includes(to)) ||
    (from === "READY" &&
      ((to === "OUT_FOR_DELIVERY" && fulfillment === "DELIVERY") ||
        (to === "COMPLETED" && fulfillment === "PICKUP") ||
        to === "CANCELED")) ||
    (from === "OUT_FOR_DELIVERY" && ["COMPLETED", "CANCELED"].includes(to))
  );
}

export function reasonRequired(to: OrderStatus): boolean {
  return to === "REJECTED" || to === "CANCELED";
}
