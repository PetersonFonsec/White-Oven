import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";

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

interface TransitionIntent {
  from: OrderStatus;
  to: OrderStatus;
  reasonCode?: string;
  reasonText?: string;
  idempotencyKey: string;
  request?: Promise<{ order: StaffOrder }>;
  uncertain: boolean;
}

export class PendingOrderIntentError extends Error {
  constructor() {
    super("Uma ação anterior ainda aguarda confirmação para este pedido.");
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
  private readonly pending = new Map<string, TransitionIntent>();

  list(section: "active" | "closed", cursor?: number): Promise<StaffOrderPage> {
    const params = new URLSearchParams({ section });
    if (cursor !== undefined) params.set("cursor", String(cursor));
    return firstValueFrom(
      this.http.get<StaffOrderPage>(`/v1/admin/orders?${params}`),
    );
  }

  pendingIntent(orderId: string): TransitionIntent | undefined {
    return this.pending.get(orderId);
  }
  hasUncertainIntent(orderId: string): boolean {
    return this.pending.get(orderId)?.uncertain ?? false;
  }

  retryPending(orderId: string): Promise<{ order: StaffOrder }> {
    const intent = this.pending.get(orderId);
    if (!intent)
      return Promise.reject(
        new Error("Não há ação pendente para este pedido."),
      );
    return this.sendIntent(orderId, intent);
  }

  transition(
    order: StaffOrder,
    to: OrderStatus,
    reasonCode?: string,
    reasonText?: string,
  ): Promise<{ order: StaffOrder }> {
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
        from: order.status,
        to,
        reasonCode,
        reasonText,
        idempotencyKey: crypto.randomUUID(),
        uncertain: false,
      };
      this.pending.set(order.id, intent);
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
        if (this.pending.get(orderId) === intent) this.pending.delete(orderId);
        return result;
      })
      .catch((error: unknown) => {
        intent.uncertain = isUncertainTransitionError(error);
        if (!intent.uncertain && this.pending.get(orderId) === intent)
          this.pending.delete(orderId);
        throw error;
      })
      .finally(() => {
        intent.request = undefined;
      });
    intent.request = request;
    return request;
  }
}
