import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  output,
  signal,
} from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { legalBlocks } from "@whiteoven/contracts";
import {
  acceptedVersions,
  parseStoreLegal,
  type StoreLegal,
} from "@whiteoven/customer-core/customer/legal";
import { StoreContext } from "../../core/tenant/store-context";
import { storePath } from "../../core/api/public-api";
import { Button } from "../../design-system/primitives";
import type { Subscription } from "rxjs";
export type Versions = ReturnType<typeof acceptedVersions>;
@Component({
  selector: "wo-legal",
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` @if (documents(); as docs) {
      @for (doc of [docs.termsOfUse, docs.privacyPolicy]; track doc.kind) {
        <details>
          <summary>
            {{
              doc.kind === "TERMS_OF_USE"
                ? "Termos de uso"
                : "Política de privacidade"
            }}
            · {{ doc.version }}
          </summary>
          @for (block of blocks(doc.body); track $index) {
            @switch (block.type) {
              @case ("heading") {
                <h3>{{ block.text }}</h3>
              }
              @case ("paragraph") {
                <p>{{ block.text }}</p>
              }
              @case ("list") {
                <ul>
                  @for (item of block.items; track $index) {
                    <li>{{ item }}</li>
                  }
                </ul>
              }
            }
          }
        </details>
      }
      <label class="check"
        ><input
          type="checkbox"
          #consent
          [checked]="checked()"
          (change)="change(consent.checked)"
        />Li e aceito os termos de uso e a política de privacidade desta
        pizzaria.</label
      >
    } @else if (failed()) {
      <p role="alert">Os documentos da loja estão indisponíveis.</p>
      <button type="button" woButton variant="secondary" (click)="reload()">
        Carregar documentos
      </button>
    } @else {
      <p role="status">Carregando os documentos da loja…</p>
    }`,
})
export class LegalConsent {
  readonly accepted = output<Versions | null>();
  readonly documents = signal<StoreLegal | null>(null);
  readonly checked = signal(false);
  readonly failed = signal(false);
  readonly blocks = legalBlocks;
  private readonly store = inject(StoreContext);
  private readonly http = inject(HttpClient);
  private active?: Subscription;
  constructor() {
    inject(DestroyRef).onDestroy(() => this.active?.unsubscribe());
  }
  ngOnInit() {
    this.reload();
  }
  reload() {
    this.active?.unsubscribe();
    this.documents.set(null);
    this.failed.set(false);
    this.change(false);
    this.active = this.http
      .get(storePath(this.store.slug()) + "/legal", { timeout: 8000 })
      .subscribe({
        next: (raw) => {
          try {
            const docs = parseStoreLegal(raw);
            this.documents.set(docs);
            this.failed.set(!docs);
          } catch {
            this.failed.set(true);
          }
        },
        error: () => this.failed.set(true),
      });
  }
  change(value: boolean) {
    this.checked.set(value);
    this.accepted.emit(
      value && this.documents() ? acceptedVersions(this.documents()!) : null,
    );
  }
}
