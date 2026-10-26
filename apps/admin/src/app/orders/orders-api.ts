import { HttpClient } from "@angular/common/http";
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

@Injectable({ providedIn: "root" })
export class OrdersApi {
  private readonly http = inject(HttpClient);

  list(): Promise<StaffOrder[]> {
    return firstValueFrom(this.http.get<StaffOrder[]>("/v1/admin/orders"));
  }

  transition(
    order: StaffOrder,
    to: OrderStatus,
    reasonCode?: string,
    reasonText?: string,
  ): Promise<{ order: StaffOrder }> {
    const body = {
      from: order.status,
      to,
      ...(reasonCode ? { reasonCode } : {}),
      ...(reasonText ? { reasonText } : {}),
    };
    return firstValueFrom(
      this.http.post<{ order: StaffOrder }>(
        `/v1/admin/orders/${encodeURIComponent(order.id)}/transitions`,
        body,
        { headers: { "Idempotency-Key": crypto.randomUUID() } },
      ),
    );
  }
}
