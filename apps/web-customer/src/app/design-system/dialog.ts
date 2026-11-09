import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  viewChild,
} from "@angular/core";
import { Button } from "./primitives";
/** Native modal: browser focus trap, Escape, inert background and focus restoration. */
@Component({
  selector: "wo-dialog",
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<dialog
    #dialog
    [attr.aria-label]="label()"
    [class.sheet]="sheet()"
  >
    <h2>{{ label() }}</h2>
    <ng-content />
    <form method="dialog">
      <button woButton variant="secondary" autofocus>Fechar</button>
    </form>
  </dialog>`,
})
export class Dialog {
  readonly label = input.required<string>();
  readonly sheet = input(false);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>("dialog");
  open(): void {
    this.dialog().nativeElement.showModal();
  }
}
