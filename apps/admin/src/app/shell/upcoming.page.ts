import { Component, input } from "@angular/core";

/** A section whose screens arrive in a later milestone; route data gives the title. */
@Component({
  selector: "wo-upcoming-page",
  template: `
    <h1 tabindex="-1" data-page-title>{{ title() }}</h1>
    <p class="muted">Esta área chega em uma próxima etapa do painel.</p>
  `,
})
export class UpcomingPage {
  readonly title = input.required<string>();
}
