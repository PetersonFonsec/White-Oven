import type { OrderStatus } from "../order/order-lifecycle-rules";
import type { Fulfillment } from "../order/order-rules";

/** What `expo-notifications` returns from `getExpoPushTokenAsync` (and its older spelling). */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;

/** A delivery older than this is dropped: a late "saiu para entrega" only confuses. */
export const PUSH_DELIVERY_MAX_AGE_MINUTES = 30;
/** Attempts after which a delivery that never reached Expo is given up. */
export const PUSH_MAX_ATTEMPTS = 5;
/** Expo accepts at most 100 messages per request. */
export const EXPO_BATCH_SIZE = 100;

export type NotifiedStatus = Extract<
  OrderStatus,
  | "PREPARING"
  | "READY"
  | "OUT_FOR_DELIVERY"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELED"
>;

/**
 * The notification text: the order number and its new state, nothing else. No customer name,
 * address, items, totals or the store's free-text reason ever leave in a push (roadmap M5.5).
 */
export function pushBody(
  status: NotifiedStatus,
  fulfillment: Fulfillment,
  number: number,
): string {
  const order = `Pedido #${number}`;
  switch (status) {
    case "PREPARING":
      return `${order} aceito e em preparo.`;
    case "READY":
      return fulfillment === "PICKUP"
        ? `${order} pronto para retirada.`
        : `${order} pronto. Logo sai para entrega.`;
    case "OUT_FOR_DELIVERY":
      return `${order} saiu para entrega.`;
    case "COMPLETED":
      return fulfillment === "PICKUP"
        ? `${order} retirado. Bom apetite!`
        : `${order} entregue. Bom apetite!`;
    case "REJECTED":
      return `A pizzaria não pôde aceitar o pedido #${number}.`;
    case "CANCELED":
      return `O pedido #${number} foi cancelado pela pizzaria.`;
  }
}

/** Seconds until the next attempt after `attempts` failed ones: 30 s, 60 s, 120 s, 240 s. */
export function pushRetryDelaySeconds(attempts: number): number {
  return 30 * 2 ** Math.max(0, attempts - 1);
}

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Read by the app to open the order; only ids. */
  data: { type: "order-status"; orderId: string };
}

/**
 * Expo's answer for one message. `deviceGone` (`DeviceNotRegistered`) deletes the device;
 * `retry` errors (rate limits) are tried again; any other error is final for that message.
 */
export type PushTicket =
  { ok: true } | { ok: false; deviceGone: boolean; retry: boolean };

/** Expo error codes of one ticket that are worth another attempt. */
const RETRY_ERRORS = new Set(["MessageRateExceeded"]);

/** Reads Expo's `{ data: [...] }` answer; anything unexpected is a failed request. */
export function parseExpoTickets(raw: unknown, count: number): PushTicket[] {
  const data = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== count)
    throw new PushRequestError("unexpected Expo response");
  return data.map((ticket: unknown) => {
    const value = ticket as {
      status?: unknown;
      details?: { error?: unknown };
    } | null;
    if (value?.status === "ok") return { ok: true };
    const error = value?.details?.error;
    return {
      ok: false,
      deviceGone: error === "DeviceNotRegistered",
      retry: typeof error === "string" && RETRY_ERRORS.has(error),
    };
  });
}

/** The whole request failed (network, timeout, 429/5xx, malformed answer): try again later. */
export class PushRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushRequestError";
  }
}

export type MessageState = "PENDING" | "SENT" | "FAILED" | "SKIPPED";

/** What one ticket does to its message: `GONE` also deletes the device. */
export function messageOutcome(
  ticket: PushTicket,
): "SENT" | "FAILED" | "GONE" | "RETRY" {
  if (ticket.ok) return "SENT";
  if (ticket.deviceGone) return "GONE";
  return ticket.retry ? "RETRY" : "FAILED";
}

/**
 * The delivery after a pass, from its messages' states. Messages still `PENDING` (a failed
 * request or a rate limit) are retried alone, until `attempts` reaches the limit; messages Expo
 * already accepted are never part of a retry.
 */
export function deliveryOutcome(
  states: readonly MessageState[],
  attempts: number,
): "SENT" | "FAILED" | "SKIPPED" | "RETRY" {
  if (states.includes("PENDING"))
    return attempts + 1 >= PUSH_MAX_ATTEMPTS ? "FAILED" : "RETRY";
  if (states.includes("SENT")) return "SENT";
  return states.every((state) => state === "SKIPPED") ? "SKIPPED" : "FAILED";
}
