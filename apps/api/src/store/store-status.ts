import type { TenantStatus } from "../tenancy/tenant.entity";
import { type OpeningHours, shiftsOfDate } from "./store-rules";

/**
 * Whether a store is open at an instant (domain-model.md#openingrule-e-closureexception, M4.1).
 * Pure: the caller reads the tenant, its hours and its pause, and passes the instant, so the
 * scenarios H1–H10 run without a database or a clock.
 */

export const STORE_STATUS_REASONS = [
  "OPEN",
  "TENANT_NOT_ACTIVE",
  "PAUSED",
  "OUTSIDE_HOURS",
] as const;
export type StoreStatusReason = (typeof STORE_STATUS_REASONS)[number];

export interface StoreStatusInput {
  tenantStatus: TenantStatus;
  /** IANA time zone of the store (`tenants.timezone`). */
  timezone: string;
  hours: OpeningHours;
  /** The `store_pauses` row, if any; `pausedUntil` null means paused until someone reopens. */
  pause: { pausedUntil: Date | null } | null;
  at: Date;
}

export interface StoreStatus {
  open: boolean;
  reason: StoreStatusReason;
}

const DAY = 24 * 60;
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The local operational day (days since 1970-01-01, as `parseLocalDate`) and minute of the day of
 * an instant in `timezone`. Seconds are dropped: shifts start and end on whole minutes and are
 * half-open, so 01:59:59 is still inside a shift ending at 02:00. An instant always has one wall
 * clock time, so daylight saving changes need no special case. An unknown zone throws RangeError.
 */
export function localMinuteOf(
  at: Date,
  timezone: string,
): { day: number; minute: number } {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(at).map((item) => [item.type, item.value]),
  );
  const day =
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) /
    (DAY * 60_000);
  return { day, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * Open when the tenant is ACTIVE, no pause is running (`pausedUntil` null or not after `at`) and
 * the local time falls in a shift of its own operational date or in one of the previous date
 * that crosses midnight. The pause wins over the hours; an exception replaces only its own date,
 * so the previous date's late shift still counts (H4) unless that date is closed (H6).
 */
export function storeStatusAt(input: StoreStatusInput): StoreStatus {
  if (input.tenantStatus !== "ACTIVE")
    return { open: false, reason: "TENANT_NOT_ACTIVE" };
  const { pause } = input;
  if (
    pause &&
    (pause.pausedUntil === null ||
      pause.pausedUntil.getTime() > input.at.getTime())
  )
    return { open: false, reason: "PAUSED" };
  const { day, minute } = localMinuteOf(input.at, input.timezone);
  const inside = (operationalDay: number, offset: number) =>
    shiftsOfDate(input.hours, operationalDay).some(
      (shift) => shift.start <= minute + offset && minute + offset < shift.end,
    );
  return inside(day, 0) || inside(day - 1, DAY)
    ? { open: true, reason: "OPEN" }
    : { open: false, reason: "OUTSIDE_HOURS" };
}
