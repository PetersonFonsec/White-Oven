import { FULFILLMENTS, type Fulfillment, type RuleResult } from "./order-rules";
import { ORDER_STATUSES, type OrderStatus } from "./order-lifecycle-rules";

/** Orders per page of the staff history (order-lifecycle.md#histórico). */
export const ORDER_HISTORY_PAGE_SIZE = 50;
/** Days one daily report covers at most. */
export const DAILY_REPORT_MAX_DAYS = 31;
/** Incidents can be reported until this many days after the order ended. */
export const INCIDENT_WINDOW_DAYS = 30;
export const INCIDENT_TEXT_MAX_LENGTH = 1000;

export const INCIDENT_TYPES = [
  "MISSING_ITEM",
  "WRONG_ITEM",
  "LATE_DELIVERY",
  "QUALITY",
  "DELIVERY_PROBLEM",
  "OTHER",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];
export const INCIDENT_REPORTERS = ["CUSTOMER", "STAFF"] as const;
export type IncidentReporter = (typeof INCIDENT_REPORTERS)[number];

/** Filters of the staff history; dates are local calendar days of the store (`YYYY-MM-DD`). */
export interface OrderHistoryFilters {
  from: string | null;
  to: string | null;
  status: OrderStatus | null;
  fulfillment: Fulfillment | null;
  number: number | null;
  /** The last number of the previous page; the next page lists lower numbers. */
  cursor: number | null;
}

export interface DailyReportRange {
  from: string;
  to: string;
}

export interface IncidentInput {
  type: IncidentType;
  description: string;
  reportedBy: IncidentReporter;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const POSITIVE = /^[1-9]\d{0,9}$/;

/** A real calendar day written as `YYYY-MM-DD` (no 2026-02-30). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 2000 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Whole days from `from` to `to`, both included (1 for the same day). */
export function daysBetween(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000 +
    1
  );
}

const positive = (value: string) =>
  POSITIVE.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;

function onlyKeys(
  query: Record<string, unknown>,
  allowed: readonly string[],
  paths: string[],
): void {
  for (const key of Object.keys(query))
    if (!allowed.includes(key)) paths.push(key);
}

/** Query of `GET /v1/admin/orders/history`. Every filter is optional; unknown keys are refused. */
export function parseOrderHistoryQuery(
  query: Record<string, unknown>,
): RuleResult<OrderHistoryFilters> {
  const paths: string[] = [];
  onlyKeys(
    query,
    ["from", "to", "status", "fulfillment", "number", "cursor"],
    paths,
  );
  const text = (key: string): string | null => {
    const value = query[key];
    if (value === undefined) return null;
    if (typeof value !== "string" || value === "") {
      paths.push(key);
      return null;
    }
    return value;
  };
  const from = text("from");
  const to = text("to");
  const status = text("status");
  const fulfillment = text("fulfillment");
  const number = text("number");
  const cursor = text("cursor");
  if (from !== null && !isCalendarDate(from)) paths.push("from");
  if (to !== null && !isCalendarDate(to)) paths.push("to");
  if (
    from !== null &&
    to !== null &&
    isCalendarDate(from) &&
    isCalendarDate(to) &&
    from > to
  )
    paths.push("to");
  if (status !== null && !ORDER_STATUSES.includes(status as OrderStatus))
    paths.push("status");
  if (
    fulfillment !== null &&
    !FULFILLMENTS.includes(fulfillment as Fulfillment)
  )
    paths.push("fulfillment");
  if (number !== null && positive(number) === null) paths.push("number");
  if (cursor !== null && positive(cursor) === null) paths.push("cursor");
  if (paths.length) return { ok: false, paths: [...new Set(paths)] };
  return {
    ok: true,
    value: {
      from,
      to,
      status: status as OrderStatus | null,
      fulfillment: fulfillment as Fulfillment | null,
      number: number === null ? null : positive(number),
      cursor: cursor === null ? null : positive(cursor),
    },
  };
}

/** Query of `GET /v1/admin/reports/daily`: both days, at most `DAILY_REPORT_MAX_DAYS`. */
export function parseDailyReportQuery(
  query: Record<string, unknown>,
): RuleResult<DailyReportRange> {
  const paths: string[] = [];
  onlyKeys(query, ["from", "to"], paths);
  const { from, to } = query;
  if (!isCalendarDate(from)) paths.push("from");
  if (!isCalendarDate(to)) paths.push("to");
  else if (
    isCalendarDate(from) &&
    (from > to || daysBetween(from, to) > DAILY_REPORT_MAX_DAYS)
  )
    paths.push("to");
  if (paths.length) return { ok: false, paths };
  return { ok: true, value: { from: from as string, to: to as string } };
}

const text = (value: unknown): string | null =>
  typeof value === "string" ? value.trim() : null;
const length = (value: string) => [...value].length;

/** Body of a new incident: type, who reported it and a description of 1 to 1000 characters. */
export function validateIncident(raw: unknown): RuleResult<IncidentInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, paths: [""] };
  const body = raw as Record<string, unknown>;
  const paths: string[] = [];
  onlyKeys(body, ["type", "description", "reportedBy"], paths);
  if (!INCIDENT_TYPES.includes(body["type"] as IncidentType))
    paths.push("type");
  const description = text(body["description"]);
  if (
    description === null ||
    length(description) < 1 ||
    length(description) > INCIDENT_TEXT_MAX_LENGTH
  )
    paths.push("description");
  if (!INCIDENT_REPORTERS.includes(body["reportedBy"] as IncidentReporter))
    paths.push("reportedBy");
  if (paths.length) return { ok: false, paths };
  return {
    ok: true,
    value: {
      type: body["type"] as IncidentType,
      description: description!,
      reportedBy: body["reportedBy"] as IncidentReporter,
    },
  };
}

/** Body of a resolution: an optional note; a blank note is no note. */
export function validateResolution(
  raw: unknown,
): RuleResult<{ resolutionNote: string | null }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, paths: [""] };
  const body = raw as Record<string, unknown>;
  const paths: string[] = [];
  onlyKeys(body, ["resolutionNote"], paths);
  const note = body["resolutionNote"];
  const trimmed = note === undefined || note === null ? "" : text(note);
  if (trimmed === null || length(trimmed) > INCIDENT_TEXT_MAX_LENGTH)
    paths.push("resolutionNote");
  if (paths.length) return { ok: false, paths };
  return { ok: true, value: { resolutionNote: trimmed || null } };
}
