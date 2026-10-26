import { HttpClient, HttpParams } from "@angular/common/http";
import { Injectable, effect, inject, signal } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { Session } from "../core/session";
import {
  type OrderStatus,
  type StaffOrder,
  isUncertainTransitionError,
} from "./orders-api";

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

export interface NewIncident {
  type: IncidentType;
  description: string;
  reportedBy: "CUSTOMER" | "STAFF";
}

/**
 * One "record this incident" intent: its `Idempotency-Key` is made once and reused by every
 * retry until the API gives a definite answer, so a retry never records it twice.
 */
export interface IncidentIntent extends NewIncident {
  orderId: string;
  idempotencyKey: string;
  createdAt: number;
  /** Restored from storage or ended in a network/5xx error: the API may have recorded it. */
  uncertain: boolean;
  request?: Promise<OrderIncident>;
}

export const INCIDENT_INTENT_STORAGE_PREFIX =
  "whiteoven.admin.incident-intents.v1";
const STORAGE_VERSION = 1;
const MAX_STORED_INTENTS = 50;
const MAX_STORAGE_BYTES = 128 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface IntentScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

interface PersistedIncidentIntents {
  version: typeof STORAGE_VERSION;
  scope: IntentScope;
  intents: Omit<IncidentIntent, "request" | "uncertain">[];
}

export class PendingIncidentIntentError extends Error {
  constructor() {
    super(
      "Um registro de ocorrência anterior deste pedido ainda aguarda confirmação.",
    );
  }
}

/** History, incidents and the daily report of the active store (`/v1/admin`, ADR 0019). */
@Injectable({ providedIn: "root" })
export class OrderHistoryApi {
  private readonly http = inject(HttpClient);
  private readonly session = inject(Session);
  /** Unconfirmed incident records by order, kept like the board's transition intents (M4.5). */
  private readonly pending = new Map<string, IncidentIntent>();
  private readonly pendingRevision = signal(0);
  private scope: (IntentScope & { storageKey: string }) | null = null;

  constructor() {
    effect(() => {
      this.session.credentials();
      this.syncScope();
    });
  }

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

  pendingIncident(orderId: string): IncidentIntent | undefined {
    this.pendingRevision();
    return this.pending.get(orderId);
  }

  /**
   * Records an incident with an `Idempotency-Key`. While an earlier record of this order is
   * unconfirmed, only that same record is sent again, with its key; the API answers a retry
   * with the incident it already created. Nothing is resent without the user asking.
   */
  reportIncident(
    orderId: string,
    incident: NewIncident,
  ): Promise<OrderIncident> {
    let intent = this.pending.get(orderId);
    if (intent) {
      if (
        intent.type !== incident.type ||
        intent.description !== incident.description ||
        intent.reportedBy !== incident.reportedBy
      )
        return Promise.reject(new PendingIncidentIntentError());
    } else {
      intent = {
        orderId,
        type: incident.type,
        description: incident.description,
        reportedBy: incident.reportedBy,
        idempotencyKey: crypto.randomUUID(),
        createdAt: Date.now(),
        uncertain: false,
      };
      this.pending.set(orderId, intent);
      this.changed();
      // Saved before the request: a reload after a lost answer still retries with this key.
      this.persist();
    }
    if (intent.request) return intent.request;
    const sent = intent;
    const request = firstValueFrom(
      this.http.post<OrderIncident>(
        `/v1/admin/orders/${encodeURIComponent(orderId)}/incidents`,
        {
          type: sent.type,
          description: sent.description,
          reportedBy: sent.reportedBy,
        },
        { headers: { "Idempotency-Key": sent.idempotencyKey } },
      ),
    ).then(
      (created) => {
        this.forget(sent);
        return created;
      },
      (error: unknown) => {
        sent.uncertain = isUncertainTransitionError(error);
        if (!sent.uncertain) this.forget(sent);
        else this.changed();
        throw error;
      },
    );
    sent.request = request.finally(() => (sent.request = undefined));
    return sent.request;
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

  private forget(intent: IncidentIntent): void {
    if (this.pending.get(intent.orderId) !== intent) return;
    this.pending.delete(intent.orderId);
    this.changed();
    this.persist();
  }

  private changed(): void {
    this.pendingRevision.update((version) => version + 1);
  }

  /** The same scope as the board: store, person and session; another scope drops the intents. */
  private syncScope(): void {
    const credentials = this.session.credentials();
    const next =
      credentials?.tenantId &&
      credentials.userId &&
      credentials.sessionId &&
      UUID_PATTERN.test(credentials.tenantId) &&
      UUID_PATTERN.test(credentials.userId) &&
      UUID_PATTERN.test(credentials.sessionId)
        ? {
            tenantId: credentials.tenantId,
            userId: credentials.userId,
            sessionId: credentials.sessionId,
          }
        : null;
    const nextKey = next
      ? `${INCIDENT_INTENT_STORAGE_PREFIX}:${next.tenantId}:${next.userId}:${next.sessionId}`
      : null;
    if (this.scope?.storageKey === nextKey) return;
    const previous = this.scope;
    this.pending.clear();
    this.changed();
    this.scope = next && nextKey ? { ...next, storageKey: nextKey } : null;
    if (previous) this.removeStored(previous.storageKey);
    if (this.scope) this.restore(this.scope);
  }

  private restore(scope: IntentScope & { storageKey: string }): void {
    let raw: string | null;
    try {
      raw = sessionStorage.getItem(scope.storageKey);
    } catch {
      return;
    }
    if (raw === null) return;
    try {
      if (raw.length > MAX_STORAGE_BYTES) throw new Error("storage too large");
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredIntents(parsed, scope))
        throw new Error("invalid storage data");
      for (const value of parsed.intents)
        this.pending.set(value.orderId, { ...value, uncertain: true });
      this.changed();
    } catch {
      this.removeStored(scope.storageKey);
    }
  }

  private persist(): void {
    const scope = this.scope;
    if (!scope) return;
    if (this.pending.size === 0) {
      this.removeStored(scope.storageKey);
      return;
    }
    const stored: PersistedIncidentIntents = {
      version: STORAGE_VERSION,
      scope: {
        tenantId: scope.tenantId,
        userId: scope.userId,
        sessionId: scope.sessionId,
      },
      intents: [...this.pending.values()].map(
        ({
          orderId,
          type,
          description,
          reportedBy,
          idempotencyKey,
          createdAt,
        }) => ({
          orderId,
          type,
          description,
          reportedBy,
          idempotencyKey,
          createdAt,
        }),
      ),
    };
    try {
      const raw = JSON.stringify(stored);
      if (raw.length <= MAX_STORAGE_BYTES)
        sessionStorage.setItem(scope.storageKey, raw);
      else this.removeStored(scope.storageKey);
    } catch {
      // sessionStorage is optional recovery; it must never block recording an incident.
    }
  }

  private removeStored(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Unavailable storage has nothing to remove.
    }
  }
}

function isStoredIntents(
  value: unknown,
  scope: IntentScope,
): value is PersistedIncidentIntents {
  if (!value || typeof value !== "object") return false;
  const stored = value as Partial<PersistedIncidentIntents>;
  if (
    stored.version !== STORAGE_VERSION ||
    stored.scope?.tenantId !== scope.tenantId ||
    stored.scope.userId !== scope.userId ||
    stored.scope.sessionId !== scope.sessionId ||
    !Array.isArray(stored.intents) ||
    stored.intents.length > MAX_STORED_INTENTS
  )
    return false;
  const orders = new Set<string>();
  return stored.intents.every((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const intent = item as IncidentIntent;
    const valid =
      typeof intent.orderId === "string" &&
      UUID_PATTERN.test(intent.orderId) &&
      !orders.has(intent.orderId) &&
      typeof intent.idempotencyKey === "string" &&
      UUID_PATTERN.test(intent.idempotencyKey) &&
      INCIDENT_TYPES.some((type) => type.id === intent.type) &&
      (intent.reportedBy === "CUSTOMER" || intent.reportedBy === "STAFF") &&
      typeof intent.description === "string" &&
      intent.description.trim().length > 0 &&
      [...intent.description].length <= INCIDENT_TEXT_MAX_LENGTH &&
      Number.isSafeInteger(intent.createdAt) &&
      intent.createdAt > 0 &&
      intent.createdAt <= Date.now() + 5 * 60 * 1000;
    orders.add(intent.orderId);
    return valid;
  });
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
