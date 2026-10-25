import { CurrencyPipe, NgTemplateOutlet } from "@angular/common";
import { Component, computed, inject, OnDestroy, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { evaluatePizza } from "@whiteoven/pizza-pricing";
import type {
  PizzaCatalog,
  PizzaConfiguration,
  PricingPolicy,
} from "@whiteoven/contracts";
import { errorMessage } from "../core/api";
import { CatalogApi, type CatalogSnapshot } from "./catalog-api";
import {
  EMPTY_PREVIEW,
  type MoneyKind,
  type PreviewSelection,
  moneyText,
  parseMoney,
  previewCrusts,
  previewFlavors,
  previewSizes,
  reconcilePreview,
} from "./menu-model";

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
type EditKind =
  | "categories"
  | "sizes"
  | "ingredients"
  | "flavors"
  | "crusts"
  | "extras"
  | "products";

/** An item being edited: a copy of the API's item (`base`) and the person's changes (`value`). */
interface Draft {
  base: string;
  value: { id: string };
}

/** An image stored by the API but not yet linked to its item. */
interface PendingImage {
  imageId: string;
  url: string;
}

/** The upload worked; linking the stored image to the item did not. */
class ImageLinkError extends Error {
  constructor(readonly original: unknown) {
    super("image link failed");
  }
}

/** A copy of the record without one key. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

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

/**
 * Preview policy while the store has none saved: HIGHEST with no surcharge, as the page states.
 * Nothing is saved; the editable policy is M3.4.
 */
const PREVIEW_POLICY: PricingPolicy = {
  halfAndHalfStrategy: "HIGHEST",
  halfAndHalfSurchargeCents: 0,
  maxExtrasPerHalf: 4,
};

/**
 * Tenant catalog editor. The API remains responsible for authorization and catalog rules.
 *
 * Edits never touch the snapshot the API returned: each form edits a draft copy, and a draft is
 * dropped only after the API confirmed its save. Reloading the catalog (after any save, or with
 * "Atualizar") keeps every draft with unsaved changes, so saving one item never discards what was
 * typed in another; "Descartar alterações" is the explicit way back to the saved values.
 */
@Component({
  selector: "wo-menu-page",
  imports: [FormsModule, CurrencyPipe, NgTemplateOutlet],
  styleUrl: "./menu.page.css",
  template: `
    <section class="menu-page" aria-labelledby="menu-title">
      <header class="menu-heading">
        <div>
          <p class="eyebrow">Cardápio da loja</p>
          <h1 id="menu-title" tabindex="-1" data-page-title>Cardápio</h1>
          <p class="muted">
            Cadastre itens, preços e disponibilidade da pizzaria.
          </p>
        </div>
        <div class="menu-heading-actions">
          <button
            type="button"
            class="button button--secondary"
            [disabled]="loading() || saving()"
            (click)="refresh()"
          >
            {{ loading() ? "Atualizando…" : "Atualizar" }}
          </button>
          @if (pendingChanges()) {
            <button
              type="button"
              class="button button--secondary"
              [disabled]="saving()"
              (click)="discardChanges()"
            >
              Descartar alterações
            </button>
          }
        </div>
      </header>

      @if (error()) {
        <p class="menu-alert" role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p class="menu-notice" role="status">{{ notice() }}</p>
      }
      @if (loading() && !catalog()) {
        <p role="status">Carregando cardápio…</p>
      }

      <nav class="menu-tabs" aria-label="Seções do cardápio" role="tablist">
        @for (section of sections; track section.id) {
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="active() === section.id"
            [attr.aria-controls]="'menu-panel-' + section.id"
            [id]="'menu-tab-' + section.id"
            (click)="selectSection(section.id)"
          >
            {{ section.label }}
          </button>
        }
      </nav>

      @if (catalog(); as data) {
        <div
          class="menu-panel"
          role="tabpanel"
          [attr.aria-labelledby]="'menu-tab-' + active()"
          [id]="'menu-panel-' + active()"
        >
          @switch (active()) {
            @case ("categories") {
              <h2>Categorias</h2>
              <form class="create-form" (ngSubmit)="createCategory()">
                <label
                  >Nome
                  <input
                    name="newCategoryName"
                    required
                    maxlength="120"
                    [(ngModel)]="newCategory.name"
                /></label>
                <label
                  >Tipo
                  <select name="newCategoryKind" [(ngModel)]="newCategory.kind">
                    <option value="PIZZA">Pizzas</option>
                    <option value="PRODUCT">Produtos</option>
                  </select></label
                >
                <button class="button" [disabled]="saving()">
                  Adicionar categoria
                </button>
              </form>
              <div class="menu-list">
                @for (item of data.categories; track item.id) {
                  @let draft = edit("categories", item);
                  <form class="menu-row" (ngSubmit)="saveCategory(draft)">
                    <label [for]="'category-name-' + item.id">Nome</label>
                    <input
                      [id]="'category-name-' + item.id"
                      [name]="'category-name-' + item.id"
                      [disabled]="item.archived || saving()"
                      [(ngModel)]="draft.name"
                    />
                    <span class="kind-label">{{
                      item.kind === "PIZZA" ? "Pizzas" : "Produtos"
                    }}</span>
                    <label [for]="'category-order-' + item.id">Ordem</label>
                    <input
                      class="short-input"
                      type="number"
                      min="0"
                      [id]="'category-order-' + item.id"
                      [name]="'category-order-' + item.id"
                      [disabled]="item.archived || saving()"
                      [(ngModel)]="draft.sortOrder"
                    />
                    @if (dirty("categories", item.id)) {
                      <span class="dirty-label">Não salvo</span>
                    }
                    @if (item.archived) {
                      <span class="archived-label">Arquivada</span>
                    } @else {
                      <button
                        class="button button--secondary"
                        [disabled]="saving()"
                      >
                        Salvar</button
                      ><button
                        type="button"
                        class="button button--secondary"
                        [disabled]="saving()"
                        (click)="archive('categories', item.id, item.name)"
                      >
                        Arquivar
                      </button>
                    }
                  </form>
                }
                @if (!data.categories.length) {
                  <p class="muted">Nenhuma categoria cadastrada.</p>
                }
              </div>
            }
            @case ("sizes") {
              <h2>Tamanhos de pizza</h2>
              <form class="create-form" (ngSubmit)="createSize()">
                <label
                  >Nome
                  <input
                    name="newSizeName"
                    required
                    maxlength="120"
                    [(ngModel)]="newSize.name"
                /></label>
                <label
                  >Fatias
                  <input
                    name="newSizeSlices"
                    type="number"
                    min="1"
                    required
                    [(ngModel)]="newSize.slices"
                /></label>
                <label
                  >Sabores
                  <select
                    name="newSizeFlavors"
                    [(ngModel)]="newSize.maxFlavors"
                  >
                    <option [ngValue]="1">Inteira</option>
                    <option [ngValue]="2">Inteira ou meio a meio</option>
                  </select></label
                >
                <label
                  >Ordem
                  <input
                    name="newSizeOrder"
                    type="number"
                    min="0"
                    [(ngModel)]="newSize.sortOrder"
                /></label>
                <button class="button" [disabled]="saving()">
                  Adicionar tamanho
                </button>
              </form>
              <div class="menu-list">
                @for (item of data.sizes; track item.id) {
                  @let draft = edit("sizes", item);
                  <form class="menu-row" (ngSubmit)="saveSize(draft)">
                    <label [for]="'size-name-' + item.id">Nome</label
                    ><input
                      [id]="'size-name-' + item.id"
                      [name]="'size-name-' + item.id"
                      [disabled]="item.archived || saving()"
                      [(ngModel)]="draft.name"
                    />
                    <label [for]="'size-slices-' + item.id">Fatias</label
                    ><input
                      class="short-input"
                      [id]="'size-slices-' + item.id"
                      [name]="'size-slices-' + item.id"
                      type="number"
                      min="1"
                      [disabled]="item.archived || saving()"
                      [(ngModel)]="draft.slices"
                    />
                    <label [for]="'size-flavors-' + item.id">Sabores</label
                    ><select
                      [id]="'size-flavors-' + item.id"
                      [name]="'size-flavors-' + item.id"
                      [disabled]="item.archived || saving()"
                      [(ngModel)]="draft.maxFlavors"
                    >
                      <option [ngValue]="1">1</option>
                      <option [ngValue]="2">2</option>
                    </select>
                    <label class="check-label"
                      ><input
                        type="checkbox"
                        [name]="'size-available-' + item.id"
                        [disabled]="item.archived || saving()"
                        [(ngModel)]="draft.available"
                      />
                      Disponível</label
                    >
                    @if (dirty("sizes", item.id)) {
                      <span class="dirty-label">Não salvo</span>
                    }
                    @if (item.archived) {
                      <span class="archived-label">Arquivado</span>
                    } @else {
                      <button
                        class="button button--secondary"
                        [disabled]="saving()"
                      >
                        Salvar</button
                      ><button
                        type="button"
                        class="button button--secondary"
                        [disabled]="saving()"
                        (click)="archive('sizes', item.id, item.name)"
                      >
                        Arquivar
                      </button>
                    }
                  </form>
                }
              </div>
            }
            @case ("ingredients") {
              <h2>Ingredientes</h2>
              <form class="create-form" (ngSubmit)="createIngredient()">
                <label
                  >Nome
                  <input
                    name="newIngredientName"
                    required
                    maxlength="120"
                    [(ngModel)]="newIngredient.name"
                /></label>
                <label class="check-label"
                  ><input
                    type="checkbox"
                    name="newIngredientRemovable"
                    [(ngModel)]="newIngredient.removable"
                  />
                  Cliente pode remover</label
                >
                <button class="button" [disabled]="saving()">
                  Adicionar ingrediente
                </button>
              </form>
              <div class="menu-list">
                @for (item of data.ingredients; track item.id) {
                  @let draft = edit("ingredients", item);
                  <form class="menu-row" (ngSubmit)="saveIngredient(draft)">
                    <label [for]="'ingredient-name-' + item.id">Nome</label
                    ><input
                      [id]="'ingredient-name-' + item.id"
                      [name]="'ingredient-name-' + item.id"
                      [disabled]="item.archived || saving()"
                      [(ngModel)]="draft.name"
                    />
                    <label class="check-label"
                      ><input
                        type="checkbox"
                        [name]="'ingredient-removable-' + item.id"
                        [disabled]="item.archived || saving()"
                        [(ngModel)]="draft.removable"
                      />
                      Removível</label
                    >
                    @if (dirty("ingredients", item.id)) {
                      <span class="dirty-label">Não salvo</span>
                    }
                    @if (item.archived) {
                      <span class="archived-label">Arquivado</span>
                    } @else {
                      <button
                        class="button button--secondary"
                        [disabled]="saving()"
                      >
                        Salvar</button
                      ><button
                        type="button"
                        class="button button--secondary"
                        [disabled]="saving()"
                        (click)="archive('ingredients', item.id, item.name)"
                      >
                        Arquivar
                      </button>
                    }
                  </form>
                }
              </div>
            }
            @case ("flavors") {
              <h2>Sabores de pizza</h2>
              <form
                class="create-form create-form--wide"
                (ngSubmit)="createFlavor()"
              >
                <label
                  >Categoria
                  <select
                    name="newFlavorCategory"
                    required
                    [(ngModel)]="newFlavor.categoryId"
                  >
                    <option value="">Selecione</option>
                    @for (
                      category of pizzaCategories(data);
                      track category.id
                    ) {
                      <option [value]="category.id">{{ category.name }}</option>
                    }
                  </select></label
                >
                <label
                  >Nome
                  <input
                    name="newFlavorName"
                    required
                    maxlength="120"
                    [(ngModel)]="newFlavor.name"
                /></label>
                <label
                  >Descrição
                  <input
                    name="newFlavorDescription"
                    maxlength="2000"
                    [(ngModel)]="newFlavor.description"
                /></label>
                <div class="ingredient-picks">
                  <span>Ingredientes</span>
                  @for (
                    ingredient of activeIngredients(data);
                    track ingredient.id
                  ) {
                    <label class="check-label"
                      ><input
                        type="checkbox"
                        [checked]="
                          newFlavor.ingredientIds.includes(ingredient.id)
                        "
                        (change)="toggleNewIngredient(ingredient.id, $event)"
                      />
                      {{ ingredient.name }}</label
                    >
                  }
                </div>
                <button
                  class="button"
                  [disabled]="saving() || !pizzaCategories(data).length"
                >
                  Adicionar sabor
                </button>
              </form>
              <div class="menu-list">
                @for (item of data.flavors; track item.id) {
                  @let draft = edit("flavors", item);
                  <article
                    class="catalog-card"
                    [class.catalog-card--archived]="item.archived"
                  >
                    <form
                      class="menu-row menu-row--main"
                      (ngSubmit)="saveFlavor(draft)"
                    >
                      <label [for]="'flavor-name-' + item.id">Nome</label
                      ><input
                        [id]="'flavor-name-' + item.id"
                        [name]="'flavor-name-' + item.id"
                        [disabled]="item.archived || saving()"
                        [(ngModel)]="draft.name"
                      />
                      <label [for]="'flavor-category-' + item.id"
                        >Categoria</label
                      ><select
                        [id]="'flavor-category-' + item.id"
                        [name]="'flavor-category-' + item.id"
                        [disabled]="item.archived || saving()"
                        [(ngModel)]="draft.categoryId"
                      >
                        @for (
                          category of pizzaCategories(data);
                          track category.id
                        ) {
                          <option [value]="category.id">
                            {{ category.name }}
                          </option>
                        }
                      </select>
                      <label class="check-label"
                        ><input
                          type="checkbox"
                          [name]="'flavor-available-' + item.id"
                          [disabled]="item.archived || saving()"
                          [(ngModel)]="draft.available"
                        />
                        Disponível</label
                      >
                      <label [for]="'flavor-description-' + item.id"
                        >Descrição</label
                      ><textarea
                        [id]="'flavor-description-' + item.id"
                        [name]="'flavor-description-' + item.id"
                        maxlength="2000"
                        [disabled]="item.archived || saving()"
                        [(ngModel)]="draft.description"
                      ></textarea>
                      <div class="ingredient-picks">
                        <span>Ingredientes</span>
                        @for (
                          ingredient of activeIngredients(data);
                          track ingredient.id
                        ) {
                          <label class="check-label"
                            ><input
                              type="checkbox"
                              [checked]="
                                draft.ingredientIds.includes(ingredient.id)
                              "
                              [disabled]="item.archived || saving()"
                              (change)="
                                toggleFlavorIngredient(
                                  draft,
                                  ingredient.id,
                                  $event
                                )
                              "
                            />
                            {{ ingredient.name }}</label
                          >
                        }
                      </div>
                      @if (dirty("flavors", item.id)) {
                        <span class="dirty-label">Não salvo</span>
                      }
                      @if (item.archived) {
                        <span class="archived-label">Arquivado</span>
                      } @else {
                        <button
                          class="button button--secondary"
                          [disabled]="saving()"
                        >
                          Salvar sabor</button
                        ><button
                          type="button"
                          class="button button--secondary"
                          [disabled]="saving()"
                          (click)="archive('flavors', item.id, item.name)"
                        >
                          Arquivar</button
                        ><button
                          type="button"
                          class="quick-toggle"
                          [disabled]="saving()"
                          (click)="
                            setAvailability('flavors', item.id, !item.available)
                          "
                        >
                          {{
                            item.available
                              ? "Marcar esgotado"
                              : "Marcar disponível"
                          }}
                        </button>
                      }
                    </form>
                    @if (!item.archived) {
                      <div class="price-grid">
                        <h3>Preços por tamanho</h3>
                        @for (size of activeSizes(data); track size.id) {
                          @let key = priceKey("flavor", item.id, size.id);
                          <form
                            class="price-row"
                            (ngSubmit)="savePrice('flavor', item.id, size.id)"
                          >
                            <label [for]="key">{{ size.name }}</label
                            ><span>R$</span>
                            <input
                              inputmode="decimal"
                              autocomplete="off"
                              [id]="key"
                              [name]="key"
                              [value]="
                                money(key, flavorPrice(data, item.id, size.id))
                              "
                              [attr.aria-invalid]="!!fieldError(key)"
                              [attr.aria-describedby]="
                                fieldError(key) ? key + '-error' : null
                              "
                              (input)="setMoney(key, $event)"
                            /><button
                              class="button button--secondary"
                              [disabled]="saving()"
                            >
                              Salvar preço
                            </button>
                            @if (hasFlavorPrice(data, item.id, size.id)) {
                              <button
                                class="text-button"
                                type="button"
                                [disabled]="saving()"
                                (click)="
                                  removePrice('flavor', item.id, size.id)
                                "
                              >
                                Remover
                              </button>
                            }
                            @if (fieldError(key); as message) {
                              <p class="field-error" [id]="key + '-error'">
                                {{ message }}
                              </p>
                            }
                          </form>
                        }
                      </div>
                      <ng-container
                        *ngTemplateOutlet="
                          imageTools;
                          context: {
                            kind: 'flavors',
                            item: item,
                            label: 'sabor',
                          }
                        "
                      />
                    }
                  </article>
                }
                @if (!data.flavors.length) {
                  <p class="muted">
                    Cadastre uma categoria do tipo Pizzas antes de adicionar
                    sabores.
                  </p>
                }
              </div>
            }
            @case ("crusts") {
              <h2>Bordas</h2>
              <ng-container
                *ngTemplateOutlet="
                  addons;
                  context: { kind: 'crusts', items: data.crusts, data: data }
                "
              />
            }
            @case ("extras") {
              <h2>Adicionais</h2>
              <ng-container
                *ngTemplateOutlet="
                  addons;
                  context: { kind: 'extras', items: data.extras, data: data }
                "
              />
            }
            @case ("products") {
              <h2>Produtos</h2>
              <form
                class="create-form create-form--wide"
                (ngSubmit)="createProduct()"
              >
                <label
                  >Categoria
                  <select
                    name="newProductCategory"
                    required
                    [(ngModel)]="newProduct.categoryId"
                  >
                    <option value="">Selecione</option>
                    @for (
                      category of productCategories(data);
                      track category.id
                    ) {
                      <option [value]="category.id">{{ category.name }}</option>
                    }
                  </select></label
                >
                <label
                  >Nome
                  <input
                    name="newProductName"
                    required
                    maxlength="120"
                    [(ngModel)]="newProduct.name"
                /></label>
                <label
                  >Preço R$
                  <input
                    name="newProductPrice"
                    inputmode="decimal"
                    autocomplete="off"
                    required
                    [attr.aria-invalid]="!!fieldError('new-product')"
                    [attr.aria-describedby]="
                      fieldError('new-product') ? 'new-product-error' : null
                    "
                    [(ngModel)]="newProduct.price"
                /></label>
                @if (fieldError("new-product"); as message) {
                  <p class="field-error" id="new-product-error">
                    {{ message }}
                  </p>
                }
                <button
                  class="button"
                  [disabled]="saving() || !productCategories(data).length"
                >
                  Adicionar produto
                </button>
              </form>
              <div class="menu-list">
                @for (item of data.simpleProducts; track item.id) {
                  @let draft = edit("products", item);
                  @let key = priceKey("product", item.id, "price");
                  <article class="catalog-card">
                    <form class="menu-row" (ngSubmit)="saveProduct(draft)">
                      <label [for]="'product-name-' + item.id">Nome</label
                      ><input
                        [id]="'product-name-' + item.id"
                        [name]="'product-name-' + item.id"
                        [disabled]="item.archived || saving()"
                        [(ngModel)]="draft.name"
                      />
                      <label [for]="'product-category-' + item.id"
                        >Categoria</label
                      ><select
                        [id]="'product-category-' + item.id"
                        [name]="'product-category-' + item.id"
                        [disabled]="item.archived || saving()"
                        [(ngModel)]="draft.categoryId"
                      >
                        @for (
                          category of productCategories(data);
                          track category.id
                        ) {
                          <option [value]="category.id">
                            {{ category.name }}
                          </option>
                        }
                      </select>
                      <label [for]="key">Preço R$</label
                      ><input
                        inputmode="decimal"
                        autocomplete="off"
                        [id]="key"
                        [name]="key"
                        [disabled]="item.archived || saving()"
                        [value]="money(key, item.priceCents)"
                        [attr.aria-invalid]="!!fieldError(key)"
                        [attr.aria-describedby]="
                          fieldError(key) ? key + '-error' : null
                        "
                        (input)="setMoney(key, $event)"
                      />
                      <label class="check-label"
                        ><input
                          type="checkbox"
                          [name]="'product-available-' + item.id"
                          [disabled]="item.archived || saving()"
                          [(ngModel)]="draft.available"
                        />
                        Disponível</label
                      >
                      @if (fieldError(key); as message) {
                        <p class="field-error" [id]="key + '-error'">
                          {{ message }}
                        </p>
                      }
                      @if (dirty("products", item.id) || moneyDirty(key)) {
                        <span class="dirty-label">Não salvo</span>
                      }
                      @if (item.archived) {
                        <span class="archived-label">Arquivado</span>
                      } @else {
                        <button
                          class="button button--secondary"
                          [disabled]="saving()"
                        >
                          Salvar produto</button
                        ><button
                          type="button"
                          class="button button--secondary"
                          [disabled]="saving()"
                          (click)="archive('products', item.id, item.name)"
                        >
                          Arquivar</button
                        ><button
                          type="button"
                          class="quick-toggle"
                          [disabled]="saving()"
                          (click)="
                            setAvailability(
                              'products',
                              item.id,
                              !item.available
                            )
                          "
                        >
                          {{
                            item.available
                              ? "Marcar esgotado"
                              : "Marcar disponível"
                          }}
                        </button>
                      }
                    </form>
                    @if (!item.archived) {
                      <ng-container
                        *ngTemplateOutlet="
                          imageTools;
                          context: {
                            kind: 'products',
                            item: item,
                            label: 'produto',
                          }
                        "
                      />
                    }
                  </article>
                }
              </div>
            }
            @case ("preview") {
              <h2>Prévia de preço</h2>
              @if (!data.pricingPolicy) {
                <p class="menu-note">
                  Esta loja ainda não tem uma política salva. Para esta prévia,
                  a estratégia inicial é HIGHEST sem sobretaxa; a escolha não
                  será salva. A política editável faz parte da etapa M3.4.
                </p>
              }
              @let selection = preview();
              @let sizes = previewSizes(data);
              @let flavors = previewFlavors(data, selection.sizeId);
              @if (!sizes.length) {
                <p class="muted" role="status">
                  Nenhum tamanho disponível. Cadastre ou marque um tamanho como
                  disponível para calcular a prévia.
                </p>
              } @else {
                <div class="preview-form">
                  <label
                    >Tamanho<select
                      name="previewSize"
                      [ngModel]="selection.sizeId"
                      (ngModelChange)="choosePreview({ sizeId: $event })"
                    >
                      @for (item of sizes; track item.id) {
                        <option [value]="item.id">{{ item.name }}</option>
                      }
                    </select></label
                  >
                  @if (flavors.length) {
                    <label
                      >Modo<select
                        name="previewMode"
                        [ngModel]="selection.mode"
                        (ngModelChange)="choosePreview({ mode: $event })"
                      >
                        <option value="WHOLE">Inteira</option>
                        @if (previewAllowsHalves(data, selection.sizeId)) {
                          <option value="HALVES">Meio a meio</option>
                        }
                      </select></label
                    >
                    <label
                      >{{
                        selection.mode === "HALVES"
                          ? "Primeiro sabor"
                          : "Sabor"
                      }}<select
                        name="previewFlavorLeft"
                        [ngModel]="selection.left"
                        (ngModelChange)="choosePreview({ left: $event })"
                      >
                        @for (item of flavors; track item.id) {
                          <option [value]="item.id">{{ item.name }}</option>
                        }
                      </select></label
                    >
                    @if (selection.mode === "HALVES") {
                      <label
                        >Segundo sabor<select
                          name="previewFlavorRight"
                          [ngModel]="selection.right"
                          (ngModelChange)="choosePreview({ right: $event })"
                        >
                          @for (item of flavors; track item.id) {
                            <option [value]="item.id">{{ item.name }}</option>
                          }
                        </select></label
                      >
                    }
                    <label
                      >Borda<select
                        name="previewCrust"
                        [ngModel]="selection.crustId"
                        (ngModelChange)="choosePreview({ crustId: $event })"
                      >
                        <option value="">Sem borda</option>
                        @for (
                          item of previewCrusts(data, selection.sizeId);
                          track item.id
                        ) {
                          <option [value]="item.id">{{ item.name }}</option>
                        }
                      </select></label
                    >
                  }
                </div>
                @if (!flavors.length) {
                  <p class="muted" role="status">
                    Nenhum sabor disponível tem preço para este tamanho.
                  </p>
                } @else if (previewEvaluation(); as evaluation) {
                  @if (evaluation.ok) {
                    <div class="preview-result" role="status">
                      <span>Preço unitário estimado</span>
                      <strong>{{
                        evaluation.price.unitPriceCents / 100 | currency: "BRL"
                      }}</strong>
                      <small
                        >Calculado por <code>pizza-pricing</code> ·
                        {{
                          data.pricingPolicy?.halfAndHalfStrategy ??
                            "HIGHEST (prévia)"
                        }}</small
                      >
                    </div>
                  } @else {
                    <p class="menu-alert" role="status">
                      {{ previewError(evaluation.errors[0]?.code ?? "") }}
                    </p>
                  }
                }
              }
            }
          }
        </div>
      }
    </section>

    <ng-template #addons let-kind="kind" let-items="items" let-data="data">
      <form class="create-form" (ngSubmit)="createNamed(kind)">
        <label
          >Nome
          <input
            [name]="'new-' + kind"
            required
            maxlength="120"
            [(ngModel)]="newNamed[kindKey(kind)]"
        /></label>
        <button class="button" [disabled]="saving()">
          {{ kind === "crusts" ? "Adicionar borda" : "Adicionar adicional" }}
        </button>
      </form>
      <div class="menu-list">
        @for (item of $any(items); track item.id) {
          @let draft = edit(kind, item);
          <article class="catalog-card">
            <form class="menu-row" (ngSubmit)="saveNamed(kind, draft)">
              <label [for]="kind + '-name-' + item.id">Nome</label
              ><input
                [id]="kind + '-name-' + item.id"
                [name]="kind + '-name-' + item.id"
                [disabled]="item.archived || saving()"
                [(ngModel)]="draft.name"
              />
              <label class="check-label"
                ><input
                  type="checkbox"
                  [name]="kind + '-available-' + item.id"
                  [disabled]="item.archived || saving()"
                  [(ngModel)]="draft.available"
                />
                Disponível</label
              >
              @if (dirty(kind, item.id)) {
                <span class="dirty-label">Não salvo</span>
              }
              @if (item.archived) {
                <span class="archived-label">Arquivado</span>
              } @else {
                <button class="button button--secondary" [disabled]="saving()">
                  Salvar</button
                ><button
                  type="button"
                  class="button button--secondary"
                  [disabled]="saving()"
                  (click)="archive(kind, item.id, item.name)"
                >
                  Arquivar</button
                ><button
                  type="button"
                  class="quick-toggle"
                  [disabled]="saving()"
                  (click)="setAvailability(kind, item.id, !item.available)"
                >
                  {{ item.available ? "Marcar esgotado" : "Marcar disponível" }}
                </button>
              }
            </form>
            @if (!item.archived) {
              <div class="price-grid">
                <h3>Preços por tamanho</h3>
                @for (size of activeSizes(data); track size.id) {
                  @if (kind === "crusts") {
                    @let key = priceKey("crust", item.id, size.id);
                    <form
                      class="price-row"
                      (ngSubmit)="savePrice('crust', item.id, size.id)"
                    >
                      <label [for]="key">{{ size.name }}</label
                      ><span>R$</span>
                      <input
                        inputmode="decimal"
                        autocomplete="off"
                        [id]="key"
                        [name]="key"
                        [value]="money(key, crustPrice(data, item.id, size.id))"
                        [attr.aria-invalid]="!!fieldError(key)"
                        [attr.aria-describedby]="
                          fieldError(key) ? key + '-error' : null
                        "
                        (input)="setMoney(key, $event)"
                      /><button
                        class="button button--secondary"
                        [disabled]="saving()"
                      >
                        Salvar preço
                      </button>
                      @if (hasCrustPrice(data, item.id, size.id)) {
                        <button
                          class="text-button"
                          type="button"
                          [disabled]="saving()"
                          (click)="removePrice('crust', item.id, size.id)"
                        >
                          Remover
                        </button>
                      }
                      @if (fieldError(key); as message) {
                        <p class="field-error" [id]="key + '-error'">
                          {{ message }}
                        </p>
                      }
                    </form>
                  } @else {
                    @let whole = priceKey("extra-whole", item.id, size.id);
                    @let half = priceKey("extra-half", item.id, size.id);
                    <form
                      class="price-row price-row--extra"
                      (ngSubmit)="savePrice('extra', item.id, size.id)"
                    >
                      <span>{{ size.name }}</span>
                      <label [for]="whole">Inteira R$</label
                      ><input
                        inputmode="decimal"
                        autocomplete="off"
                        [id]="whole"
                        [name]="whole"
                        [value]="
                          money(whole, extraWholePrice(data, item.id, size.id))
                        "
                        [attr.aria-invalid]="!!fieldError(whole)"
                        [attr.aria-describedby]="
                          fieldError(whole) ? whole + '-error' : null
                        "
                        (input)="setMoney(whole, $event)"
                      /><label [for]="half">Metade R$</label
                      ><input
                        inputmode="decimal"
                        autocomplete="off"
                        [id]="half"
                        [name]="half"
                        [value]="
                          money(half, extraHalfPrice(data, item.id, size.id))
                        "
                        [attr.aria-invalid]="!!fieldError(half)"
                        [attr.aria-describedby]="
                          fieldError(half) ? half + '-error' : null
                        "
                        (input)="setMoney(half, $event)"
                      /><button
                        class="button button--secondary"
                        [disabled]="saving()"
                      >
                        Salvar
                      </button>
                      @if (hasExtraPrice(data, item.id, size.id)) {
                        <button
                          class="text-button"
                          type="button"
                          [disabled]="saving()"
                          (click)="removePrice('extra', item.id, size.id)"
                        >
                          Remover
                        </button>
                      }
                      @if (fieldError(whole); as message) {
                        <p class="field-error" [id]="whole + '-error'">
                          Inteira: {{ message }}
                        </p>
                      }
                      @if (fieldError(half); as message) {
                        <p class="field-error" [id]="half + '-error'">
                          Metade: {{ message }}
                        </p>
                      }
                    </form>
                  }
                }
              </div>
            }
          </article>
        }
      </div>
    </ng-template>

    <ng-template #imageTools let-kind="kind" let-item="item" let-label="label">
      @let pending = pendingImage(kind, item.id);
      <div class="image-tools">
        <label
          >Imagem do {{ label }}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            [attr.aria-label]="'Imagem de ' + item.name"
            [disabled]="saving()"
            (change)="uploadImage(kind, item.id, $event)"
        /></label>
        @if (pending) {
          <div class="image-pending" role="status">
            <p>
              A imagem foi enviada, mas ainda não está associada a “{{
                item.name
              }}”.
            </p>
            <img
              class="thumbnail"
              [src]="pending.url"
              [alt]="
                'Imagem enviada para ' + item.name + ', ainda não associada'
              "
            />
            <button
              type="button"
              class="button button--secondary"
              [disabled]="saving()"
              (click)="retryImageLink(kind, item.id)"
            >
              Tentar associar de novo</button
            ><button
              type="button"
              class="text-button"
              [disabled]="saving()"
              (click)="dropPendingImage(kind, item.id)"
            >
              Descartar
            </button>
          </div>
        }
        @if (item.imageId) {
          <button
            type="button"
            class="text-button"
            (click)="showImage(item.imageId)"
          >
            {{
              imageUrls()[item.imageId] ? "Atualizar miniatura" : "Ver imagem"
            }}</button
          ><button
            type="button"
            class="text-button"
            [disabled]="saving()"
            (click)="clearImage(kind, item.id)"
          >
            Remover imagem
          </button>
          @if (imageUrls()[item.imageId]) {
            <img
              class="thumbnail"
              [src]="imageUrls()[item.imageId]"
              [alt]="'Imagem de ' + item.name"
            />
          }
        }
      </div>
    </ng-template>
  `,
})
export class MenuPage implements OnDestroy {
  private readonly api = inject(CatalogApi);
  readonly sections = SECTIONS;
  protected readonly previewSizes = previewSizes;
  protected readonly previewFlavors = previewFlavors;
  protected readonly previewCrusts = previewCrusts;
  protected readonly catalog = signal<CatalogSnapshot | null>(null);
  protected readonly active = signal<Section>("categories");
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal("");
  protected readonly notice = signal("");
  protected readonly imageUrls = signal<Record<string, string>>({});
  protected readonly imageLoading = signal<string | null>(null);
  protected readonly pendingImages = signal<Record<string, PendingImage>>({});
  protected readonly fieldErrors = signal<Record<string, string>>({});
  protected readonly preview = signal<PreviewSelection>(EMPTY_PREVIEW);
  protected readonly previewEvaluation = computed(() => {
    const data = this.catalog();
    const { sizeId, mode, left, right, crustId } = this.preview();
    if (!data || !sizeId || !left) return null;
    const configuration: PizzaConfiguration = {
      sizeId,
      mode,
      flavors:
        mode === "HALVES" ? { LEFT: left, RIGHT: right } : { LEFT: left },
      crustId: crustId || null,
      extras: [],
      removals: [],
      quantity: 1,
    };
    return evaluatePizza(
      configuration,
      this.pricingCatalog(data),
      data.pricingPolicy ?? PREVIEW_POLICY,
    );
  });

  protected newCategory = { name: "", kind: "PIZZA" as "PIZZA" | "PRODUCT" };
  protected newSize = {
    name: "",
    slices: 8,
    maxFlavors: 2 as 1 | 2,
    sortOrder: 0,
  };
  protected newIngredient = { name: "", removable: true };
  protected newFlavor = {
    categoryId: "",
    name: "",
    description: "",
    ingredientIds: [] as string[],
  };
  protected newNamed: Record<"crusts" | "extras", string> = {
    crusts: "",
    extras: "",
  };
  protected newProduct = { categoryId: "", name: "", price: "" };
  /** Narrows the untyped `kind` of the shared add-on template. */
  protected kindKey(kind: string): "crusts" | "extras" {
    return kind === "crusts" ? "crusts" : "extras";
  }
  /** Item drafts by `kind:id`, kept across reloads while they hold unsaved changes. */
  private readonly drafts = new Map<string, Draft>();
  /** Price fields as typed, by price key, kept until their save is confirmed. */
  private readonly moneyDrafts = new Map<string, string>();
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
  }

  /** "Atualizar": reloads the catalog and keeps every unsaved change, saying so. */
  protected async refresh(): Promise<void> {
    this.notice.set("");
    await this.load();
    const pending = this.pendingChanges();
    if (pending && !this.error())
      this.notice.set(
        `Cardápio atualizado. ${pending === 1 ? "1 alteração não salva foi mantida" : `${pending} alterações não salvas foram mantidas`}; use “Descartar alterações” para voltar aos valores salvos.`,
      );
  }

  protected discardChanges(): void {
    if (
      !window.confirm(
        "Descartar todas as alterações não salvas e voltar aos valores salvos?",
      )
    )
      return;
    this.drafts.clear();
    this.moneyDrafts.clear();
    this.fieldErrors.set({});
    this.notice.set("Alterações descartadas.");
  }

  protected async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.loading.set(true);
    this.error.set("");
    try {
      const data = await this.api.snapshot();
      if (generation !== this.loadGeneration) return;
      this.rebaseDrafts(data);
      this.catalog.set(data);
      this.preview.update((selection) => reconcilePreview(selection, data));
    } catch (error) {
      if (generation === this.loadGeneration)
        this.error.set(errorMessage(error));
    } finally {
      if (generation === this.loadGeneration) this.loading.set(false);
    }
  }

  /** The editable copy of an item; created from the API's item on first use. */
  protected edit<T extends { id: string }>(kind: EditKind, item: T): T {
    const key = `${kind}:${item.id}`;
    let draft = this.drafts.get(key);
    if (!draft) {
      draft = { base: JSON.stringify(item), value: structuredClone(item) };
      this.drafts.set(key, draft);
    }
    return draft.value as T;
  }

  protected dirty(kind: EditKind, id: string): boolean {
    const draft = this.drafts.get(`${kind}:${id}`);
    return !!draft && JSON.stringify(draft.value) !== draft.base;
  }

  protected pizzaCategories(data: CatalogSnapshot) {
    return data.categories.filter(
      (item) => item.kind === "PIZZA" && !item.archived,
    );
  }
  protected productCategories(data: CatalogSnapshot) {
    return data.categories.filter(
      (item) => item.kind === "PRODUCT" && !item.archived,
    );
  }
  protected activeIngredients(data: CatalogSnapshot) {
    return data.ingredients.filter((item) => !item.archived);
  }
  protected activeSizes(data: CatalogSnapshot) {
    return data.sizes.filter((item) => !item.archived);
  }

  protected async createCategory(): Promise<void> {
    await this.mutate(async () => {
      await this.api.create("categories", this.newCategory);
      this.newCategory = { name: "", kind: "PIZZA" };
      this.notice.set("Categoria adicionada.");
    });
  }
  protected async saveCategory(
    draft: CatalogSnapshot["categories"][number],
  ): Promise<void> {
    await this.mutate(async () => {
      await this.api.update("categories", draft.id, {
        name: draft.name,
        sortOrder: Number(draft.sortOrder) || 0,
      });
      this.saved("categories", draft.id);
      this.notice.set("Categoria atualizada.");
    });
  }
  protected async createSize(): Promise<void> {
    await this.mutate(async () => {
      await this.api.create("sizes", {
        ...this.newSize,
        slices: Number(this.newSize.slices),
        sortOrder: Number(this.newSize.sortOrder) || 0,
      });
      this.newSize = { name: "", slices: 8, maxFlavors: 2, sortOrder: 0 };
      this.notice.set("Tamanho adicionado.");
    });
  }
  protected async saveSize(
    draft: CatalogSnapshot["sizes"][number],
  ): Promise<void> {
    await this.mutate(async () => {
      await this.api.update("sizes", draft.id, {
        name: draft.name,
        slices: Number(draft.slices),
        maxFlavors: Number(draft.maxFlavors),
        sortOrder: Number(draft.sortOrder) || 0,
        available: draft.available,
      });
      this.saved("sizes", draft.id);
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
  protected async saveIngredient(
    draft: CatalogSnapshot["ingredients"][number],
  ): Promise<void> {
    await this.mutate(async () => {
      await this.api.update("ingredients", draft.id, {
        name: draft.name,
        removable: draft.removable,
      });
      this.saved("ingredients", draft.id);
      this.notice.set("Ingrediente atualizado.");
    });
  }
  protected toggleNewIngredient(id: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.newFlavor.ingredientIds = checked
      ? [...new Set([...this.newFlavor.ingredientIds, id])]
      : this.newFlavor.ingredientIds.filter((item) => item !== id);
  }
  protected toggleFlavorIngredient(
    draft: CatalogSnapshot["flavors"][number],
    id: string,
    event: Event,
  ): void {
    const checked = (event.target as HTMLInputElement).checked;
    draft.ingredientIds = checked
      ? [...new Set([...draft.ingredientIds, id])]
      : draft.ingredientIds.filter((value) => value !== id);
  }
  protected async createFlavor(): Promise<void> {
    await this.mutate(async () => {
      await this.api.create("flavors", {
        ...this.newFlavor,
        description: this.newFlavor.description || null,
      });
      this.newFlavor = {
        categoryId: "",
        name: "",
        description: "",
        ingredientIds: [],
      };
      this.notice.set("Sabor adicionado. Agora defina os preços por tamanho.");
    });
  }
  protected async saveFlavor(
    draft: CatalogSnapshot["flavors"][number],
  ): Promise<void> {
    await this.mutate(async () => {
      await this.api.update("flavors", draft.id, {
        categoryId: draft.categoryId,
        name: draft.name,
        description: draft.description || null,
        ingredientIds: draft.ingredientIds,
        available: draft.available,
      });
      this.saved("flavors", draft.id);
      this.notice.set("Sabor atualizado.");
    });
  }
  protected async createNamed(kind: "crusts" | "extras"): Promise<void> {
    await this.mutate(async () => {
      await this.api.create(kind, { name: this.newNamed[kind] });
      this.newNamed[kind] = "";
      this.notice.set(
        kind === "crusts" ? "Borda adicionada." : "Adicional adicionado.",
      );
    });
  }
  protected async saveNamed(
    kind: "crusts" | "extras",
    draft: { id: string; name: string; available: boolean },
  ): Promise<void> {
    await this.mutate(async () => {
      await this.api.update(kind, draft.id, {
        name: draft.name,
        available: draft.available,
      });
      this.saved(kind, draft.id);
      this.notice.set(
        kind === "crusts" ? "Borda atualizada." : "Adicional atualizado.",
      );
    });
  }
  protected async createProduct(): Promise<void> {
    const price = this.validMoney(
      "new-product",
      this.newProduct.price,
      "product",
    );
    if (price === null) return;
    await this.mutate(async () => {
      await this.api.create("products", {
        categoryId: this.newProduct.categoryId,
        name: this.newProduct.name,
        priceCents: price,
      });
      this.newProduct = { categoryId: "", name: "", price: "" };
      this.notice.set("Produto adicionado.");
    });
  }
  protected async saveProduct(
    draft: CatalogSnapshot["simpleProducts"][number],
  ): Promise<void> {
    const key = this.priceKey("product", draft.id, "price");
    const price = this.validMoney(
      key,
      this.money(key, this.savedProduct(draft.id)?.priceCents),
      "product",
    );
    if (price === null) return;
    await this.mutate(async () => {
      await this.api.update("products", draft.id, {
        categoryId: draft.categoryId,
        name: draft.name,
        priceCents: price,
        available: draft.available,
      });
      this.saved("products", draft.id);
      this.moneySaved(key);
      this.notice.set("Produto atualizado.");
    });
  }

  protected async archive(
    kind: EditKind,
    id: string,
    name: string,
  ): Promise<void> {
    if (
      !window.confirm(
        `Arquivar “${name}”? O item deixará de aparecer para pedidos.`,
      )
    )
      return;
    await this.mutate(async () => {
      await this.api.archive(kind, id);
      this.saved(kind, id);
      this.notice.set("Item arquivado.");
    });
  }
  protected async setAvailability(
    kind: "flavors" | "crusts" | "extras" | "products",
    id: string,
    available: boolean,
  ): Promise<void> {
    await this.mutate(async () => {
      await this.api.availability(kind, id, available);
      // Keep other unsaved edits of the item, but follow the confirmed availability.
      const draft = this.drafts.get(`${kind}:${id}`);
      if (draft) {
        (draft.value as unknown as { available: boolean }).available =
          available;
        draft.base = JSON.stringify({
          ...(JSON.parse(draft.base) as object),
          available,
        });
      }
      this.notice.set(
        available
          ? "Item marcado como disponível."
          : "Item marcado como esgotado.",
      );
    });
  }

  protected priceKey(kind: string, ownerId: string, sizeId: string): string {
    return `${kind}:${ownerId}:${sizeId}`;
  }
  /** The price field's text: what was typed, or the saved price. */
  protected money(key: string, cents: number | undefined): string {
    return this.moneyDrafts.get(key) ?? moneyText(cents);
  }
  protected setMoney(key: string, event: Event): void {
    this.moneyDrafts.set(key, (event.target as HTMLInputElement).value);
    this.clearFieldError(key);
  }
  protected moneyDirty(key: string): boolean {
    return this.moneyDrafts.has(key);
  }
  protected fieldError(key: string): string | null {
    return this.fieldErrors()[key] ?? null;
  }
  protected flavorPrice(
    data: CatalogSnapshot,
    owner: string,
    size: string,
  ): number | undefined {
    return data.flavorPrices.find(
      (p) => p.flavorId === owner && p.sizeId === size,
    )?.priceCents;
  }
  protected crustPrice(
    data: CatalogSnapshot,
    owner: string,
    size: string,
  ): number | undefined {
    return data.crustPrices.find(
      (p) => p.crustId === owner && p.sizeId === size,
    )?.priceCents;
  }
  protected extraWholePrice(
    data: CatalogSnapshot,
    owner: string,
    size: string,
  ): number | undefined {
    return data.extraPrices.find(
      (p) => p.extraId === owner && p.sizeId === size,
    )?.wholePriceCents;
  }
  protected extraHalfPrice(
    data: CatalogSnapshot,
    owner: string,
    size: string,
  ): number | undefined {
    return data.extraPrices.find(
      (p) => p.extraId === owner && p.sizeId === size,
    )?.halfPriceCents;
  }
  protected hasFlavorPrice(
    data: CatalogSnapshot,
    owner: string,
    size: string,
  ): boolean {
    return this.flavorPrice(data, owner, size) !== undefined;
  }
  protected hasCrustPrice(
    data: CatalogSnapshot,
    owner: string,
    size: string,
  ): boolean {
    return this.crustPrice(data, owner, size) !== undefined;
  }
  protected hasExtraPrice(
    data: CatalogSnapshot,
    owner: string,
    size: string,
  ): boolean {
    return this.extraWholePrice(data, owner, size) !== undefined;
  }

  protected async savePrice(
    kind: PriceKind,
    owner: string,
    size: string,
  ): Promise<void> {
    const data = this.catalog();
    if (!data) return;
    if (kind === "extra") {
      const wholeKey = this.priceKey("extra-whole", owner, size);
      const halfKey = this.priceKey("extra-half", owner, size);
      const whole = this.validMoney(
        wholeKey,
        this.money(wholeKey, this.extraWholePrice(data, owner, size)),
        "extra",
      );
      const half = this.validMoney(
        halfKey,
        this.money(halfKey, this.extraHalfPrice(data, owner, size)),
        "extra",
      );
      if (whole === null || half === null) return;
      await this.mutate(async () => {
        await this.api.setExtraPrice(owner, size, whole, half);
        this.moneySaved(wholeKey, halfKey);
        this.notice.set("Preço atualizado.");
      });
      return;
    }
    const key = this.priceKey(kind, owner, size);
    const saved =
      kind === "flavor"
        ? this.flavorPrice(data, owner, size)
        : this.crustPrice(data, owner, size);
    const cents = this.validMoney(key, this.money(key, saved), kind);
    if (cents === null) return;
    await this.mutate(async () => {
      if (kind === "flavor") await this.api.setFlavorPrice(owner, size, cents);
      else await this.api.setCrustPrice(owner, size, cents);
      this.moneySaved(key);
      this.notice.set("Preço atualizado.");
    });
  }
  protected async removePrice(
    kind: PriceKind,
    owner: string,
    size: string,
  ): Promise<void> {
    await this.mutate(async () => {
      if (kind === "flavor") await this.api.removeFlavorPrice(owner, size);
      else if (kind === "crust") await this.api.removeCrustPrice(owner, size);
      else await this.api.removeExtraPrice(owner, size);
      if (kind === "extra")
        this.moneySaved(
          this.priceKey("extra-whole", owner, size),
          this.priceKey("extra-half", owner, size),
        );
      else this.moneySaved(this.priceKey(kind, owner, size));
      this.notice.set("Preço removido.");
    });
  }

  protected pendingImage(kind: ImageKind, itemId: string): PendingImage | null {
    return this.pendingImages()[`${kind}:${itemId}`] ?? null;
  }

  /**
   * Uploads, then links the stored image to the item. Success is announced only after both. When
   * the link fails, the stored image is kept as pending for that item: "Tentar associar de novo"
   * retries only the link, with the same image, so a retry never uploads another copy.
   */
  protected async uploadImage(
    kind: ImageKind,
    itemId: string,
    event: Event,
  ): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    ) {
      this.notice.set("");
      this.error.set("Escolha uma imagem PNG, JPEG ou WebP de até 5 MiB.");
      return;
    }
    await this.mutate(async () => {
      const image = await this.api.uploadImage(file);
      const url = URL.createObjectURL(file);
      this.objectUrls.add(url);
      await this.linkImage(kind, itemId, { imageId: image.id, url });
    });
  }

  protected async retryImageLink(
    kind: ImageKind,
    itemId: string,
  ): Promise<void> {
    const pending = this.pendingImage(kind, itemId);
    if (!pending) return;
    await this.mutate(() => this.linkImage(kind, itemId, pending));
  }

  protected dropPendingImage(kind: ImageKind, itemId: string): void {
    this.pendingImages.update((pending) =>
      without(pending, `${kind}:${itemId}`),
    );
    this.error.set("");
    this.notice.set(
      "Envio descartado. A imagem enviada fica guardada sem uso; o item continua como estava.",
    );
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

  protected choosePreview(change: Partial<PreviewSelection>): void {
    const data = this.catalog();
    if (!data) return;
    this.preview.update((selection) =>
      reconcilePreview({ ...selection, ...change }, data),
    );
  }
  protected previewAllowsHalves(
    data: CatalogSnapshot,
    sizeId: string,
  ): boolean {
    return data.sizes.find((size) => size.id === sizeId)?.maxFlavors === 2;
  }
  protected previewError(code: string): string {
    const messages: Record<string, string> = {
      PIZZA_SIZE_UNAVAILABLE: "Escolha um tamanho disponível.",
      PIZZA_HALVES_NOT_ALLOWED: "Este tamanho não aceita pizza meio a meio.",
      PIZZA_FLAVOR_UNAVAILABLE:
        "Escolha sabores disponíveis com preço neste tamanho.",
      PIZZA_CRUST_UNAVAILABLE:
        "A borda escolhida não tem preço para este tamanho.",
      PIZZA_EXTRA_UNAVAILABLE:
        "Um adicional não está disponível para este tamanho.",
    };
    return messages[code] ?? "Não foi possível calcular com esta combinação.";
  }

  private async linkImage(
    kind: ImageKind,
    itemId: string,
    image: PendingImage,
  ): Promise<void> {
    const key = `${kind}:${itemId}`;
    try {
      await this.api.update(kind, itemId, { imageId: image.imageId });
    } catch (error) {
      this.pendingImages.update((pending) => ({ ...pending, [key]: image }));
      throw new ImageLinkError(error);
    }
    this.pendingImages.update((pending) => without(pending, key));
    this.imageUrls.update((urls) => ({ ...urls, [image.imageId]: image.url }));
    this.notice.set("Imagem enviada e associada ao item.");
  }

  /** Validates a price field; shows the problem next to it and returns null when invalid. */
  private validMoney(
    key: string,
    text: string,
    kind: MoneyKind,
  ): number | null {
    const money = parseMoney(text, kind);
    if (money.ok) {
      this.clearFieldError(key);
      return money.cents;
    }
    this.fieldErrors.update((errors) => ({ ...errors, [key]: money.message }));
    this.notice.set("");
    this.error.set("Corrija os valores destacados antes de salvar.");
    return null;
  }
  private clearFieldError(key: string): void {
    if (!(key in this.fieldErrors())) return;
    this.fieldErrors.update((errors) => without(errors, key));
  }

  /** The API confirmed a save of this item: its draft follows the next snapshot again. */
  private saved(kind: EditKind, id: string): void {
    this.drafts.delete(`${kind}:${id}`);
  }
  private moneySaved(...keys: string[]): void {
    for (const key of keys) {
      this.moneyDrafts.delete(key);
      this.clearFieldError(key);
    }
  }
  private savedProduct(id: string) {
    return this.catalog()?.simpleProducts.find((item) => item.id === id);
  }

  /**
   * After a reload: drafts without changes follow the new snapshot, drafts with changes stay as
   * typed, and drafts of items that no longer exist go away.
   */
  private rebaseDrafts(data: CatalogSnapshot): void {
    const ids: Record<EditKind, { id: string }[]> = {
      categories: data.categories,
      sizes: data.sizes,
      ingredients: data.ingredients,
      flavors: data.flavors,
      crusts: data.crusts,
      extras: data.extras,
      products: data.simpleProducts,
    };
    const existing = new Set(
      Object.entries(ids).flatMap(([kind, items]) =>
        items.map((item) => `${kind}:${item.id}`),
      ),
    );
    for (const [key, draft] of this.drafts)
      if (!existing.has(key) || JSON.stringify(draft.value) === draft.base)
        this.drafts.delete(key);
  }
  /**
   * Unsaved changes on the page. A method rather than a computed signal: drafts are plain objects
   * that the form fields change in place, so it is read again on every change detection.
   */
  protected pendingChanges(): number {
    let count = this.moneyDrafts.size;
    for (const draft of this.drafts.values())
      if (JSON.stringify(draft.value) !== draft.base) count++;
    return count;
  }

  private pricingCatalog(data: CatalogSnapshot): PizzaCatalog {
    return {
      categories: data.categories.map(({ id, kind, archived }) => ({
        id,
        kind,
        archived,
      })),
      sizes: data.sizes.map(
        ({ id, name, slices, maxFlavors, available, archived }) => ({
          id,
          name,
          slices,
          maxFlavors,
          available,
          archived,
        }),
      ),
      ingredients: data.ingredients.map(
        ({ id, name, removable, archived }) => ({
          id,
          name,
          removable,
          archived,
        }),
      ),
      flavors: data.flavors.map(
        ({ id, categoryId, name, ingredientIds, available, archived }) => ({
          id,
          categoryId,
          name,
          ingredientIds,
          available,
          archived,
        }),
      ),
      flavorPrices: data.flavorPrices,
      crusts: data.crusts.map(({ id, name, available, archived }) => ({
        id,
        name,
        available,
        archived,
      })),
      crustPrices: data.crustPrices,
      extras: data.extras.map(({ id, name, available, archived }) => ({
        id,
        name,
        available,
        archived,
      })),
      extraPrices: data.extraPrices,
    };
  }

  /**
   * Runs one write at a time: a second submit while one is in flight is ignored, so Enter pressed
   * twice never sends a duplicate request. A failed link of an uploaded image keeps the API's
   * own message and says the upload itself worked.
   */
  private async mutate(
    action: () => Promise<void>,
    reload = true,
  ): Promise<void> {
    if (this.saving()) return;
    this.error.set("");
    this.notice.set("");
    this.saving.set(true);
    try {
      await action();
      if (reload) await this.load();
    } catch (error) {
      this.notice.set("");
      this.error.set(
        error instanceof ImageLinkError
          ? `A imagem foi enviada, mas não foi associada ao item: ${errorMessage(error.original)} Use “Tentar associar de novo”.`
          : errorMessage(error),
      );
    } finally {
      this.saving.set(false);
    }
  }
}
