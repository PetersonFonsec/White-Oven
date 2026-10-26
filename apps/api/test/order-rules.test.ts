import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CatalogManagementSnapshot } from "@whiteoven/contracts";
import { priceOrder, type OrderSettings } from "../src/order/order-pricing";
import {
  orderRequestHash,
  validateOrderRequest,
  type OrderRequest,
} from "../src/order/order-rules";
import {
  ORDER_STATUSES,
  reasonRequired,
  transitionAllowed,
} from "../src/order/order-lifecycle-rules";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SIZE = id(1);
const FLAVOR = id(2);
const PRODUCT = id(3);
const PIZZAS = id(4);
const DRINKS = id(5);
const ADDRESS = id(6);

describe("M4.4 order lifecycle transition table", () => {
  it("covers every state pair, actor, and fulfillment mode", () => {
    const expected: Record<string, readonly string[]> = {
      "STAFF:DELIVERY": [
        "PLACED>PREPARING",
        "PLACED>REJECTED",
        "PREPARING>READY",
        "PREPARING>CANCELED",
        "READY>OUT_FOR_DELIVERY",
        "READY>CANCELED",
        "OUT_FOR_DELIVERY>COMPLETED",
        "OUT_FOR_DELIVERY>CANCELED",
      ],
      "STAFF:PICKUP": [
        "PLACED>PREPARING",
        "PLACED>REJECTED",
        "PREPARING>READY",
        "PREPARING>CANCELED",
        "READY>COMPLETED",
        "READY>CANCELED",
        "OUT_FOR_DELIVERY>COMPLETED",
        "OUT_FOR_DELIVERY>CANCELED",
      ],
      "CUSTOMER:DELIVERY": ["PLACED>CANCELED"],
      "CUSTOMER:PICKUP": ["PLACED>CANCELED"],
      "SYSTEM:DELIVERY": ["PLACED>REJECTED"],
      "SYSTEM:PICKUP": ["PLACED>REJECTED"],
    };
    for (const actor of ["STAFF", "CUSTOMER", "SYSTEM"] as const)
      for (const fulfillment of ["DELIVERY", "PICKUP"] as const)
        for (const from of ORDER_STATUSES)
          for (const to of ORDER_STATUSES)
            assert.equal(
              transitionAllowed(from, to, fulfillment, actor),
              expected[`${actor}:${fulfillment}`]!.includes(`${from}>${to}`),
              `${actor} ${fulfillment}: ${from} -> ${to}`,
            );
    assert.equal(reasonRequired("REJECTED"), true);
    assert.equal(reasonRequired("CANCELED"), true);
    assert.equal(reasonRequired("COMPLETED"), false);
  });
});

const catalog: CatalogManagementSnapshot = {
  categories: [
    { id: PIZZAS, kind: "PIZZA", archived: false },
    { id: DRINKS, kind: "PRODUCT", archived: false },
  ],
  sizes: [
    {
      id: SIZE,
      name: "Grande",
      slices: 8,
      maxFlavors: 2,
      available: true,
      archived: false,
    },
  ],
  ingredients: [],
  flavors: [
    {
      id: FLAVOR,
      categoryId: PIZZAS,
      name: "Calabresa",
      ingredientIds: [],
      available: true,
      archived: false,
    },
  ],
  flavorPrices: [{ flavorId: FLAVOR, sizeId: SIZE, priceCents: 4000 }],
  crusts: [],
  crustPrices: [],
  extras: [],
  extraPrices: [],
  simpleProducts: [
    {
      id: PRODUCT,
      categoryId: DRINKS,
      name: "Refrigerante",
      priceCents: 800,
      available: true,
      archived: false,
    },
  ],
  pricingPolicy: {
    halfAndHalfStrategy: "AVERAGE",
    halfAndHalfSurchargeCents: 0,
    maxExtrasPerHalf: 2,
  },
};
const settings: OrderSettings = {
  fulfillmentModes: ["DELIVERY", "PICKUP"],
  deliveryFeeCents: 500,
  minimumOrderCents: 1000,
  acceptedPaymentMethods: ["CASH"],
};
const pizzaLine = {
  kind: "PIZZA",
  pizza: {
    sizeId: SIZE,
    mode: "WHOLE",
    flavors: { LEFT: FLAVOR },
    crustId: null,
    extras: [],
    removals: [],
    quantity: 1,
  },
};
const valid = (raw: unknown): OrderRequest => {
  const result = validateOrderRequest(raw);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};

describe("order request rules", () => {
  it("reports every malformed or unknown field by path", () => {
    assert.deepEqual(validateOrderRequest([]), { ok: false, paths: [""] });
    const result = validateOrderRequest({
      fulfillment: "PICKUP",
      addressId: ADDRESS,
      paymentMethod: "PIX_ON_DELIVERY",
      changeForCents: 100,
      notes: "x".repeat(281),
      items: [
        { kind: "PIZZA", pizza: { ...pizzaLine.pizza, quantity: 0 } },
        { kind: "PRODUCT", productId: "nope", quantity: 21, priceCents: 1 },
        { kind: "COMBO" },
      ],
      totalCents: 1,
    });
    assert.deepEqual(result, {
      ok: false,
      paths: [
        "totalCents",
        "addressId",
        "changeForCents",
        "notes",
        "items[0].pizza.quantity",
        "items[1].priceCents",
        "items[1].productId",
        "items[1].quantity",
        "items[2].kind",
      ],
    });
  });

  it("requires an address for delivery and trims notes to null", () => {
    assert.deepEqual(
      validateOrderRequest({
        fulfillment: "DELIVERY",
        paymentMethod: "CASH",
        items: [pizzaLine],
      }),
      { ok: false, paths: ["addressId"] },
    );
    const request = valid({
      fulfillment: "DELIVERY",
      addressId: ADDRESS,
      paymentMethod: "CASH",
      notes: "   ",
      items: [pizzaLine],
    });
    assert.equal(request.notes, null);
    assert.equal(request.changeForCents, null);
    assert.equal(request.expectedTotalCents, null);
  });

  it("requires a confirmed total in cents only when asked to (the creation)", () => {
    const base = {
      fulfillment: "PICKUP",
      paymentMethod: "CASH",
      items: [pizzaLine],
    };
    assert.ok(validateOrderRequest(base).ok);
    assert.ok(validateOrderRequest({ ...base, expectedTotalCents: null }).ok);
    for (const expectedTotalCents of [
      undefined,
      null,
      -1,
      1.5,
      "10",
      Infinity,
      NaN,
      10_000_001,
    ])
      assert.deepEqual(
        validateOrderRequest(
          expectedTotalCents === undefined
            ? base
            : { ...base, expectedTotalCents },
          { requireExpectedTotal: true },
        ),
        { ok: false, paths: ["expectedTotalCents"] },
        String(expectedTotalCents),
      );
    for (const expectedTotalCents of [0, 4000, 10_000_000])
      assert.ok(
        validateOrderRequest(
          { ...base, expectedTotalCents },
          { requireExpectedTotal: true },
        ).ok,
      );
  });

  it("hashes the same order the same whatever the key order, and any change differently", () => {
    const a = valid({
      fulfillment: "PICKUP",
      paymentMethod: "CASH",
      items: [pizzaLine],
    });
    const b = valid({
      items: [pizzaLine],
      paymentMethod: "CASH",
      fulfillment: "PICKUP",
    });
    const c = valid({
      fulfillment: "PICKUP",
      paymentMethod: "CASH",
      items: [pizzaLine, pizzaLine],
    });
    assert.ok(orderRequestHash(a).equals(orderRequestHash(b)));
    assert.ok(!orderRequestHash(a).equals(orderRequestHash(c)));
  });
});

describe("priceOrder", () => {
  const address = {
    label: "Casa",
    postalCode: "01310100",
    street: "Rua",
    number: "1",
    complement: null,
    district: "Centro",
    city: "São Paulo",
    state: "SP",
    reference: null,
  };

  it("charges the fee only on delivery and sums lines from the catalog", () => {
    const lines = [
      pizzaLine,
      { kind: "PRODUCT", productId: PRODUCT, quantity: 2 },
    ];
    const delivery = priceOrder(
      valid({
        fulfillment: "DELIVERY",
        addressId: ADDRESS,
        paymentMethod: "CASH",
        items: lines,
      }),
      catalog,
      catalog.pricingPolicy,
      settings,
      address,
    );
    assert.ok(delivery.ok);
    assert.equal(delivery.quote.itemsSubtotalCents, 5600);
    assert.equal(delivery.quote.deliveryFeeCents, 500);
    assert.equal(delivery.quote.totalCents, 6100);
    const pickup = priceOrder(
      valid({ fulfillment: "PICKUP", paymentMethod: "CASH", items: lines }),
      catalog,
      catalog.pricingPolicy,
      settings,
      null,
    );
    assert.ok(pickup.ok);
    assert.equal(pickup.quote.deliveryFeeCents, 0);
    assert.equal(pickup.quote.totalCents, 5600);
  });

  it("checks the minimum on the items only, then the change on the total", () => {
    const product = { kind: "PRODUCT", productId: PRODUCT, quantity: 1 };
    assert.deepEqual(
      priceOrder(
        valid({
          fulfillment: "DELIVERY",
          addressId: ADDRESS,
          paymentMethod: "CASH",
          items: [product],
        }),
        catalog,
        catalog.pricingPolicy,
        settings,
        address,
      ),
      {
        ok: false,
        issues: [{ code: "MINIMUM_ORDER_NOT_REACHED", path: "items" }],
        minimumOrderCents: 1000,
      },
    );
    assert.deepEqual(
      priceOrder(
        valid({
          fulfillment: "DELIVERY",
          addressId: ADDRESS,
          paymentMethod: "CASH",
          changeForCents: 4000,
          items: [pizzaLine],
        }),
        catalog,
        catalog.pricingPolicy,
        settings,
        address,
      ),
      {
        ok: false,
        issues: [{ code: "CHANGE_FOR_TOO_LOW", path: "changeForCents" }],
      },
    );
  });

  it("keeps every amount within R$ 100.000,00, the limit included", () => {
    const priced = (priceCents: number, extra: object = {}, fee = 0) =>
      priceOrder(
        valid({
          fulfillment: "DELIVERY",
          addressId: ADDRESS,
          paymentMethod: "CASH",
          items: [{ kind: "PRODUCT", productId: PRODUCT, quantity: 20 }],
          ...extra,
        }),
        {
          ...catalog,
          simpleProducts: catalog.simpleProducts.map((p) => ({
            ...p,
            priceCents,
          })),
        },
        catalog.pricingPolicy,
        { ...settings, deliveryFeeCents: fee },
        address,
      );
    const exceeded = (path: string) => ({
      ok: false,
      issues: [{ code: "ORDER_TOTAL_EXCEEDED", path }],
      maxTotalCents: 10_000_000,
    });
    const exact = priced(500_000);
    assert.ok(exact.ok);
    assert.equal(exact.quote.totalCents, 10_000_000);
    assert.deepEqual(priced(500_001), exceeded("items[0]"));
    assert.deepEqual(priced(2_147_483_647), exceeded("items[0]"));
    assert.deepEqual(priced(Number.MAX_SAFE_INTEGER), exceeded("items[0]"));
    assert.deepEqual(priced(500_000, {}, 1), exceeded("items"));
    assert.deepEqual(
      priced(250_000, {
        items: [
          { kind: "PRODUCT", productId: PRODUCT, quantity: 20 },
          { kind: "PRODUCT", productId: PRODUCT, quantity: 20 },
          { kind: "PRODUCT", productId: PRODUCT, quantity: 1 },
        ],
      }),
      exceeded("items"),
    );
  });

  it("refuses pizzas when the store has no pricing policy and unknown products", () => {
    const result = priceOrder(
      valid({
        fulfillment: "PICKUP",
        paymentMethod: "CASH",
        items: [pizzaLine, { kind: "PRODUCT", productId: id(99), quantity: 1 }],
      }),
      catalog,
      null,
      settings,
      null,
    );
    assert.deepEqual(result, {
      ok: false,
      issues: [
        { code: "PIZZA_PRICING_UNAVAILABLE", path: "items[0]" },
        { code: "PRODUCT_UNAVAILABLE", path: "items[1].productId" },
      ],
    });
  });
});
