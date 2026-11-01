import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WELCOME_SLIDES,
  authBack,
  authForward,
  brandNameParts,
  initialAuthStep,
  welcomeDecision,
  slideAt,
} from "../src/customer/auth-flow.ts";

describe("auth flow", () => {
  it("opens on the form when another screen asked for a sign-in", () => {
    assert.equal(
      initialAuthStep({ returnsSomewhere: false, hasNotice: false }),
      "welcome",
    );
    assert.equal(
      initialAuthStep({ returnsSomewhere: true, hasNotice: false }),
      "login",
    );
    assert.equal(
      initialAuthStep({ returnsSomewhere: false, hasNotice: true }),
      "login",
    );
  });

  it("switches between sign-in and sign-up without stacking them", () => {
    let stack = authForward(["welcome"], "login");
    assert.deepEqual(stack, ["welcome", "login"]);
    stack = authForward(stack, "register");
    assert.deepEqual(stack, ["welcome", "register"]);
    stack = authForward(stack, "login");
    assert.deepEqual(stack, ["welcome", "login"]);
    assert.deepEqual(authBack(stack), ["welcome"]);
    assert.equal(authBack(["welcome"]), null);
    // Opened from the bag: back from the form leaves the flow.
    assert.equal(authBack(authForward(["login"], "register")), null);
    assert.deepEqual(authForward(["login"], "login"), ["login"]);
    assert.deepEqual(authForward(["register"], "confirm-email"), [
      "register",
      "confirm-email",
    ]);
  });

  describe("welcome at launch", () => {
    const base = {
      ready: true,
      session: "restored" as const,
      signedIn: false,
      dismissed: false,
      screen: "menu",
      availability: "open" as const,
      menu: "ok" as const,
      shown: false,
    };
    const decide = (change: Partial<Parameters<typeof welcomeDecision>[0]>) =>
      welcomeDecision({ ...base, ...change });

    it("shows on an open store, for a customer without a saved session", () => {
      assert.equal(decide({}), "show");
    });

    it("shows on a store closed by its hours or paused: the menu can still be browsed", () => {
      assert.equal(decide({ availability: "closed" }), "show");
    });

    it("never covers an unavailable or suspended store", () => {
      assert.equal(
        decide({ availability: "unavailable", screen: "unavailable" }),
        "skip",
      );
      // Even before the session is known, the unavailable screen keeps priority.
      assert.equal(
        decide({ availability: "unavailable", session: "restoring" }),
        "skip",
      );
      // And a store that becomes unavailable closes a welcome already on screen.
      assert.equal(
        decide({
          availability: "unavailable",
          screen: "unavailable",
          shown: true,
        }),
        "skip",
      );
    });

    it("skips without a connection or a menu, instead of popping up later", () => {
      assert.equal(decide({ availability: "offline" }), "skip");
      assert.equal(decide({ menu: "failed" }), "skip");
      assert.equal(decide({ menu: "loading" }), "wait");
      assert.equal(decide({ availability: null, screen: "starting" }), "wait");
      // Once shown, a refresh that loses the connection does not pull it away.
      assert.equal(decide({ availability: "offline", shown: true }), "show");
    });

    it("waits while the saved session is restored, and never shows to a signed-in customer", () => {
      assert.equal(decide({ session: "idle" }), "wait");
      assert.equal(decide({ session: "restoring" }), "wait");
      assert.equal(decide({ ready: false }), "wait");
      assert.equal(decide({ session: "restoring", signedIn: true }), "skip");
      assert.equal(decide({ signedIn: true }), "skip");
      assert.equal(decide({ signedIn: true, shown: true }), "skip");
      // A session that could not be checked may be a signed-in customer.
      assert.equal(decide({ session: "failed" }), "skip");
    });

    it("stays away once dismissed, signed in from it or left for another screen", () => {
      assert.equal(decide({ dismissed: true }), "skip");
      assert.equal(decide({ dismissed: true, shown: true }), "skip");
      // "Entrar" or "Criar conta" end in a session.
      assert.equal(decide({ shown: true, signedIn: true }), "skip");
      // The bag, an order or the account keep their own screen.
      assert.equal(decide({ screen: "cart" }), "skip");
      assert.equal(decide({ screen: "order", shown: true }), "skip");
      // Back on the menu after skipping it: the menu stays, browsable without an account.
      assert.equal(decide({ dismissed: true, screen: "menu" }), "skip");
    });
  });

  it("splits the store name for the two-tone mark", () => {
    assert.deepEqual(brandNameParts("Pizzaria  Centro "), {
      lead: "Pizzaria ",
      tail: "Centro",
    });
    assert.deepEqual(brandNameParts("Forneria"), {
      lead: "Forneria",
      tail: "",
    });
  });

  it("keeps the carousel position inside the slides", () => {
    assert.equal(WELCOME_SLIDES.length, 3);
    assert.equal(slideAt(0, 350, 3), 0);
    assert.equal(slideAt(360, 350, 3), 1);
    assert.equal(slideAt(5000, 350, 3), 2);
    assert.equal(slideAt(-20, 350, 3), 0);
    assert.equal(slideAt(100, 0, 3), 0);
  });
});
