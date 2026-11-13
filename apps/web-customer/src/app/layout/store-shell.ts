import { Preferences } from "../core/tenant/preferences";
import { Shop } from "../core/commerce/shop";
import { Catalog } from "../core/tenant/catalog";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
} from "@angular/core";
import { NgStyle } from "@angular/common";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { StoreContext } from "../core/tenant/store-context";
import { themeProperties } from "../design-system/theme";
@Component({
  providers: [StoreContext, Shop, Catalog, Preferences],
  imports: [NgStyle, RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="store-shell" [ngStyle]="theme()">
    <a class="skip" href="#conteudo">Pular para o conteúdo</a>
    <header class="store-header">
      <a class="store-identity" [routerLink]="['/lojas', store.slug()]">
        @if (store.logo(); as logo) {
          <img
            [src]="logo"
            alt=""
            width="48"
            height="48"
            (error)="hideImage($event)"
            (load)="showImage($event)"
          />
        }
        <span>{{ store.name() }}</span></a
      ><a routerLink="/">Trocar pizzaria</a>
    </header>
    <nav class="store-nav" aria-label="Navegação da loja">
      <a
        [routerLink]="['/lojas', store.slug()]"
        routerLinkActive="active"
        [routerLinkActiveOptions]="{ exact: true }"
        ariaCurrentWhenActive="page"
        >Início</a
      >
      @for (item of navigation; track item.path) {
        <a
          [routerLink]="['/lojas', store.slug(), item.path]"
          routerLinkActive="active"
          ariaCurrentWhenActive="page"
          >{{ item.name }}
          @if (item.path === "sacola") {
            ({{ shop.units() }})
          }
        </a>
      }
      <a
        [routerLink]="['/lojas', store.slug(), 'informacoes']"
        routerLinkActive="active"
        ariaCurrentWhenActive="page"
        >Informações</a
      >
    </nav>
    <main #main id="conteudo" tabindex="-1" class="store-main">
      @if (shop.problem()) {
        <p role="alert">{{ shop.problem() }}</p>
        <button (click)="shop.start(storeSlug())">Tentar abrir sacola</button>
      }
      @if (shop.state()?.error) {
        <p role="alert" class="error">{{ shop.state()?.error }}</p>
        @if (!shop.state()?.ready || shop.state()?.session === "failed") {
          <button (click)="shop.model?.init()">Tentar restaurar</button>
        }
      }
      <router-outlet (activate)="main.focus()" />
    </main>
    <footer class="store-footer">
      {{ store.name() }} · Feito com WhiteOven
    </footer>
  </div>`,
})
export class StoreShell {
  readonly shop = inject(Shop);
  readonly navigation = [
    { path: "cardapio", name: "Cardápio" },
    { path: "sacola", name: "Sacola" },
    { path: "pedidos", name: "Pedidos" },
    { path: "conta", name: "Conta" },
  ];
  readonly storeSlug = input.required<string>();
  readonly store = inject(StoreContext);
  readonly theme = computed(() =>
    themeProperties(this.store.profile()?.brand.colors),
  );
  constructor() {
    effect(() => {
      const slug = this.storeSlug();
      this.store.load(slug);
      void this.shop.start(slug);
    });
  }
  showImage(event: Event): void {
    (event.target as HTMLImageElement).hidden = false;
  }
  hideImage(event: Event): void {
    (event.target as HTMLImageElement).hidden = true;
  }
}
