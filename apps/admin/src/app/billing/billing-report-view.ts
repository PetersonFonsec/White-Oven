import { Component, input } from "@angular/core";
import { planDate, planName } from "../platform/plan-format";
import type { BillingReport, BillingReportLine } from "./billing-api";

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});
const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

/** "outubro de 2026" for "2026-10". */
export function periodLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year!, month! - 1, 1)));
}

export const formatCents = (cents: number): string => money.format(cents / 100);

/**
 * The monthly billing estimate (M6.3, ADR 0026), shared by the OWNER page and the operator
 * dialog. It always says it is an estimate: the WhiteOven does not charge yet.
 */
@Component({
  selector: "wo-billing-report-view",
  template: `
    @let data = report();
    <p class="estimate" role="note">
      <strong>Estimativa.</strong> Nada é cobrado ainda. Entram todos os pedidos
      concluídos no mês, qualquer que seja a forma de pagamento; a comissão
      incide sobre o subtotal dos itens (sem a taxa de entrega); estornos
      descontam no mês em que foram feitos; a mensalidade de cada plano vigente
      no mês entra inteira, sem pró-rata.
    </p>

    <div class="table-wrap">
      <table class="report-table">
        <caption>
          Cobrança estimada de
          {{
            label(data.period)
          }}
          (fuso
          {{
            data.timeZone
          }})
        </caption>
        <thead>
          <tr>
            <th scope="col">Plano</th>
            <th scope="col" class="number">Pedidos</th>
            <th scope="col" class="number">Estornos</th>
            <th scope="col" class="number">Subtotal dos itens</th>
            <th scope="col" class="number">Taxas de entrega</th>
            <th scope="col" class="number">Comissão</th>
          </tr>
        </thead>
        <tbody>
          @for (line of data.lines; track $index) {
            <tr>
              <th scope="row">{{ lineName(line) }}</th>
              <td class="number">{{ line.completedCount }}</td>
              <td class="number">{{ line.reversedCount }}</td>
              <td class="number">{{ cents(line.itemsSubtotalCents) }}</td>
              <td class="number">{{ cents(line.deliveryFeeCents) }}</td>
              <td class="number">{{ cents(line.commissionCents) }}</td>
            </tr>
          } @empty {
            <tr>
              <td colspan="6" class="muted">Nenhum pedido concluído no mês.</td>
            </tr>
          }
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Mês</th>
            <td class="number">{{ data.totals.completedCount }}</td>
            <td class="number">{{ data.totals.reversedCount }}</td>
            <td class="number">{{ cents(data.totals.itemsSubtotalCents) }}</td>
            <td class="number">{{ cents(data.totals.deliveryFeeCents) }}</td>
            <td class="number">{{ cents(data.totals.commissionCents) }}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <dl class="summary">
      <div>
        <dt>Mensalidades</dt>
        <dd>
          {{ cents(data.totals.monthlyFeeCents) }}
          @for (period of data.subscriptions; track period.validFrom) {
            <small class="muted">
              {{ planLabel(period.plan) }} ({{
                cents(period.monthlyFeeCents)
              }}), desde {{ dateLabel(period.validFrom, data.timeZone) }}
            </small>
          } @empty {
            <small class="muted">Nenhum plano vigente no mês.</small>
          }
        </dd>
      </div>
      <div>
        <dt>Comissão</dt>
        <dd>{{ cents(data.totals.commissionCents) }}</dd>
      </div>
      <div class="total">
        <dt>Total estimado</dt>
        <dd>{{ cents(data.totals.estimatedCents) }}</dd>
      </div>
    </dl>
  `,
  styles: `
    .estimate {
      padding: var(--wo-spacing-3);
      border-radius: var(--wo-radius-small);
      background: var(--wo-color-orangeSoft);
      line-height: 1.5;
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
    .summary {
      display: grid;
      gap: var(--wo-spacing-2);
      margin: var(--wo-spacing-4) 0 0;
    }
    .summary div {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: var(--wo-spacing-2);
    }
    .summary dt {
      font-weight: 600;
    }
    .summary dd {
      display: grid;
      justify-items: end;
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
    .summary .total {
      padding-top: var(--wo-spacing-2);
      border-top: 2px solid var(--wo-color-border);
      font-size: 1.125rem;
      font-weight: 700;
    }
  `,
})
export class BillingReportView {
  readonly report = input.required<BillingReport>();

  protected label(period: string): string {
    return periodLabel(period);
  }

  protected cents(value: number): string {
    return formatCents(value);
  }

  protected planLabel(code: BillingReportLine["plan"] & string): string {
    return planName(code);
  }

  protected dateLabel(value: string, timeZone: string): string {
    return planDate(value, timeZone);
  }

  protected lineName(line: BillingReportLine): string {
    if (line.plan === null) return "Sem plano registrado";
    return `${planName(line.plan)} (${percent.format((line.feeBasisPoints ?? 0) / 100)}%)`;
  }
}
