import assert from "node:assert/strict";
import test from "node:test";
import { createOrderDetailLoader } from "../src/customer/order-detail-loader.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    onSuccess(orderId, value) {
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
