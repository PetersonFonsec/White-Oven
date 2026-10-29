import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createCommerceModel,
  parseSaved,
  retryAllowed,
} from "../src/cart/model.ts";
import {
  createCustomerClient,
  type SecretStore,
} from "../src/customer/client.ts";
import { addProduct, changeQuantity, type CartLine } from "../src/cart/cart.ts";
import { moneyInput } from "../src/cart/summary.ts";

const customerId = randomUUID();
const otherCustomer = randomUUID();
const productId = randomUUID();
const orderId = randomUUID();
const details = {
  fulfillment: "PICKUP",
  addressId: null,
  paymentMethod: "CASH",
  changeForCents: null,
  notes: null,
} as const;
const line: CartLine = {
  id: randomUUID(),
  kind: "PRODUCT",
  productId,
  name: "Água",
  quantity: 1,
};
function memory(): SecretStore & { value: string | null; fail: boolean } {
  return {
    value: null,
    fail: false,
    async read() {
      return this.value;
    },
    async write(value) {
      if (this.fail) throw new Error("storage unavailable");
      this.value = value;
    },
    async remove() {
      if (this.fail) throw new Error("storage unavailable");
      this.value = null;
    },
  };
}
function setup() {
  const storage = memory(),
    secret = memory();
  const requests: { body: string; key: string }[] = [];
  let loseResponse = false,
    rejectCode: string | null = null,
    identity: string = customerId;
  let quoted = 500;
  let onQuote: (() => void) | null = null;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.includes("/auth/"))
      return Response.json({
        accessToken: "access",
        refreshToken: "refresh",
        expiresIn: 900,
      });
    if (path.endsWith("/me"))
      return Response.json({
        id: identity,
        name: "Cliente",
        email: "test@example.invalid",
        phone: null,
      });
    if (path.endsWith("/me/addresses")) return Response.json([]);
    if (path.endsWith("/quote")) {
      onQuote?.();
      return Response.json({
        itemsSubtotalCents: quoted,
        deliveryFeeCents: 0,
        discountCents: 0,
        totalCents: quoted,
        priceChanged: true,
      });
    }
    if (path.endsWith("/me/orders")) {
      requests.push({
        body: init!.body as string,
        key: new Headers(init?.headers).get("Idempotency-Key")!,
      });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("lost response");
      }
      if (rejectCode)
        return Response.json({ code: rejectCode }, { status: 409 });
      return Response.json({ id: orderId, number: 12, totalCents: quoted });
    }
    throw new Error(`unexpected ${path}`);
  };
  const client = () =>
    createCustomerClient({
      apiUrl: "https://api.test",
      storeSlug: "loja-a",
      fetch: fetcher,
      secret,
    });
  const model = () =>
    createCommerceModel({ client: client(), storage, uuid: randomUUID });
  return {
    storage,
    secret,
    requests,
    model,
    lose() {
      loseResponse = true;
    },
    reject(code: string | null) {
      rejectCode = code;
    },
    identity(id: string) {
      identity = id;
    },
    price(value: number) {
      quoted = value;
    },
    onQuote(fn: () => void) {
      onQuote = fn;
    },
  };
}
async function prepare(h: ReturnType<typeof setup>) {
  const model = h.model();
  assert.equal(await model.init(), true);
  assert.equal(
    await model.signIn("login", {
      email: "test@example.invalid",
      password: "test-password",
    }),
    true,
  );
  assert.equal(await model.changeCart(() => [line]), true);
  assert.equal(await model.quote(details, 400), true);
  assert.equal(model.getSnapshot().quote?.totals.priceChanged, true);
  return model;
}

test("lost order response survives restart; retry uses identical key/body and clears the cart atomically", async () => {
  const h = setup(),
    model = await prepare(h);
  h.lose();
  const first = model.confirm();
  assert.equal(await model.confirm(), false, "double tap is blocked");
  assert.equal(await first, false);
  assert.ok(model.getSnapshot().pending);
  assert.equal(await model.changeCart(() => []), false);
  const restarted = h.model();
  assert.equal(await restarted.init(), true);
  assert.equal(await restarted.confirm(), true);
  assert.deepEqual(h.requests[0], h.requests[1]);
  assert.equal(h.requests.length, 2);
  assert.equal(restarted.getSnapshot().pending, null);
  assert.equal(restarted.getSnapshot().cart.length, 0);
  assert.equal(restarted.getSnapshot().receipt?.number, 12);
  assert.equal(
    await restarted.confirm(),
    false,
    "no new order without a new quote",
  );
  assert.equal(h.requests.length, 2);
  const third = h.model();
  await third.init();
  assert.equal(third.getSnapshot().receipt?.number, 12);
  assert.equal(third.getSnapshot().cart.length, 0);
});

test("another account cannot resend or discard a pending confirmation", async () => {
  const h = setup(),
    model = await prepare(h);
  h.lose();
  await model.confirm();
  h.identity(otherCustomer);
  await model.signIn("login", {});
  assert.equal(await model.confirm(), false);
  assert.equal(await model.acknowledgePending(), false);
  assert.equal(h.requests.length, 1);
  assert.ok(model.getSnapshot().pending);
});

test("durable write failure prevents sending; failed success commit retries original request", async () => {
  const h = setup(),
    model = await prepare(h);
  h.storage.fail = true;
  assert.equal(await model.confirm(), false);
  assert.equal(h.requests.length, 0);
  h.storage.fail = false;
  h.lose();
  await model.confirm();
  h.storage.fail = true;
  assert.equal(await model.confirm(), false);
  assert.ok(model.getSnapshot().pending);
  h.storage.fail = false;
  assert.equal(await model.confirm(), true);
  assert.deepEqual(h.requests[0], h.requests[1]);
  assert.deepEqual(h.requests[1], h.requests[2]);
});

test("price change requires a new quote and explicit confirmation; ambiguous conflict stays locked", async () => {
  const h = setup(),
    model = await prepare(h);
  h.reject("ORDER_PRICE_CHANGED");
  await model.confirm();
  assert.equal(model.getSnapshot().pending, null);
  assert.equal(model.getSnapshot().quote, null);
  assert.equal(model.getSnapshot().cart.length, 1);
  assert.equal(await model.confirm(), false);
  h.reject(null);
  h.price(700);
  await model.quote(details, 500);
  assert.equal(model.getSnapshot().quote?.totals.totalCents, 700);
  h.reject("IDEMPOTENCY_CONFLICT");
  await model.confirm();
  assert.ok(model.getSnapshot().pending);
  assert.notEqual(h.requests[0]?.key, h.requests[1]?.key);
  assert.equal(JSON.parse(h.requests[1]!.body).expectedTotalCents, 700);
});

test("menu invalidation while a quote is in flight prevents a stale confirmation", async () => {
  const h = setup(),
    model = await prepare(h);
  h.onQuote(() => model.invalidateQuote());
  await model.quote(details, 500);
  assert.equal(model.getSnapshot().quote, null);
  assert.equal(await model.confirm(), false);
});

test("expired/clock-rolled-back confirmations are never automatically resubmitted", () => {
  const pending = {
    customerId,
    key: randomUUID(),
    body: "{}",
    createdAt: 1000,
  };
  assert.equal(retryAllowed(pending, 999), false);
  assert.equal(retryAllowed(pending, 1000 + 23 * 3600000), false);
  assert.equal(retryAllowed(pending, 2000), true);
});

test("corrupt saved data fails closed, quantities stay bounded and money is decimal cents", () => {
  assert.throws(() => parseSaved('{"version":1,"cart":[]}'));
  assert.throws(() =>
    parseSaved(
      JSON.stringify({
        version: 1,
        cart: [{ ...line, quantity: 21 }],
        pending: null,
        receipt: null,
      }),
    ),
  );
  assert.throws(() =>
    addProduct([{ ...line, quantity: 20 }], {
      id: randomUUID(),
      name: "Água",
      productId,
    }),
  );
  assert.throws(() => changeQuantity([line], line.id, 0));
  assert.equal(moneyInput("12,34"), 1234);
  assert.equal(moneyInput(""), null);
  assert.throws(() => moneyInput("1e3"));
});
