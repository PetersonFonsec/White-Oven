import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { RouterLink } from "@angular/router";
import { orderWhen } from "@whiteoven/customer-core/customer/order-view";
import {
  statusLabel,
  type CustomerOrderSummary,
} from "@whiteoven/customer-core/customer/orders";
import { formatCents } from "@whiteoven/customer-core/menu/menu";
@Component({
  selector: "wo-order-card",
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <article class="list-row">
    <div>
      <h2>
        <a [routerLink]="['/lojas', slug(), 'pedidos', order().id]"
          >Pedido #{{ order().number }}</a
        >
      </h2>
      <p>
        {{ when(order().placedAt) }} ·
        {{ label(order().status, order().fulfillment) }}
      </p>
    </div>
    <strong>{{ money(order().totalCents) }}</strong>
  </article>`,
})
export class OrderCard {
  readonly order = input.required<CustomerOrderSummary>();
  readonly slug = input.required<string>();
  readonly when = orderWhen;
  readonly money = formatCents;
  readonly label = statusLabel;
}
