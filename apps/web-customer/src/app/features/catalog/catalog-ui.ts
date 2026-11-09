import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  signal,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import {
  formatCents,
  imageUrl,
  type MenuItem,
} from "@whiteoven/customer-core/menu/menu";
import { addProduct } from "@whiteoven/customer-core/cart/cart";
import { StoreContext } from "../../core/tenant/store-context";
import { Shop } from "../../core/commerce/shop";
import { Catalog } from "../../core/tenant/catalog";
import { Button, State } from "../../design-system/primitives";

@Component({
  selector: "wo-catalog-notice",
  imports: [State, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` @if (store.availability() === "unavailable") {
      <wo-state
        kind="empty"
        heading="Pizzaria indisponível"
        message="Esta loja não está atendendo neste endereço."
      />
    } @else if (store.availability() === "offline") {
      <wo-state
        kind="error"
        heading="Atendimento não confirmado"
        message="Confira sua conexão para atualizar a loja."
        ><button woButton (click)="store.refresh()">
          Tentar novamente
        </button></wo-state
      >
    } @else if (catalog.status() === "error" || catalog.status() === "stale") {
      <wo-state
        kind="error"
        heading="Cardápio não atualizado"
        message="Os preços e a disponibilidade precisam ser confirmados."
        ><button woButton (click)="catalog.reload()">
          Atualizar cardápio
        </button></wo-state
      >
    } @else if (catalog.status() === "loading") {
      <p role="status">Carregando cardápio…</p>
      <div class="catalog-skeleton" aria-hidden="true">
        <i></i><i></i><i></i>
      </div>
    }`,
})
export class CatalogNotice {
  readonly store = inject(StoreContext);
  readonly catalog = inject(Catalog);
}
@Component({
  selector: "wo-product-card",
  imports: [Button, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <article class="product">
    @if (item().imageId; as id) {
      <img loading="lazy" [src]="photo(id)" alt="" />
    }
    <div>
      <h3>{{ item().name }}</h3>
      @if (item(); as product) {
        @if (product.kind === "PIZZA") {
          @if (product.description) {
            <p>{{ product.description }}</p>
          }
          <strong>A partir de {{ money(product.fromCents) }}</strong>
          <a
            woButton
            variant="secondary"
            [routerLink]="['/lojas', store.slug(), 'montar', product.id]"
            >Montar pizza</a
          >
        } @else {
          <strong>{{ money(product.priceCents) }}</strong>
          <button
            woButton
            variant="secondary"
            [disabled]="shop.locked() || catalog.status() !== 'ready'"
            (click)="add(product)"
          >
            Adicionar à sacola
          </button>
        }
      }
      @if (message()) {
        <small role="status">{{ message() }}</small>
      }
    </div>
  </article>`,
})
export class ProductCard {
  readonly item = input.required<MenuItem>();
  readonly store = inject(StoreContext);
  readonly shop = inject(Shop);
  readonly catalog = inject(Catalog);
  readonly message = signal("");
  readonly money = formatCents;
  photo(id: string) {
    return imageUrl("", this.store.slug(), id, "thumbnail");
  }
  async add(item: Extract<MenuItem, { kind: "PRODUCT" }>) {
    if (this.catalog.status() !== "ready") return;
    const ok = await this.shop.model?.changeCart((lines) =>
      addProduct(lines, {
        id: crypto.randomUUID(),
        productId: item.id,
        name: item.name,
      }),
    );
    if (ok) this.message.set("Adicionado à sacola.");
  }
}
