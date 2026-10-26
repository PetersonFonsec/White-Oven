import { createHash } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import { readCatalogSnapshot } from "../catalog/catalog.service";
import { customerOf } from "../customer/customer-auth.service";
import type { CustomerAddress } from "../customer/customer-rules";
import { ApiError } from "../errors/api-error";
import { readStoreStatus } from "../store/store.service";
import { currentTenantContext } from "../tenancy/tenant-context";
import { TenantTransactions } from "../tenancy/tenant-transaction";
import type { TenantStatus } from "../tenancy/tenant.entity";
import {
  type OrderQuote,
  type OrderSettings,
  type QuotedLine,
  priceOrder,
} from "./order-pricing";
import {
  type Fulfillment,
  type OrderRequest,
  type PaymentMethod,
  orderRequestHash,
} from "./order-rules";

/** How long an `Idempotency-Key` identifies its order (domain-model.md#ordercreationkey). */
export const ORDER_KEY_TTL_HOURS = 24;

export interface OrderQuoteView extends OrderQuote {
  /** True when the app sent `expectedTotalCents` and the server total differs. */
  priceChanged: boolean;
}

export interface OrderView {
  id: string;
  /** Sequential per store, shown as `#123`. */
  number: number;
  status: string;
  placedAt: string;
  fulfillment: Fulfillment;
  deliveryAddress: CustomerAddress | null;
  paymentMethod: PaymentMethod;
  changeForCents: number | null;
  notes: string | null;
  items: QuotedLine[];
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  totalCents: number;
}

const ADDRESS_COLUMNS = `label, postal_code as "postalCode", street, number, complement, district,
  city, state, reference`;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/**
 * Quote and idempotent creation of an order (M4.3, ADR 0018, order-lifecycle.md#checkout).
 *
 * Creation runs in one transaction under the customer's advisory lock, so two requests of one
 * customer (a retry racing the original) never interleave and an account deletion either comes
 * first (the session check refuses) or anonymizes the new order too. In that transaction:
 *
 * 1. The key is looked up first: the same key and body return the order already created, even if
 *    the store closed since; the same key with another body is a 409.
 * 2. The tenant row is locked FOR SHARE (`whiteoven_lock_tenant_status`), so a suspension either
 *    commits before (403) or waits and then rejects the new order with the others.
 * 3. Store open, settings, catalog, address and totals are checked and priced by `priceOrder`.
 * 4. The per-store counter row gives the number; order, items and key are inserted.
 */
@Injectable()
export class OrderService {
  constructor(private readonly transactions: TenantTransactions) {}

  quote(request: OrderRequest): Promise<OrderQuoteView> {
    return this.transactions.run(async (em) => {
      const { quote } = await priced(em, request);
      return {
        ...quote,
        priceChanged:
          request.expectedTotalCents !== null &&
          request.expectedTotalCents !== quote.totalCents,
      };
    });
  }

  create(
    request: OrderRequest,
    idempotencyKey: string,
  ): Promise<{ created: boolean; order: OrderView }> {
    const customerId = customerOf();
    const scope = `customer:${customerId}`;
    const keyHash = sha256(idempotencyKey);
    const requestHash = orderRequestHash(request);
    return this.transactions.run(
      async (em) => {
        const [prior] = await em.execute<
          { id: string; requestHash: Buffer; orderId: string; live: boolean }[]
        >(
          `select id, request_hash as "requestHash", order_id as "orderId", expires_at > now() as live
             from order_creation_keys where scope = ? and key_hash = ?`,
          [scope, keyHash],
        );
        if (prior?.live) {
          if (!prior.requestHash.equals(requestHash))
            throw new ApiError(
              HttpStatus.CONFLICT,
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key was used for a different order.",
            );
          return { created: false, order: await readOrder(em, prior.orderId) };
        }

        const { quote, address } = await priced(em, request);
        if (
          request.expectedTotalCents !== null &&
          request.expectedTotalCents !== quote.totalCents
        )
          throw new ApiError(
            HttpStatus.CONFLICT,
            "ORDER_PRICE_CHANGED",
            "Prices changed. Review the order and confirm again.",
            { totalCents: quote.totalCents },
          );

        const [customer] = await em.execute<
          { name: string; phone: string | null }[]
        >("select name, phone from customers where id = ?", [customerId]);
        const [counter] = await em.execute<{ number: number }[]>(
          `insert into tenant_order_counters (tenant_id, last_number)
           values (current_setting('app.tenant_id')::uuid, 1)
           on conflict (tenant_id) do update set last_number = tenant_order_counters.last_number + 1
           returning last_number as number`,
        );
        const [order] = await em.execute<{ id: string }[]>(
          `insert into orders (tenant_id, number, customer_id, customer_name, customer_phone,
             fulfillment, delivery_address, payment_method, change_for_cents, notes,
             items_subtotal_cents, delivery_fee_cents, discount_cents, total_cents)
           values (current_setting('app.tenant_id')::uuid, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?)
           returning id`,
          [
            counter!.number,
            customerId,
            customer!.name,
            customer!.phone,
            request.fulfillment,
            address ? JSON.stringify(address) : null,
            request.paymentMethod,
            request.changeForCents,
            request.notes,
            quote.itemsSubtotalCents,
            quote.deliveryFeeCents,
            quote.discountCents,
            quote.totalCents,
          ],
        );
        for (const [position, item] of quote.items.entries())
          await em.execute(
            `insert into order_items (tenant_id, order_id, position, kind, quantity, unit_price_cents,
               total_cents, snapshot)
             values (current_setting('app.tenant_id')::uuid, ?, ?, ?, ?, ?, ?, ?::jsonb)`,
            [
              order!.id,
              position,
              item.kind,
              item.quantity,
              item.unitPriceCents,
              item.totalCents,
              JSON.stringify(item.snapshot),
            ],
          );
        // An expired key is reused for the new order; a live one never reaches this point.
        if (prior)
          await em.execute(
            `update order_creation_keys
                set request_hash = ?, order_id = ?, created_at = now(),
                    expires_at = now() + make_interval(hours => ?)
              where id = ?`,
            [requestHash, order!.id, ORDER_KEY_TTL_HOURS, prior.id],
          );
        else
          await em.execute(
            `insert into order_creation_keys (tenant_id, scope, key_hash, request_hash, order_id, expires_at)
             values (current_setting('app.tenant_id')::uuid, ?, ?, ?, ?, now() + make_interval(hours => ?))`,
            [scope, keyHash, requestHash, order!.id, ORDER_KEY_TTL_HOURS],
          );
        return { created: true, order: await readOrder(em, order!.id) };
      },
      { lockCustomer: true },
    );
  }
}

/** Validations 2 to 7 of order-lifecycle.md#checkout, in the caller's transaction. */
async function priced(
  em: EntityManager,
  request: OrderRequest,
): Promise<{ quote: OrderQuote; address: CustomerAddress | null }> {
  const { tenantId } = currentTenantContext();
  const [tenant] = await em.execute<{ status: TenantStatus | null }[]>(
    "select whiteoven_lock_tenant_status(?) as status",
    [tenantId],
  );
  if (tenant?.status !== "ACTIVE")
    throw new ApiError(
      HttpStatus.FORBIDDEN,
      "TENANT_NOT_ACTIVE",
      "Store unavailable.",
    );
  const status = await readStoreStatus(em, tenantId);
  if (!status.open)
    throw new ApiError(
      HttpStatus.CONFLICT,
      "STORE_CLOSED",
      "The store is not taking orders now.",
      { reason: status.reason, pausedUntil: status.pausedUntil },
    );
  const [settings] = await em.execute<OrderSettings[]>(
    `select fulfillment_modes as "fulfillmentModes", delivery_fee_cents as "deliveryFeeCents",
            minimum_order_cents as "minimumOrderCents",
            accepted_payment_methods as "acceptedPaymentMethods"
       from store_settings`,
  );
  if (!settings)
    throw new ApiError(
      HttpStatus.CONFLICT,
      "STORE_NOT_CONFIGURED",
      "The store is not taking orders yet.",
    );
  const catalog = await readCatalogSnapshot(em);
  const address = request.addressId
    ? ((
        await em.execute<CustomerAddress[]>(
          `select ${ADDRESS_COLUMNS} from customer_addresses where id = ? and customer_id = ?`,
          [request.addressId, customerOf()],
        )
      )[0] ?? null)
    : null;
  const result = priceOrder(
    request,
    catalog,
    catalog.pricingPolicy,
    settings,
    address,
  );
  if (!result.ok)
    throw new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      "ORDER_INVALID",
      "The order cannot be placed as it is.",
      {
        errors: result.issues,
        ...(result.minimumOrderCents !== undefined
          ? { minimumOrderCents: result.minimumOrderCents }
          : {}),
      },
    );
  return { quote: result.quote, address };
}

async function readOrder(em: EntityManager, id: string): Promise<OrderView> {
  const [order] = await em.execute<
    (Omit<OrderView, "items" | "placedAt"> & { placedAt: Date })[]
  >(
    `select id, number, status, placed_at as "placedAt", fulfillment,
            delivery_address as "deliveryAddress", payment_method as "paymentMethod",
            change_for_cents as "changeForCents", notes,
            items_subtotal_cents as "itemsSubtotalCents", delivery_fee_cents as "deliveryFeeCents",
            discount_cents as "discountCents", total_cents as "totalCents"
       from orders where id = ? and customer_id = ?`,
    [id, customerOf()],
  );
  const items = await em.execute<QuotedLine[]>(
    `select kind, quantity, unit_price_cents as "unitPriceCents", total_cents as "totalCents", snapshot
       from order_items where order_id = ? order by position`,
    [id],
  );
  return {
    ...order!,
    placedAt: new Date(order!.placedAt).toISOString(),
    items,
  };
}
