import { Component, inject } from "@angular/core";
import { Session } from "../core/session";
import { StorePauseCard } from "../settings/store-pause";

@Component({
  selector: "wo-store-home-page",
  imports: [StorePauseCard],
  template: `
    <h1 tabindex="-1" data-page-title>Início</h1>
    <p>
      Você está em <strong>{{ session.store()?.displayName }}</strong
      >. As áreas do painel aparecem no menu conforme o seu papel na loja.
    </p>
    <wo-store-pause />
    <p class="muted">Acompanhe novos pedidos no quadro de pedidos.</p>
  `,
})
export class StoreHomePage {
  protected readonly session = inject(Session);
}
