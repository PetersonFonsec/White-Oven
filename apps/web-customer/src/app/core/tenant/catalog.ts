import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from "@angular/core";
import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { Subscription } from "rxjs";
import {
  parseMenu,
  menuSections,
  type PublicMenu,
} from "@whiteoven/customer-core/menu/menu";
import { featuredPizzas } from "@whiteoven/customer-core/menu/home";
import { StoreContext } from "./store-context";
import { storePath } from "../api/public-api";
@Injectable()
export class Catalog {
  private readonly store = inject(StoreContext);
  private readonly http = inject(HttpClient);
  readonly menu = signal<PublicMenu | null>(null);
  readonly status = signal<"loading" | "ready" | "stale" | "error">("loading");
  readonly sections = computed(() =>
    this.menu() ? menuSections(this.menu()!) : [],
  );
  readonly featured = computed(() => featuredPizzas(this.sections(), 4));
  private request?: Subscription;
  private done?: (menu: PublicMenu | null) => void;
  constructor() {
    effect(() => {
      const availability = this.store.availability();
      untracked(() => {
        if (availability === "open" || availability === "closed") {
          void this.reload();
        } else {
          this.cancel();
          if (availability === "unavailable") this.menu.set(null);
          this.status.set(this.menu() ? "stale" : "loading");
        }
      });
    });
    inject(DestroyRef).onDestroy(() => this.cancel());
  }
  private cancel() {
    this.request?.unsubscribe();
    this.done?.(null);
    this.done = undefined;
  }
  reload(): Promise<PublicMenu | null> {
    this.cancel();
    if (!["open", "closed"].includes(this.store.availability()))
      return Promise.resolve(null);
    this.status.set("loading");
    return new Promise((resolve) => {
      this.done = resolve;
      const fail = () => {
        this.status.set(this.menu() ? "stale" : "error");
        resolve(null);
      };
      this.request = this.http
        .get<unknown>(storePath(this.store.slug()) + "/menu", { timeout: 8000 })
        .subscribe({
          next: (raw) => {
            const menu = parseMenu(raw);
            if (!menu) {
              fail();
              return;
            }
            this.menu.set(menu);
            this.status.set("ready");
            resolve(menu);
          },
          error: (err: unknown) => {
            if (
              err instanceof HttpErrorResponse &&
              [403, 404].includes(err.status)
            ) {
              this.menu.set(null);
              this.store.availability.set("unavailable");
            }
            fail();
          },
        });
    });
  }
}
