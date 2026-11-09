import { Catalog } from "../core/tenant/catalog";
import { RouterLink } from "@angular/router";
import { imageUrl, formatCents } from "@whiteoven/customer-core/menu/menu";
import { CatalogNotice, ProductCard } from "./catalog/catalog-ui";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { StoreContext } from "../core/tenant/store-context";
import { Button, State } from "../design-system/primitives";
@Component({
  imports: [Button, State, RouterLink, CatalogNotice, ProductCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<h1>{{ store.name() }}</h1>
    @switch (store.availability()) {
      @case ("loading") {
        <wo-state
          kind="loading"
          heading="Consultando a pizzaria"
          message="Aguarde enquanto buscamos as informações da loja."
        />
      }
      @case ("unavailable") {
        <wo-state
          kind="empty"
          heading="Pizzaria indisponível"
          message="Não foi possível encontrar uma loja disponível neste endereço."
        />
      }
      @case ("offline") {
        <wo-state
          kind="error"
          heading="Não foi possível conectar"
          message="Não conseguimos confirmar o atendimento. Verifique sua conexão e tente novamente."
          ><button woButton (click)="store.refresh()">
            Tentar novamente
          </button></wo-state
        >
      }
      @case ("open") {
        <wo-state
          heading="Loja aberta"
          message="A pizzaria está em horário de atendimento."
        />
      }
      @case ("closed") {
        <wo-state
          heading="Loja fechada no momento"
          message="O atendimento está pausado ou fora do horário de funcionamento."
        />
      }
    }
    @if (store.brandFailed() && store.availability() !== "offline") {
      <p role="status">A identidade da loja não pôde ser carregada.</p>
    }
    @if (store.availability() === "open" || store.availability() === "closed") {
      <section class="store-welcome">
        @if (catalog.featured()[0]; as pizza) {
          <div>
            <h2>{{ pizza.name }}</h2>
            <p>{{ pizza.description || "Destaque da casa" }}</p>
            <strong>A partir de {{ money(pizza.fromCents) }}</strong>
            <a woButton [routerLink]="['montar', pizza.id]"
              >Montar minha pizza</a
            >
          </div>
          @if (pizza.imageId) {
            <img [src]="photo(pizza.imageId)" alt="" fetchpriority="high" />
          }
        }
      </section>
      <a woButton variant="secondary" routerLink="cardapio"
        >Ver cardápio completo</a
      >
      <nav class="chips" aria-label="Categorias">
        @for (section of catalog.sections(); track section.id) {
          <a routerLink="cardapio" [queryParams]="{ categoria: section.id }">{{
            section.name
          }}</a>
        }
      </nav>
      @if (catalog.featured().length > 1) {
        <section>
          <h2>Mais pizzas da casa</h2>
          <div class="product-grid">
            @for (item of catalog.featured().slice(1); track item.id) {
              <wo-product-card [item]="item" />
            }
          </div>
        </section>
      }
      <wo-catalog-notice />
      <button woButton variant="secondary" (click)="store.refresh()">
        Atualizar atendimento
      </button>
    }`,
})
export class StorePage {
  readonly catalog = inject(Catalog);
  readonly money = formatCents;
  photo(id: string) {
    return imageUrl("", this.store.slug(), id, "menu");
  }
  readonly store = inject(StoreContext);
}
