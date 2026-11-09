import { computed, inject, Injectable } from "@angular/core";
import { cartSummary } from "@whiteoven/customer-core/cart/summary";
import { changeQuantity, removeLine } from "@whiteoven/customer-core/cart/cart";
import { Catalog } from "../../core/tenant/catalog";
import { Shop } from "../../core/commerce/shop";
@Injectable()
export class Bag {
  readonly shop = inject(Shop);
  readonly catalog = inject(Catalog);
  readonly hidden = computed(() => {
    const s = this.shop.state();
    return !!s?.pending && s.pending.customerId !== s.profile?.id;
  });
  readonly rows = computed(() =>
    this.hidden()
      ? []
      : cartSummary(this.shop.state()?.cart ?? [], this.catalog.menu()),
  );
  readonly subtotal = computed(() => {
    const rows = this.rows();
    return rows.some((row) => row.totalCents === null)
      ? null
      : rows.reduce((sum, row) => sum + row.totalCents!, 0);
  });
  change(id: string, qty: number) {
    return this.shop.model?.changeCart((cart) => changeQuantity(cart, id, qty));
  }
  remove(id: string) {
    return this.shop.model?.changeCart((cart) => removeLine(cart, id));
  }
}
