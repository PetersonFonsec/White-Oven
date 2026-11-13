import { OrderCard } from "./order-card";
import { CategoryChip } from "../../design-system/primitives";
import { PriceSummary } from "../../design-system/commerce-controls";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import {
  type CustomerOrderDetail,
  type CustomerOrderSummary,
  orderDetailMessage,
  reorderLines,
  statusLabel,
} from "@whiteoven/customer-core/customer/orders";
import {
  ORDER_FILTERS,
  filterOrders,
  orderItemView,
  orderDateTime,
  type OrderFilter,
} from "@whiteoven/customer-core/customer/order-view";
import { formatCents } from "@whiteoven/customer-core/menu/menu";
import { Shop } from "../../core/commerce/shop";
import { Catalog } from "../../core/tenant/catalog";
import { StoreContext } from "../../core/tenant/store-context";
import { Button } from "../../design-system/primitives";
@Component({
  imports: [RouterLink, Button, PriceSummary, OrderCard, CategoryChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./orders.page.html",
})
export class OrdersPage {
  readonly shop = inject(Shop);
  readonly catalog = inject(Catalog);
  readonly store = inject(StoreContext);
  private readonly router = inject(Router);
  readonly orderId = input("");
  readonly items = signal<CustomerOrderSummary[]>([]);
  readonly detail = signal<CustomerOrderDetail | null>(null);
  readonly cursor = signal<number | null>(null);
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly filter = signal<OrderFilter>("all");
  readonly filters = ORDER_FILTERS;
  readonly visible = computed(() => filterOrders(this.items(), this.filter()));
  readonly money = formatCents;
  readonly date = orderDateTime;
  readonly label = statusLabel;
  private readonly owner = computed(() => this.shop.state()?.profile?.id);
  private abort?: AbortController;
  constructor() {
    effect((onCleanup) => {
      const owner = this.owner(),
        id = this.orderId();
      const abort = new AbortController();
      this.abort = abort;
      untracked(() => {
        this.loaded.set(false);
        this.items.set([]);
        this.detail.set(null);
        this.cursor.set(null);
        this.error.set("");
        this.busy.set(false);
        if (owner) void this.load(false);
      });
      const refresh = () => {
        const order = this.detail();
        if (
          id &&
          order &&
          !document.hidden &&
          ["PLACED", "PREPARING", "READY", "OUT_FOR_DELIVERY"].includes(
            order.status,
          )
        )
          void this.load(false);
      };
      const timer = id ? window.setInterval(refresh, 20000) : null;
      if (id) document.addEventListener("visibilitychange", refresh);
      onCleanup(() => {
        abort.abort();
        if (timer !== null) clearInterval(timer);
        document.removeEventListener("visibilitychange", refresh);
      });
    });
  }
  async load(more: boolean) {
    const model = this.shop.model,
      abort = this.abort;
    if (
      !model ||
      !abort ||
      abort.signal.aborted ||
      this.busy() ||
      !this.owner()
    )
      return;
    this.busy.set(true);
    this.error.set("");
    try {
      if (this.orderId()) {
        const order = await model.getCustomerOrder(
          this.orderId(),
          abort.signal,
        );
        if (!abort.signal.aborted) this.detail.set(order);
      } else {
        const page = await model.listCustomerOrders(
          more ? this.cursor() : null,
          abort.signal,
        );
        if (!abort.signal.aborted) {
          this.items.set(
            more ? [...this.items(), ...page.orders] : page.orders,
          );
          this.cursor.set(page.nextCursor);
          this.loaded.set(true);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted)
        this.error.set(
          orderDetailMessage(error) || "Não foi possível consultar os pedidos.",
        );
    } finally {
      if (!abort.signal.aborted) this.busy.set(false);
    }
  }
  view(item: CustomerOrderDetail["items"][number]) {
    return orderItemView(item, this.catalog.menu());
  }
  async reorder() {
    const order = this.detail(),
      abort = this.abort,
      model = this.shop.model;
    if (!order || !model || !abort || this.busy()) return;
    this.busy.set(true);
    this.error.set("");
    try {
      const menu = await this.catalog.reload();
      if (abort.signal.aborted) return;
      if (!menu)
        throw new Error("Atualize o cardápio para repetir este pedido.");
      const rebuilt = reorderLines(order, menu, () => crypto.randomUUID());
      if (!rebuilt.lines.length)
        throw new Error(
          "Nenhum item deste pedido está disponível no cardápio atual.",
        );
      if (
        (rebuilt.skipped || model.getSnapshot().cart.length) &&
        !window.confirm(
          `Substituir sua sacola pelos itens disponíveis? Itens indisponíveis: ${rebuilt.skipped}.`,
        )
      )
        return;
      if ((await model.replaceCart(rebuilt.lines)) && !abort.signal.aborted)
        await this.router.navigate(["/lojas", this.store.slug(), "sacola"]);
    } catch (e) {
      if (!abort.signal.aborted)
        this.error.set(
          e instanceof Error ? e.message : "Não foi possível repetir o pedido.",
        );
    } finally {
      if (!abort.signal.aborted) this.busy.set(false);
    }
  }
}
