import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  reorderLines,
  type CustomerOrderDetail,
} from "../src/customer/orders.ts";
import { parseMenu } from "../src/menu/menu.ts";
import { apiMenu } from "./menu-fixture.ts";

const menu = parseMenu(apiMenu())!;
const pizzaSnapshot = (overrides: Record<string, unknown> = {}) => ({
  size: { id: "grande" },
  mode: "HALVES",
  flavors: { LEFT: { id: "calabresa" }, RIGHT: { id: "marguerita" } },
  crust: { id: "catupiry" },
  extras: [{ id: "bacon", placement: "LEFT" }],
  removals: [{ id: "cebola", placement: "LEFT" }],
  ...overrides,
});
const pizzaItem = (snapshot = pizzaSnapshot(), quantity = 1) => ({
  kind: "PIZZA",
  quantity,
  unitPriceCents: 5000,
  totalCents: 5000 * quantity,
  snapshot,
});
const productItem = (quantity: number, id = "suco") => ({
  kind: "PRODUCT",
  quantity,
  unitPriceCents: 900,
  totalCents: 900 * quantity,
  snapshot: { product: { id } },
});
const order = (items: unknown[]) =>
  ({ items }) as unknown as CustomerOrderDetail;
const rebuild = (items: unknown[]) =>
  reorderLines(order(items), menu, randomUUID);

test("reorder accepts exactly 30 valid lines and counts later lines as skipped", () => {
  const exact = rebuild(Array.from({ length: 30 }, () => pizzaItem()));
  assert.equal(exact.lines.length, 30);
  assert.equal(exact.skipped, 0);

  const over = rebuild(Array.from({ length: 31 }, () => pizzaItem()));
  assert.equal(over.lines.length, 30);
  assert.equal(over.skipped, 1);
});

test("reorder consolidates repeated products, preserving first occurrence and quantity limits", () => {
  const combined = rebuild([productItem(12), pizzaItem(), productItem(8)]);
  assert.deepEqual(
    combined.lines.map((line) => line.kind),
    ["PRODUCT", "PIZZA"],
  );
  assert.equal(
    combined.lines[0]?.kind === "PRODUCT" && combined.lines[0].quantity,
    20,
  );
  assert.equal(combined.skipped, 0);

  const overflow = rebuild([productItem(18), productItem(5)]);
  assert.equal(overflow.lines.length, 1);
  assert.equal(
    overflow.lines[0]?.kind === "PRODUCT" && overflow.lines[0].quantity,
    18,
  );
  assert.equal(overflow.skipped, 1);
});

test("reorder skips invalid quantities, unavailable products and pizzas invalid in current menu", () => {
  const result = rebuild([
    productItem(0),
    productItem(21),
    productItem(1, "removed-product"),
    pizzaItem(pizzaSnapshot({ size: { id: "removed-size" } })),
    pizzaItem(pizzaSnapshot(), 1),
  ]);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0]?.kind, "PIZZA");
  assert.equal(result.skipped, 4);
});

test("reorder preserves half-and-half flavors, extras, removals and current pricing", () => {
  const result = rebuild([pizzaItem()]);
  assert.equal(result.lines[0]?.kind, "PIZZA");
  if (result.lines[0]?.kind !== "PIZZA") return;
  assert.deepEqual(result.lines[0].pizza, {
    sizeId: "grande",
    mode: "HALVES",
    flavors: { LEFT: "calabresa", RIGHT: "marguerita" },
    crustId: "catupiry",
    extras: [{ extraId: "bacon", placement: "LEFT" }],
    removals: [{ ingredientId: "cebola", placement: "LEFT" }],
    quantity: 1,
  });
  assert.equal(result.skipped, 0);
});

test("reorder counts lines dropped after the 30-line cap even when products repeat", () => {
  const result = rebuild([
    ...Array.from({ length: 30 }, () => pizzaItem()),
    productItem(1),
  ]);
  assert.equal(result.lines.length, 30);
  assert.equal(result.skipped, 1);
});
