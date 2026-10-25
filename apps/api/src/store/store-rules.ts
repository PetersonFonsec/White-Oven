/**
 * Store settings and opening hours rules (docs/architecture/domain-model.md#storesettings and
 * #openingrule-e-closureexception). Pure functions: the API validates every write with them, and
 * M4.1 builds the open/closed status on `shiftsOfDate`. The panel shows the paths these
 * functions report, so it never needs a copy of the rules.
 */

export type RuleResult<T, E> =
  { ok: true; value: T } | { ok: false; errors: E[] };

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Each missing key and then each unknown key, as paths. */
function keyIssues(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): string[] {
  const at = (key: string) => (path ? `${path}.${key}` : key);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value)
    .filter((key) => !keys.includes(key))
    .sort();
  return [...missing, ...unknown].map(at);
}

/** Money columns are PostgreSQL integer. */
const isCents = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 2_147_483_647;

export const FULFILLMENT_MODES = ["DELIVERY", "PICKUP"] as const;
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];

export const PAYMENT_METHODS = [
  "CASH",
  "CARD_ON_DELIVERY",
  "PIX_ON_DELIVERY",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface StoreSettings {
  fulfillmentModes: FulfillmentMode[];
  /** Single fixed fee (Q-04), zero allowed. */
  deliveryFeeCents: number;
  /** Applied to the items subtotal. */
  minimumOrderCents: number;
  /** Free text shown to customers; nothing is computed from it. */
  deliveryAreaDescription: string | null;
  estimatedPrepMinutes: number;
  estimatedDeliveryMinutes: number;
  /** Minutes before an order not yet accepted is rejected automatically (Q-07). */
  acceptTimeoutMinutes: number;
  acceptedPaymentMethods: PaymentMethod[];
  contactPhone: string | null;
  /** Required while PICKUP is offered. */
  pickupAddress: string | null;
}

/** What a store has before its owner saves settings: Q-04 and Q-07 recommendations. */
export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  fulfillmentModes: ["DELIVERY"],
  deliveryFeeCents: 0,
  minimumOrderCents: 0,
  deliveryAreaDescription: null,
  estimatedPrepMinutes: 30,
  estimatedDeliveryMinutes: 40,
  acceptTimeoutMinutes: 10,
  acceptedPaymentMethods: [...PAYMENT_METHODS],
  contactPhone: null,
  pickupAddress: null,
};

export const STORE_MINUTES_MAX = 240;
export const ACCEPT_TIMEOUT_MINUTES_MAX = 60;
export const DELIVERY_AREA_MAX_LENGTH = 500;
export const PICKUP_ADDRESS_MAX_LENGTH = 300;
export const CONTACT_PHONE_MAX_LENGTH = 30;

export const STORE_SETTINGS_ERROR = "STORE_SETTINGS_INVALID" as const;
export interface StoreSettingsError {
  code: typeof STORE_SETTINGS_ERROR;
  path: string;
}

const SETTINGS_KEYS = Object.keys(DEFAULT_STORE_SETTINGS);
const PHONE = /^\+?[0-9 ()-]{8,30}$/;

const minutes = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) &&
  (value as number) >= min &&
  (value as number) <= max;

/** A non-empty list of distinct allowed values. */
const subset = <T extends string>(value: unknown, allowed: readonly T[]) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => allowed.includes(item as T)) &&
  new Set(value).size === value.length;

/** Null or a string of at most `max` characters; blank text counts as null. */
const optionalText = (value: unknown, max: number) =>
  value === null || (typeof value === "string" && value.trim().length <= max);
const textOrNull = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function validateStoreSettings(
  raw: unknown,
): RuleResult<StoreSettings, StoreSettingsError> {
  const fail = (paths: string[]) => ({
    ok: false as const,
    errors: [...new Set(paths)].map((path) => ({
      code: STORE_SETTINGS_ERROR,
      path,
    })),
  });
  if (!plain(raw)) return fail([""]);
  const paths = keyIssues(raw, SETTINGS_KEYS, "");
  const {
    fulfillmentModes,
    deliveryFeeCents,
    minimumOrderCents,
    deliveryAreaDescription,
    estimatedPrepMinutes,
    estimatedDeliveryMinutes,
    acceptTimeoutMinutes,
    acceptedPaymentMethods,
    contactPhone,
    pickupAddress,
  } = raw;
  if (!subset(fulfillmentModes, FULFILLMENT_MODES))
    paths.push("fulfillmentModes");
  if (!isCents(deliveryFeeCents)) paths.push("deliveryFeeCents");
  if (!isCents(minimumOrderCents)) paths.push("minimumOrderCents");
  if (!optionalText(deliveryAreaDescription, DELIVERY_AREA_MAX_LENGTH))
    paths.push("deliveryAreaDescription");
  if (!minutes(estimatedPrepMinutes, 1, STORE_MINUTES_MAX))
    paths.push("estimatedPrepMinutes");
  if (!minutes(estimatedDeliveryMinutes, 1, STORE_MINUTES_MAX))
    paths.push("estimatedDeliveryMinutes");
  if (!minutes(acceptTimeoutMinutes, 1, ACCEPT_TIMEOUT_MINUTES_MAX))
    paths.push("acceptTimeoutMinutes");
  if (!subset(acceptedPaymentMethods, PAYMENT_METHODS))
    paths.push("acceptedPaymentMethods");
  if (!(
    contactPhone === null ||
    (typeof contactPhone === "string" &&
      (!contactPhone.trim() || PHONE.test(contactPhone.trim())))
  ))
    paths.push("contactPhone");
  if (!optionalText(pickupAddress, PICKUP_ADDRESS_MAX_LENGTH))
    paths.push("pickupAddress");
  else if (
    Array.isArray(fulfillmentModes) &&
    fulfillmentModes.includes("PICKUP") &&
    !textOrNull(pickupAddress)
  )
    paths.push("pickupAddress");
  if (paths.length) return fail(paths);
  return {
    ok: true,
    value: {
      fulfillmentModes: FULFILLMENT_MODES.filter((mode) =>
        (fulfillmentModes as string[]).includes(mode),
      ),
      deliveryFeeCents: deliveryFeeCents as number,
      minimumOrderCents: minimumOrderCents as number,
      deliveryAreaDescription: textOrNull(deliveryAreaDescription),
      estimatedPrepMinutes: estimatedPrepMinutes as number,
      estimatedDeliveryMinutes: estimatedDeliveryMinutes as number,
      acceptTimeoutMinutes: acceptTimeoutMinutes as number,
      acceptedPaymentMethods: PAYMENT_METHODS.filter((method) =>
        (acceptedPaymentMethods as string[]).includes(method),
      ),
      contactPhone: textOrNull(contactPhone),
      pickupAddress: textOrNull(pickupAddress),
    },
  };
}

/** Local time, minute precision: "18:00". */
export type LocalTime = string;
/** Local operational date: "2026-12-24". */
export type LocalDate = string;

export interface TimeRange {
  opensAt: LocalTime;
  /** Earlier than `opensAt`: closes the next day (18:00–02:00). Equal is invalid. */
  closesAt: LocalTime;
}

export interface OpeningRule extends TimeRange {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

export interface ClosureException {
  date: LocalDate;
  /** Closed the whole operational date, or open only during `shifts`. */
  closed: boolean;
  /** Substitute hours; empty when `closed`, at least one otherwise. */
  shifts: TimeRange[];
}

export interface OpeningHours {
  rules: OpeningRule[];
  exceptions: ClosureException[];
}

export const RULES_PER_WEEKDAY_MAX = 4;
export const EXCEPTIONS_MAX = 400;
export const EXCEPTION_SHIFTS_MAX = 4;

export const OPENING_HOURS_ERROR_CODES = [
  "OPENING_HOURS_INVALID",
  "OPENING_HOURS_OVERLAP",
  "OPENING_HOURS_DUPLICATE_DATE",
] as const;
export type OpeningHoursErrorCode = (typeof OPENING_HOURS_ERROR_CODES)[number];
export interface OpeningHoursError {
  code: OpeningHoursErrorCode;
  /** The offending entry, e.g. `rules[2]` or `exceptions[0].shifts[1]`. */
  path: string;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 24 * 60;

/** Minutes since midnight, or null for anything but "HH:MM". */
export function parseLocalTime(value: unknown): number | null {
  const match = typeof value === "string" ? TIME.exec(value) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Days since 1970-01-01 for a real calendar date, or null. */
export function parseLocalDate(value: unknown): number | null {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return time / (DAY * 60_000);
}

/** The weekday (0 = Sunday) of a day number from `parseLocalDate`. */
export const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7;

/**
 * A shift as a half-open interval `[start, end)` in minutes from the start of its operational
 * date; `end` passes 1440 when it closes after midnight.
 */
export interface Shift {
  start: number;
  end: number;
}

export function shiftOf(range: TimeRange): Shift {
  const start = parseLocalTime(range.opensAt)!;
  const close = parseLocalTime(range.closesAt)!;
  return { start, end: close > start ? close : close + DAY };
}

/**
 * The shifts of an operational date (precedence in the domain model): a closed exception has
 * none, an exception with hours has exactly those, otherwise the weekday's rules apply.
 */
export function shiftsOfDate(hours: OpeningHours, day: number): Shift[] {
  const exception = hours.exceptions.find(
    (item) => parseLocalDate(item.date) === day,
  );
  const ranges = exception
    ? exception.shifts
    : hours.rules.filter((rule) => rule.weekday === weekdayOf(day));
  return ranges.map(shiftOf).sort((a, b) => a.start - b.start);
}

const rangeIssues = (value: unknown, path: string, extra: string[] = []) => {
  if (!plain(value)) return [path];
  const issues = keyIssues(value, ["opensAt", "closesAt", ...extra], path);
  const opens = parseLocalTime(value["opensAt"]);
  const closes = parseLocalTime(value["closesAt"]);
  if (opens === null) issues.push(`${path}.opensAt`);
  if (closes === null || closes === opens) issues.push(`${path}.closesAt`);
  return issues;
};

interface Placed extends Shift {
  path: string;
}

/**
 * Each pair of overlapping shifts as `[earlier, later]`, earlier by start time. Shifts are on one
 * absolute minute line and half-open, so a shift ending at 02:00 and one starting at 02:00 touch
 * without overlapping.
 */
function overlappingPairs(shifts: Placed[]): [Placed, Placed][] {
  const sorted = [...shifts].sort((a, b) => a.start - b.start || a.end - b.end);
  const pairs: [Placed, Placed][] = [];
  sorted.forEach((later, index) => {
    for (const earlier of sorted.slice(0, index))
      if (later.start < earlier.end) pairs.push([earlier, later]);
  });
  return pairs;
}

const pathOrder = (path: string) => [
  path.startsWith("rules") ? 0 : path.startsWith("exceptions") ? 1 : -1,
  ...(path.match(/\d+/g) ?? []).map(Number),
];

/** Rules first, then exceptions, each by index, so the panel lists errors in form order. */
function byPath(a: OpeningHoursError, b: OpeningHoursError): number {
  const [left, right] = [pathOrder(a.path), pathOrder(b.path)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? -1) - (right[i] ?? -1);
    if (diff) return diff;
  }
  return a.path.localeCompare(b.path);
}

/**
 * Checks shape and the domain rules: valid local times, no 24-hour shift, at most one exception
 * per date, and no overlapping shifts, including a shift that crosses midnight into the next
 * day's shifts (Friday 18:00–02:00 against Saturday 01:00–03:00) and substitute hours against
 * the effective shifts of the neighbouring dates.
 */
export function validateOpeningHours(
  raw: unknown,
): RuleResult<OpeningHours, OpeningHoursError> {
  const invalid = (paths: string[]) => ({
    ok: false as const,
    errors: [...new Set(paths)].map((path) => ({
      code: "OPENING_HOURS_INVALID" as const,
      path,
    })),
  });
  if (!plain(raw)) return invalid([""]);
  const paths = keyIssues(raw, ["rules", "exceptions"], "");
  const { rules, exceptions } = raw;
  if (!Array.isArray(rules) || rules.length > 7 * RULES_PER_WEEKDAY_MAX)
    paths.push("rules");
  else
    rules.forEach((rule: unknown, index) => {
      const path = `rules[${index}]`;
      paths.push(...rangeIssues(rule, path, ["weekday"]));
      if (
        plain(rule) &&
        !(
          Number.isSafeInteger(rule["weekday"]) &&
          (rule["weekday"] as number) >= 0 &&
          (rule["weekday"] as number) <= 6
        )
      )
        paths.push(`${path}.weekday`);
    });
  if (!Array.isArray(exceptions) || exceptions.length > EXCEPTIONS_MAX)
    paths.push("exceptions");
  else
    exceptions.forEach((exception: unknown, index) => {
      const path = `exceptions[${index}]`;
      if (!plain(exception)) return void paths.push(path);
      paths.push(...keyIssues(exception, ["date", "closed", "shifts"], path));
      if (parseLocalDate(exception["date"]) === null)
        paths.push(`${path}.date`);
      const { closed, shifts } = exception;
      if (typeof closed !== "boolean") paths.push(`${path}.closed`);
      if (
        !Array.isArray(shifts) ||
        shifts.length > EXCEPTION_SHIFTS_MAX ||
        (closed === true && shifts.length > 0) ||
        (closed === false && shifts.length === 0)
      )
        paths.push(`${path}.shifts`);
      else
        shifts.forEach((shift: unknown, position) =>
          paths.push(...rangeIssues(shift, `${path}.shifts[${position}]`)),
        );
    });
  if (paths.length) return invalid(paths);

  const value: OpeningHours = {
    rules: (rules as OpeningRule[]).map(({ weekday, opensAt, closesAt }) => ({
      weekday,
      opensAt,
      closesAt,
    })),
    exceptions: (exceptions as ClosureException[])
      .map(({ date, closed, shifts }) => ({
        date,
        closed,
        shifts: shifts.map(({ opensAt, closesAt }) => ({ opensAt, closesAt })),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
  const errors: OpeningHoursError[] = [];

  const perWeekday = new Map<number, number>();
  (rules as OpeningRule[]).forEach((rule, index) => {
    const count = (perWeekday.get(rule.weekday) ?? 0) + 1;
    perWeekday.set(rule.weekday, count);
    if (count > RULES_PER_WEEKDAY_MAX)
      errors.push({ code: "OPENING_HOURS_INVALID", path: `rules[${index}]` });
  });

  // Weekly rules over two weeks, so Saturday night crossing into Sunday is compared too.
  const weekly: Placed[] = [];
  for (const week of [0, 1])
    (rules as OpeningRule[]).forEach((rule, index) => {
      const shift = shiftOf(rule);
      const offset = (week * 7 + rule.weekday) * DAY;
      weekly.push({
        start: shift.start + offset,
        end: shift.end + offset,
        path: `rules[${index}]`,
      });
    });
  // A conflict is reported once, on the shift that starts later. The weekly rules stand on their
  // own: an exception only changes one date, so it never makes an overlapping week valid.
  for (const [, later] of overlappingPairs(weekly))
    errors.push({ code: "OPENING_HOURS_OVERLAP", path: later.path });

  // Each exception date against itself and its neighbours' effective shifts.
  const exceptionIndex = new Map<number, number>();
  (exceptions as ClosureException[]).forEach((exception, index) => {
    const day = parseLocalDate(exception.date)!;
    if (exceptionIndex.has(day))
      errors.push({
        code: "OPENING_HOURS_DUPLICATE_DATE",
        path: `exceptions[${index}].date`,
      });
    else exceptionIndex.set(day, index);
  });
  // Exceptions are checked even when the week has errors, so the panel shows every problem at
  // once. A duplicate date has no single effective day, so overlaps wait until it is fixed.
  if (exceptionIndex.size === (exceptions as ClosureException[]).length) {
    const placedOf = (day: number, base: number): Placed[] => {
      const index = exceptionIndex.get(day);
      if (index !== undefined)
        return (exceptions as ClosureException[])[index]!.shifts.map(
          (range, position) => {
            const shift = shiftOf(range);
            return {
              start: shift.start + base,
              end: shift.end + base,
              path: `exceptions[${index}].shifts[${position}]`,
            };
          },
        );
      return (rules as OpeningRule[]).flatMap((rule, position) => {
        if (rule.weekday !== weekdayOf(day)) return [];
        const shift = shiftOf(rule);
        return [
          {
            start: shift.start + base,
            end: shift.end + base,
            path: `rules[${position}]`,
          },
        ];
      });
    };
    for (const [day] of exceptionIndex)
      for (const pair of overlappingPairs([
        ...placedOf(day - 1, -DAY),
        ...placedOf(day, 0),
        ...placedOf(day + 1, DAY),
      ])) {
        // Rule against rule belongs to the weekly check above. Otherwise the substitute shift is
        // at fault: the later one when both are substitutes, the exception's when one is a rule.
        const substitutes = pair.filter(
          (shift) => !shift.path.startsWith("rules"),
        );
        const path = substitutes.at(-1)?.path;
        if (path) errors.push({ code: "OPENING_HOURS_OVERLAP", path });
      }
  }

  if (errors.length) {
    const seen = new Set<string>();
    return {
      ok: false,
      errors: errors
        .filter((error) => {
          const key = `${error.code}:${error.path}`;
          return !seen.has(key) && Boolean(seen.add(key));
        })
        .sort(byPath),
    };
  }
  return { ok: true, value };
}
