import { formatCents } from "@whiteoven/customer-core/menu/menu";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { StoreContext } from "../core/tenant/store-context";
import { Button } from "../design-system/primitives";
import { Dialog } from "../design-system/dialog";
@Component({
  imports: [Button, Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<h1>Informações da loja</h1>
    <section class="panel">
      <h2>{{ store.name() }}</h2>
      @if (store.checkout(); as settings) {
        @if (settings.pickupAddress) {
          <p><strong>Retirada</strong><br />{{ settings.pickupAddress }}</p>
        }
        @if (settings.fulfillmentModes.includes("DELIVERY")) {
          <p>
            <strong>Entrega</strong><br />Taxa
            {{ money(settings.deliveryFeeCents) }}.
            {{ settings.deliveryAreaDescription }}
          </p>
        }
        <p>Pedido mínimo {{ money(settings.minimumOrderCents) }}.</p>
      } @else {
        <p>Informações de entrega e retirada indisponíveis.</p>
      }
      <button woButton variant="secondary" (click)="help.open()">
        Sobre este acesso
      </button>
    </section>
    <wo-dialog #help label="Sobre este acesso" [sheet]="true"
      ><p>
        As informações de atendimento são consultadas diretamente com a
        pizzaria. Se a conexão falhar, não podemos confirmar se a loja está
        aberta.
      </p></wo-dialog
    >`,
})
export class InformationPage {
  readonly money = formatCents;
  readonly store = inject(StoreContext);
}
