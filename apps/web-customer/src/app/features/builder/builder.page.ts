import {
  QuantitySelector,
  FlavorSelector,
} from "../../design-system/commerce-controls";
import { PIZZA_QUANTITY_MAX } from "@whiteoven/contracts";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from "@angular/core";
import { Router } from "@angular/router";
import {
  builderMenu,
  startBuilder,
  evaluateBuilder,
  changeSize,
  setMode,
  setFlavor,
  setCrust,
  setQuantity,
  toggleExtra,
  toggleRemoval,
  describePizza,
  previewConfiguration,
  priceLines,
  type BuilderState,
} from "@whiteoven/customer-core/builder/builder";
import { addPizza } from "@whiteoven/customer-core/cart/cart";
import { imageUrl, formatCents } from "@whiteoven/customer-core/menu/menu";
import type { HalfSide } from "@whiteoven/contracts";
import { Catalog } from "../../core/tenant/catalog";
import { Shop } from "../../core/commerce/shop";
import { StoreContext } from "../../core/tenant/store-context";
import { Button, Input } from "../../design-system/primitives";
import { CatalogNotice } from "../catalog/catalog-ui";
@Component({
  imports: [Button, Input, CatalogNotice, QuantitySelector, FlavorSelector],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./builder.page.html",
})
export class BuilderPage {
  readonly flavorId = input.required<string>();
  readonly catalog = inject(Catalog);
  readonly shop = inject(Shop);
  readonly store = inject(StoreContext);
  private readonly router = inject(Router);
  readonly money = formatCents;
  readonly builder = computed(() =>
    this.catalog.menu() ? builderMenu(this.catalog.menu()!) : null,
  );
  readonly state = linkedSignal<
    { id: string; initial: BuilderState | null },
    BuilderState | null
  >({
    source: () => ({
      id: this.flavorId(),
      initial: this.builder()
        ? startBuilder(this.builder()!, this.flavorId())
        : null,
    }),
    computation: (source, previous) =>
      source.initial && previous?.source.id === source.id && previous.value
        ? previous.value
        : source.initial,
  });
  readonly result = computed(() =>
    this.state() && this.builder()
      ? evaluateBuilder(this.builder()!, this.state()!)
      : null,
  );
  readonly halves = computed(() => {
    const b = this.builder(),
      s = this.state(),
      r = this.result();
    return b && s
      ? describePizza(
          b,
          r?.kind === "priced" ? r.configuration : previewConfiguration(s),
        )
      : [];
  });
  readonly lines = computed(() => {
    const r = this.result();
    return r?.kind === "priced" ? priceLines(this.builder()!, r) : [];
  });
  readonly maxQty = PIZZA_QUANTITY_MAX;
  readonly message = signal("");
  sides(state: BuilderState): HalfSide[] {
    return state.mode === "WHOLE" ? ["LEFT"] : ["LEFT", "RIGHT"];
  }
  photo(id: string | null) {
    const image = this.catalog
      .menu()
      ?.flavors.find((f) => f.id === id)?.imageId;
    return image ? imageUrl("", this.store.slug(), image, "menu") : null;
  }
  allowedFlavors(size: string) {
    const b = this.builder()!;
    return b.menu.flavors.filter(
      (f) => b.index.flavorPrice(f.id, size) !== undefined,
    );
  }
  removable(flavor: string | null) {
    const m = this.catalog.menu()!;
    const f = m.flavors.find((x) => x.id === flavor);
    return m.ingredients.filter(
      (i) => i.removable && f?.ingredientIds.includes(i.id),
    );
  }
  size(id: string) {
    const change = changeSize(this.builder()!, this.state()!, id);
    if (change.kind === "blocked") {
      this.message.set(change.message);
      return;
    }
    if (change.kind === "confirm" && !window.confirm(change.message)) return;
    this.message.set("");
    this.state.set(change.state);
  }
  mode(halves: boolean) {
    this.state.set(setMode(this.state()!, halves ? "HALVES" : "WHOLE"));
  }
  flavor(side: HalfSide, id: string) {
    this.state.set(setFlavor(this.state()!, side, id));
  }
  crust(id: string) {
    this.state.set(setCrust(this.state()!, id || null));
  }
  extra(side: HalfSide, id: string) {
    this.state.set(toggleExtra(this.state()!, side, id));
  }
  remove(side: HalfSide, id: string) {
    this.state.set(toggleRemoval(this.state()!, side, id));
  }
  quantity(value: number) {
    this.state.set(setQuantity(this.state()!, value));
  }
  async add() {
    const r = this.result();
    if (r?.kind !== "priced" || this.catalog.status() !== "ready") return;
    const name = this.halves()
      .map((h) => h.flavor)
      .join(" / ");
    if (
      await this.shop.model?.changeCart((cart) =>
        addPizza(cart, {
          id: crypto.randomUUID(),
          kind: "PIZZA",
          name,
          pizza: r.configuration,
        }),
      )
    )
      await this.router.navigate(["/lojas", this.store.slug(), "sacola"]);
  }
}
