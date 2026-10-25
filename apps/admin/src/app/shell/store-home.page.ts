import { Component, inject } from "@angular/core";
import { Session } from "../core/session";

@Component({
  selector: "wo-store-home-page",
  template: `
    <h1 tabindex="-1" data-page-title>Início</h1>
    <p>
      Você está em <strong>{{ session.store()?.displayName }}</strong
      >. As áreas do painel aparecem no menu conforme o seu papel na loja.
    </p>
    <p class="muted">
      Pedidos, cardápio e configurações chegam nas próximas etapas do painel.
    </p>
  `,
})
export class StoreHomePage {
  protected readonly session = inject(Session);
}
