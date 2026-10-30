/**
 * Monthly billing estimate of one store, built only from its ledger and plan periods (M6.3,
 * ADR 0026). Nothing here is charged: the rule follows Q-01 (every completed order counts,
 * whatever the payment method), Q-02 (the fee applies to the items subtotal) and Q-10 (a plan
 * change takes effect at the next cycle, so a period's monthly fee is never prorated).
 */

/** `YYYY-MM`: a store-local month, the `period` of every billing entry. */
export const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface ReportEntry {
  type: string;
  plan: string | null;
  feeBasisPoints: number | null;
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
}

export interface ReportPlanPeriod {
  plan: string;
  feeBasisPoints: number;
  monthlyFeeCents: number;
  validFrom: Date;
  validTo: Date | null;
}

export interface BillingReportLine {
  plan: string | null;
  feeBasisPoints: number | null;
  completedCount: number;
  reversedCount: number;
  /** Net sums: reversals in this month are negative. */
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  /** Fee over the net items subtotal, rounded half away from zero; 0 without a snapshot. */
  commissionCents: number;
}

export interface BillingReport {
  period: string;
  timeZone: string;
  /** Always true: the WhiteOven does not charge yet. */
  estimate: true;
  /** One line per plan snapshot found in the month's entries. */
  lines: BillingReportLine[];
  /** Plan periods in force at some point of the month, each with its full monthly fee. */
  subscriptions: ReportPlanPeriod[];
  totals: Omit<BillingReportLine, "plan" | "feeBasisPoints"> & {
    monthlyFeeCents: number;
    estimatedCents: number;
  };
}

/** `cents × basisPoints / 10000`, rounded half away from zero. */
export function feeOf(cents: number, basisPoints: number): number {
  const scaled = Math.abs(cents) * basisPoints;
  const rounded = Math.floor((scaled + 5000) / 10000);
  return cents < 0 ? -rounded : rounded;
}

type Execute = <T>(query: string, params: unknown[]) => Promise<T[]>;

/** Time zone, month (the current one when `period` is omitted) and its bounds, from the database. */
export async function reportMonth(
  execute: Execute,
  timeZone: string,
  period: string | undefined,
): Promise<{ period: string; monthStart: Date; monthEnd: Date }> {
  const [row] = await execute<{
    period: string;
    monthStart: string | Date;
    monthEnd: string | Date;
  }>(
    `select m.period,
            (m.period || '-01')::timestamp at time zone ? as "monthStart",
            ((m.period || '-01')::date + interval '1 month')::timestamp at time zone ? as "monthEnd"
       from (select coalesce(?::text, to_char(clock_timestamp() at time zone ?, 'YYYY-MM')) as period) m`,
    [timeZone, timeZone, period ?? null, timeZone],
  );
  return {
    period: row!.period,
    monthStart: new Date(row!.monthStart),
    monthEnd: new Date(row!.monthEnd),
  };
}

/** Plan period rows as the database returns them (timestamps may come back as text). */
export function planPeriodOf(row: {
  plan: string;
  feeBasisPoints: number;
  monthlyFeeCents: number;
  validFrom: string | Date;
  validTo: string | Date | null;
}): ReportPlanPeriod {
  return {
    plan: row.plan,
    feeBasisPoints: row.feeBasisPoints,
    monthlyFeeCents: row.monthlyFeeCents,
    validFrom: new Date(row.validFrom),
    validTo: row.validTo === null ? null : new Date(row.validTo),
  };
}

export function buildBillingReport(input: {
  period: string;
  timeZone: string;
  monthStart: Date;
  monthEnd: Date;
  entries: ReportEntry[];
  planPeriods: ReportPlanPeriod[];
}): BillingReport {
  const lines = new Map<string, BillingReportLine>();
  for (const entry of input.entries) {
    if (entry.type !== "ORDER_COMPLETED" && entry.type !== "ORDER_REVERSED")
      continue;
    const key = `${entry.plan ?? ""}:${entry.feeBasisPoints ?? ""}`;
    let line = lines.get(key);
    if (!line) {
      line = {
        plan: entry.plan,
        feeBasisPoints: entry.feeBasisPoints,
        completedCount: 0,
        reversedCount: 0,
        itemsSubtotalCents: 0,
        deliveryFeeCents: 0,
        totalCents: 0,
        commissionCents: 0,
      };
      lines.set(key, line);
    }
    if (entry.type === "ORDER_COMPLETED") line.completedCount += 1;
    else line.reversedCount += 1;
    line.itemsSubtotalCents += entry.itemsSubtotalCents;
    line.deliveryFeeCents += entry.deliveryFeeCents;
    line.totalCents += entry.totalCents;
  }
  for (const line of lines.values())
    line.commissionCents =
      line.feeBasisPoints === null
        ? 0
        : feeOf(line.itemsSubtotalCents, line.feeBasisPoints);

  const subscriptions = input.planPeriods
    .filter(
      (period) =>
        period.validFrom < input.monthEnd &&
        (period.validTo === null || period.validTo > input.monthStart),
    )
    .sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());

  // Plan code order, entries without a snapshot (development data) last.
  const sorted = [...lines.values()].sort(
    (a, b) =>
      Number(a.plan === null) - Number(b.plan === null) ||
      (a.plan ?? "").localeCompare(b.plan ?? "") ||
      (b.feeBasisPoints ?? -1) - (a.feeBasisPoints ?? -1),
  );
  const sum = (pick: (line: BillingReportLine) => number) =>
    sorted.reduce((total, line) => total + pick(line), 0);
  const commissionCents = sum((line) => line.commissionCents);
  const monthlyFeeCents = subscriptions.reduce(
    (total, period) => total + period.monthlyFeeCents,
    0,
  );
  return {
    period: input.period,
    timeZone: input.timeZone,
    estimate: true,
    lines: sorted,
    subscriptions,
    totals: {
      completedCount: sum((line) => line.completedCount),
      reversedCount: sum((line) => line.reversedCount),
      itemsSubtotalCents: sum((line) => line.itemsSubtotalCents),
      deliveryFeeCents: sum((line) => line.deliveryFeeCents),
      totalCents: sum((line) => line.totalCents),
      commissionCents,
      monthlyFeeCents,
      estimatedCents: commissionCents + monthlyFeeCents,
    },
  };
}
