import { computed, inject, Injectable, signal } from "@angular/core";
import { StoreContext } from "./store-context";
export type MenuLayout = "grid" | "list";
/** A public display preference only, scoped to this shop in the current browser. */
@Injectable()
export class Preferences {
  private readonly store = inject(StoreContext);
  private readonly selection = signal<MenuLayout | null>(null);
  readonly layout = computed<MenuLayout>(() => {
    const choice = this.selection();
    if (choice) return choice;
    try {
      return localStorage.getItem(this.key()) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  private key() {
    return "whiteoven/menu-layout/" + this.store.slug();
  }
  choose(value: MenuLayout) {
    this.selection.set(value);
    try {
      localStorage.setItem(this.key(), value);
    } catch {
      /* Still applies during this visit. */
    }
  }
}
