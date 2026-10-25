import { Component, DestroyRef, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { apiErrorCode, apiFieldErrors, errorMessage } from "../core/api";
import { Session } from "../core/session";
import { CatalogApi } from "../catalog/catalog-api";
import {
  BRAND_TOKEN_LABELS,
  brandErrorMessage,
  contrastChecks,
  normalizeHex,
  ratioText,
} from "./brand-model";
import {
  BRAND_COLOR_TOKENS,
  type BrandColorToken,
  type BrandColors,
  type BrandState,
  StoreApi,
} from "./store-api";

type ImageSlot = "logo" | "icon";

/**
 * Brand editor for the OWNER (M3.5): brand colors with a live contrast check, logo and icon, and a
 * preview of the customer app. The contrast rules come from the API, which checks them again and
 * never publishes a theme that fails them; accessibility tokens are not editable here or there.
 */
@Component({
  selector: "wo-brand-page",
  imports: [FormsModule],
  styleUrl: "./brand.page.css",
  template: `
    <section aria-labelledby="brand-title">
      <h1 id="brand-title" tabindex="-1" data-page-title>Marca</h1>
      <p class="muted">
        Cores, logotipo e ícone do aplicativo da loja. Foco, erros e fundos
        seguem o padrão WhiteOven para manter o app legível.
      </p>

      @if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p class="brand-notice" role="status">{{ notice() }}</p>
      }
      @if (loading()) {
        <p role="status">Carregando marca…</p>
      }

      @if (state(); as current) {
        <div class="brand-layout">
          <form
            class="brand-form"
            (submit)="$event.preventDefault(); publish()"
          >
            @if (!current.saved) {
              <p class="status--warning">
                A loja ainda usa as cores padrão do WhiteOven.
              </p>
            }

            <fieldset>
              <legend>Cores</legend>
              @for (token of tokens; track token) {
                <div class="brand-color">
                  <label [for]="'brand-' + token">{{ labels[token] }}</label>
                  <div class="brand-color-inputs">
                    <input
                      type="color"
                      [id]="'brand-' + token + '-picker'"
                      [attr.aria-label]="labels[token] + ' (seletor)'"
                      [ngModel]="colors()[token]"
                      (ngModelChange)="setColor(token, $event)"
                      [name]="token + '-picker'"
                    />
                    <input
                      [id]="'brand-' + token"
                      [name]="token"
                      autocomplete="off"
                      spellcheck="false"
                      maxlength="7"
                      [ngModel]="texts()[token]"
                      (ngModelChange)="setText(token, $event)"
                      [attr.aria-invalid]="fieldErrors()[token] ? true : null"
                      [attr.aria-describedby]="
                        fieldErrors()[token]
                          ? 'brand-' + token + '-error'
                          : null
                      "
                    />
                    <button
                      type="button"
                      class="button button--secondary"
                      [disabled]="colors()[token] === current.defaults[token]"
                      (click)="setColor(token, current.defaults[token])"
                    >
                      Usar padrão
                    </button>
                  </div>
                  @if (fieldErrors()[token]; as message) {
                    <p class="field-error" [id]="'brand-' + token + '-error'">
                      {{ message }}
                    </p>
                  }
                </div>
              }
            </fieldset>

            <section aria-labelledby="contrast-title" class="brand-contrast">
              <h2 id="contrast-title">Contraste</h2>
              <p class="muted">
                Cada par precisa de ao menos 4,5:1 para ser lido por todos.
              </p>
              <ul>
                @for (check of checks(); track check.path) {
                  <li
                    [class.contrast--fail]="!check.ok"
                    [attr.data-pair]="check.path"
                  >
                    <span
                      class="contrast-swatch"
                      aria-hidden="true"
                      [style.background]="colorOf(check.background)"
                      [style.color]="colorOf(check.foreground)"
                      >Aa</span
                    >
                    <span class="contrast-usage">{{ check.usage }}</span>
                    <strong>
                      {{ ratioText(check.ratio) }}
                      {{ check.ok ? "· atende" : "· insuficiente" }}
                    </strong>
                    @if (!check.ok) {
                      <span class="contrast-minimum">
                        mínimo {{ ratioText(check.minimum) }}
                      </span>
                    }
                  </li>
                }
              </ul>
            </section>

            <fieldset>
              <legend>Imagens</legend>
              @for (slot of slots; track slot.id) {
                <div class="brand-image">
                  <label [for]="'brand-' + slot.id + '-file'">{{
                    slot.label
                  }}</label>
                  <p class="muted" [id]="'brand-' + slot.id + '-hint'">
                    {{ slot.hint(current) }} PNG, JPEG ou WebP até 5 MB.
                  </p>
                  @if (previews()[slot.id]; as url) {
                    <img
                      class="brand-image-preview"
                      [class.brand-image-preview--icon]="slot.id === 'icon'"
                      [src]="url"
                      [alt]="slot.label + ' atual'"
                    />
                  }
                  <div class="brand-image-actions">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      [id]="'brand-' + slot.id + '-file'"
                      [attr.aria-describedby]="
                        'brand-' +
                        slot.id +
                        '-hint' +
                        (fieldErrors()[slot.id]
                          ? ' brand-' + slot.id + '-error'
                          : '')
                      "
                      [disabled]="uploading() === slot.id"
                      (change)="upload(slot.id, $event)"
                    />
                    @if (images()[slot.id]) {
                      <button
                        type="button"
                        class="button button--secondary"
                        (click)="removeImage(slot.id)"
                      >
                        Remover {{ slot.short }}
                      </button>
                    }
                  </div>
                  @if (uploading() === slot.id) {
                    <p role="status">Enviando imagem…</p>
                  }
                  @if (fieldErrors()[slot.id]; as message) {
                    <p class="field-error" [id]="'brand-' + slot.id + '-error'">
                      {{ message }}
                    </p>
                  }
                </div>
              }
            </fieldset>

            @if (blocked(); as reason) {
              <p class="status--warning" id="publish-blocked">{{ reason }}</p>
            }
            <button
              type="submit"
              class="button"
              [disabled]="saving() || uploading() !== null || blocked() !== ''"
              [attr.aria-describedby]="blocked() ? 'publish-blocked' : null"
            >
              Publicar marca
            </button>
            @if (current.saved) {
              <p class="muted">
                Versão publicada: {{ current.theme.version }}.
              </p>
            }
          </form>

          <aside
            class="brand-preview"
            aria-labelledby="preview-title"
            [style.--brand-primary]="colors().primary"
            [style.--brand-primary-hover]="colors().primaryHover"
            [style.--brand-primary-pressed]="colors().primaryPressed"
            [style.--brand-on-primary]="colors().onPrimary"
            [style.--brand-accent]="colors().accentText"
            [style.--brand-cream]="current.fixedColors.cream"
          >
            <h2 id="preview-title">Prévia do app</h2>
            <div
              class="phone"
              role="img"
              [attr.aria-label]="
                'Prévia do app de ' + storeName() + ' com as cores escolhidas'
              "
            >
              <div class="phone-header">
                @if (previews().logo; as url) {
                  <img class="phone-logo" [src]="url" alt="" />
                } @else {
                  <strong>{{ storeName() }}</strong>
                }
              </div>
              <div class="phone-card">
                <span class="phone-tag">Mais pedida</span>
                <strong>Pizza Margherita</strong>
                <span class="phone-price">R$ 54,90</span>
                <span class="phone-button">Adicionar ao carrinho</span>
                <div class="phone-states">
                  <span class="phone-button phone-button--hover">Cursor</span>
                  <span class="phone-button phone-button--pressed"
                    >Pressionado</span
                  >
                </div>
              </div>
              <div class="phone-cream">
                <span class="phone-price">Entrega grátis acima de R$ 80</span>
              </div>
            </div>
            <div class="app-icon-preview">
              <div class="app-icon">
                @if (previews().icon; as url) {
                  <img [src]="url" alt="" />
                } @else {
                  <span>{{ storeName().charAt(0) }}</span>
                }
              </div>
              <span>{{ storeName() }}</span>
            </div>
          </aside>
        </div>
      }
    </section>
  `,
})
export class BrandPage {
  private readonly store = inject(StoreApi);
  private readonly catalog = inject(CatalogApi);
  private readonly session = inject(Session);
  protected readonly tokens = BRAND_COLOR_TOKENS;
  protected readonly labels = BRAND_TOKEN_LABELS;
  protected readonly ratioText = ratioText;
  protected readonly slots = [
    {
      id: "logo" as const,
      label: "Logotipo",
      short: "logotipo",
      hint: (state: BrandState) =>
        `Aparece no topo do app. Ao menos ${state.imageRules.logoMinSide} px no lado maior.`,
    },
    {
      id: "icon" as const,
      label: "Ícone",
      short: "ícone",
      hint: (state: BrandState) =>
        `Imagem quadrada, ao menos ${state.imageRules.iconMinSide} × ${state.imageRules.iconMinSide} px.`,
    },
  ];

  protected readonly state = signal<BrandState | null>(null);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly uploading = signal<ImageSlot | null>(null);
  protected readonly error = signal("");
  protected readonly notice = signal("");
  protected readonly fieldErrors = signal<Record<string, string>>({});
  /** The colors as the preview uses them: the last valid value of each field. */
  protected readonly colors = signal<BrandColors>({} as BrandColors);
  /** What each text field shows, valid or not. */
  protected readonly texts = signal<Record<BrandColorToken, string>>(
    {} as Record<BrandColorToken, string>,
  );
  protected readonly images = signal<Record<ImageSlot, string | null>>({
    logo: null,
    icon: null,
  });
  protected readonly previews = signal<Record<ImageSlot, string | null>>({
    logo: null,
    icon: null,
  });
  private readonly objectUrls = new Set<string>();

  protected readonly storeName = computed(
    () => this.session.store()?.displayName ?? "Sua pizzaria",
  );
  protected readonly checks = computed(() => {
    const state = this.state();
    return state
      ? contrastChecks(this.colors(), state.fixedColors, state.contrastRules)
      : [];
  });
  /** Why publishing is off, or "" when it is allowed. */
  protected readonly blocked = computed(() => {
    const texts = this.texts();
    if (this.tokens.some((token) => normalizeHex(texts[token] ?? "") === null))
      return "Corrija as cores no formato #RRGGBB antes de publicar.";
    if (this.checks().some((check) => !check.ok))
      return "Ajuste as cores até todos os pares de contraste atenderem ao mínimo.";
    return "";
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      for (const url of this.objectUrls) URL.revokeObjectURL(url);
      this.objectUrls.clear();
    });
    void this.load();
  }

  protected colorOf(token: string): string {
    const state = this.state()!;
    return (
      (this.colors() as Record<string, string>)[token] ??
      (state.fixedColors as Record<string, string>)[token]!
    );
  }

  protected setColor(token: BrandColorToken, value: string): void {
    const hex = normalizeHex(value);
    if (!hex) return;
    this.colors.update((colors) => ({ ...colors, [token]: hex }));
    this.texts.update((texts) => ({ ...texts, [token]: hex }));
    this.clearField(token);
  }

  protected setText(token: BrandColorToken, value: string): void {
    this.texts.update((texts) => ({ ...texts, [token]: value }));
    const hex = normalizeHex(value);
    if (hex) {
      this.colors.update((colors) => ({ ...colors, [token]: hex }));
      this.clearField(token);
    } else
      this.fieldErrors.update((errors) => ({
        ...errors,
        [token]: "Use uma cor no formato #RRGGBB.",
      }));
  }

  protected async upload(slot: ImageSlot, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || this.uploading()) return;
    this.uploading.set(slot);
    this.error.set("");
    this.notice.set("");
    this.clearField(slot);
    try {
      const image = await this.catalog.uploadImage(file);
      this.images.update((images) => ({ ...images, [slot]: image.id }));
      this.showPreview(slot, URL.createObjectURL(file));
      this.notice.set("Imagem enviada. Publique a marca para usá-la no app.");
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.uploading.set(null);
    }
  }

  protected removeImage(slot: ImageSlot): void {
    this.images.update((images) => ({ ...images, [slot]: null }));
    this.showPreview(slot, null);
    this.clearField(slot);
  }

  protected async publish(): Promise<void> {
    const state = this.state();
    if (!state || this.saving() || this.blocked()) return;
    const colors = this.colors();
    const colorOverrides: Partial<BrandColors> = {};
    for (const token of this.tokens)
      if (colors[token] !== state.defaults[token])
        colorOverrides[token] = colors[token];
    this.saving.set(true);
    this.error.set("");
    this.notice.set("");
    this.fieldErrors.set({});
    try {
      const saved = await this.store.updateBrand({
        colorOverrides,
        logoAssetId: this.images().logo,
        iconAssetId: this.images().icon,
      });
      this.state.set(saved);
      this.notice.set(`Marca publicada (versão ${saved.theme.version}).`);
    } catch (error) {
      const fields: Record<string, string> = {};
      for (const { code, path } of apiFieldErrors(error)) {
        const field = path.startsWith("colorOverrides.")
          ? path.slice("colorOverrides.".length)
          : path === "logoAssetId"
            ? "logo"
            : path === "iconAssetId"
              ? "icon"
              : null;
        if (field) fields[field] ??= brandErrorMessage(code, state.imageRules);
      }
      this.fieldErrors.set(fields);
      this.error.set(
        apiErrorCode(error) === "BRAND_THEME_INVALID"
          ? "A marca não foi publicada. Corrija os pontos indicados."
          : errorMessage(error),
      );
    } finally {
      this.saving.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      const state = await this.store.brand();
      this.state.set(state);
      this.colors.set({ ...state.colors });
      this.texts.set({ ...state.colors });
      this.images.set({
        logo: state.theme.logoAssetId,
        icon: state.theme.iconAssetId,
      });
      for (const slot of ["logo", "icon"] as const) {
        const id =
          slot === "logo" ? state.theme.logoAssetId : state.theme.iconAssetId;
        if (id) void this.loadPreview(slot, id);
      }
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadPreview(slot: ImageSlot, id: string): Promise<void> {
    try {
      const blob = await this.catalog.readImage(id, "menu");
      // A newer upload or removal wins over the saved image.
      if (this.images()[slot] === id)
        this.showPreview(slot, URL.createObjectURL(blob));
    } catch {
      // The editor still works without the preview; publishing keeps the saved id.
    }
  }

  private showPreview(slot: ImageSlot, url: string | null): void {
    const previous = this.previews()[slot];
    if (previous) {
      URL.revokeObjectURL(previous);
      this.objectUrls.delete(previous);
    }
    if (url) this.objectUrls.add(url);
    this.previews.update((previews) => ({ ...previews, [slot]: url }));
  }

  private clearField(field: string): void {
    this.fieldErrors.update((errors) => {
      if (!(field in errors)) return errors;
      const rest = { ...errors };
      delete rest[field];
      return rest;
    });
  }
}
