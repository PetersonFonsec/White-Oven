import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { Injectable, effect, inject, signal } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { Session } from "../core/session";

export type OrderStatus =
  | "PLACED"
  | "PREPARING"
  | "READY"
  | "OUT_FOR_DELIVERY"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELED";

export interface OrderItem {
  kind: "PIZZA" | "PRODUCT";
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  snapshot: Record<string, unknown>;
}

export interface StaffOrder {
  id: string;
  number: number;
  status: OrderStatus;
  placedAt: string;
  fulfillment: "DELIVERY" | "PICKUP";
  deliveryAddress: Record<string, string | null> | null;
  paymentMethod: string;
  changeForCents: number | null;
  notes: string | null;
  customerName: string;
  customerPhone: string | null;
  items: OrderItem[];
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  totalCents: number;
  history: {
    from: OrderStatus | null;
    to: OrderStatus;
    at: string;
    reasonCode?: string | null;
    reasonText?: string | null;
  }[];
}

export interface StaffOrderPage {
  orders: StaffOrder[];
  nextCursor: number | null;
}

export interface TransitionIntent {
  orderId: string;
  from: OrderStatus;
  to: OrderStatus;
  reasonCode?: string;
  reasonText?: string;
  idempotencyKey: string;
  createdAt: number;
  reconciledAt?: number;
  request?: Promise<{ order: StaffOrder }>;
  uncertain: boolean;
}

export const ORDER_INTENT_STORAGE_PREFIX = "whiteoven.admin.order-intents.v1";
export const ORDER_INTENT_RECONCILIATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RECONCILIATION_CONFIRMATION_MS = 10 * 60 * 1000;
const STORAGE_VERSION = 1;
const MAX_STORED_INTENTS = 200;
const MAX_STORAGE_BYTES = 256 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_STATUSES: readonly OrderStatus[] = [
  "PLACED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "COMPLETED",
  "REJECTED",
  "CANCELED",
];
const REASON_CODES = [
  "CUSTOMER_REQUEST",
  "ITEM_UNAVAILABLE",
  "STORE_TOO_BUSY",
  "OUT_OF_DELIVERY_AREA",
  "CUSTOMER_UNREACHABLE",
  "NOT_PICKED_UP",
  "SUSPECTED_FRAUD",
  "OTHER",
] as const;

interface IntentScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

interface PersistedIntentEnvelope {
  version: typeof STORAGE_VERSION;
  scope: IntentScope;
  intents: Omit<TransitionIntent, "request" | "uncertain">[];
}

export class PendingOrderIntentError extends Error {
  constructor() {
    super("Uma ação anterior ainda aguarda confirmação para este pedido.");
  }
}

export class ReconciliationRequiredError extends Error {
  constructor() {
    super("A intenção antiga precisa reconciliar o pedido antes do retry.");
  }
}

export function isUncertainTransitionError(error: unknown): boolean {
  return (
    !(error instanceof HttpErrorResponse) ||
    error.status === 0 ||
    error.status === 408 ||
    error.status >= 500
  );
}

@Injectable({ providedIn: "root" })
export class OrdersApi {
  private readonly http = inject(HttpClient);
  private readonly session = inject(Session);
  private readonly pending = new Map<string, TransitionIntent>();
  private readonly pendingRevision = signal(0);
  private scope: (IntentScope & { storageKey: string }) | null = null;

  constructor() {
    effect(() => {
      this.session.credentials();
      this.syncScope();
    });
  }

  list(section: "active" | "closed", cursor?: number): Promise<StaffOrderPage> {
    const params = new URLSearchParams({ section });
    if (cursor !== undefined) params.set("cursor", String(cursor));
    return firstValueFrom(
      this.http.get<StaffOrderPage>(`/v1/admin/orders?${params}`),
    );
  }

  get(orderId: string): Promise<StaffOrder> {
    return firstValueFrom(
      this.http.get<StaffOrder>(
        `/v1/admin/orders/${encodeURIComponent(orderId)}`,
      ),
    );
  }

  pendingIntent(orderId: string): TransitionIntent | undefined {
    return this.pending.get(orderId);
  }
  hasUncertainIntent(orderId: string): boolean {
    return this.pending.get(orderId)?.uncertain ?? false;
  }
  requiresReconciliation(orderId: string): boolean {
    const intent = this.pending.get(orderId);
    return !!intent && this.requiresReconciliationFor(intent);
  }
  pendingVersion(): number {
    return this.pendingRevision();
  }
  pendingOrderIds(): string[] {
    return [...this.pending.keys()];
  }

  retryPending(orderId: string): Promise<{ order: StaffOrder }> {
    this.syncScope();
    const intent = this.pending.get(orderId);
    if (!intent)
      return Promise.reject(
        new Error("Não há ação pendente para este pedido."),
      );
    if (this.requiresReconciliationFor(intent))
      return Promise.reject(new ReconciliationRequiredError());
    return this.sendIntent(orderId, intent);
  }

  async reconcilePending(
    orderId: string,
  ): Promise<{ order: StaffOrder; canRetry: boolean }> {
    this.syncScope();
    const scope = this.scope;
    const intent = this.pending.get(orderId);
    if (!intent) throw new Error("Não há ação pendente para este pedido.");
    const order = await this.get(orderId);
    if (this.scope !== scope || this.pending.get(orderId) !== intent)
      throw new Error(
        "A sessão mudou durante a reconciliação. Atualize o quadro.",
      );
    if (order.status !== intent.from) {
      this.pending.delete(orderId);
      this.changed();
      this.persist();
      return { order, canRetry: false };
    }
    intent.reconciledAt = Date.now();
    this.changed();
    this.persist();
    return { order, canRetry: true };
  }

  transition(
    order: StaffOrder,
    to: OrderStatus,
    reasonCode?: string,
    reasonText?: string,
  ): Promise<{ order: StaffOrder }> {
    this.syncScope();
    let intent = this.pending.get(order.id);
    if (intent) {
      if (
        intent.from !== order.status ||
        intent.to !== to ||
        intent.reasonCode !== reasonCode ||
        intent.reasonText !== reasonText
      )
        return Promise.reject(new PendingOrderIntentError());
    } else {
      intent = {
        orderId: order.id,
        from: order.status,
        to,
        reasonCode,
        reasonText,
        idempotencyKey: crypto.randomUUID(),
        createdAt: Date.now(),
        uncertain: false,
      };
      this.pending.set(order.id, intent);
      this.changed();
      // Save the intent before subscribing to HttpClient. Storage failures never block the action.
      this.persist();
    }
    return this.sendIntent(order.id, intent);
  }

  private sendIntent(
    orderId: string,
    intent: TransitionIntent,
  ): Promise<{ order: StaffOrder }> {
    if (intent.request) return intent.request;
    const body = {
      from: intent.from,
      to: intent.to,
      ...(intent.reasonCode ? { reasonCode: intent.reasonCode } : {}),
      ...(intent.reasonText ? { reasonText: intent.reasonText } : {}),
    };
    const source = firstValueFrom(
      this.http.post<{ order: StaffOrder }>(
        `/v1/admin/orders/${encodeURIComponent(orderId)}/transitions`,
        body,
        { headers: { "Idempotency-Key": intent.idempotencyKey } },
      ),
    );
    const request = source
      .then((result) => {
        if (this.pending.get(orderId) === intent) {
          this.pending.delete(orderId);
          this.changed();
          this.persist();
        }
        return result;
      })
      .catch((error: unknown) => {
        intent.uncertain = isUncertainTransitionError(error);
        if (!intent.uncertain && this.pending.get(orderId) === intent) {
          this.pending.delete(orderId);
          this.changed();
          this.persist();
        } else if (intent.uncertain) {
          this.persist();
        }
        throw error;
      })
      .finally(() => {
        intent.request = undefined;
      });
    intent.request = request;
    return request;
  }

  private requiresReconciliationFor(intent: TransitionIntent): boolean {
    const old =
      Date.now() - intent.createdAt > ORDER_INTENT_RECONCILIATION_AGE_MS;
    const checked =
      intent.reconciledAt !== undefined &&
      Date.now() - intent.reconciledAt <= RECONCILIATION_CONFIRMATION_MS;
    return old && !checked;
  }

  private changed(): void {
    this.pendingRevision.update((version) => version + 1);
  }

  private currentScope(): IntentScope | null {
    const credentials = this.session.credentials();
    if (
      !credentials?.tenantId ||
      !credentials.userId ||
      !credentials.sessionId ||
      !UUID_PATTERN.test(credentials.tenantId) ||
      !UUID_PATTERN.test(credentials.userId) ||
      !UUID_PATTERN.test(credentials.sessionId)
    )
      return null;
    return {
      tenantId: credentials.tenantId,
      userId: credentials.userId,
      sessionId: credentials.sessionId,
    };
  }

  private scopeKey(scope: IntentScope): string {
    return `${ORDER_INTENT_STORAGE_PREFIX}:${scope.tenantId}:${scope.userId}:${scope.sessionId}`;
  }

  private syncScope(): void {
    const next = this.currentScope();
    const nextKey = next ? this.scopeKey(next) : null;
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
      if (!this.isEnvelope(parsed, scope))
        throw new Error("invalid storage data");
      for (const value of parsed.intents) {
        this.pending.set(value.orderId, { ...value, uncertain: true });
      }
      this.changed();
    } catch {
      this.removeStored(scope.storageKey);
    }
  }

  private isEnvelope(
    value: unknown,
    scope: IntentScope,
  ): value is PersistedIntentEnvelope {
    if (!value || typeof value !== "object") return false;
    const envelope = value as Partial<PersistedIntentEnvelope>;
    if (
      envelope.version !== STORAGE_VERSION ||
      !envelope.scope ||
      envelope.scope.tenantId !== scope.tenantId ||
      envelope.scope.userId !== scope.userId ||
      envelope.scope.sessionId !== scope.sessionId ||
      !Array.isArray(envelope.intents) ||
      envelope.intents.length > MAX_STORED_INTENTS
    )
      return false;
    const ids = new Set<string>();
    return envelope.intents.every((item) => {
      if (!item || typeof item !== "object") return false;
      const intent = item as TransitionIntent;
      const timestampValid =
        Number.isSafeInteger(intent.createdAt) &&
        intent.createdAt > 0 &&
        intent.createdAt <= Date.now() + 5 * 60 * 1000;
      const reasonValid =
        intent.reasonCode === undefined ||
        REASON_CODES.includes(
          intent.reasonCode as (typeof REASON_CODES)[number],
        );
      const textValid =
        intent.reasonText === undefined ||
        (typeof intent.reasonText === "string" &&
          [...intent.reasonText].length <= 280);
      if (
        !UUID_PATTERN.test(intent.orderId) ||
        ids.has(intent.orderId) ||
        !UUID_PATTERN.test(intent.idempotencyKey) ||
        !ORDER_STATUSES.includes(intent.from) ||
        !ORDER_STATUSES.includes(intent.to) ||
        !timestampValid ||
        !reasonValid ||
        !textValid ||
        (intent.reconciledAt !== undefined &&
          (!Number.isSafeInteger(intent.reconciledAt) ||
            intent.reconciledAt < intent.createdAt ||
            intent.reconciledAt > Date.now() + 5 * 60 * 1000))
      )
        return false;
      ids.add(intent.orderId);
      return true;
    });
  }

  private persist(): void {
    const scope = this.scope;
    if (!scope) return;
    if (this.pending.size === 0) {
      this.removeStored(scope.storageKey);
      return;
    }
    const intents = [...this.pending.values()].map(
      ({
        orderId,
        from,
        to,
        reasonCode,
        reasonText,
        idempotencyKey,
        createdAt,
        reconciledAt,
      }) => ({
        orderId,
        from,
        to,
        reasonCode,
        reasonText,
        idempotencyKey,
        createdAt,
        reconciledAt,
      }),
    );
    const envelope: PersistedIntentEnvelope = {
      version: STORAGE_VERSION,
      scope: {
        tenantId: scope.tenantId,
        userId: scope.userId,
        sessionId: scope.sessionId,
      },
      intents,
    };
    try {
      const raw = JSON.stringify(envelope);
      if (raw.length <= MAX_STORAGE_BYTES) {
        sessionStorage.setItem(scope.storageKey, raw);
      } else {
        this.removeStored(scope.storageKey);
      }
    } catch {
      // sessionStorage is optional recovery; it must never block a live transition.
    }
  }

  private removeStored(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // The current session still has its in-memory intent map.
    }
  }
}
