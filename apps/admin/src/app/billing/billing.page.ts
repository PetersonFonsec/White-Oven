import { Component, DestroyRef, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { errorMessage } from "../core/api";
import { BillingApi, type BillingReport } from "./billing-api";
import { BillingReportView, periodLabel } from "./billing-report-view";

/**
 * The OWNER's monthly billing estimate (M6.3, ADR 0026). The month is the store's; leaving it
 * empty asks the API for the current one, so the browser's time zone never picks the month.
 */
@Component({
  selector: "wo-billing-page",
  imports: [FormsModule, BillingReportView],
  template: `
    <section aria-labelledby="billing-title">
      <h1 id="billing-title" tabindex="-1" data-page-title>Cobrança</h1>
      <p class="muted">
        Quanto o WhiteOven cobraria da pizzaria em cada mês, calculado pelos
        pedidos concluídos e pelo plano de cada venda.
      </p>

      <form
        class="range"
        aria-label="Mês da cobrança"
        (submit)="$event.preventDefault(); load()"
      >
        <div class="field">
          <label for="billing-period">Mês</label>
          <input
            id="billing-period"
            name="period"
            type="month"
            [(ngModel)]="period"
          />
        </div>
        <button class="button" type="submit" [disabled]="loading()">
          Ver mês
        </button>
      </form>

      @if (error()) {
        <div class="status--error" role="alert">
          <p>{{ error() }}</p>
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
      }
    </section>
  `,
  styles: `
    .range {
      display: flex;
      flex-wrap: wrap;
      gap: var(--wo-spacing-3);
      align-items: end;
      margin: var(--wo-spacing-4) 0;
    }
  `,
})
export class BillingPage {
  private readonly api = inject(BillingApi);
  protected period = "";
  protected readonly report = signal<BillingReport | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  private request = 0;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
    void this.load();
  }

  /**
   * Asks for the month in the field (the current one when empty). The previous month's report
   * leaves the page as the request starts, so a failure never shows it under the new month.
   */
  protected async load(): Promise<void> {
    const requested = this.period || null;
    const request = ++this.request;
    this.report.set(null);
    this.loading.set(true);
    this.error.set(null);
    try {
      const report = await this.api.storeReport(requested);
      if (this.destroyed || request !== this.request) return;
      this.report.set(report);
      this.period = report.period;
    } catch (error) {
      if (this.destroyed || request !== this.request) return;
      this.error.set(
        `Não foi possível carregar a cobrança de ${requested ? periodLabel(requested) : "este mês"}. ${errorMessage(error)}`,
      );
    } finally {
      if (!this.destroyed && request === this.request) this.loading.set(false);
    }
  }
}
