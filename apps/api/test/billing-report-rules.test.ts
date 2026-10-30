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

  it("rounds each sale's fee, not the month's sum, so every cent traces to an entry", () => {
    // Two R$ 0,17 sales at 3%: 0,51 centavo each, 1 cent each. On the R$ 0,34 sum it would be 1.
    const report = buildBillingReport({
      ...month,
      entries: [entry("ORDER_COMPLETED", 17), entry("ORDER_COMPLETED", 17)],
      planPeriods: [],
    });
    assert.equal(report.lines[0]!.commissionCents, 2);
    assert.equal(feeOf(34, 300), 1, "the rule this replaces");
    // Exactly half a cent rounds away from zero, both ways.
    assert.equal(feeOf(50, 100), 1);
    assert.equal(feeOf(-50, 100), -1);
  });

  it("charges nothing on Pro's zero fee and never on the delivery fee", () => {
    const report = buildBillingReport({
      ...month,
      entries: [
        entry("ORDER_COMPLETED", 5000, "PRO", 0, 700),
        entry("ORDER_COMPLETED", 1000, "FLEX", 300, 99999),
      ],
      planPeriods: [],
    });
    assert.deepEqual(
      report.lines.map((line) => [line.plan, line.commissionCents]),
      [
        ["FLEX", 30],
        ["PRO", 0],
      ],
    );
  });

  it("cancels a sale's own fee with its reversal, in the same month or a later one", () => {
    const sale = entry("ORDER_COMPLETED", 1650);
    const reversal = entry("ORDER_REVERSED", -1650);
    const same = buildBillingReport({
      ...month,
      entries: [sale, entry("ORDER_COMPLETED", 17), reversal],
      planPeriods: [],
    });
    assert.equal(
      same.totals.commissionCents,
      1,
      "only the R$ 0,17 sale is left",
    );
    // Sale in October, reversal in November: October keeps 50, November gets exactly -50.
    const october = buildBillingReport({
      ...month,
      entries: [sale],
      planPeriods: [],
    });
    const november = buildBillingReport({
      ...month,
      period: "2026-11",
      entries: [reversal],
      planPeriods: [],
    });
    assert.equal(october.totals.commissionCents, 50);
    assert.equal(november.totals.commissionCents, -50);
    assert.equal(november.lines[0]!.reversedCount, 1);
  });

  it("keeps the lines' commissions adding up to the report's total", () => {
    const amounts = [17, 33, 1650, 4999, 12345, 1];
    const report = buildBillingReport({
      ...month,
      entries: [
        ...amounts.map((cents) => entry("ORDER_COMPLETED", cents)),
        ...amounts.map((cents) => entry("ORDER_COMPLETED", cents, "FLEX", 250)),
        entry("ORDER_REVERSED", -33),
        entry("ORDER_COMPLETED", 777, "PRO", 0),
      ],
      planPeriods: [],
    });
    assert.equal(report.lines.length, 3);
    assert.equal(
      report.lines.reduce((sum, line) => sum + line.commissionCents, 0),
      report.totals.commissionCents,
    );
    assert.equal(
      report.totals.commissionCents,
      amounts.reduce(
        (sum, cents) => sum + feeOf(cents, 300) + feeOf(cents, 250),
        0,
      ) - feeOf(33, 300),
    );
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
