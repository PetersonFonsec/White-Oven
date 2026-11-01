import type { PublicMenu } from "../menu/menu.ts";
import type {
  CustomerOrderItem,
  CustomerOrderStatus,
  CustomerOrderSummary,
} from "./orders.ts";

/**
 * What the order screens show, decided without React Native so `node --test` covers it. Items
 * are described from the order's immutable snapshot (names as they were when ordered); only the
 * pictures come from the current menu, and an item no longer on it simply has none.
 */

export type OrderFilter = "all" | "active" | "completed" | "canceled";

export const ORDER_FILTERS: readonly { value: OrderFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "active", label: "Em andamento" },
  { value: "completed", label: "Concluídos" },
  { value: "canceled", label: "Cancelados" },
];

const ACTIVE: readonly CustomerOrderStatus[] = [
  "PLACED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
];

export function filterGroup(status: CustomerOrderStatus): OrderFilter {
  if (ACTIVE.includes(status)) return "active";
  return status === "COMPLETED" ? "completed" : "canceled";
}

/** The loaded orders that match a filter; "Carregar mais" still pages through all of them. */
export function filterOrders<T extends Pick<CustomerOrderSummary, "status">>(
  orders: readonly T[],
  filter: OrderFilter,
): T[] {
  return filter === "all"
    ? [...orders]
    : orders.filter((order) => filterGroup(order.status) === filter);
}

/** What the list says when a filter leaves nothing of the loaded orders. */
export function emptyFilterMessage(filter: OrderFilter): string {
  switch (filter) {
    case "active":
      return "Nenhum pedido em andamento agora.";
    case "completed":
      return "Nenhum pedido concluído entre os carregados.";
    case "canceled":
      return "Nenhum pedido cancelado ou recusado entre os carregados.";
    default:
      return "Nenhum pedido.";
  }
}

const MONTHS = [
  "jan.",
  "fev.",
  "mar.",
  "abr.",
  "mai.",
  "jun.",
  "jul.",
  "ago.",
  "set.",
  "out.",
  "nov.",
  "dez.",
];

/**
 * "24 de out. de 2026 às 19:24", in the device's time zone. Written by hand: Hermes does not
 * guarantee every `Intl` option, and the label must read the same on every phone.
 */
export function orderDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getDate()} de ${MONTHS[date.getMonth()]} de ${date.getFullYear()} às ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export interface OrderItemView {
  title: string;
  /** One line per detail: flavors of each half, crust, extras, removals. */
  lines: string[];
  /** Pictures from the current menu, one per half; empty when there is none. */
  imageIds: string[];
}

const row = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const nameOf = (value: unknown) => text(row(value)?.["name"]);
const idOf = (value: unknown) => text(row(value)?.["id"]);
const placementLabel = (value: unknown) =>
  value === "LEFT" ? " (1ª metade)" : value === "RIGHT" ? " (2ª metade)" : "";

export function orderItemView(
  item: CustomerOrderItem,
  menu: PublicMenu | null,
): OrderItemView {
  const snapshot = item.snapshot;
  if (item.kind === "PRODUCT") {
    const product = row(snapshot["product"]);
    const id = idOf(product);
    const current = id
      ? menu?.simpleProducts.find((entry) => entry.id === id)
      : undefined;
    return {
      title: nameOf(product) ?? "Produto",
      lines: [],
      imageIds: current?.imageId ? [current.imageId] : [],
    };
  }
  const size = nameOf(snapshot["size"]);
  const halves = snapshot["mode"] === "HALVES";
  const flavors = row(snapshot["flavors"]);
  const sides = flavors
    ? (halves ? [flavors["LEFT"], flavors["RIGHT"]] : [flavors["LEFT"]])
        .map(row)
        .filter((side): side is Record<string, unknown> => side !== null)
    : [];
  const names = sides
    .map((side) => text(side["name"]))
    .filter((name): name is string => name !== null);
  const imageIds = sides
    .map((side) => {
      const id = text(side["id"]);
      return id
        ? (menu?.flavors.find((flavor) => flavor.id === id)?.imageId ?? null)
        : null;
    })
    .filter((id): id is string => id !== null);
  const lines = [...names];
  const crust = nameOf(snapshot["crust"]);
  if (crust) lines.push(`Borda ${crust}`);
  const list = (key: string, prefix: string) =>
    Array.isArray(snapshot[key])
      ? (snapshot[key] as unknown[])
          .map((entry) => {
            const name = nameOf(entry);
            return name
              ? `${prefix}${name}${placementLabel(row(entry)?.["placement"])}`
              : null;
          })
          .filter((line): line is string => line !== null)
      : [];
  lines.push(...list("extras", "+ "), ...list("removals", "Sem "));
  const title = [
    "Pizza",
    size,
    halves ? "Meio a Meio" : names.length === 1 ? null : "Inteira",
  ]
    .filter(Boolean)
    .join(" ");
  return { title, lines, imageIds };
}
