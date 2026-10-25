import { CurrencyPipe } from "@angular/common";
import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import type { PricingPolicy } from "@whiteoven/contracts";
import { apiErrorCode, apiFieldErrors, errorMessage } from "../core/api";
import { CatalogApi, type CatalogSnapshot } from "../catalog/catalog-api";
import { moneyText, parseMoney } from "../catalog/menu-model";
import {
  WEEKDAYS,
  WEEK_ORDER,
  crossesMidnight,
  hoursErrorsByEntry,
  policyExamples,
} from "./settings-model";
import {
  type ClosureException,
  type FulfillmentMode,
  type OpeningRule,
  type PaymentMethod,
  StoreApi,
  type StoreSettings,
  type StoreState,
  type TimeRange,
} from "./store-api";

type Section = "policy" | "hours" | "orders";

/** Before the owner saves a policy: the recommended default (Q-06), as the menu preview uses. */
const DEFAULT_POLICY: PricingPolicy = {
  halfAndHalfStrategy: "HIGHEST",
  halfAndHalfSurchargeCents: 0,
  maxExtrasPerHalf: 4,
};

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  CASH: "Dinheiro na entrega",
  CARD_ON_DELIVERY: "Cartão na entrega",
  PIX_ON_DELIVERY: "Pix na entrega",
};
const MODE_LABELS: Record<FulfillmentMode, string> = {
  DELIVERY: "Entrega",
  PICKUP: "Retirada no balcão",
};

const SETTINGS_MESSAGES: Record<string, string> = {
  fulfillmentModes: "Escolha ao menos uma forma de atendimento.",
  acceptedPaymentMethods: "Escolha ao menos uma forma de pagamento.",
  estimatedPrepMinutes: "Use de 1 a 240 minutos.",
  estimatedDeliveryMinutes: "Use de 1 a 240 minutos.",
  acceptTimeoutMinutes: "Use de 1 a 60 minutos.",
  contactPhone: "Use só números, espaços, parênteses, + e -.",
  pickupAddress: "Informe o endereço de retirada (até 300 caracteres).",
  deliveryAreaDescription: "Use até 500 caracteres.",
  deliveryFeeCents: "Confira o valor.",
  minimumOrderCents: "Confira o valor.",
};

interface SettingsForm {
  fulfillmentModes: FulfillmentMode[];
  fee: string;
  minimum: string;
  area: string;
  prep: number;
  delivery: number;
  timeout: number;
  payments: PaymentMethod[];
  phone: string;
  pickup: string;
}

/**
 * Store settings for the OWNER (M3.4): pricing policy with a live price preview, weekly hours with
 * date exceptions, and order, delivery and payment settings. Each section saves on its own and
 * keeps what the other sections have unsaved. The API validates everything again; hour overlaps
 * across midnight are decided there and shown next to the offending row.
 */
@Component({
  selector: "wo-settings-page",
  imports: [FormsModule, CurrencyPipe],
  styleUrl: "./settings.page.css",
  template: `
    <section aria-labelledby="settings-title">
      <h1 id="settings-title" tabindex="-1" data-page-title>Configurações</h1>
      <p class="muted">
        Política de preço, horários e como a loja recebe pedidos.
        @if (state(); as current) {
          Horários no fuso {{ current.timezone }}.
        }
      </p>

      @if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p class="settings-notice" role="status">{{ notice() }}</p>
      }
      @if (loading()) {
        <p role="status">Carregando configurações…</p>
      }

      <nav class="settings-tabs" role="tablist" aria-label="Seções">
        @for (section of sections; track section.id) {
          <button
            type="button"
            role="tab"
            [id]="'settings-tab-' + section.id"
            [attr.aria-selected]="active() === section.id"
            [attr.aria-controls]="'settings-panel'"
            (click)="active.set(section.id)"
          >
            {{ section.label }}
          </button>
        }
      </nav>

      @if (state()) {
        <div
          id="settings-panel"
          class="settings-panel"
          role="tabpanel"
          [attr.aria-labelledby]="'settings-tab-' + active()"
        >
          @switch (active()) {
            @case ("policy") {
              <h2>Política de preço</h2>
              @if (!policySaved()) {
                <p class="status--warning">
                  Nenhuma política salva ainda. Os valores abaixo são a
                  recomendação inicial (maior preço, sem sobretaxa).
                </p>
              }
              <form class="settings-form" (ngSubmit)="savePolicy()">
                <fieldset>
                  <legend>Pizza meio a meio cobra</legend>
                  <label class="check"
                    ><input
                      type="radio"
                      name="strategy"
                      value="HIGHEST"
                      [(ngModel)]="policy.halfAndHalfStrategy"
                    />
                    O preço do sabor mais caro</label
                  >
                  <label class="check"
                    ><input
                      type="radio"
                      name="strategy"
                      value="AVERAGE"
                      [(ngModel)]="policy.halfAndHalfStrategy"
                    />
                    A média dos dois sabores</label
                  >
                </fieldset>
                <label for="policy-surcharge"
                  >Sobretaxa do meio a meio (R$)</label
                >
                <input
                  id="policy-surcharge"
                  name="surcharge"
                  inputmode="decimal"
                  autocomplete="off"
                  [(ngModel)]="policy.surcharge"
                  [attr.aria-invalid]="!!fieldErrors()['surcharge']"
                  [attr.aria-describedby]="
                    fieldErrors()['surcharge'] ? 'policy-surcharge-error' : null
                  "
                />
                @if (fieldErrors()["surcharge"]; as message) {
                  <p class="field-error" id="policy-surcharge-error">
                    {{ message }}
                  </p>
                }
                <label for="policy-extras"
                  >Adicionais por metade (máximo)</label
                >
                <input
                  id="policy-extras"
                  name="maxExtras"
                  type="number"
                  min="0"
                  max="10"
                  [(ngModel)]="policy.maxExtrasPerHalf"
                  [attr.aria-invalid]="!!fieldErrors()['maxExtras']"
                />
                @if (fieldErrors()["maxExtras"]; as message) {
                  <p class="field-error">{{ message }}</p>
                }
                <button class="button" [disabled]="saving()">
                  Salvar política
                </button>
              </form>

              <h3>Prévia com esta política</h3>
              @if (!catalog()) {
                <p class="muted">
                  Não foi possível carregar o cardápio para a prévia.
                </p>
              } @else if (examples(); as list) {
                <ul class="examples" aria-live="polite">
                  @for (example of list; track example.label) {
                    <li>
                      <span
                        >{{ example.label }}
                        <small class="muted">{{
                          example.description
                        }}</small></span
                      >
                      <strong>{{
                        example.unitPriceCents === null
                          ? "—"
                          : (example.unitPriceCents / 100 | currency: "BRL")
                      }}</strong>
                    </li>
                  }
                </ul>
                <p class="muted">
                  Calculado pelo mesmo motor de preço do pedido, ainda sem
                  salvar.
                </p>
              } @else {
                <p class="muted">
                  Para ver exemplos, cadastre um tamanho de dois sabores e
                  preços para ao menos dois sabores nele.
                </p>
              }
            }

            @case ("hours") {
              <h2>Horários</h2>
              <p class="muted">
                Um turno que fecha antes de abrir termina no dia seguinte (ex.:
                18:00–02:00). Ele conta para o dia em que começa.
              </p>
              <form (ngSubmit)="saveHours()">
                @for (weekday of weekOrder; track weekday) {
                  <fieldset class="day">
                    <legend>{{ weekdays[weekday] }}</legend>
                    @for (row of rulesOf(weekday); track row.index) {
                      <div class="shift">
                        <label [for]="'rule-' + row.index + '-opens'"
                          >Abre</label
                        >
                        <input
                          type="time"
                          required
                          [id]="'rule-' + row.index + '-opens'"
                          [name]="'rule-' + row.index + '-opens'"
                          [(ngModel)]="row.rule.opensAt"
                          [attr.aria-invalid]="!!hoursErrors()[row.key]"
                          [attr.aria-describedby]="
                            hoursErrors()[row.key] ? row.key + '-error' : null
                          "
                        />
                        <label [for]="'rule-' + row.index + '-closes'"
                          >Fecha</label
                        >
                        <input
                          type="time"
                          required
                          [id]="'rule-' + row.index + '-closes'"
                          [name]="'rule-' + row.index + '-closes'"
                          [(ngModel)]="row.rule.closesAt"
                          [attr.aria-invalid]="!!hoursErrors()[row.key]"
                          [attr.aria-describedby]="
                            hoursErrors()[row.key] ? row.key + '-error' : null
                          "
                        />
                        @if (crossesMidnight(row.rule)) {
                          <span class="muted">fecha no dia seguinte</span>
                        }
                        <button
                          type="button"
                          class="button--link"
                          [attr.aria-label]="
                            'Remover turno de ' + weekdays[weekday]
                          "
                          (click)="removeRule(row.index)"
                        >
                          Remover
                        </button>
                        @if (hoursErrors()[row.key]; as message) {
                          <p class="field-error" [id]="row.key + '-error'">
                            {{ message }}
                          </p>
                        }
                      </div>
                    } @empty {
                      <p class="muted">Fechado</p>
                    }
                    <button
                      type="button"
                      class="button--link"
                      (click)="addRule(weekday)"
                    >
                      Adicionar turno
                    </button>
                  </fieldset>
                }

                <h3>Exceções por data</h3>
                @for (
                  exception of hours.exceptions;
                  track exception.date;
                  let i = $index
                ) {
                  <div class="exception">
                    <strong>{{ dateLabel(exception.date) }}</strong>
                    <span>{{
                      exception.closed
                        ? "Fechado"
                        : rangesLabel(exception.shifts)
                    }}</span>
                    <button
                      type="button"
                      class="button--link"
                      [attr.aria-label]="
                        'Remover exceção de ' + dateLabel(exception.date)
                      "
                      (click)="removeException(i)"
                    >
                      Remover
                    </button>
                    @for (key of exceptionErrorKeys(i); track key) {
                      <p class="field-error">{{ hoursErrors()[key] }}</p>
                    }
                  </div>
                } @empty {
                  <p class="muted">Nenhuma exceção cadastrada.</p>
                }

                <fieldset class="day">
                  <legend>Nova exceção</legend>
                  <label for="exception-date">Data</label>
                  <input
                    id="exception-date"
                    name="exceptionDate"
                    type="date"
                    [(ngModel)]="newException.date"
                  />
                  <label class="check"
                    ><input
                      type="radio"
                      name="exceptionClosed"
                      [value]="true"
                      [(ngModel)]="newException.closed"
                    />
                    Fechado o dia todo</label
                  >
                  <label class="check"
                    ><input
                      type="radio"
                      name="exceptionClosed"
                      [value]="false"
                      [(ngModel)]="newException.closed"
                    />
                    Horário especial</label
                  >
                  @if (!newException.closed) {
                    @for (
                      shift of newException.shifts;
                      track $index;
                      let s = $index
                    ) {
                      <div class="shift">
                        <label [for]="'exception-shift-' + s + '-opens'"
                          >Abre</label
                        >
                        <input
                          type="time"
                          [id]="'exception-shift-' + s + '-opens'"
                          [name]="'exception-shift-' + s + '-opens'"
                          [(ngModel)]="shift.opensAt"
                        />
                        <label [for]="'exception-shift-' + s + '-closes'"
                          >Fecha</label
                        >
                        <input
                          type="time"
                          [id]="'exception-shift-' + s + '-closes'"
                          [name]="'exception-shift-' + s + '-closes'"
                          [(ngModel)]="shift.closesAt"
                        />
                        @if (crossesMidnight(shift)) {
                          <span class="muted">fecha no dia seguinte</span>
                        }
                        @if (newException.shifts.length > 1) {
                          <button
                            type="button"
                            class="button--link"
                            (click)="newException.shifts.splice(s, 1)"
                          >
                            Remover
                          </button>
                        }
                      </div>
                    }
                    <button
                      type="button"
                      class="button--link"
                      (click)="
                        newException.shifts.push({
                          opensAt: '18:00',
                          closesAt: '23:00',
                        })
                      "
                    >
                      Adicionar turno
                    </button>
                  }
                  @if (fieldErrors()["exception"]; as message) {
                    <p class="field-error" role="alert">{{ message }}</p>
                  }
                  <button
                    type="button"
                    class="button button--secondary"
                    (click)="addException()"
                  >
                    Incluir exceção
                  </button>
                </fieldset>

                @if (hoursErrors()["hours"]; as message) {
                  <p class="field-error">{{ message }}</p>
                }
                <button class="button" [disabled]="saving()">
                  Salvar horários
                </button>
              </form>
            }

            @case ("orders") {
              <h2>Pedidos e entrega</h2>
              <form class="settings-form" (ngSubmit)="saveSettings()">
                <fieldset>
                  <legend>Atendimento</legend>
                  @for (mode of modes; track mode) {
                    <label class="check"
                      ><input
                        type="checkbox"
                        [name]="'mode-' + mode"
                        [checked]="form.fulfillmentModes.includes(mode)"
                        (change)="toggle(form.fulfillmentModes, mode, $event)"
                      />
                      {{ modeLabels[mode] }}</label
                    >
                  }
                  @if (fieldErrors()["fulfillmentModes"]; as message) {
                    <p class="field-error">{{ message }}</p>
                  }
                </fieldset>
                @for (field of moneyFields; track field.key) {
                  <label [for]="'settings-' + field.key">{{
                    field.label
                  }}</label>
                  <input
                    inputmode="decimal"
                    autocomplete="off"
                    [id]="'settings-' + field.key"
                    [name]="field.key"
                    [(ngModel)]="form[field.key]"
                    [attr.aria-invalid]="!!fieldErrors()[field.key]"
                    [attr.aria-describedby]="
                      fieldErrors()[field.key]
                        ? 'settings-' + field.key + '-error'
                        : null
                    "
                  />
                  @if (fieldErrors()[field.key]; as message) {
                    <p
                      class="field-error"
                      [id]="'settings-' + field.key + '-error'"
                    >
                      {{ message }}
                    </p>
                  }
                }
                <label for="settings-area">Área de entrega</label>
                <textarea
                  id="settings-area"
                  name="area"
                  maxlength="500"
                  placeholder="Ex.: Centro, Vila Nova e Jardim América"
                  [(ngModel)]="form.area"
                ></textarea>
                @for (field of minuteFields; track field.key) {
                  <label [for]="'settings-' + field.key">{{
                    field.label
                  }}</label>
                  <input
                    type="number"
                    min="1"
                    [max]="field.max"
                    [id]="'settings-' + field.key"
                    [name]="field.key"
                    [(ngModel)]="form[field.key]"
                    [attr.aria-invalid]="!!fieldErrors()[field.key]"
                  />
                  @if (fieldErrors()[field.key]; as message) {
                    <p class="field-error">{{ message }}</p>
                  }
                }
                <fieldset>
                  <legend>Pagamento</legend>
                  @for (method of payments; track method) {
                    <label class="check"
                      ><input
                        type="checkbox"
                        [name]="'payment-' + method"
                        [checked]="form.payments.includes(method)"
                        (change)="toggle(form.payments, method, $event)"
                      />
                      {{ paymentLabels[method] }}</label
                    >
                  }
                  @if (fieldErrors()["acceptedPaymentMethods"]; as message) {
                    <p class="field-error">{{ message }}</p>
                  }
                </fieldset>
                <label for="settings-phone">Telefone de contato</label>
                <input
                  id="settings-phone"
                  name="phone"
                  type="tel"
                  autocomplete="off"
                  [(ngModel)]="form.phone"
                  [attr.aria-invalid]="!!fieldErrors()['contactPhone']"
                />
                @if (fieldErrors()["contactPhone"]; as message) {
                  <p class="field-error">{{ message }}</p>
                }
                <label for="settings-pickup">Endereço de retirada</label>
                <input
                  id="settings-pickup"
                  name="pickup"
                  maxlength="300"
                  [(ngModel)]="form.pickup"
                  [attr.aria-invalid]="!!fieldErrors()['pickupAddress']"
                />
                @if (fieldErrors()["pickupAddress"]; as message) {
                  <p class="field-error">{{ message }}</p>
                }
                <button class="button" [disabled]="saving()">
                  Salvar pedidos e entrega
                </button>
              </form>
            }
          }
        </div>
      }
    </section>
  `,
})
export class SettingsPage {
  private readonly store = inject(StoreApi);
  private readonly catalogApi = inject(CatalogApi);

  protected readonly sections: { id: Section; label: string }[] = [
    { id: "policy", label: "Política de preço" },
    { id: "hours", label: "Horários" },
    { id: "orders", label: "Pedidos e entrega" },
  ];
  protected readonly weekdays = WEEKDAYS;
  protected readonly weekOrder = WEEK_ORDER;
  protected readonly modes: FulfillmentMode[] = ["DELIVERY", "PICKUP"];
  protected readonly modeLabels = MODE_LABELS;
  protected readonly payments: PaymentMethod[] = [
    "CASH",
    "CARD_ON_DELIVERY",
    "PIX_ON_DELIVERY",
  ];
  protected readonly paymentLabels = PAYMENT_LABELS;
  protected readonly moneyFields = [
    { key: "fee", label: "Taxa de entrega (R$)" },
    { key: "minimum", label: "Pedido mínimo (R$)" },
  ] as const;
  protected readonly minuteFields = [
    { key: "prep", label: "Tempo de preparo (minutos)", max: 240 },
    { key: "delivery", label: "Tempo de entrega (minutos)", max: 240 },
    {
      key: "timeout",
      label:
        "Tempo para aceitar um pedido antes da recusa automática (minutos)",
      max: 60,
    },
  ] as const;
  protected readonly crossesMidnight = crossesMidnight;

  protected readonly active = signal<Section>("policy");
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal("");
  protected readonly notice = signal("");
  protected readonly state = signal<StoreState | null>(null);
  protected readonly catalog = signal<CatalogSnapshot | null>(null);
  protected readonly policySaved = signal(false);
  protected readonly fieldErrors = signal<Record<string, string>>({});
  protected readonly hoursErrors = signal<Record<string, string>>({});

  protected policy = {
    halfAndHalfStrategy: DEFAULT_POLICY.halfAndHalfStrategy,
    surcharge: "0.00",
    maxExtrasPerHalf: DEFAULT_POLICY.maxExtrasPerHalf,
  };
  protected hours: { rules: OpeningRule[]; exceptions: ClosureException[] } = {
    rules: [],
    exceptions: [],
  };
  protected form: SettingsForm = this.formOf(null);
  protected newException: ClosureException = this.blankException();

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    const [state, catalog] = await Promise.allSettled([
      this.store.get(),
      this.catalogApi.snapshot(),
    ]);
    this.loading.set(false);
    if (state.status === "rejected") {
      this.error.set(errorMessage(state.reason));
      return;
    }
    this.state.set(state.value);
    this.form = this.formOf(state.value.settings);
    this.hours = structuredClone(state.value.openingHours);
    if (catalog.status === "fulfilled") {
      this.catalog.set(catalog.value);
      const saved = catalog.value.pricingPolicy;
      this.policySaved.set(Boolean(saved));
      this.policy = this.policyFormOf(saved ?? DEFAULT_POLICY);
    }
  }

  /** The examples for the policy as typed; null without a priced two-flavor size. */
  protected examples() {
    const data = this.catalog();
    const surcharge = parseMoney(this.policy.surcharge, "product");
    if (!data) return null;
    return policyExamples(data, {
      halfAndHalfStrategy: this.policy.halfAndHalfStrategy,
      halfAndHalfSurchargeCents: surcharge.ok ? surcharge.cents : 0,
      maxExtrasPerHalf: Number(this.policy.maxExtrasPerHalf) || 0,
    });
  }

  protected async savePolicy(): Promise<void> {
    const surcharge = parseMoney(this.policy.surcharge, "product");
    const maxExtras = Number(this.policy.maxExtrasPerHalf);
    if (!surcharge.ok) return this.fieldError({ surcharge: surcharge.message });
    if (!Number.isInteger(maxExtras) || maxExtras < 0 || maxExtras > 10)
      return this.fieldError({ maxExtras: "Use de 0 a 10." });
    await this.write(async () => {
      const saved = await this.store.updatePricingPolicy({
        halfAndHalfStrategy: this.policy.halfAndHalfStrategy,
        halfAndHalfSurchargeCents: surcharge.cents,
        maxExtrasPerHalf: maxExtras,
      });
      this.policy = this.policyFormOf(saved);
      this.policySaved.set(true);
      this.catalog.update((data) => data && { ...data, pricingPolicy: saved });
      this.notice.set("Política de preço salva.");
    });
  }

  protected rulesOf(weekday: number) {
    return this.hours.rules.flatMap((rule, index) =>
      rule.weekday === weekday ? [{ rule, index, key: `rules[${index}]` }] : [],
    );
  }
  protected addRule(weekday: number): void {
    this.hours.rules.push({ weekday, opensAt: "18:00", closesAt: "23:00" });
    this.hoursErrors.set({});
  }
  protected removeRule(index: number): void {
    this.hours.rules.splice(index, 1);
    this.hoursErrors.set({});
  }
  protected removeException(index: number): void {
    this.hours.exceptions.splice(index, 1);
    this.hoursErrors.set({});
  }
  protected exceptionErrorKeys(index: number): string[] {
    const prefix = `exceptions[${index}]`;
    return Object.keys(this.hoursErrors()).filter((key) =>
      key.startsWith(prefix),
    );
  }

  /** Adds the typed exception to the list; nothing is sent until "Salvar horários". */
  protected addException(): void {
    const exception = this.newException;
    if (!exception.date)
      return this.fieldError({ exception: "Escolha a data da exceção." });
    if (this.hours.exceptions.some((item) => item.date === exception.date))
      return this.fieldError({
        exception: "Já existe uma exceção para esta data.",
      });
    if (
      !exception.closed &&
      exception.shifts.some(
        (shift) =>
          !shift.opensAt || !shift.closesAt || shift.opensAt === shift.closesAt,
      )
    )
      return this.fieldError({
        exception:
          "Preencha abertura e fechamento de cada turno, com horários diferentes.",
      });
    this.hours.exceptions = [
      ...this.hours.exceptions,
      {
        date: exception.date,
        closed: exception.closed,
        shifts: exception.closed ? [] : exception.shifts.map((s) => ({ ...s })),
      },
    ].sort((a, b) => a.date.localeCompare(b.date));
    this.newException = this.blankException();
    this.fieldErrors.set({});
    this.hoursErrors.set({});
    this.notice.set("Exceção incluída. Salve os horários para valer.");
  }

  protected async saveHours(): Promise<void> {
    const invalid: Record<string, string> = {};
    this.hours.rules.forEach((rule, index) => {
      if (!rule.opensAt || !rule.closesAt)
        invalid[`rules[${index}]`] = "Informe abertura e fechamento.";
      else if (rule.opensAt === rule.closesAt)
        invalid[`rules[${index}]`] =
          "Abertura e fechamento precisam ser diferentes.";
    });
    if (Object.keys(invalid).length) {
      this.hoursErrors.set(invalid);
      this.notice.set("");
      this.error.set("Confira os horários destacados.");
      return;
    }
    await this.write(async () => {
      try {
        const saved = await this.store.updateOpeningHours({
          rules: this.hours.rules.map(({ weekday, opensAt, closesAt }) => ({
            weekday,
            opensAt,
            closesAt,
          })),
          exceptions: this.hours.exceptions,
        });
        this.hours = structuredClone(saved);
        this.state.update(
          (current) => current && { ...current, openingHours: saved },
        );
        this.hoursErrors.set({});
        this.notice.set("Horários salvos.");
      } catch (error) {
        if (apiErrorCode(error) === "OPENING_HOURS_INVALID")
          this.hoursErrors.set(hoursErrorsByEntry(apiFieldErrors(error)));
        throw error;
      }
    });
  }

  protected toggle<T>(list: T[], value: T, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const index = list.indexOf(value);
    if (checked && index < 0) list.push(value);
    if (!checked && index >= 0) list.splice(index, 1);
  }

  protected async saveSettings(): Promise<void> {
    const errors: Record<string, string> = {};
    const fee = parseMoney(this.form.fee, "product");
    const minimum = parseMoney(this.form.minimum, "product");
    if (!fee.ok) errors["fee"] = fee.message;
    if (!minimum.ok) errors["minimum"] = minimum.message;
    if (!this.form.fulfillmentModes.length)
      errors["fulfillmentModes"] = SETTINGS_MESSAGES["fulfillmentModes"]!;
    if (!this.form.payments.length)
      errors["acceptedPaymentMethods"] =
        SETTINGS_MESSAGES["acceptedPaymentMethods"]!;
    if (
      this.form.fulfillmentModes.includes("PICKUP") &&
      !this.form.pickup.trim()
    )
      errors["pickupAddress"] = SETTINGS_MESSAGES["pickupAddress"]!;
    const whole = (value: unknown, max: number, key: string) => {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > max)
        errors[key] =
          SETTINGS_MESSAGES[
            key === "prep"
              ? "estimatedPrepMinutes"
              : key === "delivery"
                ? "estimatedDeliveryMinutes"
                : "acceptTimeoutMinutes"
          ]!;
      return number;
    };
    const prep = whole(this.form.prep, 240, "prep");
    const delivery = whole(this.form.delivery, 240, "delivery");
    const timeout = whole(this.form.timeout, 60, "timeout");
    if (Object.keys(errors).length || !fee.ok || !minimum.ok)
      return this.fieldError(errors);
    const settings: StoreSettings = {
      fulfillmentModes: this.modes.filter((mode) =>
        this.form.fulfillmentModes.includes(mode),
      ),
      deliveryFeeCents: fee.cents,
      minimumOrderCents: minimum.cents,
      deliveryAreaDescription: this.form.area.trim() || null,
      estimatedPrepMinutes: prep,
      estimatedDeliveryMinutes: delivery,
      acceptTimeoutMinutes: timeout,
      acceptedPaymentMethods: this.payments.filter((method) =>
        this.form.payments.includes(method),
      ),
      contactPhone: this.form.phone.trim() || null,
      pickupAddress: this.form.pickup.trim() || null,
    };
    await this.write(async () => {
      try {
        const saved = await this.store.updateSettings(settings);
        this.form = this.formOf(saved);
        this.state.update(
          (current) =>
            current && { ...current, settings: saved, settingsSaved: true },
        );
        this.notice.set("Configurações de pedidos e entrega salvas.");
      } catch (error) {
        const byField: Record<string, string> = {};
        for (const { path } of apiFieldErrors(error)) {
          const key =
            path === "deliveryFeeCents"
              ? "fee"
              : path === "minimumOrderCents"
                ? "minimum"
                : path;
          byField[key] = SETTINGS_MESSAGES[path] ?? "Confira este campo.";
        }
        this.fieldErrors.set(byField);
        throw error;
      }
    });
  }

  protected dateLabel(date: string): string {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString(
      "pt-BR",
      {
        timeZone: "UTC",
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      },
    );
  }
  protected rangesLabel(ranges: TimeRange[]): string {
    return ranges
      .map(
        (range) =>
          `${range.opensAt}–${range.closesAt}${crossesMidnight(range) ? " (dia seguinte)" : ""}`,
      )
      .join(", ");
  }

  private fieldError(errors: Record<string, string>): void {
    this.fieldErrors.set(errors);
    this.notice.set("");
    this.error.set("Corrija os campos destacados antes de salvar.");
  }

  /** One write at a time, so a double submit sends a single request. */
  private async write(action: () => Promise<void>): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set("");
    this.notice.set("");
    this.fieldErrors.set({});
    try {
      await action();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  private policyFormOf(policy: PricingPolicy) {
    return {
      halfAndHalfStrategy: policy.halfAndHalfStrategy,
      surcharge: moneyText(policy.halfAndHalfSurchargeCents),
      maxExtrasPerHalf: policy.maxExtrasPerHalf,
    };
  }

  private formOf(settings: StoreSettings | null): SettingsForm {
    return {
      fulfillmentModes: [...(settings?.fulfillmentModes ?? ["DELIVERY"])],
      fee: moneyText(settings?.deliveryFeeCents ?? 0),
      minimum: moneyText(settings?.minimumOrderCents ?? 0),
      area: settings?.deliveryAreaDescription ?? "",
      prep: settings?.estimatedPrepMinutes ?? 30,
      delivery: settings?.estimatedDeliveryMinutes ?? 40,
      timeout: settings?.acceptTimeoutMinutes ?? 10,
      payments: [
        ...(settings?.acceptedPaymentMethods ?? [
          "CASH",
          "CARD_ON_DELIVERY",
          "PIX_ON_DELIVERY",
        ]),
      ],
      phone: settings?.contactPhone ?? "",
      pickup: settings?.pickupAddress ?? "",
    };
  }

  private blankException(): ClosureException {
    return {
      date: "",
      closed: true,
      shifts: [{ opensAt: "18:00", closesAt: "23:00" }],
    };
  }
}
