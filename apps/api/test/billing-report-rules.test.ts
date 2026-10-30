import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BILLING_PERIOD,
  buildBillingReport,
  feeOf,
  type ReportEntry,
} from "../src/billing/billing-report";

const entry = (
  type: string,
  itemsSubtotalCents: number,
  plan: string | null = "FLEX",
  feeBasisPoints: number | null = 300,
  deliveryFeeCents = 0,
): ReportEntry => ({
  type,
  plan,
  feeBasisPoints,
  itemsSubtotalCents,
  deliveryFeeCents,
  totalCents: itemsSubtotalCents + deliveryFeeCents,
});

const month = {
  period: "2026-10",
  timeZone: "America/Sao_Paulo",
  monthStart: new Date("2026-10-01T03:00:00Z"),
  monthEnd: new Date("2026-11-01T03:00:00Z"),
};

describe("M6.3 billing report rules", () => {
  it("rounds the fee half away from zero, in cents", () => {
    assert.equal(feeOf(4000, 300), 120);
    assert.equal(feeOf(1650, 300), 50); // 49.5 → 50
    assert.equal(feeOf(1649, 300), 49); // 49.47 → 49
    assert.equal(feeOf(-1650, 300), -50);
    assert.equal(feeOf(12345, 0), 0);
    assert.equal(feeOf(0, 300), 0);
  });

  it("accepts only YYYY-MM months", () => {
    for (const ok of ["2026-01", "2026-12", "1999-10"])
      assert.ok(BILLING_PERIOD.test(ok), ok);
    for (const bad of ["2026-00", "2026-13", "2026-1", "26-10", "2026-10-01"])
      assert.ok(!BILLING_PERIOD.test(bad), bad);
  });

  it("charges the fee on the net items subtotal of every completed order, never the delivery fee", () => {
    const report = buildBillingReport({
      ...month,
      entries: [
        entry("ORDER_COMPLETED", 4000, "FLEX", 300, 700),
        entry("ORDER_COMPLETED", 1650),
        entry("ORDER_REVERSED", -4000, "FLEX", 300, -700),
        entry("ADJUSTMENT", 99999),
      ],
      planPeriods: [],
    });
    assert.deepEqual(report.lines, [
      {
        plan: "FLEX",
        feeBasisPoints: 300,
        completedCount: 2,
        reversedCount: 1,
        itemsSubtotalCents: 1650,
        deliveryFeeCents: 0,
        totalCents: 1650,
        commissionCents: 50,
      },
    ]);
    assert.equal(report.estimate, true);
    assert.equal(report.totals.estimatedCents, 50);
  });

  it("keeps one line per plan snapshot and adds the full monthly fee of each period in force", () => {
    const report = buildBillingReport({
      ...month,
      entries: [
        entry("ORDER_COMPLETED", 10000, "PRO", 0),
        entry("ORDER_COMPLETED", 10000, "FLEX", 300),
        entry("ORDER_COMPLETED", 3000, null, null),
      ],
      planPeriods: [
        // Ended exactly when the month began: not in force during it.
        {
          plan: "FLEX",
          feeBasisPoints: 300,
          monthlyFeeCents: 0,
          validFrom: new Date("2026-01-01T03:00:00Z"),
          validTo: month.monthStart,
        },
        {
          plan: "PRO",
          feeBasisPoints: 0,
          monthlyFeeCents: 19900,
          validFrom: month.monthStart,
          validTo: null,
        },
        // Starts when the month ends: not yet.
        {
          plan: "FLEX",
          feeBasisPoints: 300,
          monthlyFeeCents: 0,
          validFrom: month.monthEnd,
          validTo: null,
        },
      ],
    });
    assert.deepEqual(
      report.lines.map((line) => [
        line.plan,
        line.itemsSubtotalCents,
        line.commissionCents,
      ]),
      [
        ["FLEX", 10000, 300],
        ["PRO", 10000, 0],
        [null, 3000, 0],
      ],
    );
    assert.deepEqual(
      report.subscriptions.map((period) => period.plan),
      ["PRO"],
    );
    assert.deepEqual(report.totals, {
      completedCount: 3,
      reversedCount: 0,
      itemsSubtotalCents: 23000,
      deliveryFeeCents: 0,
      totalCents: 23000,
      commissionCents: 300,
      monthlyFeeCents: 19900,
      estimatedCents: 20200,
    });
  });

  it("reports an empty month with no lines and zero totals", () => {
    const report = buildBillingReport({
      ...month,
      entries: [],
      planPeriods: [],
    });
    assert.deepEqual(report.lines, []);
    assert.equal(report.totals.estimatedCents, 0);
  });
});
