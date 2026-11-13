import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { FormControl, ReactiveFormsModule } from "@angular/forms";
import { formatCents } from "@whiteoven/customer-core/menu/menu";
import type { CheckoutDetails } from "@whiteoven/customer-core/cart/cart";
import { Input } from "./primitives";

@Component({
  selector: "wo-quantity",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <div class="quantity">
    <button
      type="button"
      [attr.aria-label]="'Diminuir ' + label()"
      [disabled]="disabled() || value() <= 1"
      (click)="changed.emit(value() - 1)"
    >
      −</button
    ><span>{{ value() }}</span
    ><button
      type="button"
      [attr.aria-label]="'Aumentar ' + label()"
      [disabled]="disabled() || value() >= max()"
      (click)="changed.emit(value() + 1)"
    >
      +
    </button>
  </div>`,
})
export class QuantitySelector {
  readonly label = input.required<string>();
  readonly value = input.required<number>();
  readonly max = input.required<number>();
  readonly disabled = input(false);
  readonly changed = output<number>();
}

@Component({
  selector: "wo-flavors",
  imports: [Input],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <label
    >Sabor<select woInput #select (change)="changed.emit(select.value)">
      <option disabled value="" [selected]="!value()">Escolha um sabor</option>
      @for (flavor of flavors(); track flavor.id) {
        <option [value]="flavor.id" [selected]="flavor.id === value()">
          {{ flavor.name }}
        </option>
      }
    </select></label
  >`,
})
export class FlavorSelector {
  readonly value = input<string | null>(null);
  readonly flavors = input.required<readonly { id: string; name: string }[]>();
  readonly changed = output<string>();
}

@Component({
  selector: "wo-payment-method",
  imports: [Input, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <label
    >Pagamento<select woInput [formControl]="control()">
      @for (method of methods(); track method) {
        <option [value]="method">{{ labels[method] }}</option>
      }
    </select></label
  >`,
})
export class PaymentMethodSelector {
  readonly control = input.required<FormControl<string>>();
  readonly methods = input.required<CheckoutDetails["paymentMethod"][]>();
  readonly labels = {
    CASH: "Dinheiro",
    PIX_ON_DELIVERY: "PIX na entrega",
    CARD_ON_DELIVERY: "Cartão na entrega",
  };
}

@Component({
  selector: "wo-price-summary",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <p>Subtotal {{ money(value().itemsSubtotalCents) }}</p>
    <p>Entrega {{ money(value().deliveryFeeCents) }}</p>
    @if (value().discountCents) {
      <p>Desconto {{ money(value().discountCents) }}</p>
    }
    <strong>Total {{ money(value().totalCents) }}</strong>`,
})
export class PriceSummary {
  readonly value = input.required<{
    itemsSubtotalCents: number;
    deliveryFeeCents: number;
    discountCents: number;
    totalCents: number;
  }>();
  readonly money = formatCents;
}
