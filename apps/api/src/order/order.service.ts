import { createHash } from "node:crypto";
import {
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { EntityManager } from "@mikro-orm/postgresql";
import { readCatalogSnapshot } from "../catalog/catalog.service";
import { customerOf } from "../customer/customer-auth.service";
import type { CustomerAddress } from "../customer/customer-rules";
import { ApiError } from "../errors/api-error";
import { JsonLogger } from "../logging/json-logger";
import { readStoreStatus } from "../store/store.service";
import { currentTenantContext } from "../tenancy/tenant-context";
import { runInTenant, TenantTransactions } from "../tenancy/tenant-transaction";
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
import {
  reasonRequired,
  transitionAllowed,
  type OrderStatus,
  type RejectionReason,
} from "./order-lifecycle-rules";

/** How long an `Idempotency-Key` identifies its order (domain-model.md#ordercreationkey). */
export const ORDER_KEY_TTL_HOURS = 24;

/** A timeout transaction locks at most this many orders. */
export const ORDER_TIMEOUT_BATCH_SIZE = 100;
/** Bound work per tenant per timer tick so a large store cannot delay every later tenant. */
export const ORDER_TIMEOUT_MAX_BATCHES_PER_TENANT_PER_RUN = 10;

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LockedOrder {
  id: string;
  status: OrderStatus;
  fulfillment: Fulfillment;
  totalCents: number;
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  paymentMethod: PaymentMethod;
}

interface PersistedTransitionChange {
  from: OrderStatus;
  to: OrderStatus;
  reasonCode: RejectionReason | null;
  reasonText: string | null;
  commandHash: Buffer;
  at: Date | string;
}

type PublicTransitionChange = Omit<PersistedTransitionChange, "commandHash">;

interface WriteTransitionInput {
  orderId: string;
  from: OrderStatus;
  to: OrderStatus;
  actorType: "CUSTOMER" | "STAFF" | "SYSTEM";
  actorId: string;
  reasonCode: RejectionReason | null;
  reasonText: string | null;
  keyHash: Buffer;
  commandHash: Buffer;
  requestId?: string;
}

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
export class OrderService implements OnModuleInit, OnModuleDestroy {
  private timeout?: NodeJS.Timeout;
  private jobRunning = false;
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly orm: MikroORM,
    private readonly logger: JsonLogger,
  ) {}

  onModuleInit(): void {
    this.timeout = setInterval(() => void this.rejectExpiredOrders(), 60_000);
    this.timeout.unref();
  }
  onModuleDestroy(): void {
    if (this.timeout) clearInterval(this.timeout);
  }

  async transition(input: {
    orderId: string;
    from: OrderStatus;
    to: OrderStatus;
    reasonCode?: RejectionReason;
    reasonText?: string;
    idempotencyKey: string;
    requestId?: string;
  }): Promise<unknown> {
    const actor = currentTenantContext().actor;
    const actorType = actor.type === "customer" ? "CUSTOMER" : "STAFF";
    const actorId =
      actor.type === "customer"
        ? actor.customerId
        : actor.type === "staff"
          ? actor.staffUserId
          : "";
    const keyHash = sha256(input.idempotencyKey);
    const commandHash = createHash("sha256")
      .update(
        JSON.stringify([
          input.from,
          input.to,
          input.reasonCode ?? null,
          input.reasonText?.trim() ?? null,
        ]),
      )
      .digest();
    return this.transactions.run(
      async (em) => {
        const [tenant] = await em.execute<{ status: string }[]>(
          "select whiteoven_lock_tenant_status(?) as status",
          [currentTenantContext().tenantId],
        );
        const suspendedOwnerClose =
          tenant?.status === "SUSPENDED" &&
          actorType === "STAFF" &&
          actor.type === "staff" &&
          actor.role === "OWNER";
        if (tenant?.status !== "ACTIVE" && !suspendedOwnerClose)
          throw new ApiError(
            HttpStatus.FORBIDDEN,
            "TENANT_NOT_ACTIVE",
            "Store unavailable.",
          );
        const [order] = await em.execute<LockedOrder[]>(
          `select id, status, fulfillment, total_cents as "totalCents", items_subtotal_cents as "itemsSubtotalCents",
                delivery_fee_cents as "deliveryFeeCents", payment_method as "paymentMethod", placed_at as "placedAt"
           from orders where id = ? for update`,
          [input.orderId],
        );
        if (!order)
          throw new ApiError(
            HttpStatus.NOT_FOUND,
            "NOT_FOUND",
            "Order not found.",
          );
        const [prior] = await em.execute<PersistedTransitionChange[]>(
          `select from_status as "from", to_status as "to", reason_code as "reasonCode", reason_text as "reasonText",
                command_hash as "commandHash", at from order_status_changes where order_id = ? and command_key_hash = ?`,
          [input.orderId, keyHash],
        );
        if (prior) {
          if (!prior.commandHash.equals(commandHash))
            throw new ApiError(
              HttpStatus.CONFLICT,
              "IDEMPOTENCY_KEY_REUSED",
              "Idempotency key was used for another transition.",
            );
          return {
            order: await readTransitionOrder(
              em,
              input.orderId,
              actorType,
              actorId,
            ),
            change: publicTransitionChange(prior),
          };
        }
        if (input.from !== order.status) {
          const [lastChange] = await em.execute<
            { from: OrderStatus; to: OrderStatus; at: Date | string }[]
          >(
            `select from_status as "from", to_status as "to", at from order_status_changes where order_id = ? order by at desc limit 1`,
            [input.orderId],
          );
          throw new ApiError(
            HttpStatus.CONFLICT,
            "ORDER_STATE_CONFLICT",
            "Order state changed. Reload it.",
            { currentStatus: order.status, lastChange: lastChange ?? null },
          );
        }
        if (
          !transitionAllowed(
            input.from,
            input.to,
            order.fulfillment,
            actorType,
          ) ||
          reasonRequired(input.to) !== Boolean(input.reasonCode) ||
          (actorType === "CUSTOMER" &&
            (input.reasonCode !== "CUSTOMER_REQUEST" ||
              input.to !== "CANCELED")) ||
          (actorType === "STAFF" &&
            ["CUSTOMER_REQUEST", "ACCEPT_TIMEOUT", "STORE_SUSPENDED"].includes(
              input.reasonCode ?? "",
            )) ||
          (input.reasonCode === "OTHER" &&
            (!input.reasonText?.trim() ||
              [...input.reasonText.trim()].length > 280)) ||
          (input.reasonCode !== "OTHER" && input.reasonText !== undefined)
        )
          throw new ApiError(
            HttpStatus.UNPROCESSABLE_ENTITY,
            "ORDER_INVALID_TRANSITION",
            "This order transition is not allowed.",
          );
        if (
          tenant?.status === "SUSPENDED" &&
          (!suspendedOwnerClose || !["CANCELED", "REJECTED"].includes(input.to))
        )
          throw new ApiError(
            HttpStatus.FORBIDDEN,
            "TENANT_NOT_ACTIVE",
            "Store unavailable.",
          );
        await this.writeTransition(em, {
          orderId: input.orderId,
          from: input.from,
          to: input.to,
          actorType,
          actorId,
          reasonCode: input.reasonCode ?? null,
          reasonText: input.reasonText?.trim() ?? null,
          keyHash,
          commandHash,
          requestId: input.requestId,
        });
        await em.execute(
          `update orders set status = ?, rejection_reason = ?, updated_at = now() where id = ?`,
          [
            input.to,
            input.to === "REJECTED" ? input.reasonCode : null,
            input.orderId,
          ],
        );
        if (input.to === "COMPLETED") await this.recordBilling(em, order);
        const [persistedChange] = await em.execute<PublicTransitionChange[]>(
          `select from_status as "from", to_status as "to", reason_code as "reasonCode",
                  reason_text as "reasonText", at
             from order_status_changes where order_id = ? and command_key_hash = ?`,
          [input.orderId, keyHash],
        );
        if (!persistedChange)
          throw new Error("Order transition history was not persisted.");
        return {
          order: await readTransitionOrder(
            em,
            input.orderId,
            actorType,
            actorId,
          ),
          change: publicTransitionChange(persistedChange),
        };
      },
      actorType === "STAFF" ? { lockTenantStatusFirst: true } : undefined,
    );
  }

  private async writeTransition(
    em: EntityManager,
    c: WriteTransitionInput,
  ): Promise<void> {
    await em.execute(
      `insert into order_status_changes (tenant_id, order_id, from_status, to_status, actor_type, actor_id, reason_code, reason_text, command_key_hash, command_hash)
      values (current_setting('app.tenant_id')::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.orderId,
        c.from,
        c.to,
        c.actorType,
        c.actorId,
        c.reasonCode,
        c.reasonText,
        c.keyHash,
        c.commandHash,
      ],
    );
    if (c.actorType === "STAFF")
      await em.execute(`select whiteoven_order_audit(?,?,?,?,?,?)`, [
        c.actorId,
        c.orderId,
        c.from,
        c.to,
        c.reasonCode,
        typeof c.requestId === "string" && UUID.test(c.requestId)
          ? c.requestId
          : null,
      ]);
  }

  private async recordBilling(
    em: EntityManager,
    order: Pick<
      LockedOrder,
      | "id"
      | "itemsSubtotalCents"
      | "deliveryFeeCents"
      | "totalCents"
      | "paymentMethod"
    >,
  ): Promise<void> {
    await em.execute(
      `insert into billing_entries (tenant_id, order_id, type, items_subtotal_cents, delivery_fee_cents, total_cents, payment_method, paid_online)
      values (current_setting('app.tenant_id')::uuid, ?, 'ORDER_COMPLETED', ?, ?, ?, ?, false) on conflict (tenant_id, order_id, type) do nothing`,
      [
        order.id,
        order.itemsSubtotalCents,
        order.deliveryFeeCents,
        order.totalCents,
        order.paymentMethod,
      ],
    );
  }

  private async rejectExpiredOrders(): Promise<void> {
    if (this.jobRunning) return;
    this.jobRunning = true;
    try {
      const em = this.orm.em.fork({ clear: true });
      const tenants = await em.execute<{ id: string }[]>(
        `select id from tenants where status = 'ACTIVE'`,
      );
      for (const tenant of tenants) {
        for (
          let batch = 1;
          batch <= ORDER_TIMEOUT_MAX_BATCHES_PER_TENANT_PER_RUN;
          batch++
        ) {
          try {
            const processed = await runInTenant(
              this.orm,
              tenant.id,
              async (tx) => {
                const [state] = await tx.execute<{ status: string }[]>(
                  "select whiteoven_lock_tenant_status(?) as status",
                  [tenant.id],
                );
                if (state?.status !== "ACTIVE") return 0;
                const due = await tx.execute<{ id: string }[]>(
                  `select o.id from orders o join store_settings s on true
                    where o.status = 'PLACED'
                      and o.placed_at + make_interval(mins => s.accept_timeout_minutes) <= now()
                    order by o.placed_at, o.id
                    limit ? for update of o skip locked`,
                  [ORDER_TIMEOUT_BATCH_SIZE],
                );
                for (const { id } of due) {
                  const key = "system:accept-timeout";
                  const keyHash = sha256(key);
                  const commandHash = createHash("sha256")
                    .update(
                      JSON.stringify([
                        "PLACED",
                        "REJECTED",
                        "ACCEPT_TIMEOUT",
                        null,
                      ]),
                    )
                    .digest();
                  const [prior] = await tx.execute(
                    `select 1 from order_status_changes where order_id = ? and command_key_hash = ?`,
                    [id, keyHash],
                  );
                  if (prior) continue;
                  const updated = await tx.execute<{ id: string }[]>(
                    `update orders set status='REJECTED', rejection_reason='ACCEPT_TIMEOUT', updated_at=now()
                      where id=? and status='PLACED' returning id`,
                    [id],
                  );
                  if (!updated.length) continue;
                  await this.writeTransition(tx, {
                    orderId: id,
                    from: "PLACED",
                    to: "REJECTED",
                    actorType: "SYSTEM",
                    actorId: tenant.id,
                    reasonCode: "ACCEPT_TIMEOUT",
                    reasonText: null,
                    keyHash,
                    commandHash,
                  });
                }
                return due.length;
              },
            );
            if (processed === 0) break;
          } catch {
            this.logger.write(
              "error",
              "order acceptance timeout batch failed",
              { tenantId: tenant.id, batch },
            );
            break;
          }
        }
      }
    } catch {
      this.logger.write("error", "order acceptance timeout job failed");
    } finally {
      this.jobRunning = false;
    }
  }

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

        // The controller requires expectedTotalCents here; a null still never matches a total.
        const { quote, address } = await priced(em, request);
        if (request.expectedTotalCents !== quote.totalCents)
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
        await em.execute(
          `insert into order_status_changes (tenant_id, order_id, from_status, to_status, actor_type, actor_id)
           values (current_setting('app.tenant_id')::uuid, ?, null, 'PLACED', 'CUSTOMER', ?)`,
          [order!.id, customerId],
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

function publicTransitionChange(change: {
  from: OrderStatus;
  to: OrderStatus;
  reasonCode: RejectionReason | null;
  reasonText: string | null;
  at: Date | string;
}) {
  return {
    from: change.from,
    to: change.to,
    reasonCode: change.reasonCode,
    reasonText: change.reasonText,
    at: new Date(change.at).toISOString(),
  };
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
        ...(result.maxTotalCents !== undefined
          ? { maxTotalCents: result.maxTotalCents }
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

async function readTransitionOrder(
  em: EntityManager,
  id: string,
  actorType: "CUSTOMER" | "STAFF",
  actorId: string,
): Promise<Record<string, unknown>> {
  const [order] = await em.execute<Record<string, unknown>[]>(
    `select id, number, status, placed_at as "placedAt", fulfillment, payment_method as "paymentMethod",
            items_subtotal_cents as "itemsSubtotalCents", delivery_fee_cents as "deliveryFeeCents",
            discount_cents as "discountCents", total_cents as "totalCents"
       from orders where id = ? ${actorType === "CUSTOMER" ? "and customer_id = ?" : ""}`,
    actorType === "CUSTOMER" ? [id, actorId] : [id],
  );
  if (!order)
    throw new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "Order not found.");
  const history = await em.execute<Record<string, unknown>[]>(
    `select from_status as "from", to_status as "to", actor_type as "actorType", reason_code as "reasonCode",
            reason_text as "reasonText", at from order_status_changes where order_id = ? order by at asc`,
    [id],
  );
  if (actorType === "CUSTOMER")
    for (const event of history) delete event["reasonText"];
  return { ...order, history };
}
