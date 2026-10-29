import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BRAND_COLORS } from "../src/brand/colors.ts";
import type { Answer, StoreView } from "../src/brand/store-loader.ts";
import { type PublicMenu, parseMenu } from "../src/menu/menu.ts";
import {
  type MenuState,
  buildingAfterRefresh,
  createMenuLoader,
  destinationAfterRefresh,
  menuAfterLoad,
  menuWhileLoading,
  screenFor,
} from "../src/navigation/app-state.ts";
import {
  MENU_STALE_NOTICE,
  menuNotices,
} from "../src/screens/store-messages.ts";
import { apiMenu } from "./menu-fixture.ts";

const view = (availability: StoreView["availability"]): StoreView => ({
  name: "Forno do Bairro",
  colors: DEFAULT_BRAND_COLORS,
  logoImageId: null,
  brandVersion: 1,
  brandSource: "api",
  brandStale: false,
  availability,
});
const OPEN = view({ kind: "open" });
const CLOSED = view({
  kind: "closed",
  reason: "OUTSIDE_HOURS",
  pausedUntil: null,
  timezone: "America/Sao_Paulo",
});
const OFFLINE = view({ kind: "offline" });
const UNAVAILABLE = view({ kind: "unavailable" });
const menu = parseMenu(apiMenu())!;
const LOADED: MenuState = { kind: "ok", menu, stale: false };
const isStale = (state: MenuState) => state.kind === "ok" && state.stale;

describe("app navigation", () => {
  it("keeps account accessible during suspension but blocks cart", () => {
    assert.deepEqual(screenFor(UNAVAILABLE, LOADED, null, "account"), {
      kind: "account",
    });
    assert.deepEqual(screenFor(UNAVAILABLE, LOADED, null, "cart"), {
      kind: "unavailable",
    });
    assert.deepEqual(screenFor(CLOSED, LOADED, null, "cart"), {
      kind: "cart",
      recoveryOnly: false,
    });
  });

  it("opens the cart of an unavailable store only to recover a pending confirmation", () => {
    // Available store: the normal checkout.
    for (const store of [OPEN, CLOSED, OFFLINE])
      assert.deepEqual(screenFor(store, LOADED, null, "cart", null), {
        kind: "cart",
        recoveryOnly: false,
      });
    // Unavailable without a pending confirmation: blocked.
    assert.deepEqual(screenFor(UNAVAILABLE, LOADED, null, "cart", null), {
      kind: "unavailable",
    });
    // Unavailable with one: recovery only (the screen offers no quote or cart change).
    assert.deepEqual(screenFor(UNAVAILABLE, LOADED, null, "cart", "pending"), {
      kind: "cart",
      recoveryOnly: true,
    });
    // A pending confirmation does not reopen the menu or the builder of an unavailable store.
    assert.deepEqual(
      screenFor(UNAVAILABLE, LOADED, "calabresa", null, "pending"),
      { kind: "unavailable" },
    );
  });

  it("keeps a recovery open when a refresh confirms the store unavailable", () => {
    assert.equal(
      destinationAfterRefresh("cart", UNAVAILABLE, "pending"),
      "cart",
    );
    // Recovery succeeded while unavailable: its receipt stays on screen.
    assert.equal(
      destinationAfterRefresh("cart", UNAVAILABLE, "receipt"),
      "cart",
    );
    assert.equal(destinationAfterRefresh("cart", UNAVAILABLE, null), null);
    assert.equal(destinationAfterRefresh("cart", OPEN, null), "cart");
    assert.equal(
      destinationAfterRefresh("account", UNAVAILABLE, null),
      "account",
    );
  });
  it("opens the builder for open, closed and unconfirmed stores", () => {
    for (const store of [OPEN, CLOSED, OFFLINE])
      assert.deepEqual(screenFor(store, LOADED, "calabresa"), {
        kind: "builder",
        flavorId: "calabresa",
      });
    // Offline is not a suspension: the menu stays reachable too.
    assert.deepEqual(screenFor(OFFLINE, LOADED, null), { kind: "menu" });
    // The builder prices with a menu; without one the menu screen shows its state.
    assert.deepEqual(screenFor(OPEN, { kind: "failed" }, "calabresa"), {
      kind: "menu",
    });
    assert.deepEqual(screenFor(null, LOADED, "calabresa"), {
      kind: "starting",
    });
  });

  it("closes the builder when a refresh confirms the store unavailable, for good", () => {
    for (const before of [OPEN, CLOSED]) {
      assert.equal(screenFor(before, LOADED, "calabresa").kind, "builder");
      // Even before the open pizza is cleared, unavailable wins over it.
      assert.deepEqual(screenFor(UNAVAILABLE, LOADED, "calabresa"), {
        kind: "unavailable",
      });
      const building = buildingAfterRefresh("calabresa", UNAVAILABLE);
      assert.equal(building, null);
      // The store serves again: the old pizza does not come back on its own.
      assert.deepEqual(screenFor(OPEN, LOADED, building), { kind: "menu" });
    }
    // Offline and closed answers keep the open pizza.
    assert.equal(buildingAfterRefresh("calabresa", OFFLINE), "calabresa");
    assert.equal(buildingAfterRefresh("calabresa", CLOSED), "calabresa");
  });

  it("goes back from the builder to the menu", () => {
    // Back (button or Android) clears the open pizza; the screen follows from the state.
    assert.equal(screenFor(OPEN, LOADED, "calabresa").kind, "builder");
    assert.deepEqual(screenFor(OPEN, LOADED, null), { kind: "menu" });
  });
});

describe("menu reloads", () => {
  const ok = (version: number): Answer<PublicMenu> => ({
    kind: "ok",
    body: { ...menu, version },
  });
  const failed: Answer<PublicMenu> = { kind: "failed" };

  it("shows the error only when there is no menu, and marks a kept menu stale", () => {
    const first = menuAfterLoad(menuWhileLoading({ kind: "loading" }), failed);
    assert.deepEqual(first, { kind: "failed" });
    assert.deepEqual(menuWhileLoading(first), { kind: "loading" });

    const loaded = menuAfterLoad(first, ok(1));
    assert.deepEqual(loaded, {
      kind: "ok",
      menu: { ...menu, version: 1 },
      stale: false,
    });
    // A reload keeps the menu on screen while it runs.
    assert.equal(menuWhileLoading(loaded), loaded);
    const stale = menuAfterLoad(menuWhileLoading(loaded), failed);
    assert.deepEqual(stale, { ...loaded, stale: true });
    // Still stale while the next reload runs; cleared only by a menu that arrived.
    assert.equal(menuWhileLoading(stale), stale);
    assert.deepEqual(menuAfterLoad(stale, failed), stale);
    assert.deepEqual(menuAfterLoad(stale, ok(2)), {
      kind: "ok",
      menu: { ...menu, version: 2 },
      stale: false,
    });
    for (const unavailable of [{ kind: "unavailable" } as const])
      assert.deepEqual(menuAfterLoad(loaded, unavailable), {
        ...loaded,
        stale: true,
      });
  });

  it("warns on the menu while it is stale, next to the store's own notices", () => {
    assert.deepEqual(menuNotices(OPEN, true), [MENU_STALE_NOTICE]);
    assert.deepEqual(menuNotices(OPEN, false), []);
    assert.deepEqual(menuNotices(CLOSED, true), [
      "Loja fechada. Forno do Bairro está fora do horário de funcionamento.",
      MENU_STALE_NOTICE,
    ]);
    assert.match(
      MENU_STALE_NOTICE,
      /Preços e disponibilidade podem ter mudado/,
    );
  });

  it("lets only the latest of two concurrent reloads change the menu", async () => {
    let state: MenuState = { kind: "loading" };
    const pending: {
      signal: AbortSignal;
      resolve: (answer: Answer<PublicMenu>) => void;
    }[] = [];
    const loader = createMenuLoader(
      (signal) => new Promise((resolve) => pending.push({ signal, resolve })),
      (change) => {
        state = change(state);
      },
    );
    const older = loader.reload();
    const newer = loader.reload();
    assert.equal(pending[0]!.signal.aborted, true);
    assert.equal(pending[1]!.signal.aborted, false);
    pending[1]!.resolve(ok(2));
    await newer;
    // The older answer arrives last and is dropped.
    pending[0]!.resolve(ok(1));
    await older;
    assert.deepEqual(state, {
      kind: "ok",
      menu: { ...menu, version: 2 },
      stale: false,
    });

    // A failure after that marks the menu stale; a later success clears it.
    const failing = loader.reload();
    pending[2]!.resolve(failed);
    await failing;
    assert.equal(isStale(state), true);
    const recovering = loader.reload();
    pending[3]!.resolve(ok(3));
    await recovering;
    assert.deepEqual(state, {
      kind: "ok",
      menu: { ...menu, version: 3 },
      stale: false,
    });

    // Disposed (screen gone): the running reload is aborted and changes nothing.
    const lost = loader.reload();
    loader.dispose();
    assert.equal(pending[4]!.signal.aborted, true);
    pending[4]!.resolve(failed);
    await lost;
    assert.equal(isStale(state), false);
    await loader.reload();
    assert.equal(pending.length, 5);
  });

  it("treats a load that throws as a failed reload", async () => {
    let state: MenuState = LOADED;
    const loader = createMenuLoader(
      () => Promise.reject(new Error("network")),
      (change) => {
        state = change(state);
      },
    );
    await loader.reload();
    assert.deepEqual(state, { ...LOADED, stale: true });
  });
});
