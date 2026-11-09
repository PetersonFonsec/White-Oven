import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  input,
} from "@angular/core";
/** Native buttons retain keyboard, form and disabled semantics. */
@Directive({
  selector: "button[woButton], a[woButton]",
  host: {
    class: "wo-button",
    "[class.secondary]": "variant() === 'secondary'",
  },
})
export class Button {
  readonly variant = input<"primary" | "secondary">("primary");
}
/** Attach to native controls so Reactive Forms need no custom value accessor. */
@Directive({
  selector: "input[woInput], select[woInput], textarea[woInput]",
  host: { class: "wo-input" },
})
export class Input {}
@Component({
  selector: "wo-state",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section class="state" [attr.aria-busy]="kind() === 'loading'">
    <h2>{{ heading() }}</h2>
    <p [attr.role]="kind() === 'error' ? 'alert' : 'status'">{{ message() }}</p>
    <ng-content />
  </section>`,
})
export class State {
  readonly kind = input<"loading" | "empty" | "error" | "info">("info");
  readonly heading = input.required<string>();
  readonly message = input.required<string>();
}

/** Toggle filters announce their selection while retaining the native button's keyboard behavior. */
@Directive({
  selector: "button[woChip]",
  host: { type: "button", "[attr.aria-pressed]": "selected()" },
})
export class CategoryChip {
  readonly selected = input.required<boolean>({ alias: "woChip" });
}
