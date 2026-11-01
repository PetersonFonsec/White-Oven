import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CheckoutConditions,
  checkoutAction,
} from "../src/cart/checkout-flow.ts";
import {
  orderProgress,
  progressSummary,
  statusTone,
} from "../src/customer/order-progress.ts";

const ok: CheckoutConditions = {
  ready: true,
  busy: false,
  pending: false,
  empty: false,
  unavailableItems: false,
  stale: false,
  canOrder: true,
  settingsLoaded: true,
  signedIn: true,
  delivery: true,
  addressChosen: true,
};

describe("checkout main action", () => {
  it("reviews the total first, then confirms", () => {
    assert.deepEqual(checkoutAction(ok, false), { kind: "quote" });
    assert.deepEqual(checkoutAction(ok, true), { kind: "confirm" });
  });

  it("offers sign-in instead of a dead button", () => {
    assert.deepEqual(checkoutAction({ ...ok, signedIn: false }, false), {
      kind: "sign-in",
    });
  });

  it("says why it is blocked, in the order the customer can fix it", () => {
    const reason = (patch: Partial<CheckoutConditions>) => {
      const action = checkoutAction({ ...ok, ...patch }, false);
      return action.kind === "blocked" ? action.reason : action.kind;
    };
    assert.match(reason({ pending: true, empty: true }), /pendente/);
    assert.match(reason({ empty: true }), /vazia/);
    assert.match(reason({ unavailableItems: true }), /indisponíveis/);
    assert.match(reason({ stale: true }), /desatualizado/);
    assert.match(reason({ canOrder: false }), /aberta/);
    assert.match(reason({ settingsLoaded: false }), /entrega e pagamento/);
    assert.match(reason({ addressChosen: false }), /endereço/);
    assert.equal(reason({ delivery: false, addressChosen: false }), "quote");
    // A store that cannot take orders blocks before asking to sign in.
    assert.match(reason({ canOrder: false, signedIn: false }), /aberta/);
  });
});

describe("order progress", () => {
  it("draws delivery with 'saiu para entrega' and pickup without it", () => {
    const delivery = orderProgress("PREPARING", "DELIVERY")!;
    assert.deepEqual(
      delivery.map((step) => step.state),
      ["done", "current", "upcoming", "upcoming", "upcoming"],
    );
    assert.equal(delivery[3]!.label, "Saiu para entrega");
    const pickup = orderProgress("READY", "PICKUP")!;
    assert.equal(pickup.length, 4);
    assert.equal(pickup[2]!.label, "Pronto para retirada");
    assert.equal(
      progressSummary("READY", "PICKUP"),
      "Etapa 3 de 4: Pronto para retirada",
    );
  });

  it("marks a completed order as done and has no progress for a rejected one", () => {
    assert.ok(
      orderProgress("COMPLETED", "PICKUP")!.every((s) => s.state === "done"),
    );
    assert.equal(orderProgress("REJECTED", "DELIVERY"), null);
    assert.equal(orderProgress("CANCELED", "PICKUP"), null);
    assert.equal(statusTone("CANCELED"), "error");
    assert.equal(statusTone("COMPLETED"), "success");
    assert.equal(statusTone("PLACED"), "progress");
  });
});
