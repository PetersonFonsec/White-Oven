import { HttpClient, HttpParams } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import type { OrderStatus, StaffOrder } from "./orders-api";

export type Fulfillment = "DELIVERY" | "PICKUP";
export type PaymentMethod = "CASH" | "CARD_ON_DELIVERY" | "PIX_ON_DELIVERY";

export const INCIDENT_TYPES = [
  { id: "MISSING_ITEM", label: "Item faltando" },
  { id: "WRONG_ITEM", label: "Item errado" },
  { id: "LATE_DELIVERY", label: "Atraso" },
  { id: "QUALITY", label: "Qualidade" },
  { id: "DELIVERY_PROBLEM", label: "Problema na entrega" },
  { id: "OTHER", label: "Outro" },
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number]["id"];
export const INCIDENT_TEXT_MAX_LENGTH = 1000;

/** Filters of the history; dates are the store's local days (`YYYY-MM-DD`). */
export interface HistoryFilters {
  from?: string;
  to?: string;
  status?: OrderStatus;
  fulfillment?: Fulfillment;
  number?: number;
}

export interface HistoryEntry {
  id: string;
  number: number;
  status: OrderStatus;
  placedAt: string;
  fulfillment: Fulfillment;
  paymentMethod: PaymentMethod;
  customerName: string | null;
  totalCents: number;
  openIncidents: number;
}

export interface HistoryPage {
  orders: HistoryEntry[];
  nextCursor: number | null;
}

export interface OrderIncident {
  id: string;
  type: IncidentType;
  description: string;
  reportedBy: "CUSTOMER" | "STAFF";
  status: "OPEN" | "RESOLVED";
  resolutionNote: string | null;
  createdAt: string;
  createdByName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
}

/** The staff detail with authors of transitions and the order's incidents (M4.6). */
export interface OrderDetail extends Omit<
  StaffOrder,
  "history" | "customerName"
> {
  /** Null once the customer deleted the account. */
  customerName: string | null;
  history: (StaffOrder["history"][number] & {
    actorType?: "CUSTOMER" | "STAFF" | "SYSTEM";
    actorName?: string | null;
  })[];
  incidents: OrderIncident[];
}

export interface SalesTotal {
  count: number;
  totalCents: number;
}

export interface DailySales extends SalesTotal {
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  byFulfillment: Record<Fulfillment, SalesTotal>;
  byPaymentMethod: Record<PaymentMethod, SalesTotal>;
}

export interface DailyReport {
  from: string;
  to: string;
  timezone: string;
  days: (DailySales & { date: string })[];
  totals: DailySales;
}

/** At most this many days per report, like the API. */
export const DAILY_REPORT_MAX_DAYS = 31;

/** History, incidents and the daily report of the active store (`/v1/admin`, ADR 0019). */
@Injectable({ providedIn: "root" })
export class OrderHistoryApi {
  private readonly http = inject(HttpClient);

  history(filters: HistoryFilters, cursor?: number): Promise<HistoryPage> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries({ ...filters, cursor }))
      if (value !== undefined && value !== "")
        params = params.set(key, String(value));
    return firstValueFrom(
      this.http.get<HistoryPage>("/v1/admin/orders/history", { params }),
    );
  }

  detail(orderId: string): Promise<OrderDetail> {
    return firstValueFrom(
      this.http.get<OrderDetail>(
        `/v1/admin/orders/${encodeURIComponent(orderId)}`,
      ),
    );
  }

  reportIncident(
    orderId: string,
    incident: {
      type: IncidentType;
      description: string;
      reportedBy: "CUSTOMER" | "STAFF";
    },
  ): Promise<OrderIncident> {
    return firstValueFrom(
      this.http.post<OrderIncident>(
        `/v1/admin/orders/${encodeURIComponent(orderId)}/incidents`,
        incident,
      ),
    );
  }

  resolveIncident(
    orderId: string,
    incidentId: string,
    resolutionNote: string,
  ): Promise<OrderIncident> {
    return firstValueFrom(
      this.http.post<OrderIncident>(
        `/v1/admin/orders/${encodeURIComponent(orderId)}/incidents/${encodeURIComponent(incidentId)}/resolve`,
        { resolutionNote: resolutionNote.trim() || null },
      ),
    );
  }

  dailyReport(from: string, to: string): Promise<DailyReport> {
    return firstValueFrom(
      this.http.get<DailyReport>("/v1/admin/reports/daily", {
        params: new HttpParams().set("from", from).set("to", to),
      }),
    );
  }
}

/** `YYYY-MM-DD` of `date` in the browser's zone (the store's in the pilot). */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `day` moved by `days` calendar days. */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return localDay(new Date(year, month - 1, date + days));
}
