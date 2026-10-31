import type { Answer, StoreView } from "../brand/store-loader.ts";
import type { PublicMenu } from "../menu/menu.ts";

/**
 * The menu the app holds (ADR 0021). `stale` marks a menu kept on screen after a reload failed:
 * its prices and availability may have changed, and the menu and the builder say so.
 */
export type MenuState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ok"; menu: PublicMenu; stale: boolean };

/** A reload starts: a menu on screen stays (and keeps its staleness) while it runs. */
export function menuWhileLoading(current: MenuState): MenuState {
  return current.kind === "ok" ? current : { kind: "loading" };
}

/**
 * A reload ended. A new menu replaces the old one and clears the warning; a failure keeps the
 * menu on screen marked stale, or shows the error when there was none.
 */
export function menuAfterLoad(
  current: MenuState,
  answer: Answer<PublicMenu>,
): MenuState {
  if (answer.kind === "ok")
    return { kind: "ok", menu: answer.body, stale: false };
  return current.kind === "ok"
    ? { ...current, stale: true }
    : { kind: "failed" };
}

export interface MenuLoader {
  /** Starts a reload; an earlier one still running is aborted and its answer dropped. */
  reload(): Promise<void>;
  dispose(): void;
}

/**
 * Reloads the menu once at a time: only the latest reload may change the state, so an answer
 * that arrives late never replaces a newer one. Pure, with `load` injected, for tests.
 */
export function createMenuLoader(
  load: (signal: AbortSignal) => Promise<Answer<PublicMenu>>,
  update: (change: (current: MenuState) => MenuState) => void,
): MenuLoader {
  let running: AbortController | null = null;
  let disposed = false;
  return {
    async reload() {
      if (disposed) return;
      running?.abort();
      const controller = new AbortController();
      running = controller;
      update(menuWhileLoading);
      let answer: Answer<PublicMenu>;
      try {
        answer = await load(controller.signal);
      } catch {
        answer = { kind: "failed" };
      }
      if (controller.signal.aborted || disposed) return;
      running = null;
      update((current) => menuAfterLoad(current, answer));
    },
    dispose() {
      disposed = true;
      running?.abort();
    },
  };
}

export type Screen =
  | { kind: "starting" }
  /** The API confirmed the store is not serving: nothing else is reachable. */
  | { kind: "unavailable" }
  | { kind: "account" }
  /** `recoveryOnly`: the store is unavailable; only a pending confirmation and its result show. */
  | { kind: "cart"; recoveryOnly: boolean }
  | { kind: "history" }
  | { kind: "order"; orderId: string }
  | { kind: "menu" }
  | { kind: "builder"; flavorId: string };

export type Destination =
  | { kind: "account" }
  | { kind: "cart" }
  | { kind: "history" }
  | { kind: "order"; orderId: string }
  /** String forms remain accepted by the existing navigation contract. */
  | "account"
  | "cart"
  | null;

export const destinationKind = (destination: Destination) =>
  typeof destination === "string" ? destination : (destination?.kind ?? null);

/**
 * What the saved commerce state needs from the cart screen while the store is unavailable:
 * a pending confirmation to recover, or the receipt that recovery just produced.
 */
export type Recovery = "pending" | "receipt" | null;

/**
 * The one place that decides what the app shows. A store confirmed unavailable wins over
 * the builder and checkout. Account and customer order history remain readable; the cart only
 * opens to recover a pending confirmation (ADR 0022): never to quote or change that cart.
 * Closed and offline stores keep the menu and the builder,
 * with their notices. The builder needs a menu to price with.
 */
export function screenFor(
  view: StoreView | null,
  menu: MenuState,
  building: string | null,
  destination: Destination = null,
  recovery: Recovery = null,
): Screen {
  if (destinationKind(destination) === "account") return { kind: "account" };
  if (destinationKind(destination) === "history") return { kind: "history" };
  if (typeof destination === "object" && destination?.kind === "order")
    return { kind: "order", orderId: destination.orderId };
  if (!view) return { kind: "starting" };
  if (view.availability.kind === "unavailable")
    return destinationKind(destination) === "cart" && recovery
      ? { kind: "cart", recoveryOnly: true }
      : { kind: "unavailable" };
  if (destinationKind(destination) === "cart")
    return { kind: "cart", recoveryOnly: false };
  if (building && menu.kind === "ok")
    return { kind: "builder", flavorId: building };
  return { kind: "menu" };
}

/**
 * The open pizza after a store refresh: closed when the store is confirmed unavailable, so it
 * does not come back on its own when the store serves again.
 */
export function buildingAfterRefresh(
  building: string | null,
  view: StoreView,
): string | null {
  return view.availability.kind === "unavailable" ? null : building;
}

/**
 * The destination after a store refresh: a store confirmed unavailable closes the cart unless it
 * is recovering a pending confirmation, which a status change must not interrupt.
 */
export function destinationAfterRefresh(
  destination: Destination,
  view: StoreView,
  recovery: Recovery,
): Destination {
  return destinationKind(destination) === "cart" &&
    view.availability.kind === "unavailable" &&
    !recovery
    ? null
    : destination;
}
