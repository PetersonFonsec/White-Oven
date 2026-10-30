import { HttpClient, HttpParams } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import type { PlanCode } from "../platform/platform-api";

export interface BillingReportLine {
  /** Plan snapshot of the entries; null only for development entries without one. */
  plan: PlanCode | null;
  feeBasisPoints: number | null;
  completedCount: number;
  reversedCount: number;
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  commissionCents: number;
}

export interface BillingReportPeriod {
  plan: PlanCode;
  feeBasisPoints: number;
  monthlyFeeCents: number;
  validFrom: string;
  validTo: string | null;
}

/** Monthly billing estimate of one store, built from its ledger (M6.3, ADR 0026). */
export interface BillingReport {
  period: string;
  timeZone: string;
  estimate: true;
  lines: BillingReportLine[];
  subscriptions: BillingReportPeriod[];
  totals: Omit<BillingReportLine, "plan" | "feeBasisPoints"> & {
    monthlyFeeCents: number;
    estimatedCents: number;
  };
}

export type ReversalReason = "COMPLETED_BY_MISTAKE" | "SALE_UNDONE";

export interface BillingEntry {
  id: string;
  type:
    "ORDER_COMPLETED" | "ORDER_REVERSED" | "SUBSCRIPTION_PERIOD" | "ADJUSTMENT";
  orderId: string | null;
  orderNumber: number | null;
  plan: PlanCode | null;
  feeBasisPoints: number | null;
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  paymentMethod: string;
  occurredAt: string;
  period: string;
  reversesEntryId: string | null;
  reasonCode: ReversalReason | null;
  reversedByEntryId: string | null;
}

const params = (period: string | null) =>
  period ? new HttpParams().set("period", period) : new HttpParams();
const tenantPath = (tenantId: string) =>
  `/v1/platform/tenants/${encodeURIComponent(tenantId)}`;

@Injectable({ providedIn: "root" })
export class BillingApi {
  private readonly http = inject(HttpClient);

  /** The active store's estimate, for its OWNER; `null` asks for the current month. */
  storeReport(period: string | null): Promise<BillingReport> {
    return firstValueFrom(
      this.http.get<BillingReport>("/v1/admin/reports/billing", {
        params: params(period),
      }),
    );
  }

  tenantReport(
    tenantId: string,
    period: string | null,
  ): Promise<BillingReport> {
    return firstValueFrom(
      this.http.get<BillingReport>(`${tenantPath(tenantId)}/billing-report`, {
        params: params(period),
      }),
    );
  }

  tenantEntries(tenantId: string, period: string): Promise<BillingEntry[]> {
    return firstValueFrom(
      this.http.get<BillingEntry[]>(`${tenantPath(tenantId)}/billing-entries`, {
        params: params(period),
      }),
    );
  }

  reverse(
    tenantId: string,
    entryId: string,
    reasonCode: ReversalReason,
  ): Promise<{ entryId: string; changed: boolean }> {
    return firstValueFrom(
      this.http.post<{ entryId: string; changed: boolean }>(
        `${tenantPath(tenantId)}/billing-entries/${encodeURIComponent(entryId)}/reversal`,
        { reasonCode },
      ),
    );
  }
}
