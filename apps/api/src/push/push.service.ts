import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import type { EntityManager } from "@mikro-orm/postgresql";
import { API_CONFIG, type ApiConfig } from "../config/config";
import { customerOf } from "../customer/customer-auth.service";
import { JsonLogger } from "../logging/json-logger";
import type { Fulfillment } from "../order/order-rules";
import { currentTenantContext } from "../tenancy/tenant-context";
import { runInTenant, TenantTransactions } from "../tenancy/tenant-transaction";
import {
  type NotifiedStatus,
  PUSH_DELIVERY_MAX_AGE_MINUTES,
  PUSH_MAX_ATTEMPTS,
  type PushMessage,
  PushRequestError,
  type PushTicket,
  deliveryOutcome,
  pushBody,
  pushRetryDelaySeconds,
} from "./push-rules";
import { ExpoPushSender, type PushSender } from "./push-sender";

/** Deliveries one tenant transaction locks and sends. */
export const PUSH_BATCH_SIZE = 50;
/** Bound work per tenant per tick so a busy store cannot delay the others. */
export const PUSH_MAX_BATCHES_PER_TENANT_PER_RUN = 4;
const PUSH_INTERVAL_MS = 10_000;

export interface PushDeviceStatus {
  enabled: boolean;
}

interface DueDelivery {
  id: string;
  orderId: string;
  customerId: string;
  toStatus: NotifiedStatus;
  attempts: number;
  stale: boolean;
  number: number;
  fulfillment: Fulfillment;
}

/**
 * Order status notifications (M5.5, ADR 0027). Devices opt in through the customer routes; the
 * database queues one `push_deliveries` row per store or system transition of an order whose
 * customer has a live device, and this job sends them through Expo Push when `PUSH_DELIVERY=expo`.
 */
@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly sender: PushSender | null;

  constructor(
    private readonly transactions: TenantTransactions,
    private readonly orm: MikroORM,
    private readonly logger: JsonLogger,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.sender =
      config.push.delivery === "expo"
        ? new ExpoPushSender(config.push.expoAccessToken)
        : null;
  }

  onModuleInit(): void {
    if (!this.sender) return;
    const sender = this.sender;
    this.timer = setInterval(
      () => void this.deliverPending(sender),
      PUSH_INTERVAL_MS,
    );
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Opt-in of this signed-in device. The token belongs to the current session: a new token of
   * the same session replaces the old one, and a token another account of this store registered
   * moves to this one (the device signed in again).
   */
  register(token: string): Promise<PushDeviceStatus> {
    const customerId = customerOf();
    const sessionId = sessionOf();
    return this.transactions.run(
      async (em) => {
        await em.execute(
          "delete from customer_push_devices where session_id = ? and token <> ?",
          [sessionId, token],
        );
        await em.execute(
          `insert into customer_push_devices (tenant_id, customer_id, session_id, token)
           values (current_setting('app.tenant_id')::uuid, ?, ?, ?)
           on conflict (tenant_id, token) do update
             set customer_id = excluded.customer_id, session_id = excluded.session_id, updated_at = now()`,
          [customerId, sessionId, token],
        );
        return { enabled: true };
      },
      { lockCustomer: true },
    );
  }

  /** Opt-out of this device. Idempotent. */
  async unregister(): Promise<void> {
    const sessionId = sessionOf();
    await this.transactions.run((em) =>
      em.execute("delete from customer_push_devices where session_id = ?", [
        sessionId,
      ]),
    );
  }

  status(): Promise<PushDeviceStatus> {
    const sessionId = sessionOf();
    return this.transactions.run(async (em) => {
      const rows = await em.execute(
        "select 1 from customer_push_devices where session_id = ?",
        [sessionId],
      );
      return { enabled: rows.length > 0 };
    });
  }

  /**
   * One pass over every store's due deliveries. At least once: a crash after Expo accepted a
   * batch and before the commit sends it again on the next pass.
   */
  async deliverPending(sender: PushSender): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const em = this.orm.em.fork({ clear: true });
      const tenants = await em.execute<{ id: string; name: string }[]>(
        `select id, display_name as name from tenants where status <> 'ONBOARDING'`,
      );
      for (const tenant of tenants)
        for (
          let batch = 1;
          batch <= PUSH_MAX_BATCHES_PER_TENANT_PER_RUN;
          batch++
        ) {
          try {
            const processed = await runInTenant(this.orm, tenant.id, (tx) =>
              this.deliverBatch(tx, tenant.name, sender),
            );
            if (processed < PUSH_BATCH_SIZE) break;
          } catch {
            this.logger.write("error", "push delivery batch failed", {
              tenantId: tenant.id,
              batch,
            });
            break;
          }
        }
    } catch {
      this.logger.write("error", "push delivery job failed");
    } finally {
      this.running = false;
    }
  }

  private async deliverBatch(
    tx: EntityManager,
    storeName: string,
    sender: PushSender,
  ): Promise<number> {
    const due = await tx.execute<DueDelivery[]>(
      `select d.id, d.order_id as "orderId", d.customer_id as "customerId",
              d.to_status as "toStatus", d.attempts,
              d.created_at <= now() - make_interval(mins => ?) as stale,
              o.number, o.fulfillment
         from push_deliveries d
         join orders o on o.tenant_id = d.tenant_id and o.id = d.order_id
        where d.state = 'PENDING' and d.next_attempt_at <= now()
        order by d.created_at, d.id
        limit ? for update of d skip locked`,
      [PUSH_DELIVERY_MAX_AGE_MINUTES, PUSH_BATCH_SIZE],
    );
    if (!due.length) return 0;
    const finish = (ids: string[], state: string) =>
      ids.length
        ? tx.execute(
            `update push_deliveries set state = ?, finished_at = now()
              where id = any(?::uuid[])`,
            [state, `{${ids.join(",")}}`],
          )
        : Promise.resolve();

    const live = due.filter((delivery) => !delivery.stale);
    await finish(
      due.filter((delivery) => delivery.stale).map((delivery) => delivery.id),
      "EXPIRED",
    );
    const customers = [...new Set(live.map((delivery) => delivery.customerId))];
    const devices = customers.length
      ? await tx.execute<{ id: string; customerId: string; token: string }[]>(
          `select d.id, d.customer_id as "customerId", d.token
             from customer_push_devices d
             join customer_sessions s on s.id = d.session_id
            where d.customer_id = any(?::uuid[])
              and s.revoked_at is null and s.expires_at > now()
            order by d.created_at, d.id`,
          [`{${customers.join(",")}}`],
        )
      : [];

    const messages: PushMessage[] = [];
    const sent: { delivery: DueDelivery; deviceIds: string[]; at: number }[] =
      [];
    const skipped: string[] = [];
    for (const delivery of live) {
      const own = devices.filter(
        (device) => device.customerId === delivery.customerId,
      );
      if (!own.length) {
        skipped.push(delivery.id);
        continue;
      }
      sent.push({
        delivery,
        deviceIds: own.map((device) => device.id),
        at: messages.length,
      });
      for (const device of own)
        messages.push({
          to: device.token,
          title: storeName,
          body: pushBody(
            delivery.toStatus,
            delivery.fulfillment,
            delivery.number,
          ),
          data: { type: "order-status", orderId: delivery.orderId },
        });
    }
    await finish(skipped, "SKIPPED");
    if (!messages.length) return due.length;

    let tickets: PushTicket[];
    try {
      tickets = await sender.send(messages);
      if (tickets.length !== messages.length)
        throw new PushRequestError("ticket count mismatch");
    } catch (error) {
      if (!(error instanceof PushRequestError)) throw error;
      await this.retry(
        tx,
        sent.map(({ delivery }) => delivery),
      );
      this.logger.write("warn", "push request failed", {
        deliveries: sent.length,
      });
      return due.length;
    }

    const gone: string[] = [];
    const outcomes = { SENT: [] as string[], FAILED: [] as string[] };
    const retries: DueDelivery[] = [];
    for (const { delivery, deviceIds, at } of sent) {
      const own = tickets.slice(at, at + deviceIds.length);
      own.forEach((ticket, index) => {
        if (!ticket.ok && ticket.deviceGone) gone.push(deviceIds[index]!);
      });
      const outcome = deliveryOutcome(own);
      if (outcome === "RETRY") retries.push(delivery);
      else outcomes[outcome].push(delivery.id);
    }
    if (gone.length)
      await tx.execute(
        "delete from customer_push_devices where id = any(?::uuid[])",
        [`{${gone.join(",")}}`],
      );
    await finish(outcomes.SENT, "SENT");
    await finish(outcomes.FAILED, "FAILED");
    await this.retry(tx, retries);
    return due.length;
  }

  private async retry(
    tx: EntityManager,
    deliveries: DueDelivery[],
  ): Promise<void> {
    for (const delivery of deliveries) {
      const attempts = delivery.attempts + 1;
      if (attempts >= PUSH_MAX_ATTEMPTS)
        await tx.execute(
          `update push_deliveries set state = 'FAILED', attempts = ?, finished_at = now() where id = ?`,
          [attempts, delivery.id],
        );
      else
        await tx.execute(
          `update push_deliveries
              set attempts = ?, next_attempt_at = now() + make_interval(secs => ?)
            where id = ?`,
          [attempts, pushRetryDelaySeconds(attempts), delivery.id],
        );
    }
  }
}

function sessionOf(): string {
  const { actor } = currentTenantContext();
  if (actor.type !== "customer") throw new Error("customer route required");
  return actor.sessionId;
}
