import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyFilterMessage,
  filterGroup,
  filterOrders,
  orderDateTime,
  orderItemView,
} from "../src/customer/order-view.ts";
import type {
  CustomerOrderItem,
  CustomerOrderStatus,
} from "../src/customer/orders.ts";
import { parseMenu } from "../src/menu/menu.ts";
import { apiMenu } from "./menu-fixture.ts";

const menu = parseMenu(apiMenu())!;
const pizza = (snapshot: Record<string, unknown>): CustomerOrderItem => ({
  kind: "PIZZA",
  quantity: 1,
  unitPriceCents: 6290,
  totalCents: 6290,
  snapshot,
});

describe("order view", () => {
  it("groups statuses into the list filters", () => {
    const statuses: CustomerOrderStatus[] = [
      "PLACED",
      "PREPARING",
      "READY",
      "OUT_FOR_DELIVERY",
      "COMPLETED",
      "REJECTED",
      "CANCELED",
    ];
    assert.deepEqual(statuses.map(filterGroup), [
      "active",
      "active",
      "active",
      "active",
      "completed",
      "canceled",
      "canceled",
    ]);
    const orders = statuses.map((status, number) => ({ status, number }));
    assert.equal(filterOrders(orders, "all").length, 7);
    assert.deepEqual(
      filterOrders(orders, "canceled").map((order) => order.status),
      ["REJECTED", "CANCELED"],
    );
    assert.equal(filterOrders(orders, "completed").length, 1);
    assert.match(emptyFilterMessage("active"), /em andamento/);
  });

  it("writes the date like the mockup, in the device's time zone", () => {
    const local = new Date(2026, 9, 24, 19, 4).toISOString();
    assert.equal(orderDateTime(local), "24 de out. de 2026 às 19:04");
    assert.equal(orderDateTime("not a date"), "");
  });

  it("describes a half-and-half pizza from its snapshot, pictures from the menu", () => {
    const view = orderItemView(
      pizza({
        size: { id: "grande", name: "Grande" },
        mode: "HALVES",
        flavors: {
          LEFT: { id: "calabresa", name: "Calabresa" },
          RIGHT: { id: "marguerita", name: "Margherita (como era)" },
        },
        crust: { id: "catupiry", name: "Catupiry" },
        extras: [{ id: "bacon", name: "Bacon", placement: "LEFT" }],
        removals: [{ id: "cebola", name: "Cebola", placement: "WHOLE" }],
      }),
      menu,
    );
    assert.equal(view.title, "Pizza Grande Meio a Meio");
    // Names come from the snapshot (what was ordered), not from today's menu.
    assert.deepEqual(view.lines, [
      "Calabresa",
      "Margherita (como era)",
      "Borda Catupiry",
      "+ Bacon (1ª metade)",
      "Sem Cebola",
    ]);
    const withImages = menu.flavors
      .filter((flavor) => ["calabresa", "marguerita"].includes(flavor.id))
      .map((flavor) => flavor.imageId)
      .filter(Boolean);
    assert.deepEqual(view.imageIds, withImages);
  });

  it("survives a snapshot with missing parts and a product off the menu", () => {
    const whole = orderItemView(
      pizza({
        size: { id: "x", name: "Média" },
        mode: "WHOLE",
        flavors: { LEFT: { id: "gone", name: "Portuguesa" } },
      }),
      null,
    );
    assert.equal(whole.title, "Pizza Média");
    assert.deepEqual(whole.lines, ["Portuguesa"]);
    assert.deepEqual(whole.imageIds, []);
    assert.equal(orderItemView(pizza({}), menu).title, "Pizza Inteira");
    const product = orderItemView(
      {
        kind: "PRODUCT",
        quantity: 1,
        unitPriceCents: 1290,
        totalCents: 1290,
        snapshot: { product: { id: "removed", name: "Refrigerante 2L" } },
      },
      menu,
    );
    assert.deepEqual(product, {
      title: "Refrigerante 2L",
      lines: [],
      imageIds: [],
    });
  });
});
