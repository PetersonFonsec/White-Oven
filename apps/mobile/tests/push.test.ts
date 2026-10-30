import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomerError } from "../src/customer/client.ts";
import { orderDetailMessage } from "../src/customer/orders.ts";
import {
  type PermissionStatus,
  type PushApi,
  type PushNative,
  createNotificationRouter,
  createPushModel,
  orderIdFromNotification,
} from "../src/customer/push.ts";

const TOKEN = "ExponentPushToken[device-1]";
const ORDER = "0f3c1a52-6d2e-4b8f-9a77-3f1e2d4c5b6a";
const INSTALLATION = "6b0c3e1d-2f4a-4c5b-8d9e-0a1b2c3d4e5f";
const installation = async () => INSTALLATION;

function fakes(
  permission: PermissionStatus = "undetermined",
  answer: PermissionStatus = "granted",
) {
  const calls: string[] = [];
  let enabled = false;
  const native: PushNative & {
    permissionNow: PermissionStatus;
    tokenNow: string;
  } = {
    permissionNow: permission,
    tokenNow: TOKEN,
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
      return this.tokenNow;
    },
  };
  const api: PushApi & { enabled: boolean } = {
    get enabled() {
      return enabled;
    },
    set enabled(value) {
      enabled = value;
    },
    async status() {
      calls.push("GET");
      return { enabled };
    },
    async register(token, installationId) {
      calls.push(`PUT ${token} ${installationId}`);
      enabled = true;
      return { enabled };
    },
    async unregister(installationId) {
      calls.push(`DELETE ${installationId}`);
      enabled = false;
      return null;
    },
  };
  return { native, api, calls };
}

describe("order notification opt-in", () => {
  it("is unavailable in a build without a push project and never calls the API", async () => {
    const { api, calls } = fakes();
    const model = createPushModel({ api, native: null, installation });
    assert.equal(model.getSnapshot().status, "unavailable");
    await model.refresh();
    await model.enable();
    assert.deepEqual(calls, []);
    model.reset();
    assert.equal(model.getSnapshot().status, "unavailable");
  });

  it("reads the opt-in without asking the OS, releasing this installation from an earlier account", async () => {
    const { native, api, calls } = fakes();
    const model = createPushModel({ api, native, installation });
    assert.equal(model.getSnapshot().status, "unknown");
    await model.refresh();
    assert.equal(model.getSnapshot().status, "off");
    assert.deepEqual(calls, ["GET", `DELETE ${INSTALLATION}`]);
  });

  it("asks for permission only on the explicit opt-in, then registers the token and installation", async () => {
    const { native, api, calls } = fakes();
    const model = createPushModel({ api, native, installation });
    await model.enable();
    assert.equal(model.getSnapshot().status, "on");
    assert.deepEqual(calls, [
      "permission",
      "request",
      "token",
      `PUT ${TOKEN} ${INSTALLATION}`,
    ]);

    calls.length = 0;
    await model.disable();
    assert.equal(model.getSnapshot().status, "off");
    assert.deepEqual(calls, [`DELETE ${INSTALLATION}`]);
  });

  it("registers a rotated token again on the next refresh", async () => {
    const { native, api, calls } = fakes("granted");
    const model = createPushModel({ api, native, installation });
    await model.enable();
    native.tokenNow = "ExponentPushToken[device-2]";
    calls.length = 0;
    await model.refresh();
    assert.equal(model.getSnapshot().status, "on");
    assert.deepEqual(calls, [
      "GET",
      "permission",
      "token",
      `PUT ExponentPushToken[device-2] ${INSTALLATION}`,
    ]);
  });

  it("leaves the API untouched when the customer refuses the permission", async () => {
    const { native, api, calls } = fakes("undetermined", "denied");
    const model = createPushModel({ api, native, installation });
    await model.enable();
    assert.equal(model.getSnapshot().status, "denied");
    assert.deepEqual(calls, ["permission", "request"]);
  });

  it("reports an opt-in the OS later blocked, so the screen can point to the settings", async () => {
    const { native, api } = fakes("granted");
    const model = createPushModel({ api, native, installation });
    await model.enable();
    native.permissionNow = "denied";
    await model.refresh();
    assert.equal(model.getSnapshot().status, "denied");
  });

  it("keeps the last status and shows a message when the API fails", async () => {
    const { native, api } = fakes("granted");
    const model = createPushModel({
      native,
      installation,
      api: {
        ...api,
        status: api.status,
        unregister: api.unregister,
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

  it("refuses a malformed token, installation id or answer instead of showing it as on", async () => {
    const { native, api } = fakes("granted");
    native.tokenNow = "fcm-token";
    const model = createPushModel({ api, native, installation });
    await model.enable();
    assert.equal(model.getSnapshot().status, "unknown");
    assert.ok(model.getSnapshot().error);

    const noInstallation = createPushModel({
      api: fakes().api,
      native: fakes("granted").native,
      installation: async () => "serial-123",
    });
    await noInstallation.enable();
    assert.equal(noInstallation.getSnapshot().status, "unknown");
    assert.ok(noInstallation.getSnapshot().error);

    const broken = createPushModel({
      native: fakes("granted").native,
      installation,
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
      installation,
      api: {
        ...api,
        register: api.register,
        unregister: api.unregister,
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
});

describe("tapped order notifications", () => {
  const data = { type: "order-status", orderId: ORDER };
  const restored = { status: "restored" as const, signedIn: true };

  it("accepts only this app's order notifications with a UUID", () => {
    assert.equal(orderIdFromNotification(data), ORDER);
    for (const invalid of [
      null,
      undefined,
      {},
      { type: "promo", orderId: ORDER },
      { type: "order-status", orderId: "../x" },
      { type: "order-status", orderId: `${ORDER}x` },
      { type: "order-status", orderId: 1 },
    ])
      assert.equal(orderIdFromNotification(invalid), null);
    const router = createNotificationRouter();
    assert.equal(
      router.opened("n-1", { type: "order-status", orderId: "abc" }),
      false,
    );
    assert.deepEqual(router.take(restored), { kind: "none" });
  });

  it("opens the order of a signed-in customer", () => {
    const router = createNotificationRouter();
    assert.equal(router.opened("n-1", data), true);
    assert.deepEqual(router.take(restored), { kind: "order", orderId: ORDER });
    assert.deepEqual(router.take(restored), { kind: "none" }, "only once");
  });

  it("waits while the session is restored after a cold start, then decides", () => {
    // The app was closed: the tap arrives before the saved session is read.
    const router = createNotificationRouter();
    router.opened("n-cold", data);
    assert.deepEqual(router.take({ status: "idle", signedIn: false }), {
      kind: "wait",
    });
    assert.deepEqual(router.take({ status: "restoring", signedIn: false }), {
      kind: "wait",
    });
    assert.deepEqual(router.take(restored), { kind: "order", orderId: ORDER });
  });

  it("sends a signed-out or expired session to the account screen, not the order", () => {
    const expired = createNotificationRouter();
    expired.opened("n-1", data);
    assert.deepEqual(expired.take({ status: "restored", signedIn: false }), {
      kind: "login",
      orderId: ORDER,
    });
    const failed = createNotificationRouter();
    failed.opened("n-2", data);
    assert.deepEqual(failed.take({ status: "failed", signedIn: false }), {
      kind: "login",
      orderId: ORDER,
    });
  });

  it("opens a tap from the background or foreground as soon as it arrives", () => {
    const router = createNotificationRouter();
    assert.deepEqual(router.take(restored), { kind: "none" });
    router.opened("n-background", data);
    assert.deepEqual(router.take(restored), { kind: "order", orderId: ORDER });
  });

  it("opens each notification once, though the launch response and the listener both report it", () => {
    const router = createNotificationRouter();
    assert.equal(router.opened("n-1", data), true);
    assert.equal(router.opened("n-1", data), false);
    assert.deepEqual(router.take(restored), { kind: "order", orderId: ORDER });
    assert.deepEqual(router.take(restored), { kind: "none" });
    const other = "1f3c1a52-6d2e-4b8f-9a77-3f1e2d4c5b6a";
    assert.equal(
      router.opened("n-2", { type: "order-status", orderId: other }),
      true,
    );
    assert.deepEqual(router.take(restored), { kind: "order", orderId: other });
  });

  it("shows nothing of an order of another account or one that does not exist", () => {
    // The API answers 404 for both; the screen then shows only this message.
    const message = orderDetailMessage(new CustomerError(404, "NOT_FOUND"));
    assert.match(message, /não está disponível nesta conta/);
    assert.match(
      orderDetailMessage(new CustomerError(0, "NETWORK")),
      /conexão/,
    );
  });
});
