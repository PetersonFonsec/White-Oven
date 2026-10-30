import assert from "node:assert/strict";
import test from "node:test";
import {
  createCustomerOrderListLoader,
  createOrderDetailLoader,
  createOrderSessionFence,
} from "../src/customer/order-detail-loader.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("changing order aborts the old request and accepts the new order immediately", async () => {
  const requests: {
    orderId: string;
    signal: AbortSignal;
    response: ReturnType<typeof deferred<string>>;
  }[] = [];
  const loaded: string[] = [];
  const loader = createOrderDetailLoader({
    load(orderId, signal) {
      const response = deferred<string>();
      requests.push({ orderId, signal, response });
      return response.promise;
    },
    onStart() {},
    onSuccess(orderId, _generation, value) {
      loaded.push(`${orderId}:${value}`);
    },
    onError(_orderId, error) {
      throw error;
    },
    onSettled() {},
  });

  const oldRequest = loader.load("order-a");
  const newRequest = loader.load("order-b");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.signal.aborted, true);
  assert.equal(requests[1]!.signal.aborted, false);
  assert.equal(loader.isLoading("order-b"), true);

  requests[1]!.response.resolve("new detail");
  await newRequest;
  requests[0]!.response.resolve("old detail");
  await oldRequest;
  assert.deepEqual(loaded, ["order-b:new detail"]);
  assert.equal(loader.isLoading("order-b"), false);
});

test("repeated reads for the selected order do not start duplicate requests", async () => {
  let loads = 0;
  const pending = deferred<string>();
  const loader = createOrderDetailLoader({
    load() {
      loads++;
      return pending.promise;
    },
    onStart() {},
    onSuccess() {},
    onError() {},
    onSettled() {},
  });
  const first = loader.load("order-a");
  await loader.load("order-a");
  assert.equal(loads, 1);
  pending.resolve("detail");
  await first;
});

test("the same order starts a fresh request after the customer session changes", async () => {
  const requests: {
    signal: AbortSignal;
    response: ReturnType<typeof deferred<string>>;
  }[] = [];
  const loaded: string[] = [];
  const loader = createOrderDetailLoader({
    load(_orderId, signal) {
      const response = deferred<string>();
      requests.push({ signal, response });
      return response.promise;
    },
    onStart() {},
    onSuccess(_orderId, generation, value) {
      loaded.push(`${generation}:${value}`);
    },
    onError() {},
    onSettled() {},
  });

  const firstSession = loader.load("same-order", 1);
  const secondSession = loader.load("same-order", 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.signal.aborted, true);
  requests[1]!.response.resolve("customer B detail");
  await secondSession;
  requests[0]!.response.resolve("customer A detail");
  await firstSession;
  assert.deepEqual(loaded, ["2:customer B detail"]);
});

test("old list responses and finally blocks cannot alter the new customer's page", async () => {
  const model = {};
  const fence = createOrderSessionFence<typeof model>();
  const state = {
    orders: [] as string[],
    cursor: null as number | null,
    loading: false,
    error: null as string | null,
  };
  const requests: {
    signal: AbortSignal;
    response: ReturnType<typeof deferred<{ orders: string[]; cursor: number }>>;
  }[] = [];
  const loader = createCustomerOrderListLoader({
    load(_cursor, signal) {
      const response = deferred<{ orders: string[]; cursor: number }>();
      requests.push({ signal, response });
      return response.promise;
    },
    onStart(generation) {
      if (!fence.isCurrent(generation)) return;
      state.loading = true;
      state.error = null;
    },
    onSuccess(generation, page, replace) {
      if (!fence.isCurrent(generation)) return;
      state.orders = replace ? page.orders : [...state.orders, ...page.orders];
      state.cursor = page.cursor;
    },
    onError(generation, error) {
      if (fence.isCurrent(generation)) state.error = String(error);
    },
    onSettled(generation) {
      if (fence.isCurrent(generation)) state.loading = false;
    },
  });

  const sessionA = fence.update(model, "customer-a").generation;
  const oldPage = loader.load(12, false, sessionA);
  const sessionB = fence.update(model, "customer-b").generation;
  loader.cancel();
  state.orders = [];
  state.cursor = null;
  state.loading = false;
  state.error = null;
  const newPage = loader.load(null, true, sessionB);
  assert.equal(requests[0]!.signal.aborted, true);
  assert.equal(state.loading, true);

  // This fetch deliberately ignores AbortSignal and resolves after B has started.
  requests[0]!.response.resolve({ orders: ["A-only-order"], cursor: 11 });
  await oldPage;
  assert.deepEqual(state, {
    orders: [],
    cursor: null,
    loading: true,
    error: null,
  });

  requests[1]!.response.resolve({ orders: ["B-only-order"], cursor: 7 });
  await newPage;
  assert.deepEqual(state, {
    orders: ["B-only-order"],
    cursor: 7,
    loading: false,
    error: null,
  });
});

test("an old list rejection cannot replace the new customer's error or loading state", async () => {
  const model = {};
  const fence = createOrderSessionFence<typeof model>();
  const state = { loading: false, error: null as string | null };
  const requests: ReturnType<typeof deferred<string>>[] = [];
  const loader = createCustomerOrderListLoader({
    load() {
      const request = deferred<string>();
      requests.push(request);
      return request.promise;
    },
    onStart(generation) {
      if (fence.isCurrent(generation)) {
        state.loading = true;
        state.error = null;
      }
    },
    onSuccess() {},
    onError(generation, error) {
      if (fence.isCurrent(generation)) state.error = String(error);
    },
    onSettled(generation) {
      if (fence.isCurrent(generation)) state.loading = false;
    },
  });
  const oldSession = fence.update(model, "customer-a").generation;
  const oldRequest = loader.load(null, true, oldSession);
  const newSession = fence.update(model, "customer-b").generation;
  loader.cancel();
  state.loading = false;
  state.error = null;
  const newRequest = loader.load(null, true, newSession);

  requests[0]!.reject(new Error("customer A failed"));
  await oldRequest;
  assert.deepEqual(state, { loading: true, error: null });
  requests[1]!.resolve("customer B page");
  await newRequest;
  assert.deepEqual(state, { loading: false, error: null });
});

test("logout and login as the same customer creates a new request generation", () => {
  const fence = createOrderSessionFence<object>();
  const model = {};
  const first = fence.update(model, "customer-a").generation;
  fence.update(model, null);
  const signedBackIn = fence.update(model, "customer-a").generation;
  assert.notEqual(signedBackIn, first);
  assert.equal(fence.isCurrent(first), false);
  assert.equal(fence.isCurrent(signedBackIn), true);

  const anotherTenant = fence.update({}, "customer-a").generation;
  assert.notEqual(anotherTenant, signedBackIn);
  assert.equal(fence.isCurrent(signedBackIn), false);
});
