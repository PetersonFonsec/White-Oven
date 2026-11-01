import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WELCOME_SLIDES,
  authBack,
  authForward,
  brandNameParts,
  initialAuthStep,
  showsWelcome,
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

  it("shows the welcome only for a launch with no saved session on the menu", () => {
    const base = {
      ready: true,
      session: "restored" as const,
      signedIn: false,
      dismissed: false,
      screen: "menu",
    };
    assert.equal(showsWelcome(base), true);
    assert.equal(showsWelcome({ ...base, session: "restoring" }), false);
    assert.equal(showsWelcome({ ...base, session: "failed" }), false);
    assert.equal(showsWelcome({ ...base, ready: false }), false);
    assert.equal(showsWelcome({ ...base, signedIn: true }), false);
    assert.equal(showsWelcome({ ...base, dismissed: true }), false);
    // An unavailable store, the bag or an order keep their own screen.
    assert.equal(showsWelcome({ ...base, screen: "unavailable" }), false);
    assert.equal(showsWelcome({ ...base, screen: "cart" }), false);
    assert.equal(showsWelcome({ ...base, screen: "starting" }), false);
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
