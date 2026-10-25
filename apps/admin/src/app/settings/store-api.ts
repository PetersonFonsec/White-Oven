import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import type { CatalogPolicy } from "../catalog/catalog-api";

const STORE = "/v1/admin/store";

export type FulfillmentMode = "DELIVERY" | "PICKUP";
export type PaymentMethod = "CASH" | "CARD_ON_DELIVERY" | "PIX_ON_DELIVERY";

export interface StoreSettings {
  fulfillmentModes: FulfillmentMode[];
  deliveryFeeCents: number;
  minimumOrderCents: number;
  deliveryAreaDescription: string | null;
  estimatedPrepMinutes: number;
  estimatedDeliveryMinutes: number;
  acceptTimeoutMinutes: number;
  acceptedPaymentMethods: PaymentMethod[];
  contactPhone: string | null;
  pickupAddress: string | null;
}

export interface TimeRange {
  opensAt: string;
  closesAt: string;
}
export interface OpeningRule extends TimeRange {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}
export interface ClosureException {
  date: string;
  closed: boolean;
  shifts: TimeRange[];
}
export interface OpeningHours {
  rules: OpeningRule[];
  exceptions: ClosureException[];
}

export interface StorePause {
  paused: boolean;
  /** Null while paused: until someone reopens. */
  pausedUntil: string | null;
  /** The store's IANA time zone, in which `pausedUntil` is shown. */
  timezone: string;
}

export interface StoreState {
  timezone: string;
  settingsSaved: boolean;
  settings: StoreSettings;
  openingHours: OpeningHours;
  pause: StorePause;
}

export type PauseMinutes = 15 | 30 | 60;

export const BRAND_COLOR_TOKENS = [
  "primary",
  "primaryHover",
  "primaryPressed",
  "onPrimary",
  "accentText",
] as const;
export type BrandColorToken = (typeof BRAND_COLOR_TOKENS)[number];
export type BrandColors = Record<BrandColorToken, string>;
export type FixedColorToken = "surface" | "cream";

export interface ContrastRule {
  foreground: BrandColorToken | FixedColorToken;
  background: BrandColorToken | FixedColorToken;
  minimum: number;
  usage: string;
}

export interface BrandThemeInput {
  colorOverrides: Partial<BrandColors>;
  logoAssetId: string | null;
  iconAssetId: string | null;
}
export interface BrandTheme extends BrandThemeInput {
  version: number;
}

/** The brand as the API keeps it, with the rules the editor previews against. */
export interface BrandState {
  saved: boolean;
  theme: BrandTheme;
  colors: BrandColors;
  defaults: BrandColors;
  fixedColors: Record<FixedColorToken, string>;
  contrastRules: ContrastRule[];
  imageRules: { logoMinSide: number; iconMinSide: number };
}

@Injectable({ providedIn: "root" })
export class StoreApi {
  private readonly http = inject(HttpClient);

  get(): Promise<StoreState> {
    return firstValueFrom(this.http.get<StoreState>(`${STORE}/settings`));
  }

  updateSettings(settings: StoreSettings): Promise<StoreSettings> {
    return firstValueFrom(
      this.http.put<StoreSettings>(`${STORE}/settings`, settings),
    );
  }

  updateOpeningHours(hours: OpeningHours): Promise<OpeningHours> {
    return firstValueFrom(
      this.http.put<OpeningHours>(`${STORE}/opening-hours`, hours),
    );
  }

  brand(): Promise<BrandState> {
    return firstValueFrom(this.http.get<BrandState>(`${STORE}/brand`));
  }

  updateBrand(theme: BrandThemeInput): Promise<BrandState> {
    return firstValueFrom(this.http.put<BrandState>(`${STORE}/brand`, theme));
  }

  updatePricingPolicy(policy: CatalogPolicy): Promise<CatalogPolicy> {
    return firstValueFrom(
      this.http.put<CatalogPolicy>("/v1/admin/catalog/pricing-policy", policy),
    );
  }

  pause(): Promise<StorePause> {
    return firstValueFrom(this.http.get<StorePause>(`${STORE}/pause`));
  }

  /** Pauses new orders for some minutes, or until reopened when `minutes` is null. */
  startPause(minutes: PauseMinutes | null): Promise<StorePause> {
    return firstValueFrom(
      this.http.put<StorePause>(`${STORE}/pause`, { minutes }),
    );
  }

  endPause(): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`${STORE}/pause`));
  }
}
