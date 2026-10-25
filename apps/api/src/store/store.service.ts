import { HttpStatus, Injectable } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ApiError } from "../errors/api-error";
import { currentTenantContext } from "../tenancy/tenant-context";
import {
  TenantStatusPolicy,
  type TenantCapability,
} from "../tenancy/tenant-status-policy";
import type { TenantStatus } from "../tenancy/tenant.entity";
import { TenantTransactions } from "../tenancy/tenant-transaction";
import {
  DEFAULT_STORE_SETTINGS,
  type OpeningHours,
  type StoreSettings,
} from "./store-rules";

export const PAUSE_MINUTES = [15, 30, 60] as const;
export type PauseMinutes = (typeof PAUSE_MINUTES)[number];

export interface StorePause {
  paused: boolean;
  /** ISO instant; null while paused means "until someone reopens". */
  pausedUntil: string | null;
  /** The store's IANA time zone (`tenants.timezone`), for showing `pausedUntil` in local time. */
  timezone: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@Injectable()
export class StoreService {
  constructor(private readonly transactions: TenantTransactions) {}

  /** Settings, hours and pause; defaults when the owner has not saved settings yet. */
  get() {
    return this.transactions.run(async (em) => {
      const [[tenant], [settings], [hours], pause] = await Promise.all([
        em.execute<{ timezone: string }[]>(
          "select timezone from tenants where id = ?",
          [currentTenantContext().tenantId],
        ),
        em.execute<StoreSettings[]>(
          `select fulfillment_modes as "fulfillmentModes", delivery_fee_cents as "deliveryFeeCents",
            minimum_order_cents as "minimumOrderCents", delivery_area_description as "deliveryAreaDescription",
            estimated_prep_minutes as "estimatedPrepMinutes", estimated_delivery_minutes as "estimatedDeliveryMinutes",
            accept_timeout_minutes as "acceptTimeoutMinutes", accepted_payment_methods as "acceptedPaymentMethods",
            contact_phone as "contactPhone", pickup_address as "pickupAddress" from store_settings`,
        ),
        em.execute<OpeningHours[]>(
          "select rules, exceptions from store_opening_hours",
        ),
        this.readPause(em),
      ]);
      return {
        timezone: tenant?.timezone ?? "America/Sao_Paulo",
        settingsSaved: Boolean(settings),
        settings: settings ?? DEFAULT_STORE_SETTINGS,
        openingHours: hours ?? { rules: [], exceptions: [] },
        pause,
      };
    });
  }

  getPause(): Promise<StorePause> {
    return this.transactions.run((em) => this.readPause(em));
  }

  async updateSettings(settings: StoreSettings, requestId: string) {
    await this.perform(requestId, "storeSettingsWrite", (em) =>
      em.execute(
        `insert into store_settings (tenant_id,fulfillment_modes,delivery_fee_cents,minimum_order_cents,
          delivery_area_description,estimated_prep_minutes,estimated_delivery_minutes,accept_timeout_minutes,
          accepted_payment_methods,contact_phone,pickup_address)
        values (current_setting('app.tenant_id')::uuid,?::text[],?,?,?,?,?,?,?::text[],?,?)
        on conflict (tenant_id) do update set fulfillment_modes=excluded.fulfillment_modes,
          delivery_fee_cents=excluded.delivery_fee_cents,minimum_order_cents=excluded.minimum_order_cents,
          delivery_area_description=excluded.delivery_area_description,
          estimated_prep_minutes=excluded.estimated_prep_minutes,
          estimated_delivery_minutes=excluded.estimated_delivery_minutes,
          accept_timeout_minutes=excluded.accept_timeout_minutes,
          accepted_payment_methods=excluded.accepted_payment_methods,
          contact_phone=excluded.contact_phone,pickup_address=excluded.pickup_address,updated_at=now()`,
        [
          pgArray(settings.fulfillmentModes),
          settings.deliveryFeeCents,
          settings.minimumOrderCents,
          settings.deliveryAreaDescription,
          settings.estimatedPrepMinutes,
          settings.estimatedDeliveryMinutes,
          settings.acceptTimeoutMinutes,
          pgArray(settings.acceptedPaymentMethods),
          settings.contactPhone,
          settings.pickupAddress,
        ],
      ),
    );
    return settings;
  }

  /** Replaces the whole week and its exceptions: overlap rules span entries, so they save together. */
  async updateOpeningHours(hours: OpeningHours, requestId: string) {
    await this.perform(requestId, "storeSettingsWrite", (em) =>
      em.execute(
        `insert into store_opening_hours (tenant_id,rules,exceptions)
        values (current_setting('app.tenant_id')::uuid,?::jsonb,?::jsonb)
        on conflict (tenant_id) do update set rules=excluded.rules,exceptions=excluded.exceptions,updated_at=now()`,
        [JSON.stringify(hours.rules), JSON.stringify(hours.exceptions)],
      ),
    );
    return hours;
  }

  /** Pauses for some minutes, or until reopened when `minutes` is null. Replaces a running pause. */
  pause(minutes: PauseMinutes | null, requestId: string): Promise<StorePause> {
    return this.perform(requestId, "storePause", async (em) => {
      await em.execute(
        `insert into store_pauses (tenant_id,paused_until)
        values (current_setting('app.tenant_id')::uuid, case when ?::integer is null then null else now() + make_interval(mins => ?::integer) end)
        on conflict (tenant_id) do update set paused_until=excluded.paused_until,created_at=now()`,
        [minutes, minutes],
      );
      return this.readPause(em);
    });
  }

  async resume(requestId: string): Promise<void> {
    await this.perform(requestId, "storePause", (em) =>
      em.execute("delete from store_pauses"),
    );
  }

  private async readPause(em: EntityManager): Promise<StorePause> {
    const [row] = await em.execute<
      { timezone: string; pausedUntil: Date | null; active: boolean | null }[]
    >(
      `select t.timezone, p.paused_until as "pausedUntil",
        (p.tenant_id is not null and (p.paused_until is null or p.paused_until > now())) as active
      from tenants t left join store_pauses p on p.tenant_id = t.id where t.id = ?`,
      [currentTenantContext().tenantId],
    );
    const timezone = row?.timezone ?? "America/Sao_Paulo";
    if (!row?.active) return { paused: false, pausedUntil: null, timezone };
    return {
      paused: true,
      pausedUntil: row.pausedUntil
        ? new Date(row.pausedUntil).toISOString()
        : null,
      timezone,
    };
  }

  private perform<T>(
    requestId: string,
    capability: TenantCapability,
    work: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.transactions.run(async (em) => {
      const context = currentTenantContext();
      if (context.actor.type !== "staff")
        throw new Error("store writes require staff");
      // The audit trigger reads the same transaction settings as the catalog's.
      await em.execute(
        "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true), set_config('app.catalog_request_id', ?, true)",
        [
          context.actor.staffUserId,
          context.actor.sessionId,
          UUID.test(requestId) ? requestId : "",
        ],
      );
      const [tenant] = await em.execute<{ status: TenantStatus }[]>(
        "select status from tenants where id = ?",
        [context.tenantId],
      );
      if (
        !tenant ||
        !TenantStatusPolicy.allows(
          tenant.status,
          context.actor.role,
          capability,
        )
      )
        throw new ApiError(
          HttpStatus.FORBIDDEN,
          "STORE_WRITE_FORBIDDEN",
          "Store settings are read-only for this store status.",
        );
      return work(em);
    });
  }
}

/** A PostgreSQL array literal of known enum values (never free text). */
const pgArray = (values: readonly string[]) => `{${values.join(",")}}`;
