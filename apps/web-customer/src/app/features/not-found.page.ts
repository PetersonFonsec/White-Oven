import { ChangeDetectionStrategy, Component } from "@angular/core";
import { RouterLink } from "@angular/router";
import { Button } from "../design-system/primitives";
@Component({
  imports: [RouterLink, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="not-found">
    <h1>Página não encontrada</h1>
    <p>Confira o endereço ou abra novamente sua pizzaria.</p>
    <a woButton routerLink="/">Encontrar pizzaria</a>
  </section>`,
})
export class NotFoundPage {}
