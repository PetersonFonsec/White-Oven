import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomerError } from "../src/customer/client.ts";
import {
  type PermissionStatus,
  type PushApi,
  type PushNative,
  createPushModel,
  orderIdFromNotification,
} from "../src/customer/push.ts";

const TOKEN = "ExponentPushToken[device-1]";
const ORDER = "0f3c1a52-6d2e-4b8f-9a77-3f1e2d4c5b6a";

function fakes(
  permission: PermissionStatus = "undetermined",
  answer: PermissionStatus = "granted",
) {
  const calls: string[] = [];
  let enabled = false;
  const native: PushNative & { permissionNow: PermissionStatus } = {
    permissionNow: permission,
    async permission() {
      calls.push("permission");
      return this.permissionNow;
    },
    async request() {
      calls.push("request");
      this.permissionNow = answer;
      return answer;
    },
    async token() {
      calls.push("token");
      return TOKEN;
    },
  };
  const api: PushApi = {
    async status() {
      calls.push("GET");
      return { enabled };
    },
    async register(token) {
      calls.push(`PUT ${token}`);
      enabled = true;
      return { enabled };
    },
    async unregister() {
      calls.push("DELETE");
      enabled = false;
      return null;
    },
  };
  return { native, api, calls };
}

describe("order notification opt-in", () => {
  it("is unavailable in a build without a push project and never calls the API", async () => {
    const { api, calls } = fakes();
    const model = createPushModel({ api, native: null });
    assert.equal(model.getSnapshot().status, "unavailable");
    await model.refresh();
    await model.enable();
    assert.deepEqual(calls, []);
    model.reset();
    assert.equal(model.getSnapshot().status, "unavailable");
  });

  it("reads the opt-in without asking the OS for permission", async () => {
    const { native, api, calls } = fakes();
    const model = createPushModel({ api, native });
    assert.equal(model.getSnapshot().status, "unknown");
    await model.refresh();
    assert.equal(model.getSnapshot().status, "off");
    assert.deepEqual(calls, ["GET"]);
  });

  it("asks for permission only on the explicit opt-in, then registers the token", async () => {
    const { native, api, calls } = fakes();
    const model = createPushModel({ api, native });
    await model.enable();
    assert.equal(model.getSnapshot().status, "on");
    assert.deepEqual(calls, ["permission", "request", "token", `PUT ${TOKEN}`]);

    calls.length = 0;
    await model.disable();
    assert.equal(model.getSnapshot().status, "off");
    assert.deepEqual(calls, ["DELETE"]);
  });

  it("leaves the API untouched when the customer refuses the permission", async () => {
    const { native, api, calls } = fakes("undetermined", "denied");
    const model = createPushModel({ api, native });
    await model.enable();
    assert.equal(model.getSnapshot().status, "denied");
    assert.deepEqual(calls, ["permission", "request"]);
  });

  it("reports an opt-in the OS later blocked, so the screen can point to the settings", async () => {
    const { native, api } = fakes("granted");
    const model = createPushModel({ api, native });
    await model.enable();
    native.permissionNow = "denied";
    await model.refresh();
    assert.equal(model.getSnapshot().status, "denied");
  });

  it("keeps the last status and shows a message when the API fails", async () => {
    const { native, api } = fakes("granted");
    const model = createPushModel({
      native,
      api: {
        ...api,
        register: async () => {
          throw new CustomerError(0, "NETWORK");
        },
      },
    });
    await model.refresh();
    await model.enable();
    const state = model.getSnapshot();
    assert.equal(state.status, "off");
    assert.equal(state.busy, false);
    assert.match(state.error ?? "", /conexão/);
  });

  it("refuses a malformed token or answer instead of showing it as on", async () => {
    const { native, api } = fakes("granted");
    native.token = async () => "fcm-token";
    const model = createPushModel({ api, native });
    await model.enable();
    assert.equal(model.getSnapshot().status, "unknown");
    assert.ok(model.getSnapshot().error);

    const broken = createPushModel({
      native: fakes("granted").native,
      api: { ...api, status: async () => ({ enabled: "yes" }) },
    });
    await broken.refresh();
    assert.equal(broken.getSnapshot().status, "unknown");
    assert.ok(broken.getSnapshot().error);
  });

  it("drops an answer that arrives after a sign-out", async () => {
    const { native, api } = fakes("granted");
    let release!: () => void;
    const model = createPushModel({
      native,
      api: {
        ...api,
        status: () =>
          new Promise((resolve) => {
            release = () => resolve({ enabled: true });
          }),
      },
    });
    const pending = model.refresh();
    model.reset();
    release();
    await pending;
    assert.deepEqual(model.getSnapshot(), {
      status: "unknown",
      busy: false,
      error: null,
    });
  });

  it("opens only orders of this app's own notifications", () => {
    assert.equal(
      orderIdFromNotification({ type: "order-status", orderId: ORDER }),
      ORDER,
    );
    for (const data of [
      null,
      undefined,
      {},
      { type: "promo", orderId: ORDER },
      { type: "order-status", orderId: "../x" },
      { type: "order-status", orderId: 1 },
    ])
      assert.equal(orderIdFromNotification(data), null);
  });
});
