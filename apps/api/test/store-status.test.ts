import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type ClosureException,
  type OpeningHours,
  parseLocalDate,
  validateOpeningHours,
} from "../src/store/store-rules";
import {
  localMinuteOf,
  type StoreStatusInput,
  storeStatusAt,
} from "../src/store/store-status";

// Friday 18:00–02:00 and Saturday 18:00–23:00, the domain model's reference week.
// 2026-10-30 is a Friday, 2026-10-31 a Saturday; São Paulo is UTC−3 all year.
const friday = "2026-10-30";
const saturday = "2026-10-31";
const week = (exceptions: ClosureException[] = []): OpeningHours => {
  const result = validateOpeningHours({
    rules: [
      { weekday: 5, opensAt: "18:00", closesAt: "02:00" },
      { weekday: 6, opensAt: "18:00", closesAt: "23:00" },
    ],
    exceptions,
  });
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};
const local = (date: string, time: string) =>
  new Date(`${date}T${time.length === 5 ? `${time}:00` : time}-03:00`);
const status = (
  hours: OpeningHours,
  at: Date,
  overrides: Partial<StoreStatusInput> = {},
) =>
  storeStatusAt({
    tenantStatus: "ACTIVE",
    timezone: "America/Sao_Paulo",
    hours,
    pause: null,
    at,
    ...overrides,
  });
const open = { open: true, reason: "OPEN" };
const outside = { open: false, reason: "OUTSIDE_HOURS" };
const closedOn = (date: string): ClosureException => ({
  date,
  closed: true,
  shifts: [],
});
const substitute = (
  date: string,
  opensAt: string,
  closesAt: string,
): ClosureException => ({
  date,
  closed: false,
  shifts: [{ opensAt, closesAt }],
});

test("H1: Friday 23:30 is inside Friday's shift", () => {
  assert.deepEqual(status(week(), local(friday, "23:30")), open);
});

test("H2: Saturday 01:59 is still Friday's shift", () => {
  assert.deepEqual(status(week(), local(saturday, "01:59")), open);
  assert.deepEqual(status(week(), local(saturday, "01:59:59.999")), open);
});

test("H3: Saturday 02:00 is closed, the shift's end is exclusive", () => {
  assert.deepEqual(status(week(), local(saturday, "02:00")), outside);
});

test("H4: closing Saturday keeps Friday's shift running at Saturday 01:30", () => {
  assert.deepEqual(
    status(week([closedOn(saturday)]), local(saturday, "01:30")),
    open,
  );
});

test("H5: closing Saturday closes Saturday 19:00", () => {
  assert.deepEqual(
    status(week([closedOn(saturday)]), local(saturday, "19:00")),
    outside,
  );
});

test("H6: closing Friday also closes the part of its shift after midnight", () => {
  assert.deepEqual(
    status(week([closedOn(friday)]), local(saturday, "01:30")),
    outside,
  );
});

test("H7: Saturday's substitute 12:00–15:00 opens Saturday 13:00", () => {
  assert.deepEqual(
    status(
      week([substitute(saturday, "12:00", "15:00")]),
      local(saturday, "13:00"),
    ),
    open,
  );
});

test("H8: Saturday's substitute replaces its weekly 18:00–23:00", () => {
  assert.deepEqual(
    status(
      week([substitute(saturday, "12:00", "15:00")]),
      local(saturday, "19:00"),
    ),
    outside,
  );
});

test("H9: Friday's substitute 18:00–23:59 no longer reaches Saturday 00:30", () => {
  const hours = week([substitute(friday, "18:00", "23:59")]);
  assert.deepEqual(status(hours, local(saturday, "00:30")), outside);
  assert.deepEqual(status(hours, local(friday, "23:58")), open);
});

test("H10: a pause until Saturday 00:30 closes Friday 23:45, inside the shift", () => {
  const pause = { pausedUntil: local(saturday, "00:30") };
  assert.deepEqual(status(week(), local(friday, "23:45"), { pause }), {
    open: false,
    reason: "PAUSED",
  });
  // The pause ends at its instant, and the shift is still running.
  assert.deepEqual(status(week(), local(saturday, "00:30"), { pause }), open);
});

test("store status: a pause with no end closes the store until reopened", () => {
  assert.deepEqual(
    status(week(), local(friday, "20:00"), { pause: { pausedUntil: null } }),
    { open: false, reason: "PAUSED" },
  );
});

test("store status: only an ACTIVE tenant opens, before any pause or hours", () => {
  for (const tenantStatus of ["ONBOARDING", "SUSPENDED", "CLOSED"] as const)
    assert.deepEqual(
      status(week(), local(friday, "20:00"), {
        tenantStatus,
        pause: { pausedUntil: null },
      }),
      { open: false, reason: "TENANT_NOT_ACTIVE" },
    );
});

test("store status: a store with no hours is always closed", () => {
  assert.deepEqual(
    status({ rules: [], exceptions: [] }, local(friday, "20:00")),
    outside,
  );
});

test("store status: the opening minute counts, the minute before does not", () => {
  assert.deepEqual(status(week(), local(friday, "18:00")), open);
  assert.deepEqual(status(week(), local(friday, "17:59:59")), outside);
});

test("store status: a Saturday night shift crosses into Sunday and the next week", () => {
  const hours = validateOpeningHours({
    rules: [{ weekday: 6, opensAt: "20:00", closesAt: "01:00" }],
    exceptions: [],
  });
  assert.ok(hours.ok);
  assert.deepEqual(status(hours.value, local("2026-11-01", "00:30")), open);
  assert.deepEqual(status(hours.value, local("2026-11-01", "01:00")), outside);
});

test("store status: the instant is read in the store's own time zone", () => {
  // 2026-10-30 23:30 in São Paulo is 2026-10-31 02:30 UTC, also 02:30 in Lisbon: past 02:00.
  const at = local(friday, "23:30");
  assert.deepEqual(status(week(), at), open);
  assert.deepEqual(status(week(), at, { timezone: "Europe/Lisbon" }), outside);
  assert.deepEqual(localMinuteOf(at, "UTC"), {
    day: parseLocalDate(saturday)!,
    minute: 2 * 60 + 30,
  });
});

test("store status: wall clock time across daylight saving changes", () => {
  // New York: 2026-03-08 jumps 02:00 → 03:00; 2026-11-01 repeats 01:00–02:00.
  const zone = "America/New_York";
  assert.deepEqual(localMinuteOf(new Date("2026-03-08T06:59:00Z"), zone), {
    day: parseLocalDate("2026-03-08")!,
    minute: 60 + 59,
  });
  assert.deepEqual(localMinuteOf(new Date("2026-03-08T07:00:00Z"), zone), {
    day: parseLocalDate("2026-03-08")!,
    minute: 3 * 60,
  });
  // Both 01:30 of the repeated hour are inside a Saturday 22:00–02:00 shift.
  const hours = validateOpeningHours({
    rules: [{ weekday: 6, opensAt: "22:00", closesAt: "02:00" }],
    exceptions: [],
  });
  assert.ok(hours.ok);
  for (const at of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"])
    assert.deepEqual(
      status(hours.value, new Date(at), { timezone: zone }),
      open,
      at,
    );
  assert.deepEqual(
    status(hours.value, new Date("2026-11-01T07:00:00Z"), { timezone: zone }),
    outside,
  );
});

test("store status: an unknown time zone is an error, never a guess", () => {
  assert.throws(
    () => status(week(), local(friday, "20:00"), { timezone: "Mars/Olympus" }),
    RangeError,
  );
});

test("store status: overlapping shifts never reach the status, validation rejects them", () => {
  const result = validateOpeningHours({
    rules: [
      { weekday: 5, opensAt: "18:00", closesAt: "02:00" },
      { weekday: 6, opensAt: "01:00", closesAt: "03:00" },
    ],
    exceptions: [],
  });
  assert.deepEqual(result, {
    ok: false,
    errors: [{ code: "OPENING_HOURS_OVERLAP", path: "rules[1]" }],
  });
});
