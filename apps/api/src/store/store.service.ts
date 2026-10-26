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
  BRAND_COLOR_TOKENS,
  type BrandColorToken,
  type BrandError,
  type BrandThemeInput,
  CONTRAST_RULES,
  DEFAULT_BRAND_COLORS,
  FIXED_COLORS,
  ICON_MIN_SIDE,
  LOGO_MIN_SIDE,
  resolveBrandColors,
} from "./brand-rules";
import {
  DEFAULT_STORE_SETTINGS,
  type OpeningHours,
  type StoreSettings,
} from "./store-rules";
import { type StoreStatusReason, storeStatusAt } from "./store-status";

export const PAUSE_MINUTES = [15, 30, 60] as const;
export type PauseMinutes = (typeof PAUSE_MINUTES)[number];

export interface StorePause {
  paused: boolean;
  /** ISO instant; null while paused means "until someone reopens". */
  pausedUntil: string | null;
  /** The store's IANA time zone (`tenants.timezone`), for showing `pausedUntil` in local time. */
  timezone: string;
}

/** `GET /v1/public/stores/{slug}/status` (M4.1). */
export interface PublicStoreStatus {
  open: boolean;
  reason: StoreStatusReason;
  /** ISO instant the store reopens by itself; set only while `reason` is PAUSED with an end. */
  pausedUntil: string | null;
  timezone: string;
  /** The database instant the status was computed for. */
  checkedAt: string;
}

/**
 * `GET /v1/public/stores/{slug}` (M5.1, ADR 0020): what the app needs to wear the store's brand.
 * Colors are already resolved over the WhiteOven defaults; images arrive with the public menu
 * images (M5.2), so nothing here points at an asset.
 */
export interface PublicStoreProfile {
  slug: string;
  name: string;
  brand: {
    /** `brand_themes.version`; 0 while the store uses the WhiteOven defaults. */
    version: number;
    colors: Record<BrandColorToken, string>;
  };
}

export interface BrandTheme extends BrandThemeInput {
  /** Grows on every save; 0 while the store uses the WhiteOven defaults. */
  version: number;
}

/** The brand as saved, the colors it resolves to, and the rules the panel previews against. */
export interface BrandState {
  saved: boolean;
  theme: BrandTheme;
  colors: Record<BrandColorToken, string>;
  defaults: typeof DEFAULT_BRAND_COLORS;
  fixedColors: typeof FIXED_COLORS;
  contrastRules: typeof CONTRAST_RULES;
  imageRules: { logoMinSide: number; iconMinSide: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Open or closed now, from the tenant, its hours and its pause read in one statement, inside the
 * caller's transaction (the public status and the order creation of M4.3). The instant is the
 * database clock, the same one that writes `store_pauses.paused_until`.
 */
export async function readStoreStatus(
  em: EntityManager,
  tenantId: string,
): Promise<PublicStoreStatus> {
  const [row] = await em.execute<
    {
      status: TenantStatus;
      timezone: string;
      rules: OpeningHours["rules"] | null;
      exceptions: OpeningHours["exceptions"] | null;
      paused: boolean;
      pausedUntil: Date | null;
      now: Date;
    }[]
  >(
    `select t.status, t.timezone, h.rules, h.exceptions,
      p.tenant_id is not null as paused, p.paused_until as "pausedUntil", now() as now
    from tenants t
    left join store_opening_hours h on h.tenant_id = t.id
    left join store_pauses p on p.tenant_id = t.id
    where t.id = ?`,
    [tenantId],
  );
  if (!row) throw new Error("store status: tenant not found");
  const at = new Date(row.now);
  const pausedUntil = row.pausedUntil ? new Date(row.pausedUntil) : null;
  const status = storeStatusAt({
    tenantStatus: row.status,
    timezone: row.timezone,
    hours: { rules: row.rules ?? [], exceptions: row.exceptions ?? [] },
    pause: row.paused ? { pausedUntil } : null,
    at,
  });
  return {
    ...status,
    pausedUntil:
      status.reason === "PAUSED" && pausedUntil
        ? pausedUntil.toISOString()
        : null,
    timezone: row.timezone,
    checkedAt: at.toISOString(),
  };
}

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

  /**
   * Open or closed now, from the tenant, its hours and its pause read in one statement. The
   * instant is the database clock, the same one that writes `store_pauses.paused_until`.
   */
  getStatus(): Promise<PublicStoreStatus> {
    return this.transactions.run((em) =>
      readStoreStatus(em, currentTenantContext().tenantId),
    );
  }

  /** Name and brand colors of the store in the URL; read on every request, never cached here. */
  getPublicProfile(): Promise<PublicStoreProfile> {
    return this.transactions.run(async (em) => {
      const [[tenant], brand] = await Promise.all([
        em.execute<{ slug: string; name: string }[]>(
          "select slug, display_name as name from tenants where id = ?",
          [currentTenantContext().tenantId],
        ),
        this.readBrand(em),
      ]);
      return {
        slug: tenant!.slug,
        name: tenant!.name,
        brand: { version: brand.theme.version, colors: brand.colors },
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

  getBrand(): Promise<BrandState> {
    return this.transactions.run((em) => this.readBrand(em));
  }

  /**
   * Saves a theme that already passed `validateBrandTheme`, after checking its images belong to
   * this store and have the right size. Each save is a new version.
   */
  updateBrand(theme: BrandThemeInput, requestId: string): Promise<BrandState> {
    return this.perform(requestId, "storeSettingsWrite", async (em) => {
      const ids = [theme.logoAssetId, theme.iconAssetId].filter(
        (id): id is string => id !== null,
      );
      const images = ids.length
        ? await em.execute<{ id: string; width: number; height: number }[]>(
            "select id, width, height from image_assets where id = any(?::uuid[])",
            [`{${ids.join(",")}}`],
          )
        : [];
      const image = (id: string | null) => images.find((row) => row.id === id);
      const errors: BrandError[] = [];
      if (theme.logoAssetId) {
        const logo = image(theme.logoAssetId);
        if (!logo)
          errors.push({ code: "BRAND_IMAGE_NOT_FOUND", path: "logoAssetId" });
        else if (Math.max(logo.width, logo.height) < LOGO_MIN_SIDE)
          errors.push({ code: "BRAND_LOGO_TOO_SMALL", path: "logoAssetId" });
      }
      if (theme.iconAssetId) {
        const icon = image(theme.iconAssetId);
        if (!icon)
          errors.push({ code: "BRAND_IMAGE_NOT_FOUND", path: "iconAssetId" });
        else if (icon.width !== icon.height)
          errors.push({ code: "BRAND_ICON_NOT_SQUARE", path: "iconAssetId" });
        else if (icon.width < ICON_MIN_SIDE)
          errors.push({ code: "BRAND_ICON_TOO_SMALL", path: "iconAssetId" });
      }
      if (errors.length)
        throw new ApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          "BRAND_THEME_INVALID",
          "Invalid brand theme.",
          { errors },
        );
      await em.execute(
        `insert into brand_themes (tenant_id,color_overrides,logo_asset_id,icon_asset_id)
        values (current_setting('app.tenant_id')::uuid,?::jsonb,?,?)
        on conflict (tenant_id) do update set color_overrides=excluded.color_overrides,
          logo_asset_id=excluded.logo_asset_id,icon_asset_id=excluded.icon_asset_id,
          version=brand_themes.version+1,updated_at=now()`,
        [
          JSON.stringify(theme.colorOverrides),
          theme.logoAssetId,
          theme.iconAssetId,
        ],
      );
      return this.readBrand(em);
    });
  }

  private async readBrand(em: EntityManager): Promise<BrandState> {
    const [row] = await em.execute<BrandTheme[]>(
      `select color_overrides as "colorOverrides", logo_asset_id as "logoAssetId",
        icon_asset_id as "iconAssetId", version from brand_themes`,
    );
    const theme: BrandTheme = row
      ? {
          // Token order, whatever order jsonb kept.
          colorOverrides: Object.fromEntries(
            BRAND_COLOR_TOKENS.flatMap((token) =>
              row.colorOverrides[token]
                ? [[token, row.colorOverrides[token]]]
                : [],
            ),
          ),
          logoAssetId: row.logoAssetId,
          iconAssetId: row.iconAssetId,
          version: row.version,
        }
      : {
          colorOverrides: {},
          logoAssetId: null,
          iconAssetId: null,
          version: 0,
        };
    return {
      saved: Boolean(row),
      theme,
      colors: resolveBrandColors(theme.colorOverrides),
      defaults: DEFAULT_BRAND_COLORS,
      fixedColors: FIXED_COLORS,
      contrastRules: CONTRAST_RULES,
      imageRules: { logoMinSide: LOGO_MIN_SIDE, iconMinSide: ICON_MIN_SIDE },
    };
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
