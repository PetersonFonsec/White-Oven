import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import type { EntityManager } from "@mikro-orm/postgresql";
import { API_CONFIG, type ApiConfig } from "../config/config";
import { customerOf } from "../customer/customer-auth.service";
import { JsonLogger } from "../logging/json-logger";
import type { Fulfillment } from "../order/order-rules";
import { currentTenantContext } from "../tenancy/tenant-context";
import { runInTenant, TenantTransactions } from "../tenancy/tenant-transaction";
import {
  EXPO_BATCH_SIZE,
  type MessageState,
  type NotifiedStatus,
  PUSH_DELIVERY_MAX_AGE_MINUTES,
  type PushMessage,
  deliveryOutcome,
  messageOutcome,
  pushBody,
  pushRetryDelaySeconds,
} from "./push-rules";
import { ExpoPushSender, type PushSender } from "./push-sender";

/** Deliveries one claim takes. */
export const PUSH_BATCH_SIZE = 50;
/** Bound work per tenant per tick so a busy store cannot delay the others. */
export const PUSH_MAX_BATCHES_PER_TENANT_PER_RUN = 4;
/**
 * How long a claim keeps other workers away from its deliveries. Far above the requests of one
 * claim (each at most 10 s); after it, a crashed worker's deliveries are claimed again.
 */
export const PUSH_CLAIM_LEASE_SECONDS = 120;
const PUSH_INTERVAL_MS = 10_000;

export interface PushDeviceStatus {
  enabled: boolean;
}

/** Test seams of one pass; production passes none. */
export interface PushPassHooks {
  /** After a claim committed, before any request of it. */
  afterClaim?: () => Promise<void>;
  /** After a request's check committed, right before the request. */
  beforeRequest?: () => Promise<void>;
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

interface Target {
  messageId: string;
  deliveryId: string;
  deviceId: string;
  token: string;
}

interface Claim {
  claimId: string;
  deliveries: DueDelivery[];
  targets: Target[];
}

const uuids = (ids: readonly string[]) => `{${ids.join(",")}}`;

/**
 * Order status notifications (M5.5, ADR 0027). Devices opt in through the customer routes; the
 * database queues one `push_deliveries` row per store or system transition of an order whose
 * customer has a live device, and this job sends them through Expo Push when `PUSH_DELIVERY=expo`.
 *
 * A pass over a store runs in three steps, and no transaction stays open during a request:
 * 1. Claim: due deliveries are locked, get one `push_messages` row per device and a lease.
 * 2. Send: per request of up to 100 messages, a short transaction first keeps only messages whose
 *    session is still live, holding the session rows `FOR SHARE` until it commits. A revocation
 *    that committed before that check stops the message; one that commits after it finds the
 *    request already authorized (ADR 0027).
 * 3. Settle: each message is settled on its own ticket; only messages without an answer
 *    (a failed request, a rate limit) are retried, with the delivery's backoff.
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
   * Opt-in of this installation for the signed-in session. The installation id, the token and
   * the session each keep one row per store: a rotated token updates the row, and an installation
   * now signed in to another account or session loses its older subscription.
   */
  register(token: string, installationId: string): Promise<PushDeviceStatus> {
    const customerId = customerOf();
    const sessionId = sessionOf();
    return this.transactions.run(
      async (em) => {
        // Registrations of one store are rare and serialize here, whatever row they touch.
        await em.execute(
          `select pg_advisory_xact_lock(hashtextextended('whiteoven:push-devices:' || current_setting('app.tenant_id'), 0))`,
        );
        await em.execute(
          `delete from customer_push_devices
            where (installation_id = ? and (customer_id <> ? or session_id <> ?))
               or ((session_id = ? or token = ?) and installation_id <> ?)`,
          [
            installationId,
            customerId,
            sessionId,
            sessionId,
            token,
            installationId,
          ],
        );
        await em.execute(
          `insert into customer_push_devices (tenant_id, customer_id, session_id, installation_id, token)
           values (current_setting('app.tenant_id')::uuid, ?, ?, ?, ?)
           on conflict (tenant_id, installation_id) do update
             set token = excluded.token, updated_at = now()`,
          [customerId, sessionId, installationId, token],
        );
        return { enabled: true };
      },
      { lockCustomer: true },
    );
  }

  /**
   * Opt-out of this session's device and, when given, of the installation whatever account
   * subscribed it before: a new sign-in on the device ends the previous account's notifications.
   * Idempotent.
   */
  async unregister(installationId: string | null): Promise<void> {
    const sessionId = sessionOf();
    await this.transactions.run((em) =>
      em.execute(
        `delete from customer_push_devices
          where session_id = ? or installation_id = ?::uuid`,
        [sessionId, installationId],
      ),
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
   * request and before its settlement sends those messages again once the lease ends.
   */
  async deliverPending(
    sender: PushSender,
    hooks: PushPassHooks = {},
  ): Promise<void> {
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
            const claim = await runInTenant(this.orm, tenant.id, (tx) =>
              this.claim(tx),
            );
            if (!claim) break;
            await hooks.afterClaim?.();
            if (claim.targets.length)
              await this.send(tenant.id, tenant.name, claim, sender, hooks);
            if (claim.deliveries.length < PUSH_BATCH_SIZE) break;
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

  /** Step 1. Null when nothing is due; deliveries without a live device settle right here. */
  private async claim(tx: EntityManager): Promise<Claim | null> {
    const due = await tx.execute<DueDelivery[]>(
      `select d.id, d.order_id as "orderId", d.customer_id as "customerId",
              d.to_status as "toStatus", d.attempts,
              d.created_at <= now() - make_interval(mins => ?) as stale,
              o.number, o.fulfillment
         from push_deliveries d
         join orders o on o.tenant_id = d.tenant_id and o.id = d.order_id
        where d.state = 'PENDING' and d.next_attempt_at <= now()
          and (d.claimed_until is null or d.claimed_until <= now())
        order by d.created_at, d.id
        limit ? for update of d skip locked`,
      [PUSH_DELIVERY_MAX_AGE_MINUTES, PUSH_BATCH_SIZE],
    );
    if (!due.length) return null;

    const stale = due.filter((delivery) => delivery.stale);
    if (stale.length) {
      const ids = uuids(stale.map((delivery) => delivery.id));
      await tx.execute(
        `update push_messages set state = 'SKIPPED', finished_at = now()
          where delivery_id = any(?::uuid[]) and state = 'PENDING'`,
        [ids],
      );
      await tx.execute(
        `update push_deliveries
            set state = 'EXPIRED', finished_at = now(), claim_id = null, claimed_until = null
          where id = any(?::uuid[])`,
        [ids],
      );
    }
    const live = due.filter((delivery) => !delivery.stale);
    if (!live.length) return { claimId: "", deliveries: due, targets: [] };
    const liveIds = uuids(live.map((delivery) => delivery.id));

    // Sessions first, then devices: the order logout and account deletion lock them in, so a
    // claim and a revocation wait for each other instead of deadlocking.
    const devices = await tx.execute<{ id: string; customerId: string }[]>(
      `select v.id, v.customer_id as "customerId"
         from customer_push_devices v
         join customer_sessions s on s.id = v.session_id
        where v.customer_id = any(?::uuid[])
          and s.revoked_at is null and s.expires_at > now()
        order by v.id
          for share of s`,
      [uuids([...new Set(live.map((delivery) => delivery.customerId))])],
    );
    // The first claim fixes a delivery's devices: one message per device subscribed now.
    const started = new Set(
      (
        await tx.execute<{ deliveryId: string }[]>(
          `select distinct delivery_id as "deliveryId" from push_messages
            where delivery_id = any(?::uuid[])`,
          [liveIds],
        )
      ).map((row) => row.deliveryId),
    );
    const fresh = live
      .filter((delivery) => !started.has(delivery.id))
      .flatMap((delivery) =>
        devices
          .filter((device) => device.customerId === delivery.customerId)
          .map((device) => [delivery.id, device.id] as const),
      );
    if (fresh.length)
      await tx.execute(
        `insert into push_messages (tenant_id, delivery_id, device_id)
         select current_setting('app.tenant_id')::uuid, x.delivery_id, x.device_id
           from unnest(?::uuid[], ?::uuid[]) as x (delivery_id, device_id)`,
        [uuids(fresh.map(([id]) => id)), uuids(fresh.map(([, id]) => id))],
      );
    const targets = await tx.execute<Target[]>(
      `select m.id as "messageId", m.delivery_id as "deliveryId", v.id as "deviceId", v.token
         from push_messages m
         join push_deliveries d on d.id = m.delivery_id
         join customer_push_devices v on v.id = m.device_id and v.customer_id = d.customer_id
        where m.delivery_id = any(?::uuid[]) and m.state = 'PENDING'
          and v.id = any(?::uuid[])
        order by d.created_at, d.id, m.id`,
      [liveIds, uuids(devices.map((device) => device.id))],
    );
    await tx.execute(
      `update push_messages set state = 'SKIPPED', finished_at = now()
        where delivery_id = any(?::uuid[]) and state = 'PENDING'
          and not (id = any(?::uuid[]))`,
      [liveIds, uuids(targets.map((target) => target.messageId))],
    );
    const claimId = randomUUID();
    const withTargets = new Set(targets.map((target) => target.deliveryId));
    if (withTargets.size)
      await tx.execute(
        `update push_deliveries
            set claim_id = ?, claimed_until = now() + make_interval(secs => ?)
          where id = any(?::uuid[])`,
        [claimId, PUSH_CLAIM_LEASE_SECONDS, uuids([...withTargets])],
      );
    for (const delivery of live)
      if (!withTargets.has(delivery.id))
        await this.settleDelivery(tx, delivery, null);
    return {
      claimId,
      deliveries: due,
      targets,
    };
  }

  /** Steps 2 and 3, one request of up to 100 messages at a time. */
  private async send(
    tenantId: string,
    storeName: string,
    claim: Claim,
    sender: PushSender,
    hooks: PushPassHooks,
  ): Promise<void> {
    const byId = new Map(
      claim.deliveries.map((delivery) => [delivery.id, delivery]),
    );
    const settled = new Map<string, "SENT" | "FAILED" | "SKIPPED">();
    const gone: string[] = [];
    for (
      let start = 0;
      start < claim.targets.length;
      start += EXPO_BATCH_SIZE
    ) {
      const chunk = claim.targets.slice(start, start + EXPO_BATCH_SIZE);
      const allowed = await runInTenant(this.orm, tenantId, (tx) =>
        this.stillAllowed(tx, claim.claimId, chunk),
      );
      for (const target of chunk)
        if (!allowed.has(target.messageId))
          settled.set(target.messageId, "SKIPPED");
      const sending = chunk.filter((target) => allowed.has(target.messageId));
      if (!sending.length) continue;
      const messages: PushMessage[] = sending.map((target) => {
        const delivery = byId.get(target.deliveryId)!;
        return {
          to: target.token,
          title: storeName,
          body: pushBody(
            delivery.toStatus,
            delivery.fulfillment,
            delivery.number,
          ),
          data: { type: "order-status", orderId: delivery.orderId },
        };
      });
      await hooks.beforeRequest?.();
      try {
        const tickets = await sender.send(messages);
        if (tickets.length !== sending.length)
          throw new Error("ticket count mismatch");
        sending.forEach((target, index) => {
          const outcome = messageOutcome(tickets[index]!);
          if (outcome === "RETRY") return;
          if (outcome === "GONE") gone.push(target.deviceId);
          settled.set(
            target.messageId,
            outcome === "GONE" ? "FAILED" : outcome,
          );
        });
      } catch {
        // Only this request's messages stay pending; earlier requests keep their tickets.
        this.logger.write("warn", "push request failed", {
          tenantId,
          messages: sending.length,
        });
      }
    }
    await runInTenant(this.orm, tenantId, async (tx) => {
      // Devices before messages, as a revocation does (its delete nulls their messages).
      if (gone.length)
        await tx.execute(
          "delete from customer_push_devices where id = any(?::uuid[])",
          [uuids(gone)],
        );
      for (const state of ["SENT", "FAILED", "SKIPPED"] as const) {
        const ids = [...settled]
          .filter(([, value]) => value === state)
          .map(([id]) => id);
        if (ids.length)
          await tx.execute(
            `update push_messages m set state = ?, finished_at = now()
               from push_deliveries d
              where m.id = any(?::uuid[]) and m.state = 'PENDING'
                and d.id = m.delivery_id and d.claim_id = ?`,
            [state, uuids(ids), claim.claimId],
          );
      }
      const claimed = new Set(claim.targets.map((target) => target.deliveryId));
      for (const id of claimed)
        await this.settleDelivery(tx, byId.get(id)!, claim.claimId);
    });
  }

  /**
   * The synchronization point with session revocation: the messages of `chunk` whose device
   * still belongs to the delivery's customer through a live session. `FOR SHARE` makes a
   * revocation in progress finish first, so it is seen; the lock ends with this transaction,
   * before the request.
   */
  private async stillAllowed(
    tx: EntityManager,
    claimId: string,
    chunk: readonly Target[],
  ): Promise<Set<string>> {
    const rows = await tx.execute<{ id: string }[]>(
      `select m.id
         from push_messages m
         join push_deliveries d on d.id = m.delivery_id and d.claim_id = ?
                               and d.claimed_until > now()
         join customer_push_devices v on v.id = m.device_id and v.customer_id = d.customer_id
         join customer_sessions s on s.id = v.session_id
        where m.id = any(?::uuid[]) and m.state = 'PENDING'
          and s.revoked_at is null and s.expires_at > now()
          for share of s`,
      [claimId, uuids(chunk.map((target) => target.messageId))],
    );
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Settles a delivery from its messages. `claimId` null settles one that was never claimed;
   * otherwise only while the claim is still this worker's (an expired lease left it to another).
   */
  private async settleDelivery(
    tx: EntityManager,
    delivery: DueDelivery,
    claimId: string | null,
  ): Promise<void> {
    const [current] = await tx.execute<{ attempts: number }[]>(
      `select attempts from push_deliveries
        where id = ? and state = 'PENDING' and claim_id is not distinct from ?
        for update`,
      [delivery.id, claimId],
    );
    if (!current) return;
    const states = (
      await tx.execute<{ state: MessageState }[]>(
        "select state from push_messages where delivery_id = ?",
        [delivery.id],
      )
    ).map((row) => row.state);
    const outcome = deliveryOutcome(
      states.length ? states : ["SKIPPED"],
      current.attempts,
    );
    if (outcome === "RETRY") {
      await tx.execute(
        `update push_deliveries
            set attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => ?),
                claim_id = null, claimed_until = null
          where id = ?`,
        [pushRetryDelaySeconds(current.attempts + 1), delivery.id],
      );
      return;
    }
    if (outcome === "FAILED" && states.includes("PENDING"))
      await tx.execute(
        `update push_messages set state = 'FAILED', finished_at = now()
          where delivery_id = ? and state = 'PENDING'`,
        [delivery.id],
      );
    await tx.execute(
      `update push_deliveries
          set state = ?, finished_at = now(), claim_id = null, claimed_until = null,
              attempts = attempts + ?
        where id = ?`,
      [outcome, states.includes("PENDING") ? 1 : 0, delivery.id],
    );
  }
}

function sessionOf(): string {
  const { actor } = currentTenantContext();
  if (actor.type !== "customer") throw new Error("customer route required");
  return actor.sessionId;
}
