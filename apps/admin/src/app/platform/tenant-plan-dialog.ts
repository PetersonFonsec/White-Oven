import {
  Component,
  ElementRef,
  ViewChild,
  inject,
  input,
  output,
  signal,
  type OnInit,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { errorMessage } from "../core/api";
import {
  PlatformApi,
  type Plan,
  type PlanCode,
  type PlanSubscription,
  type PlatformTenant,
} from "./platform-api";

const PLAN_NAMES: Record<PlanCode, string> = { FLEX: "Flex", PRO: "Pro" };

export const planName = (code: PlanCode): string => PLAN_NAMES[code];

/** "3% por venda, sem mensalidade" from the values recorded for a plan or period. */
export function planTerms(
  plan: Pick<Plan, "feeBasisPoints" | "monthlyFeeCents">,
): string {
  const fee =
    plan.feeBasisPoints > 0
      ? `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(plan.feeBasisPoints / 100)}% por venda`
      : "sem comissão por venda";
  const monthly =
    plan.monthlyFeeCents > 0
      ? `${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(plan.monthlyFeeCents / 100)} por mês`
      : "sem mensalidade";
  return `${fee}, ${monthly}`;
}

export const planDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "—"
    : new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(date);
};

/** Operator dialog to set a tenant's plan and read its plan history (M6.1, ADR 0024). */
@Component({
  selector: "wo-tenant-plan-dialog",
  imports: [FormsModule],
  template: `
    <dialog
      #dialog
      class="plan-dialog"
      aria-labelledby="plan-title"
      aria-describedby="plan-description"
      (cancel)="onCancel($event)"
    >
      <h2 id="plan-title" tabindex="-1">Plano de {{ tenant().displayName }}</h2>
      <p id="plan-description">
        @if (tenant().plan) {
          A troca vale a partir do primeiro dia do próximo mês, no fuso da loja.
          Até lá o plano atual continua valendo e os valores de cada período
          ficam registrados.
        } @else {
          A pizzaria ainda não tem plano. O plano escolhido começa a valer agora
          e é necessário para ativar a loja.
        }
      </p>

      <form (ngSubmit)="save()">
        <fieldset>
          <legend>Plano</legend>
          @for (plan of plans(); track plan.code) {
            <label class="plan-option">
              <input
                type="radio"
                name="plan"
                [id]="'plan-' + plan.code"
                [value]="plan.code"
                [(ngModel)]="choice"
              />
              <span>
                <strong>{{ name(plan.code) }}</strong>
                <small>{{ terms(plan) }}</small>
              </span>
            </label>
          }
        </fieldset>

        @if (error()) {
          <p class="status--error" role="alert">{{ error() }}</p>
        }

        <div class="dialog-actions">
          <button
            class="button button--secondary"
            type="button"
            (click)="close()"
          >
            Voltar
          </button>
          <button class="button" type="submit" [disabled]="saving() || !choice">
            {{ saving() ? "Salvando…" : "Salvar plano" }}
          </button>
        </div>
      </form>

      <section aria-labelledby="plan-history-title">
        <h3 id="plan-history-title">Histórico</h3>
        @if (loadingHistory()) {
          <p role="status">Carregando histórico…</p>
        } @else if (historyError()) {
          <p class="status--error" role="alert">{{ historyError() }}</p>
        } @else if (history().length === 0) {
          <p class="muted">Nenhum plano registrado.</p>
        } @else {
          <ol class="plan-history">
            @for (period of history(); track period.id) {
              <li>
                <strong>{{ name(period.code) }}</strong>
                <span>{{ terms(period) }}</span>
                <span class="muted">
                  {{ periodLabel(period) }}
                </span>
              </li>
            }
          </ol>
        }
      </section>
    </dialog>
  `,
  styles: `
    .plan-dialog {
      width: min(560px, calc(100% - 32px));
      max-height: calc(100% - 32px);
      padding: var(--wo-spacing-5);
      border: 0;
      border-radius: var(--wo-radius-card);
      background: var(--wo-color-surface);
      color: var(--wo-color-text);
      box-shadow: 0 18px 56px rgb(0 0 0 / 0.2);
    }
    .plan-dialog::backdrop {
      background: rgb(20 18 17 / 0.48);
    }
    h2 {
      margin: 0 0 var(--wo-spacing-3);
      font-size: 1.25rem;
    }
    h3 {
      margin: var(--wo-spacing-5) 0 var(--wo-spacing-2);
      font-size: 1rem;
    }
    p {
      line-height: 1.55;
    }
    fieldset {
      display: grid;
      gap: var(--wo-spacing-2);
      margin: 0;
      padding: 0;
      border: 0;
    }
    legend {
      margin-bottom: var(--wo-spacing-2);
      font-weight: var(--wo-fontWeight-bold);
    }
    .plan-option {
      display: flex;
      align-items: flex-start;
      gap: var(--wo-spacing-3);
      padding: var(--wo-spacing-3);
      border: 1px solid var(--wo-color-border);
      border-radius: var(--wo-radius-small);
      cursor: pointer;
    }
    .plan-option:has(input:checked) {
      border-color: var(--wo-color-accentText);
      background: var(--wo-color-orangeSoft);
    }
    .plan-option input {
      margin-top: 4px;
    }
    .plan-option span,
    .plan-history li {
      display: grid;
      gap: 2px;
    }
    .plan-history {
      display: grid;
      gap: var(--wo-spacing-3);
      margin: 0;
      padding-left: var(--wo-spacing-4);
    }
    .dialog-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: var(--wo-spacing-2);
      margin-top: var(--wo-spacing-4);
    }
  `,
})
export class TenantPlanDialog implements OnInit {
  private readonly api = inject(PlatformApi);

  readonly tenant = input.required<PlatformTenant>();
  readonly plans = input.required<Plan[]>();
  /** Emits a confirmation for the page after a save, or null when closed without saving. */
  readonly closed = output<string | null>();

  protected readonly history = signal<PlanSubscription[]>([]);
  protected readonly loadingHistory = signal(true);
  protected readonly historyError = signal("");
  protected readonly saving = signal(false);
  protected readonly error = signal("");
  protected choice: PlanCode | "" = "";

  @ViewChild("dialog")
  set dialog(element: ElementRef<HTMLDialogElement> | undefined) {
    const dialog = element?.nativeElement;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.open = true;
    dialog.querySelector<HTMLElement>("h2")?.focus();
  }

  ngOnInit(): void {
    const tenant = this.tenant();
    this.choice =
      tenant.scheduledPlan?.code ??
      tenant.plan?.code ??
      this.plans()[0]?.code ??
      "";
    void this.loadHistory();
  }

  protected async loadHistory(): Promise<void> {
    this.loadingHistory.set(true);
    this.historyError.set("");
    try {
      this.history.set(await this.api.listPlanSubscriptions(this.tenant().id));
    } catch (error) {
      this.historyError.set(errorMessage(error));
    } finally {
      this.loadingHistory.set(false);
    }
  }

  protected async save(): Promise<void> {
    const choice = this.choice;
    if (!choice || this.saving()) return;
    this.error.set("");
    this.saving.set(true);
    try {
      const result = await this.api.changePlan(this.tenant().id, choice);
      const plan = planName(result.plan);
      const startsLater = new Date(result.validFrom).getTime() > Date.now();
      this.closed.emit(
        !result.changed
          ? `Nenhuma mudança: ${this.tenant().displayName} já está com o plano ${plan}${startsLater ? ` agendado para ${planDate(result.validFrom)}` : ""}.`
          : startsLater
            ? `Plano ${plan} agendado para ${planDate(result.validFrom)} em ${this.tenant().displayName}.`
            : `${this.tenant().displayName} está no plano ${plan}.`,
      );
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    if (!this.saving()) this.closed.emit(null);
  }

  protected onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  protected name(code: PlanCode): string {
    return planName(code);
  }

  protected terms(
    plan: Pick<Plan, "feeBasisPoints" | "monthlyFeeCents">,
  ): string {
    return planTerms(plan);
  }

  protected periodLabel(period: PlanSubscription): string {
    const now = Date.now();
    const from = new Date(period.validFrom).getTime();
    if (from > now) return `Começa em ${planDate(period.validFrom)}`;
    if (period.validTo && new Date(period.validTo).getTime() <= now)
      return `De ${planDate(period.validFrom)} a ${planDate(period.validTo)}`;
    return period.validTo
      ? `Atual, desde ${planDate(period.validFrom)}, até ${planDate(period.validTo)}`
      : `Atual, desde ${planDate(period.validFrom)}`;
  }
}
