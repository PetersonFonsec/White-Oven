import { createHash } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ApiError } from "../errors/api-error";
import { currentTenantContext } from "../tenancy/tenant-context";
import { TenantStatusPolicy } from "../tenancy/tenant-status-policy";
import { TenantTransactions } from "../tenancy/tenant-transaction";
import {
  type BillingReport,
  buildBillingReport,
  planPeriodOf,
  type ReportEntry,
  reportMonth,
} from "../billing/billing-report";
import type { TenantStatus } from "../tenancy/tenant.entity";
import {
  FULFILLMENTS,
  PAYMENT_METHODS,
  type Fulfillment,
  type PaymentMethod,
} from "./order-rules";
import type { OrderStatus } from "./order-lifecycle-rules";
import {
  INCIDENT_WINDOW_DAYS,
  ORDER_HISTORY_PAGE_SIZE,
  type DailyReportRange,
  type IncidentInput,
  type IncidentReporter,
  type IncidentType,
  type OrderHistoryFilters,
} from "./order-history-rules";

export interface OrderHistoryEntry {
  id: string;
  number: number;
  status: OrderStatus;
  placedAt: string;
  fulfillment: Fulfillment;
  paymentMethod: PaymentMethod;
  /** Null once the customer deleted the account. */
  customerName: string | null;
  totalCents: number;
  openIncidents: number;
}

export interface OrderHistoryPage {
  orders: OrderHistoryEntry[];
  nextCursor: number | null;
}

export interface OrderIncidentView {
  id: string;
  type: IncidentType;
  description: string;
  reportedBy: IncidentReporter;
  status: "OPEN" | "RESOLVED";
  resolutionNote: string | null;
  createdAt: string;
  createdByName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
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

export interface DailyReport extends DailyReportRange {
  /** The store's IANA zone: days are its local calendar days. */
  timezone: string;
  /** Every day of the range, oldest first, zero when nothing was completed. */
  days: (DailySales & { date: string })[];
  totals: DailySales;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SHA-256 of a validated incident, the body an `Idempotency-Key` stands for. */
export const incidentRequestHash = (input: IncidentInput) =>
  sha256(JSON.stringify([input.type, input.description, input.reportedBy]));

const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

const INCIDENT_COLUMNS = `i.id, i.type, i.description, i.reported_by as "reportedBy", i.status,
  i.resolution_note as "resolutionNote", i.created_at as "createdAt", c.name as "createdByName",
  i.resolved_at as "resolvedAt", r.name as "resolvedByName"`;
const INCIDENT_JOINS = `left join staff_users c on c.id = i.created_by
  left join staff_users r on r.id = i.resolved_by`;

type IncidentRow = Omit<OrderIncidentView, "createdAt" | "resolvedAt"> & {
  createdAt: Date | string;
  resolvedAt: Date | string | null;
};
const incidentView = (row: IncidentRow): OrderIncidentView => ({
  ...row,
  createdAt: iso(row.createdAt)!,
  resolvedAt: iso(row.resolvedAt),
});

/** Incidents of one order, oldest first, in the caller's tenant transaction. */
export async function readIncidents(
  em: EntityManager,
  orderId: string,
): Promise<OrderIncidentView[]> {
  const rows = await em.execute<IncidentRow[]>(
    `select ${INCIDENT_COLUMNS} from order_incidents i ${INCIDENT_JOINS}
      where i.order_id = ? order by i.created_at, i.id`,
    [orderId],
  );
  return rows.map(incidentView);
}

const emptySales = (): DailySales => ({
  count: 0,
  totalCents: 0,
  itemsSubtotalCents: 0,
  deliveryFeeCents: 0,
  byFulfillment: Object.fromEntries(
    FULFILLMENTS.map((mode) => [mode, { count: 0, totalCents: 0 }]),
  ) as Record<Fulfillment, SalesTotal>,
  byPaymentMethod: Object.fromEntries(
    PAYMENT_METHODS.map((method) => [method, { count: 0, totalCents: 0 }]),
  ) as Record<PaymentMethod, SalesTotal>,
});

/**
 * Staff history, daily report and incidents (M4.6, ADR 0019, order-lifecycle.md#histórico).
 * Everything runs in the token's tenant through `TenantTransactions`, under RLS. Incidents never
 * touch the order row: they are records next to it.
 */
@Injectable()
export class OrderHistoryService {
  constructor(private readonly transactions: TenantTransactions) {}

  /** Newest first by number; dates are the store's local days of `placedAt`. */
  history(filters: OrderHistoryFilters): Promise<OrderHistoryPage> {
    return this.transactions.run(async (em) => {
      const rows = await em.execute<
        (Omit<OrderHistoryEntry, "placedAt"> & { placedAt: Date | string })[]
      >(
        `select o.id, o.number, o.status, o.placed_at as "placedAt", o.fulfillment,
                o.payment_method as "paymentMethod", o.customer_name as "customerName",
                o.total_cents as "totalCents",
                (select count(*)::int from order_incidents i
                  where i.order_id = o.id and i.status = 'OPEN') as "openIncidents"
           from orders o join tenants t on t.id = o.tenant_id
          where (?::date is null or o.placed_at >= (?::date)::timestamp at time zone t.timezone)
            and (?::date is null or o.placed_at < (?::date + 1)::timestamp at time zone t.timezone)
            and (?::text is null or o.status = ?::text)
            and (?::text is null or o.fulfillment = ?::text)
            and (?::integer is null or o.number = ?::integer)
            and (?::integer is null or o.number < ?::integer)
          order by o.number desc
          limit ?`,
        [
          filters.from,
          filters.from,
          filters.to,
          filters.to,
          filters.status,
          filters.status,
          filters.fulfillment,
          filters.fulfillment,
          filters.number,
          filters.number,
          filters.cursor,
          filters.cursor,
          ORDER_HISTORY_PAGE_SIZE + 1,
        ],
      );
      const page = rows.slice(0, ORDER_HISTORY_PAGE_SIZE);
      return {
        orders: page.map((row) => ({ ...row, placedAt: iso(row.placedAt)! })),
        nextCursor:
          rows.length > ORDER_HISTORY_PAGE_SIZE
            ? (page.at(-1)?.number ?? null)
            : null,
      };
    });
  }

  /**
   * Count and sum of COMPLETED orders per local day of their completion, split by fulfillment
   * and payment method. Rejected and canceled orders never count.
   */
  /** The active store's billing estimate for one month (ADR 0026); the current one by default. */
  billingReport(period: string | undefined): Promise<BillingReport> {
    return this.transactions.run(async (em) => {
      const execute = <T>(query: string, params: unknown[]) =>
        em.execute<T[]>(query, params);
      const [tenant] = await em.execute<{ timezone: string }[]>(
        "select timezone from tenants where id = ?",
        [currentTenantContext().tenantId],
      );
      const month = await reportMonth(execute, tenant!.timezone, period);
      const entries = await em.execute<ReportEntry[]>(
        `select type, plan, fee_basis_points as "feeBasisPoints", items_subtotal_cents as "itemsSubtotalCents",
                delivery_fee_cents as "deliveryFeeCents", total_cents as "totalCents"
           from billing_entries where period = ?`,
        [month.period],
      );
      const periods = await em.execute<Parameters<typeof planPeriodOf>[0][]>(
        `select plan, fee_basis_points as "feeBasisPoints", monthly_fee_cents as "monthlyFeeCents",
                valid_from as "validFrom", valid_to as "validTo"
           from plan_subscriptions`,
        [],
      );
      return buildBillingReport({
        ...month,
        timeZone: tenant!.timezone,
        entries,
        planPeriods: periods.map(planPeriodOf),
      });
    });
  }

  dailyReport(range: DailyReportRange): Promise<DailyReport> {
    return this.transactions.run(async (em) => {
      const [tenant] = await em.execute<{ timezone: string }[]>(
        "select timezone from tenants where id = ?",
        [currentTenantContext().tenantId],
      );
      const rows = await em.execute<
        {
          day: string;
          fulfillment: Fulfillment;
          paymentMethod: PaymentMethod;
          count: number;
          totalCents: string;
          itemsSubtotalCents: string;
          deliveryFeeCents: string;
        }[]
      >(
        `select to_char((c.at at time zone t.timezone)::date, 'YYYY-MM-DD') as day,
                o.fulfillment, o.payment_method as "paymentMethod", count(*)::int as count,
                sum(o.total_cents)::bigint as "totalCents",
                sum(o.items_subtotal_cents)::bigint as "itemsSubtotalCents",
                sum(o.delivery_fee_cents)::bigint as "deliveryFeeCents"
           from order_status_changes c
           join orders o on o.id = c.order_id
           join tenants t on t.id = o.tenant_id
          where c.to_status = 'COMPLETED' and o.status = 'COMPLETED'
            and c.at >= (?::date)::timestamp at time zone t.timezone
            and c.at < (?::date + 1)::timestamp at time zone t.timezone
          group by 1, 2, 3`,
        [range.from, range.to],
      );
      const days = new Map<string, DailySales>();
      for (
        let day = new Date(`${range.from}T00:00:00Z`);
        day <= new Date(`${range.to}T00:00:00Z`);
        day.setUTCDate(day.getUTCDate() + 1)
      )
        days.set(day.toISOString().slice(0, 10), emptySales());
      const totals = emptySales();
      for (const row of rows) {
        const total = Number(row.totalCents);
        for (const sales of [days.get(row.day)!, totals]) {
          sales.count += row.count;
          sales.totalCents += total;
          sales.itemsSubtotalCents += Number(row.itemsSubtotalCents);
          sales.deliveryFeeCents += Number(row.deliveryFeeCents);
          sales.byFulfillment[row.fulfillment].count += row.count;
          sales.byFulfillment[row.fulfillment].totalCents += total;
          sales.byPaymentMethod[row.paymentMethod].count += row.count;
          sales.byPaymentMethod[row.paymentMethod].totalCents += total;
        }
      }
      return {
        ...range,
        timezone: tenant!.timezone,
        days: [...days].map(([date, sales]) => ({ date, ...sales })),
        totals,
      };
    });
  }

  /**
   * Records an incident on an order of this store: open orders, or ended ones up to
   * `INCIDENT_WINDOW_DAYS` after they ended. The order itself is not changed.
   *
   * Idempotent per store, order and `Idempotency-Key`: the same key and body return the incident
   * the key created (`created: false`), even after the window closed; another body is a 409
   * IDEMPOTENCY_CONFLICT. Two requests with one key insert once: the second waits for the
   * first's unique key and then reads its incident.
   */
  reportIncident(
    orderId: string,
    input: IncidentInput,
    idempotencyKey: string,
    requestId: string | null,
  ): Promise<{ created: boolean; incident: OrderIncidentView }> {
    const keyHash = sha256(idempotencyKey);
    const requestHash = incidentRequestHash(input);
    return this.write(requestId, async (em, staffUserId) => {
      const replay = async () => {
        const [prior] = await em.execute<{ id: string; requestHash: Buffer }[]>(
          `select id, request_hash as "requestHash" from order_incidents
            where order_id = ? and key_hash = ?`,
          [orderId, keyHash],
        );
        if (!prior) return null;
        if (!prior.requestHash.equals(requestHash))
          throw new ApiError(
            HttpStatus.CONFLICT,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was used for a different incident.",
          );
        return {
          created: false,
          incident: await this.readIncident(em, orderId, prior.id),
        };
      };
      const repeated = await replay();
      if (repeated) return repeated;
      const [order] = await em.execute<{ windowClosed: boolean }[]>(
        `select o.status in ('COMPLETED','REJECTED','CANCELED') and coalesce(
                  (select max(c.at) from order_status_changes c
                    where c.order_id = o.id and c.to_status in ('COMPLETED','REJECTED','CANCELED')),
                  o.updated_at) < now() - make_interval(days => ?) as "windowClosed"
           from orders o where o.id = ?`,
        [INCIDENT_WINDOW_DAYS, orderId],
      );
      if (!order)
        throw new ApiError(
          HttpStatus.NOT_FOUND,
          "NOT_FOUND",
          "Order not found.",
        );
      if (order.windowClosed)
        throw new ApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          "INCIDENT_WINDOW_CLOSED",
          `Incidents are recorded up to ${INCIDENT_WINDOW_DAYS} days after the order ended.`,
          { windowDays: INCIDENT_WINDOW_DAYS },
        );
      // A concurrent request with the same key makes this insert wait and then skip.
      const [created] = await em.execute<{ id: string }[]>(
        `insert into order_incidents (tenant_id, order_id, type, description, reported_by,
           created_by, key_hash, request_hash)
         values (current_setting('app.tenant_id')::uuid, ?, ?, ?, ?, ?, ?, ?)
         on conflict (tenant_id, order_id, key_hash) do nothing
         returning id`,
        [
          orderId,
          input.type,
          input.description,
          input.reportedBy,
          staffUserId,
          keyHash,
          requestHash,
        ],
      );
      if (!created) {
        const raced = await replay();
        if (!raced) throw new Error("Incident key conflict without a row.");
        return raced;
      }
      return {
        created: true,
        incident: await this.readIncident(em, orderId, created.id),
      };
    });
  }

  /** Resolves an open incident once; a resolved one is 409 INCIDENT_ALREADY_RESOLVED. */
  resolveIncident(
    orderId: string,
    incidentId: string,
    resolutionNote: string | null,
    requestId: string | null,
  ): Promise<OrderIncidentView> {
    return this.write(requestId, async (em, staffUserId) => {
      const [resolved] = await em.execute<{ id: string }[]>(
        `update order_incidents
            set status = 'RESOLVED', resolution_note = ?, resolved_by = ?, resolved_at = now()
          where id = ? and order_id = ? and status = 'OPEN'
          returning id`,
        [resolutionNote, staffUserId, incidentId, orderId],
      );
      if (!resolved) {
        const [existing] = await em.execute(
          "select 1 from order_incidents where id = ? and order_id = ?",
          [incidentId, orderId],
        );
        throw existing
          ? new ApiError(
              HttpStatus.CONFLICT,
              "INCIDENT_ALREADY_RESOLVED",
              "This incident was already resolved.",
            )
          : new ApiError(
              HttpStatus.NOT_FOUND,
              "NOT_FOUND",
              "Incident not found.",
            );
      }
      return this.readIncident(em, orderId, incidentId);
    });
  }

  /**
   * An incident write: the tenant row is locked FOR SHARE (`whiteoven_lock_tenant_status`), so a
   * suspension either commits first and the policy sees it, or waits for this write. The staff
   * session goes into transaction settings: the database checks the author against it and the
   * audit trigger records it (ADR 0019).
   */
  private write<T>(
    requestId: string | null,
    work: (em: EntityManager, staffUserId: string) => Promise<T>,
  ): Promise<T> {
    return this.transactions.run(async (em) => {
      const { tenantId, actor } = currentTenantContext();
      if (actor.type !== "staff")
        throw new Error("incident writes require staff");
      await em.execute(
        `select set_config('app.incident_actor_id', ?, true),
                set_config('app.incident_session_id', ?, true),
                set_config('app.incident_request_id', ?, true)`,
        [
          actor.staffUserId,
          actor.sessionId,
          requestId && UUID.test(requestId) ? requestId : "",
        ],
      );
      const [tenant] = await em.execute<{ status: TenantStatus | null }[]>(
        "select whiteoven_lock_tenant_status(?) as status",
        [tenantId],
      );
      if (
        !tenant?.status ||
        !TenantStatusPolicy.allows(tenant.status, actor.role, "incidentWrite")
      )
        throw new ApiError(
          HttpStatus.FORBIDDEN,
          "TENANT_NOT_ACTIVE",
          "Store unavailable.",
        );
      return work(em, actor.staffUserId);
    });
  }

  private async readIncident(
    em: EntityManager,
    orderId: string,
    incidentId: string,
  ): Promise<OrderIncidentView> {
    const [row] = await em.execute<IncidentRow[]>(
      `select ${INCIDENT_COLUMNS} from order_incidents i ${INCIDENT_JOINS}
        where i.id = ? and i.order_id = ?`,
      [incidentId, orderId],
    );
    return incidentView(row!);
  }
}
