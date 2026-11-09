import { QuantitySelector } from "../../design-system/commerce-controls";
import { CART_QUANTITY_LIMIT } from "@whiteoven/customer-core/cart/cart";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterLink } from "@angular/router";
import { formatCents } from "@whiteoven/customer-core/menu/menu";
import { StoreContext } from "../../core/tenant/store-context";
import { Button } from "../../design-system/primitives";
import { Bag } from "./bag";
import { CatalogNotice } from "../catalog/catalog-ui";
@Component({
  providers: [Bag],
  imports: [RouterLink, Button, CatalogNotice, QuantitySelector],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <h1>Sacola</h1>
    <wo-catalog-notice />
    @if (!bag.shop.state()?.ready) {
      <p role="status">Abrindo sacola…</p>
    } @else if (bag.hidden()) {
      <p>Entre na conta que confirmou o pedido para recuperar o resultado.</p>
      <a [routerLink]="['/lojas', store.slug(), 'conta']">Entrar na conta</a>
    } @else if (bag.rows().length) {
      <div class="bag-grid">
        <section>
          @for (row of bag.rows(); track row.id) {
            <article class="list-row">
              <div>
                <h2>{{ row.name }}</h2>
                @for (line of row.details; track $index) {
                  <p>{{ line }}</p>
                }
                <strong>{{
                  row.totalCents === null
                    ? "Item indisponível"
                    : money(row.totalCents)
                }}</strong>
              </div>
              <wo-quantity
                [label]="row.name"
                [value]="row.quantity"
                [max]="maxQty"
                [disabled]="bag.shop.locked()"
                (changed)="bag.change(row.id, $event)"
              />
              <button
                [disabled]="bag.shop.locked()"
                (click)="bag.remove(row.id)"
              >
                Remover
              </button>
            </article>
          }
        </section>
        <aside class="panel">
          <h2>Resumo</h2>
          <p>Subtotal dos itens</p>
          <strong>{{
            bag.subtotal() === null
              ? "Atualize os itens"
              : money(bag.subtotal()!)
          }}</strong>
          <p>O total com entrega será confirmado na cotação.</p>
          <a woButton [routerLink]="['/lojas', store.slug(), 'checkout']">{{
            bag.shop.state()?.pending
              ? "Recuperar confirmação"
              : "Ir para checkout"
          }}</a>
        </aside>
      </div>
    } @else {
      <h2>Sua sacola está vazia</h2>
      <a woButton [routerLink]="['/lojas', store.slug(), 'cardapio']"
        >Escolher no cardápio</a
      >
    }`,
})
export class CartPage {
  readonly maxQty = CART_QUANTITY_LIMIT;
  readonly bag = inject(Bag);
  readonly store = inject(StoreContext);
  readonly money = formatCents;
}
