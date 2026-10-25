import { CurrencyPipe } from "@angular/common";
import {
  Component,
  computed,
  inject,
  OnDestroy,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { evaluatePizza } from "@whiteoven/pizza-pricing";
import type {
  PizzaCatalog,
  PizzaConfiguration,
  PricingPolicy,
} from "@whiteoven/contracts";
import { errorMessage } from "../core/api";
import { CatalogApi, type CatalogSnapshot } from "./catalog-api";

type Section =
  | "categories"
  | "sizes"
  | "ingredients"
  | "flavors"
  | "crusts"
  | "extras"
  | "products"
  | "preview";
type PriceKind = "flavor" | "crust" | "extra";
type ImageKind = "flavors" | "products";
type PriceValue = { value: number; halfValue?: number };

const SECTIONS: { id: Section; label: string }[] = [
  { id: "categories", label: "Categorias" },
  { id: "sizes", label: "Tamanhos" },
  { id: "ingredients", label: "Ingredientes" },
  { id: "flavors", label: "Sabores" },
  { id: "crusts", label: "Bordas" },
  { id: "extras", label: "Adicionais" },
  { id: "products", label: "Produtos" },
  { id: "preview", label: "Prévia de preço" },
];

/** Tenant catalog editor. The API remains responsible for authorization and catalog rules. */
@Component({
  selector: "wo-menu-page",
  imports: [FormsModule, CurrencyPipe],
  styleUrl: "./menu.page.css",
  template: `
    <section class="menu-page" aria-labelledby="menu-title">
      <header class="menu-heading">
        <div>
          <p class="eyebrow">Cardápio da loja</p>
          <h1 id="menu-title" tabindex="-1" data-page-title>Cardápio</h1>
          <p class="muted">Cadastre itens, preços e disponibilidade da pizzaria.</p>
        </div>
        <button type="button" class="button button--secondary" [disabled]="loading()" (click)="load()">
          {{ loading() ? "Atualizando…" : "Atualizar" }}
        </button>
      </header>

      @if (error()) { <p class="menu-alert" role="alert">{{ error() }}</p> }
      @if (notice()) { <p class="menu-notice" role="status">{{ notice() }}</p> }
      @if (loading() && !catalog()) { <p role="status">Carregando cardápio…</p> }

      <nav class="menu-tabs" aria-label="Seções do cardápio" role="tablist">
        @for (section of sections; track section.id) {
          <button type="button" role="tab" [attr.aria-selected]="active() === section.id"
            [attr.aria-controls]="'menu-panel-' + section.id" [id]="'menu-tab-' + section.id"
            (click)="selectSection(section.id)">{{ section.label }}</button>
        }
      </nav>

      @if (catalog(); as data) {
        <div class="menu-panel" role="tabpanel" [attr.aria-labelledby]="'menu-tab-' + active()"
          [id]="'menu-panel-' + active()">
          @switch (active()) {
            @case ("categories") {
              <h2>Categorias</h2>
              <form class="create-form" (ngSubmit)="createCategory()">
                <label>Nome <input name="newCategoryName" required maxlength="120" [(ngModel)]="newCategory.name" /></label>
                <label>Tipo <select name="newCategoryKind" [(ngModel)]="newCategory.kind"><option value="PIZZA">Pizzas</option><option value="PRODUCT">Produtos</option></select></label>
                <button class="button" [disabled]="saving()">Adicionar categoria</button>
              </form>
              <div class="menu-list">
                @for (item of data.categories; track item.id) {
                  <form class="menu-row" (ngSubmit)="saveCategory(item)">
                    <label [for]="'category-name-' + item.id">Nome</label>
                    <input [id]="'category-name-' + item.id" [name]="'category-name-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.name" />
                    <span class="kind-label">{{ item.kind === "PIZZA" ? "Pizzas" : "Produtos" }}</span>
                    <label [for]="'category-order-' + item.id">Ordem</label>
                    <input class="short-input" type="number" min="0" [id]="'category-order-' + item.id" [name]="'category-order-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.sortOrder" />
                    @if (item.archived) { <span class="archived-label">Arquivada</span> }
                    @else { <button class="button button--secondary" [disabled]="saving()">Salvar</button><button type="button" class="button button--secondary" [disabled]="saving()" (click)="archive('categories', item.id, item.name)">Arquivar</button> }
                  </form>
                }
                @if (!data.categories.length) { <p class="muted">Nenhuma categoria cadastrada.</p> }
              </div>
            }
            @case ("sizes") {
              <h2>Tamanhos de pizza</h2>
              <form class="create-form" (ngSubmit)="createSize()">
                <label>Nome <input name="newSizeName" required maxlength="120" [(ngModel)]="newSize.name" /></label>
                <label>Fatias <input name="newSizeSlices" type="number" min="1" required [(ngModel)]="newSize.slices" /></label>
                <label>Sabores <select name="newSizeFlavors" [(ngModel)]="newSize.maxFlavors"><option [ngValue]="1">Inteira</option><option [ngValue]="2">Inteira ou meio a meio</option></select></label>
                <label>Ordem <input name="newSizeOrder" type="number" min="0" [(ngModel)]="newSize.sortOrder" /></label>
                <button class="button" [disabled]="saving()">Adicionar tamanho</button>
              </form>
              <div class="menu-list">
                @for (item of data.sizes; track item.id) {
                  <form class="menu-row" (ngSubmit)="saveSize(item)">
                    <label [for]="'size-name-' + item.id">Nome</label><input [id]="'size-name-' + item.id" [name]="'size-name-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.name" />
                    <label [for]="'size-slices-' + item.id">Fatias</label><input class="short-input" [id]="'size-slices-' + item.id" [name]="'size-slices-' + item.id" type="number" min="1" [disabled]="item.archived || saving()" [(ngModel)]="item.slices" />
                    <label [for]="'size-flavors-' + item.id">Sabores</label><select [id]="'size-flavors-' + item.id" [name]="'size-flavors-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.maxFlavors"><option [ngValue]="1">1</option><option [ngValue]="2">2</option></select>
                    <label class="check-label"><input type="checkbox" [name]="'size-available-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.available" /> Disponível</label>
                    @if (item.archived) { <span class="archived-label">Arquivado</span> }
                    @else { <button class="button button--secondary" [disabled]="saving()">Salvar</button><button type="button" class="button button--secondary" [disabled]="saving()" (click)="archive('sizes', item.id, item.name)">Arquivar</button> }
                  </form>
                }
              </div>
            }
            @case ("ingredients") {
              <h2>Ingredientes</h2>
              <form class="create-form" (ngSubmit)="createIngredient()">
                <label>Nome <input name="newIngredientName" required maxlength="120" [(ngModel)]="newIngredient.name" /></label>
                <label class="check-label"><input type="checkbox" name="newIngredientRemovable" [(ngModel)]="newIngredient.removable" /> Cliente pode remover</label>
                <button class="button" [disabled]="saving()">Adicionar ingrediente</button>
              </form>
              <div class="menu-list">
                @for (item of data.ingredients; track item.id) {
                  <form class="menu-row" (ngSubmit)="saveIngredient(item)">
                    <label [for]="'ingredient-name-' + item.id">Nome</label><input [id]="'ingredient-name-' + item.id" [name]="'ingredient-name-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.name" />
                    <label class="check-label"><input type="checkbox" [name]="'ingredient-removable-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.removable" /> Removível</label>
                    @if (item.archived) { <span class="archived-label">Arquivado</span> }
                    @else { <button class="button button--secondary" [disabled]="saving()">Salvar</button><button type="button" class="button button--secondary" [disabled]="saving()" (click)="archive('ingredients', item.id, item.name)">Arquivar</button> }
                  </form>
                }
              </div>
            }
            @case ("flavors") {
              <h2>Sabores de pizza</h2>
              <form class="create-form create-form--wide" (ngSubmit)="createFlavor()">
                <label>Categoria <select name="newFlavorCategory" required [(ngModel)]="newFlavor.categoryId"><option value="">Selecione</option>@for (category of pizzaCategories(data); track category.id) { <option [value]="category.id">{{ category.name }}</option> }</select></label>
                <label>Nome <input name="newFlavorName" required maxlength="120" [(ngModel)]="newFlavor.name" /></label>
                <label>Descrição <input name="newFlavorDescription" maxlength="2000" [(ngModel)]="newFlavor.description" /></label>
                <div class="ingredient-picks"><span>Ingredientes</span>@for (ingredient of activeIngredients(data); track ingredient.id) { <label class="check-label"><input type="checkbox" [checked]="newFlavor.ingredientIds.includes(ingredient.id)" (change)="toggleNewIngredient(ingredient.id, $event)" /> {{ ingredient.name }}</label> }</div>
                <button class="button" [disabled]="saving() || !pizzaCategories(data).length">Adicionar sabor</button>
              </form>
              <div class="menu-list">
                @for (item of data.flavors; track item.id) {
                  <article class="catalog-card" [class.catalog-card--archived]="item.archived">
                    <form class="menu-row menu-row--main" (ngSubmit)="saveFlavor(item)">
                      <label [for]="'flavor-name-' + item.id">Nome</label><input [id]="'flavor-name-' + item.id" [name]="'flavor-name-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.name" />
                      <label [for]="'flavor-category-' + item.id">Categoria</label><select [id]="'flavor-category-' + item.id" [name]="'flavor-category-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.categoryId">@for (category of pizzaCategories(data); track category.id) { <option [value]="category.id">{{ category.name }}</option> }</select>
                      <label class="check-label"><input type="checkbox" [name]="'flavor-available-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.available" /> Disponível</label>
                      <label [for]="'flavor-description-' + item.id">Descrição</label><textarea [id]="'flavor-description-' + item.id" [name]="'flavor-description-' + item.id" maxlength="2000" [disabled]="item.archived || saving()" [(ngModel)]="item.description"></textarea>
                      <div class="ingredient-picks"><span>Ingredientes</span>@for (ingredient of activeIngredients(data); track ingredient.id) { <label class="check-label"><input type="checkbox" [checked]="item.ingredientIds.includes(ingredient.id)" [disabled]="item.archived || saving()" (change)="toggleFlavorIngredient(item, ingredient.id, $event)" /> {{ ingredient.name }}</label> }</div>
                      @if (item.archived) { <span class="archived-label">Arquivado</span> }
                      @else { <button class="button button--secondary" [disabled]="saving()">Salvar sabor</button><button type="button" class="button button--secondary" [disabled]="saving()" (click)="archive('flavors', item.id, item.name)">Arquivar</button><button type="button" class="quick-toggle" [disabled]="saving()" (click)="setAvailability('flavors', item.id, !item.available)">{{ item.available ? "Marcar esgotado" : "Marcar disponível" }}</button> }
                    </form>
                    @if (!item.archived) {
                      <div class="price-grid"><h3>Preços por tamanho</h3>@for (size of activeSizes(data); track size.id) { <form class="price-row" (ngSubmit)="savePrice('flavor', item.id, size.id)"><label [for]="priceKey('flavor', item.id, size.id)">{{ size.name }}</label><span>R$</span><input type="number" min="0.01" step="0.01" [id]="priceKey('flavor', item.id, size.id)" [name]="priceKey('flavor', item.id, size.id)" [value]="priceDraft('flavor', item.id, size.id, flavorPrice(data, item.id, size.id))" (input)="setPriceDraft('flavor', item.id, size.id, $event)" /><button class="button button--secondary" [disabled]="saving()">Salvar preço</button>@if (hasFlavorPrice(data, item.id, size.id)) { <button class="text-button" type="button" [disabled]="saving()" (click)="removePrice('flavor', item.id, size.id)">Remover</button> }</form> }</div>
                      <div class="image-tools"><label>Imagem do sabor <input type="file" accept="image/png,image/jpeg,image/webp" [attr.aria-label]="'Imagem de ' + item.name" [disabled]="saving()" (change)="uploadImage('flavors', item.id, $event)" /></label>@if (item.imageId) { <button type="button" class="text-button" (click)="showImage(item.imageId!)">{{ imageUrls()[item.imageId!] ? "Atualizar miniatura" : "Ver imagem" }}</button><button type="button" class="text-button" [disabled]="saving()" (click)="clearImage('flavors', item.id)">Remover imagem</button>@if (imageUrls()[item.imageId]) { <img class="thumbnail" [src]="imageUrls()[item.imageId]" [alt]="'Imagem de ' + item.name" /> } }</div>
                    }
                  </article>
                }
                @if (!data.flavors.length) { <p class="muted">Cadastre uma categoria do tipo Pizzas antes de adicionar sabores.</p> }
              </div>
            }
            @case ("crusts") {
              <h2>Bordas</h2>
              <form class="create-form" (ngSubmit)="createNamed('crusts')"><label>Nome <input name="newCrustName" required maxlength="120" [(ngModel)]="newNamed.crusts" /></label><button class="button" [disabled]="saving()">Adicionar borda</button></form>
              <div class="menu-list">@for (item of data.crusts; track item.id) { <article class="catalog-card"><form class="menu-row" (ngSubmit)="saveNamed('crusts', item)"><label [for]="'crust-name-' + item.id">Nome</label><input [id]="'crust-name-' + item.id" [name]="'crust-name-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.name"/><label class="check-label"><input type="checkbox" [name]="'crust-available-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.available"/> Disponível</label>@if (item.archived) { <span class="archived-label">Arquivada</span> } @else { <button class="button button--secondary" [disabled]="saving()">Salvar</button><button type="button" class="button button--secondary" (click)="archive('crusts', item.id, item.name)">Arquivar</button><button type="button" class="quick-toggle" [disabled]="saving()" (click)="setAvailability('crusts', item.id, !item.available)">{{ item.available ? "Marcar esgotado" : "Marcar disponível" }}</button> }</form>@if (!item.archived) { <div class="price-grid"><h3>Preços por tamanho</h3>@for (size of activeSizes(data); track size.id) { <form class="price-row" (ngSubmit)="savePrice('crust', item.id, size.id)"><label [for]="priceKey('crust', item.id, size.id)">{{ size.name }}</label><span>R$</span><input type="number" min="0" step="0.01" [id]="priceKey('crust', item.id, size.id)" [name]="priceKey('crust', item.id, size.id)" [value]="priceDraft('crust', item.id, size.id, crustPrice(data, item.id, size.id))" (input)="setPriceDraft('crust', item.id, size.id, $event)"/><button class="button button--secondary" [disabled]="saving()">Salvar preço</button>@if (hasCrustPrice(data, item.id, size.id)) { <button class="text-button" type="button" (click)="removePrice('crust', item.id, size.id)">Remover</button> }</form> }</div> }</article> }</div>
            }
            @case ("extras") {
              <h2>Adicionais</h2>
              <form class="create-form" (ngSubmit)="createNamed('extras')"><label>Nome <input name="newExtraName" required maxlength="120" [(ngModel)]="newNamed.extras" /></label><button class="button" [disabled]="saving()">Adicionar adicional</button></form>
              <div class="menu-list">@for (item of data.extras; track item.id) { <article class="catalog-card"><form class="menu-row" (ngSubmit)="saveNamed('extras', item)"><label [for]="'extra-name-' + item.id">Nome</label><input [id]="'extra-name-' + item.id" [name]="'extra-name-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.name"/><label class="check-label"><input type="checkbox" [name]="'extra-available-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.available"/> Disponível</label>@if (item.archived) { <span class="archived-label">Arquivado</span> } @else { <button class="button button--secondary" [disabled]="saving()">Salvar</button><button type="button" class="button button--secondary" (click)="archive('extras', item.id, item.name)">Arquivar</button><button type="button" class="quick-toggle" [disabled]="saving()" (click)="setAvailability('extras', item.id, !item.available)">{{ item.available ? "Marcar esgotado" : "Marcar disponível" }}</button> }</form>@if (!item.archived) { <div class="price-grid"><h3>Preços por tamanho</h3>@for (size of activeSizes(data); track size.id) { <form class="price-row price-row--extra" (ngSubmit)="savePrice('extra', item.id, size.id)"><label>{{ size.name }}</label><label [for]="priceKey('extra-whole', item.id, size.id)">Inteira R$</label><input type="number" min="0" step="0.01" [id]="priceKey('extra-whole', item.id, size.id)" [name]="priceKey('extra-whole', item.id, size.id)" [value]="priceDraft('extra-whole', item.id, size.id, extraWholePrice(data, item.id, size.id))" (input)="setPriceDraft('extra-whole', item.id, size.id, $event)"/><label [for]="priceKey('extra-half', item.id, size.id)">Metade R$</label><input type="number" min="0" step="0.01" [id]="priceKey('extra-half', item.id, size.id)" [name]="priceKey('extra-half', item.id, size.id)" [value]="priceDraft('extra-half', item.id, size.id, extraHalfPrice(data, item.id, size.id))" (input)="setPriceDraft('extra-half', item.id, size.id, $event)"/><button class="button button--secondary" [disabled]="saving()">Salvar</button>@if (hasExtraPrice(data, item.id, size.id)) { <button class="text-button" type="button" (click)="removePrice('extra', item.id, size.id)">Remover</button> }</form> }</div> }</article> }</div>
            }
            @case ("products") {
              <h2>Produtos</h2>
              <form class="create-form create-form--wide" (ngSubmit)="createProduct()"><label>Categoria <select name="newProductCategory" required [(ngModel)]="newProduct.categoryId"><option value="">Selecione</option>@for (category of productCategories(data); track category.id) { <option [value]="category.id">{{ category.name }}</option> }</select></label><label>Nome <input name="newProductName" required maxlength="120" [(ngModel)]="newProduct.name"/></label><label>Preço R$ <input name="newProductPrice" type="number" min="0" step="0.01" required [(ngModel)]="newProduct.price"/></label><button class="button" [disabled]="saving() || !productCategories(data).length">Adicionar produto</button></form>
              <div class="menu-list">@for (item of data.simpleProducts; track item.id) { <article class="catalog-card"><form class="menu-row" (ngSubmit)="saveProduct(item)"><label [for]="'product-name-' + item.id">Nome</label><input [id]="'product-name-' + item.id" [name]="'product-name-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.name"/><label [for]="'product-category-' + item.id">Categoria</label><select [id]="'product-category-' + item.id" [name]="'product-category-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.categoryId">@for (category of productCategories(data); track category.id) { <option [value]="category.id">{{ category.name }}</option> }</select><label [for]="'product-price-' + item.id">Preço R$</label><input [id]="'product-price-' + item.id" [name]="'product-price-' + item.id" type="number" min="0" step="0.01" [disabled]="item.archived || saving()" [ngModel]="item.priceCents / 100" (ngModelChange)="item.priceCents = cents($event)"/><label class="check-label"><input type="checkbox" [name]="'product-available-' + item.id" [disabled]="item.archived || saving()" [(ngModel)]="item.available"/> Disponível</label>@if (item.archived) { <span class="archived-label">Arquivado</span> } @else { <button class="button button--secondary" [disabled]="saving()">Salvar produto</button><button type="button" class="button button--secondary" [disabled]="saving()" (click)="archive('products', item.id, item.name)">Arquivar</button><button type="button" class="quick-toggle" [disabled]="saving()" (click)="setAvailability('products', item.id, !item.available)">{{ item.available ? "Marcar esgotado" : "Marcar disponível" }}</button> }</form><div class="image-tools"><label>Imagem do produto <input type="file" accept="image/png,image/jpeg,image/webp" [attr.aria-label]="'Imagem de ' + item.name" [disabled]="saving()" (change)="uploadImage('products', item.id, $event)" /></label>@if (item.imageId) { <button type="button" class="text-button" (click)="showImage(item.imageId!)">{{ imageUrls()[item.imageId!] ? "Atualizar miniatura" : "Ver imagem" }}</button><button type="button" class="text-button" [disabled]="saving()" (click)="clearImage('products', item.id)">Remover imagem</button>@if (imageUrls()[item.imageId]) { <img class="thumbnail" [src]="imageUrls()[item.imageId]" [alt]="'Imagem de ' + item.name" /> } }</div></article> }</div>
            }
            @case ("preview") {
              <h2>Prévia de preço</h2>
              @if (!data.pricingPolicy) { <p class="menu-note">Esta loja ainda não tem uma política salva. Para esta prévia, a estratégia inicial é HIGHEST sem sobretaxa; a escolha não será salva. A política editável faz parte da etapa M3.4.</p> }
              @if (!activeSizes(data).length || !pricedFlavors(data).length) { <p class="muted">Cadastre pelo menos um tamanho disponível e um sabor com preço para calcular a prévia.</p> }
              @else {
                <div class="preview-form"><label>Tamanho<select name="previewSize" [(ngModel)]="previewSizeId">@for (item of activeSizes(data); track item.id) { <option [value]="item.id">{{ item.name }}</option> }</select></label><label>Modo<select name="previewMode" [(ngModel)]="previewMode"><option value="WHOLE">Inteira</option><option value="HALVES">Meio a meio</option></select></label><label>Primeiro sabor<select name="previewFlavorLeft" [(ngModel)]="previewFlavorLeft">@for (item of pricedFlavors(data); track item.id) { <option [value]="item.id">{{ item.name }}</option> }</select></label>@if (previewMode() === "HALVES") { <label>Segundo sabor<select name="previewFlavorRight" [(ngModel)]="previewFlavorRight">@for (item of pricedFlavors(data); track item.id) { <option [value]="item.id">{{ item.name }}</option> }</select></label> }<label>Borda<select name="previewCrust" [(ngModel)]="previewCrustId"><option value="">Sem borda</option>@for (item of pricedCrusts(data, previewSizeId()); track item.id) { <option [value]="item.id">{{ item.name }}</option> }</select></label></div>
                @if (previewEvaluation(); as evaluation) { @if (evaluation.ok) { <div class="preview-result" role="status"><span>Preço unitário estimado</span><strong>{{ evaluation.price.unitPriceCents / 100 | currency:"BRL" }}</strong><small>Calculado por <code>pizza-pricing</code> · {{ data.pricingPolicy?.halfAndHalfStrategy ?? "HIGHEST (prévia)" }}</small></div> } @else { <p class="menu-alert" role="status">{{ previewError(evaluation.errors[0]?.code ?? "") }}</p> } }
              }
            }
          }
        </div>
      }
    </section>
  `,
})
export class MenuPage implements OnDestroy {
  private readonly api = inject(CatalogApi);
  readonly sections = SECTIONS;
  protected readonly catalog = signal<CatalogSnapshot | null>(null);
  protected readonly active = signal<Section>("categories");
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal("");
  protected readonly notice = signal("");
  protected readonly imageUrls = signal<Record<string, string>>({});
  protected readonly imageLoading = signal<string | null>(null);
  protected readonly previewSizeId = signal("");
  protected readonly previewMode = signal<"WHOLE" | "HALVES">("WHOLE");
  protected readonly previewFlavorLeft = signal("");
  protected readonly previewFlavorRight = signal("");
  protected readonly previewCrustId = signal("");
  protected readonly previewEvaluation = computed(() => {
    const data = this.catalog();
    const sizeId = this.previewSizeId();
    const left = this.previewFlavorLeft();
    if (!data || !sizeId || !left) return null;
    const mode = this.previewMode();
    const configuration: PizzaConfiguration = {
      sizeId,
      mode,
      flavors:
        mode === "HALVES"
          ? { LEFT: left, RIGHT: this.previewFlavorRight() || left }
          : { LEFT: left },
      crustId: this.previewCrustId() || null,
      extras: [],
      removals: [],
      quantity: 1,
    };
    const temporaryPolicy: PricingPolicy = {
      halfAndHalfStrategy: data.pricingPolicy?.halfAndHalfStrategy ?? "HIGHEST",
      halfAndHalfSurchargeCents:
        data.pricingPolicy?.halfAndHalfSurchargeCents ?? 0,
      maxExtrasPerHalf: data.pricingPolicy?.maxExtrasPerHalf ?? 4,
    };
    return evaluatePizza(configuration, this.pricingCatalog(data), temporaryPolicy);
  });

  protected newCategory = { name: "", kind: "PIZZA" as "PIZZA" | "PRODUCT" };
  protected newSize = { name: "", slices: 8, maxFlavors: 2 as 1 | 2, sortOrder: 0 };
  protected newIngredient = { name: "", removable: true };
  protected newFlavor = { categoryId: "", name: "", description: "", ingredientIds: [] as string[] };
  protected newNamed: Record<"crusts" | "extras", string> = { crusts: "", extras: "" };
  protected newProduct = { categoryId: "", name: "", price: "" };
  protected priceDrafts: Record<string, string> = {};
  private loadGeneration = 0;
  private readonly objectUrls = new Set<string>();

  constructor() {
    void this.load();
  }

  ngOnDestroy(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }

  protected selectSection(section: Section): void {
    this.active.set(section);
    const data = this.catalog();
    if (section === "preview" && data) this.initializePreview(data);
  }

  protected async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.loading.set(true);
    this.error.set("");
    try {
      const data = await this.api.snapshot();
      if (generation !== this.loadGeneration) return;
      this.catalog.set(data);
      this.initializePreview(data);
      this.priceDrafts = {};
    } catch (error) {
      if (generation === this.loadGeneration) this.error.set(errorMessage(error));
    } finally {
      if (generation === this.loadGeneration) this.loading.set(false);
    }
  }

  protected pizzaCategories(data: CatalogSnapshot) {
    return data.categories.filter((item) => item.kind === "PIZZA" && !item.archived);
  }
  protected productCategories(data: CatalogSnapshot) {
    return data.categories.filter((item) => item.kind === "PRODUCT" && !item.archived);
  }
  protected activeIngredients(data: CatalogSnapshot) {
    return data.ingredients.filter((item) => !item.archived);
  }
  protected activeSizes(data: CatalogSnapshot) {
    return data.sizes.filter((item) => !item.archived);
  }
  protected pricedFlavors(data: CatalogSnapshot) {
    const priced = new Set(data.flavorPrices.map((item) => item.flavorId));
    return data.flavors.filter((item) => item.available && !item.archived && priced.has(item.id));
  }
  protected pricedCrusts(data: CatalogSnapshot, sizeId: string) {
    const priced = new Set(data.crustPrices.filter((price) => price.sizeId === sizeId).map((price) => price.crustId));
    return data.crusts.filter((item) => item.available && !item.archived && priced.has(item.id));
  }

  protected async createCategory(): Promise<void> {
    await this.mutate(async () => {
      await this.api.create("categories", this.newCategory);
      this.newCategory = { name: "", kind: "PIZZA" };
      this.notice.set("Categoria adicionada.");
    });
  }
  protected async saveCategory(item: CatalogSnapshot["categories"][number]): Promise<void> {
    await this.mutate(async () => {
      await this.api.update("categories", item.id, { name: item.name, sortOrder: Number(item.sortOrder) || 0 });
      this.notice.set("Categoria atualizada.");
    });
  }
  protected async createSize(): Promise<void> {
    await this.mutate(async () => {
      await this.api.create("sizes", { ...this.newSize, slices: Number(this.newSize.slices), sortOrder: Number(this.newSize.sortOrder) || 0 });
      this.newSize = { name: "", slices: 8, maxFlavors: 2, sortOrder: 0 };
      this.notice.set("Tamanho adicionado.");
    });
  }
  protected async saveSize(item: CatalogSnapshot["sizes"][number]): Promise<void> {
    await this.mutate(async () => {
      await this.api.update("sizes", item.id, { name: item.name, slices: Number(item.slices), maxFlavors: Number(item.maxFlavors), sortOrder: Number(item.sortOrder) || 0, available: item.available });
      this.notice.set("Tamanho atualizado.");
    });
  }
  protected async createIngredient(): Promise<void> {
    await this.mutate(async () => {
      await this.api.create("ingredients", this.newIngredient);
      this.newIngredient = { name: "", removable: true };
      this.notice.set("Ingrediente adicionado.");
    });
  }
  protected async saveIngredient(item: CatalogSnapshot["ingredients"][number]): Promise<void> {
    await this.mutate(async () => {
      await this.api.update("ingredients", item.id, { name: item.name, removable: item.removable });
      this.notice.set("Ingrediente atualizado.");
    });
  }
  protected toggleNewIngredient(id: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.newFlavor.ingredientIds = checked
      ? [...new Set([...this.newFlavor.ingredientIds, id])]
      : this.newFlavor.ingredientIds.filter((item) => item !== id);
  }
  protected toggleFlavorIngredient(item: CatalogSnapshot["flavors"][number], id: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    item.ingredientIds = checked
      ? [...new Set([...item.ingredientIds, id])]
      : item.ingredientIds.filter((value) => value !== id);
  }
  protected async createFlavor(): Promise<void> {
    await this.mutate(async () => {
      await this.api.create("flavors", { ...this.newFlavor, description: this.newFlavor.description || null });
      this.newFlavor = { categoryId: "", name: "", description: "", ingredientIds: [] };
      this.notice.set("Sabor adicionado. Agora defina os preços por tamanho.");
    });
  }
  protected async saveFlavor(item: CatalogSnapshot["flavors"][number]): Promise<void> {
    await this.mutate(async () => {
      await this.api.update("flavors", item.id, { categoryId: item.categoryId, name: item.name, description: item.description, ingredientIds: item.ingredientIds, available: item.available });
      this.notice.set("Sabor atualizado.");
    });
  }
  protected async createNamed(kind: "crusts" | "extras"): Promise<void> {
    await this.mutate(async () => {
      await this.api.create(kind, { name: this.newNamed[kind] });
      this.newNamed[kind] = "";
      this.notice.set(kind === "crusts" ? "Borda adicionada." : "Adicional adicionado.");
    });
  }
  protected async saveNamed(kind: "crusts" | "extras", item: CatalogSnapshot["crusts"][number] | CatalogSnapshot["extras"][number]): Promise<void> {
    await this.mutate(async () => {
      await this.api.update(kind, item.id, { name: item.name, available: item.available });
      this.notice.set(kind === "crusts" ? "Borda atualizada." : "Adicional atualizado.");
    });
  }
  protected async createProduct(): Promise<void> {
    const priceCents = this.cents(this.newProduct.price);
    await this.mutate(async () => {
      await this.api.create("products", { categoryId: this.newProduct.categoryId, name: this.newProduct.name, priceCents });
      this.newProduct = { categoryId: "", name: "", price: "" };
      this.notice.set("Produto adicionado.");
    });
  }
  protected async saveProduct(item: CatalogSnapshot["simpleProducts"][number]): Promise<void> {
    await this.mutate(async () => {
      await this.api.update("products", item.id, { categoryId: item.categoryId, name: item.name, priceCents: Number(item.priceCents), available: item.available });
      this.notice.set("Produto atualizado.");
    });
  }

  protected async archive(kind: "categories" | "sizes" | "ingredients" | "flavors" | "crusts" | "extras" | "products", id: string, name: string): Promise<void> {
    if (!window.confirm(`Arquivar “${name}”? O item deixará de aparecer para pedidos.`)) return;
    await this.mutate(async () => {
      await this.api.archive(kind, id);
      this.notice.set("Item arquivado.");
    });
  }
  protected async setAvailability(kind: "flavors" | "crusts" | "extras" | "products", id: string, available: boolean): Promise<void> {
    await this.mutate(async () => {
      await this.api.availability(kind, id, available);
      this.notice.set(available ? "Item marcado como disponível." : "Item marcado como esgotado.");
    });
  }

  protected priceKey(kind: string, ownerId: string, sizeId: string): string {
    return `${kind}:${ownerId}:${sizeId}`;
  }
  protected priceDraft(kind: string, ownerId: string, sizeId: string, cents: number | undefined): string {
    return this.priceDrafts[this.priceKey(kind, ownerId, sizeId)] ?? (cents === undefined ? "" : (cents / 100).toFixed(2));
  }
  protected setPriceDraft(kind: string, ownerId: string, sizeId: string, event: Event): void {
    this.priceDrafts[this.priceKey(kind, ownerId, sizeId)] = (event.target as HTMLInputElement).value;
  }
  protected flavorPrice(data: CatalogSnapshot, owner: string, size: string): number | undefined {
    return data.flavorPrices.find((p) => p.flavorId === owner && p.sizeId === size)?.priceCents;
  }
  protected crustPrice(data: CatalogSnapshot, owner: string, size: string): number | undefined {
    return data.crustPrices.find((p) => p.crustId === owner && p.sizeId === size)?.priceCents;
  }
  protected extraWholePrice(data: CatalogSnapshot, owner: string, size: string): number | undefined {
    return data.extraPrices.find((p) => p.extraId === owner && p.sizeId === size)?.wholePriceCents;
  }
  protected extraHalfPrice(data: CatalogSnapshot, owner: string, size: string): number | undefined {
    return data.extraPrices.find((p) => p.extraId === owner && p.sizeId === size)?.halfPriceCents;
  }
  protected hasFlavorPrice(data: CatalogSnapshot, owner: string, size: string): boolean { return this.flavorPrice(data, owner, size) !== undefined; }
  protected hasCrustPrice(data: CatalogSnapshot, owner: string, size: string): boolean { return this.crustPrice(data, owner, size) !== undefined; }
  protected hasExtraPrice(data: CatalogSnapshot, owner: string, size: string): boolean { return this.extraWholePrice(data, owner, size) !== undefined; }

  protected async savePrice(kind: PriceKind, owner: string, size: string): Promise<void> {
    const data = this.catalog();
    if (!data) return;
    await this.mutate(async () => {
      if (kind === "flavor") {
        const cents = this.cents(this.priceDraft("flavor", owner, size, this.flavorPrice(data, owner, size)));
        await this.api.setFlavorPrice(owner, size, cents);
      } else if (kind === "crust") {
        const cents = this.cents(this.priceDraft("crust", owner, size, this.crustPrice(data, owner, size)));
        await this.api.setCrustPrice(owner, size, cents);
      } else {
        const whole = this.cents(this.priceDraft("extra-whole", owner, size, this.extraWholePrice(data, owner, size)));
        const half = this.cents(this.priceDraft("extra-half", owner, size, this.extraHalfPrice(data, owner, size)));
        await this.api.setExtraPrice(owner, size, whole, half);
      }
      this.notice.set("Preço atualizado.");
    });
  }
  protected async removePrice(kind: PriceKind, owner: string, size: string): Promise<void> {
    await this.mutate(async () => {
      if (kind === "flavor") await this.api.removeFlavorPrice(owner, size);
      else if (kind === "crust") await this.api.removeCrustPrice(owner, size);
      else await this.api.removeExtraPrice(owner, size);
      this.notice.set("Preço removido.");
    });
  }

  protected async uploadImage(kind: ImageKind, itemId: string, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      this.error.set("Escolha uma imagem PNG, JPEG ou WebP de até 5 MiB.");
      return;
    }
    await this.mutate(async () => {
      const image = await this.api.uploadImage(file);
      try {
        await this.api.update(kind, itemId, { imageId: image.id });
      } catch (error) {
        this.error.set(`A imagem foi recebida, mas não pôde ser associada. Tente novamente; código do ativo: ${image.id}. ${errorMessage(error)}`);
        return;
      }
      const url = URL.createObjectURL(file);
      this.objectUrls.add(url);
      this.imageUrls.update((urls) => ({ ...urls, [image.id]: url }));
      this.notice.set("Imagem enviada e associada ao item.");
    }, false);
  }
  protected async showImage(id: string): Promise<void> {
    if (this.imageUrls()[id] || this.imageLoading() === id) return;
    this.imageLoading.set(id);
    try {
      const blob = await this.api.readImage(id);
      const url = URL.createObjectURL(blob);
      this.objectUrls.add(url);
      this.imageUrls.update((urls) => ({ ...urls, [id]: url }));
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.imageLoading.set(null);
    }
  }
  protected async clearImage(kind: ImageKind, itemId: string): Promise<void> {
    await this.mutate(async () => {
      await this.api.update(kind, itemId, { imageId: null });
      this.notice.set("Imagem removida do item.");
    });
  }

  protected cents(value: string | number): number {
    const normalized = String(value).trim().replace(",", ".");
    const amount = Number(normalized);
    return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : -1;
  }
  protected previewError(code: string): string {
    const messages: Record<string, string> = {
      PIZZA_SIZE_UNAVAILABLE: "Escolha um tamanho disponível.",
      PIZZA_HALVES_NOT_ALLOWED: "Este tamanho não aceita pizza meio a meio.",
      PIZZA_FLAVOR_UNAVAILABLE: "Escolha sabores disponíveis com preço neste tamanho.",
      PIZZA_CRUST_UNAVAILABLE: "A borda escolhida não tem preço para este tamanho.",
      PIZZA_EXTRA_UNAVAILABLE: "Um adicional não está disponível para este tamanho.",
    };
    return messages[code] ?? "Não foi possível calcular com esta combinação.";
  }

  private initializePreview(data: CatalogSnapshot): void {
    const size = this.activeSizes(data)[0];
    const flavor = this.pricedFlavors(data)[0];
    if (!this.previewSizeId() && size) this.previewSizeId.set(size.id);
    if (!this.previewFlavorLeft() && flavor) this.previewFlavorLeft.set(flavor.id);
    if (!this.previewFlavorRight() && flavor) this.previewFlavorRight.set(flavor.id);
  }
  private pricingCatalog(data: CatalogSnapshot): PizzaCatalog {
    return {
      categories: data.categories.map(({ id, kind, archived }) => ({ id, kind, archived })),
      sizes: data.sizes.map(({ id, name, slices, maxFlavors, available, archived }) => ({ id, name, slices, maxFlavors, available, archived })),
      ingredients: data.ingredients.map(({ id, name, removable, archived }) => ({ id, name, removable, archived })),
      flavors: data.flavors.map(({ id, categoryId, name, ingredientIds, available, archived }) => ({ id, categoryId, name, ingredientIds, available, archived })),
      flavorPrices: data.flavorPrices,
      crusts: data.crusts.map(({ id, name, available, archived }) => ({ id, name, available, archived })),
      crustPrices: data.crustPrices,
      extras: data.extras.map(({ id, name, available, archived }) => ({ id, name, available, archived })),
      extraPrices: data.extraPrices,
    };
  }
  private async mutate(action: () => Promise<void>, reload = true): Promise<void> {
    this.error.set("");
    this.notice.set("");
    this.saving.set(true);
    try {
      await action();
      if (reload) await this.load();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }
}
