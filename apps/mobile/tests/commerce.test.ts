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
  let onQuote: (() => void | Promise<void>) | null = null;
  let loginFailure: "invalid" | "network" | null = null,
    meFailures = 0;
  const calls = { refresh: 0, login: 0 };
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/auth/refresh")) calls.refresh++;
    if (path.endsWith("/auth/login")) {
      calls.login++;
      if (loginFailure === "network") throw new Error("offline");
      if (loginFailure === "invalid")
        return Response.json({ code: "INVALID_CREDENTIALS" }, { status: 401 });
    }
    if (path.endsWith("/me") && meFailures > 0) {
      meFailures--;
      throw new Error("offline");
    }
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
      await onQuote?.();
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
  const model = (now?: () => number) =>
    createCommerceModel({ client: client(), storage, uuid: randomUUID, now });
  return {
    storage,
    secret,
    requests,
    calls,
    model,
    failLogin(kind: "invalid" | "network" | null) {
      loginFailure = kind;
    },
    failProfile(times: number) {
      meFailures = times;
    },
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
    onQuote(fn: () => void | Promise<void>) {
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

test("replaceCart accepts 30 valid lines without loss and rejects excess lines", async () => {
  const h = setup();
  const model = await prepare(h);
  const thirty: CartLine[] = Array.from({ length: 30 }, () => ({
    ...line,
    id: randomUUID(),
    productId: randomUUID(),
  }));
  assert.equal(await model.replaceCart(thirty), true);
  assert.equal(model.getSnapshot().cart.length, 30);
  assert.deepEqual(model.getSnapshot().cart, thirty);
  const previousCart = model.getSnapshot().cart;
  const previousStorage = h.storage.value;
  assert.equal(
    await model.replaceCart([
      ...thirty,
      { ...line, id: randomUUID(), productId: randomUUID() },
    ]),
    false,
  );
  assert.deepEqual(model.getSnapshot().cart, previousCart);
  assert.equal(h.storage.value, previousStorage);
});

test("replaceCart consolidates repeated products and rejects totals above 20", async () => {
  const h = setup();
  const model = await prepare(h);
  const repeated: CartLine[] = [
    { ...line, id: randomUUID(), quantity: 7 },
    { ...line, id: randomUUID(), quantity: 13 },
  ];
  assert.equal(await model.replaceCart(repeated), true);
  const consolidated = model.getSnapshot().cart[0];
  assert.ok(consolidated?.kind === "PRODUCT");
  assert.equal(consolidated.quantity, 20);
  const previous = h.storage.value;
  assert.equal(
    await model.replaceCart([
      { ...line, id: randomUUID(), quantity: 20 },
      { ...line, id: randomUUID(), quantity: 1 },
    ]),
    false,
  );
  assert.equal(h.storage.value, previous);
  const unchanged = model.getSnapshot().cart[0];
  assert.ok(unchanged?.kind === "PRODUCT");
  assert.equal(unchanged.quantity, 20);
});

test("replaceCart rejects invalid quantities without changing cart, quote or persistence", async () => {
  for (const quantity of [0, -1, 21, 1.5]) {
    const h = setup();
    const model = await prepare(h);
    const previousCart = model.getSnapshot().cart;
    const previousQuote = model.getSnapshot().quote;
    const previousStorage = h.storage.value;
    assert.equal(
      await model.replaceCart([{ ...line, quantity } as CartLine]),
      false,
    );
    assert.deepEqual(model.getSnapshot().cart, previousCart);
    assert.deepEqual(model.getSnapshot().quote, previousQuote);
    assert.equal(h.storage.value, previousStorage);
  }
});

test("failed account switch never restores the previous identity; the original account recovers the pending order", async () => {
  for (const kind of ["invalid", "network"] as const) {
    const h = setup(),
      model = await prepare(h);
    h.lose();
    assert.equal(await model.confirm(), false);
    const pending = model.getSnapshot().pending;
    assert.ok(pending);
    h.failLogin(kind);
    h.identity(otherCustomer);
    assert.equal(await model.signIn("login", {}), false);
    assert.equal(model.getSnapshot().profile, null);
    assert.ok(model.getSnapshot().error);
    assert.equal(h.secret.value, null, "previous session ended locally");
    const refreshes = h.calls.refresh;
    assert.equal(await model.refreshAccount(), false);
    assert.equal(model.getSnapshot().profile, null);
    assert.equal(h.calls.refresh, refreshes, "no refresh into the old session");
    assert.equal(await model.confirm(), false);
    assert.equal(await model.acknowledgePending(), false);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(model.getSnapshot().pending, pending);
    h.failLogin(null);
    h.identity(customerId);
    assert.equal(await model.signIn("login", {}), true);
    assert.equal(model.getSnapshot().profile?.id, customerId);
    assert.equal(await model.confirm(), true);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[0], h.requests[1], "same key and body");
    assert.equal(model.getSnapshot().receipt?.number, 12);
  }
});

test("init loads the cart once, retries a failed session restore and never runs concurrently", async () => {
  const h = setup(),
    first = await prepare(h);
  assert.equal(first.getSnapshot().cart.length, 1);
  h.failProfile(1);
  const model = h.model();
  const refreshes = h.calls.refresh;
  const [a, b] = [model.init(), model.init()];
  assert.equal(a, b, "concurrent calls share one initialization");
  assert.equal(await a, false);
  assert.equal(h.calls.refresh, refreshes + 1);
  let snapshot = model.getSnapshot();
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.session, "failed");
  assert.equal(snapshot.profile, null);
  assert.ok(snapshot.error);
  assert.equal(snapshot.cart.length, 1, "cart stays available");
  const extra: CartLine = {
    ...line,
    id: randomUUID(),
    productId: randomUUID(),
  };
  assert.equal(await model.changeCart((lines) => [...lines, extra]), true);
  assert.equal(await model.init(), true);
  snapshot = model.getSnapshot();
  assert.equal(snapshot.session, "restored");
  assert.equal(snapshot.profile?.id, customerId);
  assert.equal(
    snapshot.cart.length,
    2,
    "retry does not reload over newer changes",
  );
  const calls = h.calls.refresh;
  assert.equal(await model.init(), true);
  assert.equal(
    h.calls.refresh,
    calls,
    "a restored session is not restored again",
  );
});

test("a transient storage read failure leaves init retryable", async () => {
  const h = setup();
  await prepare(h);
  const read = h.storage.read;
  h.storage.read = async () => {
    throw new Error("keychain locked");
  };
  const model = h.model();
  assert.equal(await model.init(), false);
  assert.equal(model.getSnapshot().ready, false);
  assert.equal(model.getSnapshot().session, "idle");
  assert.equal(await model.changeCart(() => []), false);
  h.storage.read = read;
  assert.equal(await model.init(), true);
  assert.equal(model.getSnapshot().cart.length, 1);
  assert.equal(model.getSnapshot().profile?.id, customerId);
});

test("a suspended store keeps the pending confirmation indeterminate and recoverable with the same key", async () => {
  const h = setup(),
    model = await prepare(h);
  h.lose();
  assert.equal(await model.confirm(), false);
  const pending = model.getSnapshot().pending;
  assert.ok(pending);
  // The store is suspended while the customer recovers: the API refuses to reconcile.
  h.reject("TENANT_NOT_ACTIVE");
  assert.equal(await model.confirm(), false);
  assert.match(
    model.getSnapshot().error!,
    /Confira diretamente com a pizzaria/,
  );
  assert.deepEqual(model.getSnapshot().pending, pending, "not discarded");
  assert.equal(await model.changeCart(() => []), false, "cart stays locked");
  assert.equal(await model.quote(details, 500), false, "no new quote");
  // Restart during the suspension: still the same confirmation.
  const restarted = h.model();
  assert.equal(await restarted.init(), true);
  assert.deepEqual(restarted.getSnapshot().pending, pending);
  // The store serves again: the same key and body recover the order.
  h.reject(null);
  assert.equal(await restarted.confirm(), true);
  assert.equal(h.requests.length, 3);
  assert.ok(
    h.requests.every((r) => r.key === pending.key && r.body === pending.body),
  );
  assert.equal(restarted.getSnapshot().receipt?.number, 12);
});

test("an expired confirmation is never resent by the model, even when the store is unavailable", async () => {
  const h = setup(),
    model = await prepare(h);
  h.lose();
  await model.confirm();
  const pending = model.getSnapshot().pending!;
  const later = h.model(() => pending.createdAt + 23 * 60 * 60 * 1000);
  assert.equal(await later.init(), true);
  assert.equal(await later.confirm(), false);
  assert.match(later.getSnapshot().error!, /prazo de recuperação terminou/);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(later.getSnapshot().pending, pending);
  const earlier = h.model(() => pending.createdAt - 1);
  await earlier.init();
  assert.equal(await earlier.confirm(), false, "clock rolled back");
  assert.equal(h.requests.length, 1);
});

test("every cart, address and form change invalidates the quote", async () => {
  const h = setup(),
    model = await prepare(h);
  const quoted = async () => {
    assert.equal(await model.quote(details, 500), true);
    assert.ok(model.getSnapshot().quote);
  };
  const second: CartLine = {
    ...line,
    id: randomUUID(),
    productId: randomUUID(),
  };
  // Quantity change.
  assert.equal(
    await model.changeCart((lines) => changeQuantity(lines, line.id, 2)),
    true,
  );
  assert.equal(model.getSnapshot().quote, null);
  // Item removal.
  await model.changeCart((lines) => [...lines, second]);
  await quoted();
  assert.equal(
    await model.changeCart((lines) => lines.filter((l) => l.id !== second.id)),
    true,
  );
  assert.equal(model.getSnapshot().quote, null);
  // Address change (saved in the account).
  await quoted();
  const savedAddress = await model.saveAddress({
    label: "Casa",
    postalCode: "01000-000",
    street: "Rua A",
    number: "1",
    complement: null,
    district: "Centro",
    city: "São Paulo",
    state: "SP",
    reference: null,
  });
  assert.equal(model.getSnapshot().quote, null);
  assert.equal(savedAddress, true);
  // Fulfillment, payment and address selection are screen state: the screen calls invalidateQuote.
  for (let change = 0; change < 3; change++) {
    await quoted();
    model.invalidateQuote();
    assert.equal(model.getSnapshot().quote, null);
    assert.equal(
      await model.confirm(),
      false,
      "no confirmation without a new quote",
    );
  }
  assert.equal(h.requests.length, 0);
  // A new quote after the changes is valid and confirms the current cart.
  await quoted();
  assert.equal(await model.confirm(), true);
  assert.equal(JSON.parse(h.requests[0]!.body).items.length, 1);
  assert.equal(JSON.parse(h.requests[0]!.body).items[0].quantity, 2);
});

test("a quote answer that arrives after an invalidation is dropped; cart changes cannot overlap a quote", async () => {
  const h = setup(),
    model = await prepare(h);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let arrived!: () => void;
  const inFlight = new Promise<void>((resolve) => (arrived = resolve));
  h.onQuote(() => {
    arrived();
    return gate;
  });
  const quoting = model.quote(details, 500);
  await inFlight;
  // Serialization: a cart change while the quote runs is refused, so it cannot race the answer.
  assert.equal(await model.changeCart(() => []), false);
  // Screen-level invalidation (form or navigation) is not serialized: the generation guards it.
  model.invalidateQuote();
  release();
  assert.equal(await quoting, true);
  assert.equal(model.getSnapshot().quote, null, "late answer dropped");
  assert.equal(model.getSnapshot().cart.length, 1);
  assert.equal(await model.confirm(), false);
  assert.equal(h.requests.length, 0);
});
