import { CategoryChip } from "../../design-system/primitives";
import { Preferences } from "../../core/tenant/preferences";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from "@angular/core";
import { FormControl, ReactiveFormsModule } from "@angular/forms";
import { toSignal } from "@angular/core/rxjs-interop";
import { CatalogNotice, ProductCard } from "./catalog-ui";
import { Catalog } from "../../core/tenant/catalog";
import { Input } from "../../design-system/primitives";
export const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
@Component({
  imports: [
    CatalogNotice,
    ProductCard,
    ReactiveFormsModule,
    Input,
    CategoryChip,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <h1>Cardápio</h1>
    <label for="search">Buscar por nome ou ingrediente</label
    ><input woInput id="search" type="search" [formControl]="search" />
    <nav class="chips" aria-label="Categorias">
      <button (click)="selected.set('')" [woChip]="active() === ''">
        Todos
      </button>
      @for (section of catalog.sections(); track section.id) {
        <button
          (click)="selected.set(section.id)"
          [woChip]="active() === section.id"
        >
          {{ section.name }}
        </button>
      }
    </nav>
    <wo-catalog-notice />
    @for (section of visible(); track section.id) {
      <section>
        <h2>{{ section.name }}</h2>
        <div class="product-grid" [class.compact]="prefs.layout() === 'list'">
          @for (item of section.items; track item.id) {
            <wo-product-card [item]="item" />
          }
        </div>
      </section>
    }
    @if (!visible().length && catalog.status() === "ready") {
      <p role="status">Nenhum produto encontrado.</p>
    }`,
})
export class CatalogPage {
  readonly prefs = inject(Preferences);
  readonly catalog = inject(Catalog);
  readonly categoria = input("");
  readonly selected = signal<string | null>(null);
  readonly search = new FormControl("", { nonNullable: true });
  private readonly term = toSignal(this.search.valueChanges, {
    initialValue: "",
  });
  readonly active = computed(() => this.selected() ?? this.categoria() ?? "");
  readonly visible = computed(() => {
    const query = fold(this.term());
    const menu = this.catalog.menu();
    return this.catalog
      .sections()
      .filter((section) => !this.active() || section.id === this.active())
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => {
          const flavor = menu?.flavors.find((f) => f.id === item.id);
          const ingredients =
            menu?.ingredients
              .filter((i) => flavor?.ingredientIds.includes(i.id))
              .map((i) => i.name) ?? [];
          return fold(
            [
              item.name,
              item.kind === "PIZZA" ? item.description : "",
              ...ingredients,
            ].join(" "),
          ).includes(query);
        }),
      }))
      .filter((section) => section.items.length);
  });
}
