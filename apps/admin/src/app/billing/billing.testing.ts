import type { BillingReport } from "./billing-api";

/** A month with three Flex orders, one reversed, for the billing specs. */
export const sampleReport = (period = "2026-10"): BillingReport => ({
  period,
  timeZone: "America/Sao_Paulo",
  estimate: true,
  lines: [
    {
      plan: "FLEX",
      feeBasisPoints: 300,
      completedCount: 3,
      reversedCount: 1,
      itemsSubtotalCents: 8000,
      deliveryFeeCents: 700,
      totalCents: 8700,
      commissionCents: 240,
    },
  ],
  subscriptions: [
    {
      plan: "FLEX",
      feeBasisPoints: 300,
      monthlyFeeCents: 0,
      validFrom: "2026-08-01T03:00:00Z",
      validTo: null,
    },
  ],
  totals: {
    completedCount: 3,
    reversedCount: 1,
    itemsSubtotalCents: 8000,
    deliveryFeeCents: 700,
    totalCents: 8700,
    commissionCents: 240,
    monthlyFeeCents: 0,
    estimatedCents: 240,
  },
});
