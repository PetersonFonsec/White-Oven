import { CurrencyPipe, DatePipe } from "@angular/common";
import { Component, DestroyRef, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { errorMessage } from "../core/api";
import {
  DAILY_REPORT_MAX_DAYS,
  type DailyReport,
  OrderHistoryApi,
  addDays,
  localDay,
} from "../orders/history-api";

/**
 * Daily sales of the active store for the OWNER (M4.6, ADR 0019): count and sum of completed
 * orders per local day of completion, split by mode and payment method. The API sums only
 * COMPLETED orders; the page lays the days out and checks the range before asking.
 */
@Component({
  selector: "wo-daily-report-page",
  imports: [CurrencyPipe, DatePipe, FormsModule],
  template: `
    <section aria-labelledby="report-title">
      <h1 id="report-title" tabindex="-1" data-page-title>Relatório diário</h1>
      <p class="muted">
        Quantidade e soma dos pedidos concluídos em cada dia, pelo horário da
        conclusão. Pedidos recusados ou cancelados não entram.
      </p>

      <form
        class="range"
        aria-label="Período do relatório"
        (submit)="$event.preventDefault(); load()"
      >
        <div class="field">
          <label for="report-from">De</label>
          <input
            id="report-from"
            name="from"
            type="date"
            required
            [(ngModel)]="from"
          />
        </div>
        <div class="field">
          <label for="report-to">Até</label>
          <input
            id="report-to"
            name="to"
            type="date"
            required
            [(ngModel)]="to"
          />
        </div>
        <button class="button" type="submit" [disabled]="loading()">
          Ver relatório
        </button>
      </form>
      <p class="muted">Até {{ maxDays }} dias por consulta.</p>

      @if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }
      @if (loading() && !report()) {
        <p role="status">Carregando relatório…</p>
      }

      @if (report(); as data) {
        <div class="table-wrap">
          <table class="report-table">
            <caption>
              Vendas concluídas de
              {{
                data.from | date: "dd/MM/yyyy" : "UTC"
              }}
              a
              {{
                data.to | date: "dd/MM/yyyy" : "UTC"
              }}
              (fuso
              {{
                data.timezone
              }})
            </caption>
            <thead>
              <tr>
                <th scope="col">Dia</th>
                <th scope="col" class="number">Pedidos</th>
                <th scope="col" class="number">Total</th>
                <th scope="col" class="number">Entrega</th>
                <th scope="col" class="number">Retirada</th>
                <th scope="col" class="number">Dinheiro</th>
                <th scope="col" class="number">Cartão</th>
                <th scope="col" class="number">Pix</th>
              </tr>
            </thead>
            <tbody>
              @for (day of data.days; track day.date) {
                <tr [class.empty-day]="day.count === 0">
                  <th scope="row">
                    {{ day.date | date: "dd/MM/yyyy" : "UTC" }}
                  </th>
                  <td class="number">{{ day.count }}</td>
                  <td class="number">
                    {{ day.totalCents / 100 | currency: "BRL" }}
                  </td>
                  <td class="number">
                    {{ day.byFulfillment.DELIVERY.count }} ·
                    {{
                      day.byFulfillment.DELIVERY.totalCents / 100
                        | currency: "BRL"
                    }}
                  </td>
                  <td class="number">
                    {{ day.byFulfillment.PICKUP.count }} ·
                    {{
                      day.byFulfillment.PICKUP.totalCents / 100
                        | currency: "BRL"
                    }}
                  </td>
                  <td class="number">
                    {{
                      day.byPaymentMethod.CASH.totalCents / 100
                        | currency: "BRL"
                    }}
                  </td>
                  <td class="number">
                    {{
                      day.byPaymentMethod.CARD_ON_DELIVERY.totalCents / 100
                        | currency: "BRL"
                    }}
                  </td>
                  <td class="number">
                    {{
                      day.byPaymentMethod.PIX_ON_DELIVERY.totalCents / 100
                        | currency: "BRL"
                    }}
                  </td>
                </tr>
              }
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Período</th>
                <td class="number">{{ data.totals.count }}</td>
                <td class="number">
                  {{ data.totals.totalCents / 100 | currency: "BRL" }}
                </td>
                <td class="number">
                  {{ data.totals.byFulfillment.DELIVERY.count }} ·
                  {{
                    data.totals.byFulfillment.DELIVERY.totalCents / 100
                      | currency: "BRL"
                  }}
                </td>
                <td class="number">
                  {{ data.totals.byFulfillment.PICKUP.count }} ·
                  {{
                    data.totals.byFulfillment.PICKUP.totalCents / 100
                      | currency: "BRL"
                  }}
                </td>
                <td class="number">
                  {{
                    data.totals.byPaymentMethod.CASH.totalCents / 100
                      | currency: "BRL"
                  }}
                </td>
                <td class="number">
                  {{
                    data.totals.byPaymentMethod.CARD_ON_DELIVERY.totalCents /
                      100 | currency: "BRL"
                  }}
                </td>
                <td class="number">
                  {{
                    data.totals.byPaymentMethod.PIX_ON_DELIVERY.totalCents / 100
                      | currency: "BRL"
                  }}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p class="muted">
          Taxas de entrega no período:
          {{ data.totals.deliveryFeeCents / 100 | currency: "BRL" }}. Pagamentos
          são registrados como informados no pedido; não há conferência de
          caixa.
        </p>
      }
    </section>
  `,
  styles: `
    .range {
      display: flex;
      flex-wrap: wrap;
      gap: var(--wo-spacing-3);
      align-items: end;
      margin-top: var(--wo-spacing-4);
    }
    .table-wrap {
      overflow-x: auto;
      margin-top: var(--wo-spacing-4);
    }
    .report-table {
      width: 100%;
      border-collapse: collapse;
    }
    .report-table caption {
      text-align: left;
      font-weight: 600;
      padding-bottom: var(--wo-spacing-2);
    }
    .report-table th,
    .report-table td {
      padding: var(--wo-spacing-2) var(--wo-spacing-3);
      border-bottom: 1px solid var(--wo-color-border);
      text-align: left;
      white-space: nowrap;
    }
    .report-table .number {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .report-table tfoot th,
    .report-table tfoot td {
      font-weight: 700;
      border-top: 2px solid var(--wo-color-border);
    }
    .empty-day {
      color: var(--wo-color-muted);
    }
  `,
})
export class DailyReportPage {
  private readonly api = inject(OrderHistoryApi);
  protected readonly maxDays = DAILY_REPORT_MAX_DAYS;
  protected to = localDay(new Date());
  protected from = addDays(this.to, -6);
  protected readonly report = signal<DailyReport | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  private request = 0;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
    void this.load();
  }

  protected async load(): Promise<void> {
    if (!this.from || !this.to || this.from > this.to) {
      this.error.set("Escolha um período com a data final igual ou posterior.");
      return;
    }
    if (addDays(this.from, this.maxDays - 1) < this.to) {
      this.error.set(`Escolha no máximo ${this.maxDays} dias.`);
      return;
    }
    const request = ++this.request;
    this.loading.set(true);
    this.error.set(null);
    try {
      const report = await this.api.dailyReport(this.from, this.to);
      if (!this.destroyed && request === this.request) this.report.set(report);
    } catch (error) {
      if (!this.destroyed && request === this.request)
        this.error.set(errorMessage(error));
    } finally {
      if (request === this.request) this.loading.set(false);
    }
  }
}
