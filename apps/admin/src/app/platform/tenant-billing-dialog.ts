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
  BillingApi,
  type BillingEntry,
  type BillingReport,
  type ReversalReason,
} from "../billing/billing-api";
import {
  BillingReportView,
  formatCents,
  periodLabel,
} from "../billing/billing-report-view";
import type { PlatformTenant } from "./platform-api";

const REASONS: { code: ReversalReason; label: string }[] = [
  { code: "COMPLETED_BY_MISTAKE", label: "Concluído por engano" },
  { code: "SALE_UNDONE", label: "Venda desfeita" },
];

/**
 * Operator dialog with a store's monthly estimate and ledger (M6.3, ADR 0026), where a completed
 * order's entry can be reversed with a fixed reason (ADR 0025). Reversing never edits an entry:
 * it adds a negative one in the month it is made.
 */
@Component({
  selector: "wo-tenant-billing-dialog",
  imports: [FormsModule, BillingReportView],
  template: `
    <dialog
      #dialog
      class="billing-dialog"
      aria-labelledby="billing-dialog-title"
      (cancel)="onCancel($event)"
    >
      <h2 id="billing-dialog-title" tabindex="-1">
        Cobrança de {{ tenant().displayName }}
      </h2>

      <form
        class="range"
        aria-label="Mês da cobrança"
        (submit)="$event.preventDefault(); changeMonth()"
      >
        <div class="field">
          <label for="tenant-billing-period">Mês</label>
          <input
            id="tenant-billing-period"
            name="period"
            type="month"
            [(ngModel)]="period"
          />
        </div>
        <button class="button" type="submit" [disabled]="loading()">
          Ver mês
        </button>
      </form>

      @if (notice()) {
        <p class="status--success" role="status">{{ notice() }}</p>
      }
      @if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }
      @if (loadError()) {
        <div class="status--error" role="alert">
          <p>{{ loadError() }}</p>
          <button
            class="button button--secondary"
            type="button"
            [disabled]="loading()"
            (click)="load()"
          >
            Tentar novamente
          </button>
        </div>
      }
      @if (loading()) {
        <p role="status">Carregando cobrança…</p>
      }

      @if (report(); as data) {
        <wo-billing-report-view [report]="data" />

        <section aria-labelledby="ledger-title">
          <h3 id="ledger-title">Lançamentos de {{ label(data.period) }}</h3>
          @if (entries().length === 0) {
            <p class="muted">Nenhum lançamento no mês.</p>
          } @else {
            <div class="table-wrap">
              <table class="ledger">
                <thead>
                  <tr>
                    <th scope="col">Pedido</th>
                    <th scope="col">Lançamento</th>
                    <th scope="col">Data</th>
                    <th scope="col" class="number">Itens</th>
                    <th scope="col" class="number">Total</th>
                    <th scope="col">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  @for (entry of entries(); track entry.id) {
                    <tr>
                      <th scope="row">#{{ entry.orderNumber }}</th>
                      <td>{{ kind(entry) }}</td>
                      <td>{{ dateTime(entry.occurredAt, data.timeZone) }}</td>
                      <td class="number">
                        {{ cents(entry.itemsSubtotalCents) }}
                      </td>
                      <td class="number">{{ cents(entry.totalCents) }}</td>
                      <td>
                        @if (reversible(entry)) {
                          @if (reversing() === entry.id) {
                            <form
                              class="reversal"
                              [attr.aria-label]="
                                'Estornar pedido #' + entry.orderNumber
                              "
                              (submit)="$event.preventDefault(); reverse(entry)"
                            >
                              <label [for]="'reason-' + entry.id">Motivo</label>
                              <select
                                [id]="'reason-' + entry.id"
                                name="reason"
                                [(ngModel)]="reason"
                              >
                                @for (option of reasons; track option.code) {
                                  <option [value]="option.code">
                                    {{ option.label }}
                                  </option>
                                }
                              </select>
                              <button
                                class="button button--danger"
                                type="submit"
                                [disabled]="saving()"
                              >
                                {{
                                  saving() ? "Estornando…" : "Confirmar estorno"
                                }}
                              </button>
                              <button
                                class="button button--secondary"
                                type="button"
                                [disabled]="saving()"
                                (click)="reversing.set(null)"
                              >
                                Cancelar
                              </button>
                            </form>
                          } @else {
                            <button
                              class="button button--secondary"
                              type="button"
                              [attr.aria-label]="
                                'Estornar pedido #' + entry.orderNumber
                              "
                              [disabled]="saving()"
                              (click)="askReversal(entry)"
                            >
                              Estornar
                            </button>
                          }
                        } @else if (
                          entry.type === "ORDER_COMPLETED" &&
                          !entry.reversedByEntryId &&
                          !entry.plan
                        ) {
                          <span class="muted">Sem plano registrado</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      <div class="dialog-actions">
        <button
          class="button button--secondary"
          type="button"
          (click)="close()"
        >
          Fechar
        </button>
      </div>
    </dialog>
  `,
  styles: `
    .billing-dialog {
      width: min(880px, calc(100% - 32px));
      max-height: calc(100% - 32px);
      padding: var(--wo-spacing-5);
      border: 0;
      border-radius: var(--wo-radius-card);
      background: var(--wo-color-surface);
      color: var(--wo-color-text);
      box-shadow: 0 18px 56px rgb(0 0 0 / 0.2);
    }
    .billing-dialog::backdrop {
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
    .range {
      display: flex;
      flex-wrap: wrap;
      gap: var(--wo-spacing-3);
      align-items: end;
      margin-bottom: var(--wo-spacing-4);
    }
    .table-wrap {
      overflow-x: auto;
    }
    .ledger {
      width: 100%;
      border-collapse: collapse;
    }
    .ledger th,
    .ledger td {
      padding: var(--wo-spacing-2) var(--wo-spacing-3);
      border-bottom: 1px solid var(--wo-color-border);
      text-align: left;
      white-space: nowrap;
    }
    .ledger .number {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .reversal {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--wo-spacing-2);
    }
    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: var(--wo-spacing-4);
    }
  `,
})
export class TenantBillingDialog implements OnInit {
  private readonly api = inject(BillingApi);

  readonly tenant = input.required<PlatformTenant>();
  readonly closed = output<void>();

  protected readonly reasons = REASONS;
  protected period = "";
  protected reason: ReversalReason = "COMPLETED_BY_MISTAKE";
  protected readonly report = signal<BillingReport | null>(null);
  protected readonly entries = signal<BillingEntry[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly reversing = signal<string | null>(null);
  protected readonly error = signal("");
  protected readonly notice = signal("");
  /** Why the month's data are not on screen; cleared by a successful load. */
  protected readonly loadError = signal("");
  private request = 0;

  @ViewChild("dialog")
  set dialog(element: ElementRef<HTMLDialogElement> | undefined) {
    const dialog = element?.nativeElement;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.open = true;
    dialog.querySelector<HTMLElement>("h2")?.focus();
  }

  ngOnInit(): void {
    void this.load();
  }

  /** A new month from the form: earlier notices belong to the month being left. */
  protected changeMonth(): void {
    this.notice.set("");
    this.error.set("");
    void this.load();
  }

  /**
   * Loads the month's estimate, then the same month's entries, and shows them only together:
   * as a load starts the previous month leaves the dialog, so a failure (of either call) never
   * leaves old figures or reversal buttons on screen. Resolves false when it failed.
   */
  protected async load(): Promise<boolean> {
    const request = ++this.request;
    const tenantId = this.tenant().id;
    const requested = this.period || null;
    const month = requested ? periodLabel(requested) : "este mês";
    this.report.set(null);
    this.entries.set([]);
    this.reversing.set(null);
    this.loading.set(true);
    this.loadError.set("");
    try {
      let report: BillingReport;
      try {
        report = await this.api.tenantReport(tenantId, requested);
      } catch (error) {
        if (request === this.request)
          this.loadError.set(
            `Não foi possível carregar o relatório de ${month}. ${errorMessage(error)}`,
          );
        return false;
      }
      if (request !== this.request) return false;
      let entries: BillingEntry[];
      try {
        entries = await this.api.tenantEntries(tenantId, report.period);
      } catch (error) {
        if (request === this.request)
          this.loadError.set(
            `Não foi possível carregar os lançamentos de ${periodLabel(report.period)}. ${errorMessage(error)}`,
          );
        return false;
      }
      if (request !== this.request) return false;
      this.report.set(report);
      this.entries.set(entries);
      this.period = report.period;
      return true;
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }

  protected reversible(entry: BillingEntry): boolean {
    return (
      entry.type === "ORDER_COMPLETED" &&
      !entry.reversedByEntryId &&
      entry.plan !== null
    );
  }

  protected askReversal(entry: BillingEntry): void {
    this.notice.set("");
    this.error.set("");
    this.reason = "COMPLETED_BY_MISTAKE";
    this.reversing.set(entry.id);
  }

  /**
   * Reverses once, then reloads the month. A failed reload after a confirmed reversal says the
   * reversal was recorded and offers a reload, never a new reversal: the month's data leave the
   * dialog until it is reloaded. `saving` stays on until then, so a double click sends one request.
   */
  protected async reverse(entry: BillingEntry): Promise<void> {
    if (this.saving() || !this.reversible(entry)) return;
    this.saving.set(true);
    this.error.set("");
    this.notice.set("");
    try {
      let result: { changed: boolean };
      try {
        result = await this.api.reverse(
          this.tenant().id,
          entry.id,
          this.reason,
        );
      } catch (error) {
        this.error.set(
          `O estorno do pedido #${entry.orderNumber} não foi registrado. ${errorMessage(error)}`,
        );
        return;
      }
      this.reversing.set(null);
      this.notice.set(
        result.changed
          ? `Pedido #${entry.orderNumber} estornado. O estorno entra na cobrança do mês atual.`
          : `O pedido #${entry.orderNumber} já estava estornado.`,
      );
      if (!(await this.load()))
        this.notice.set(
          `${this.notice()} Os dados do mês não foram atualizados; use "Tentar novamente" para vê-los.`,
        );
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    if (!this.saving()) this.closed.emit();
  }

  protected onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  protected kind(entry: BillingEntry): string {
    if (entry.type === "ORDER_REVERSED")
      return entry.reasonCode === "SALE_UNDONE"
        ? "Estorno: venda desfeita"
        : "Estorno: concluído por engano";
    return entry.reversedByEntryId ? "Venda (estornada)" : "Venda";
  }

  protected label(period: string): string {
    return periodLabel(period);
  }

  protected cents(value: number): string {
    return formatCents(value);
  }

  protected dateTime(value: string, timeZone: string): string {
    const date = new Date(value);
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone,
      }).format(date);
    } catch {
      return `${new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" }).format(date)} (UTC)`;
    }
  }
}
