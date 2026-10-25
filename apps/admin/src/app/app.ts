import { DOCUMENT } from "@angular/common";
import { Component, DestroyRef, inject } from "@angular/core";
import { NavigationEnd, Router, RouterOutlet } from "@angular/router";
import { filter } from "rxjs";

/**
 * Root. After each navigation, focus moves to the new page's heading (`[data-page-title]`), so
 * keyboard and screen reader users land on the content that changed.
 */
@Component({
  selector: "wo-root",
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class App {
  constructor() {
    const document = inject(DOCUMENT);
    const subscription = inject(Router)
      .events.pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() =>
        setTimeout(() =>
          document.querySelector<HTMLElement>("[data-page-title]")?.focus(),
        ),
      );
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }
}
