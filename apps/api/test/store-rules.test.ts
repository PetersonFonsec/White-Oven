import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STORE_SETTINGS,
  type OpeningHours,
  parseLocalDate,
  shiftsOfDate,
  validateOpeningHours,
  validateStoreSettings,
  weekdayOf,
} from "../src/store/store-rules";

const FRIDAY = 5;
const SATURDAY = 6;
// Friday 18:00–02:00 and Saturday 18:00–23:00, the domain model's reference week.
const week = (): OpeningHours => ({
  rules: [
    { weekday: FRIDAY, opensAt: "18:00", closesAt: "02:00" },
    { weekday: SATURDAY, opensAt: "18:00", closesAt: "23:00" },
  ],
  exceptions: [],
});
// 2026-10-30 is a Friday, 2026-10-31 a Saturday.
const friday = "2026-10-30";
const saturday = "2026-10-31";
const errors = (raw: unknown) => {
  const result = validateOpeningHours(raw);
  return result.ok ? [] : result.errors;
};
const valid = (raw: unknown) => {
  const result = validateOpeningHours(raw);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};
const day = (date: string) => parseLocalDate(date)!;

test("store rules: dates map to weekdays and reject impossible days", () => {
  assert.equal(weekdayOf(day(friday)), FRIDAY);
  assert.equal(weekdayOf(day("1970-01-01")), 4);
  assert.equal(weekdayOf(day("1969-12-28")), 0);
  for (const date of ["2026-02-29", "2026-13-01", "2026-1-01", "hoje"])
    assert.equal(parseLocalDate(date), null, date);
  assert.equal(parseLocalDate("2028-02-29") !== null, true);
});

test("accepts a shift that crosses midnight and keeps it on the date it starts", () => {
  const hours = valid(week());
  assert.deepEqual(shiftsOfDate(hours, day(friday)), [
    { start: 18 * 60, end: 26 * 60 },
  ]);
  assert.deepEqual(shiftsOfDate(hours, day(saturday)), [
    { start: 18 * 60, end: 23 * 60 },
  ]);
});

test("rejects a next-day shift that starts before the previous night ends", () => {
  const hours = week();
  hours.rules.push({ weekday: SATURDAY, opensAt: "01:00", closesAt: "03:00" });
  assert.deepEqual(errors(hours), [
    { code: "OPENING_HOURS_OVERLAP", path: "rules[2]" },
  ]);
  // Ending exactly when the next shift starts is fine: the end is exclusive.
  hours.rules[2] = { weekday: SATURDAY, opensAt: "02:00", closesAt: "03:00" };
  assert.deepEqual(errors(hours), []);
});

test("compares Saturday night against Sunday across the week boundary", () => {
  const hours: OpeningHours = {
    rules: [
      { weekday: SATURDAY, opensAt: "22:00", closesAt: "03:00" },
      { weekday: 0, opensAt: "02:00", closesAt: "05:00" },
    ],
    exceptions: [],
  };
  assert.deepEqual(errors(hours), [
    { code: "OPENING_HOURS_OVERLAP", path: "rules[1]" },
  ]);
});

test("rejects overlapping shifts on the same day and 24-hour shifts", () => {
  assert.deepEqual(
    errors({
      rules: [
        { weekday: 1, opensAt: "11:00", closesAt: "15:00" },
        { weekday: 1, opensAt: "14:00", closesAt: "18:00" },
      ],
      exceptions: [],
    }),
    [{ code: "OPENING_HOURS_OVERLAP", path: "rules[1]" }],
  );
  assert.deepEqual(
    errors({
      rules: [{ weekday: 1, opensAt: "18:00", closesAt: "18:00" }],
      exceptions: [],
    }),
    [{ code: "OPENING_HOURS_INVALID", path: "rules[0].closesAt" }],
  );
});

test("substitute hours replace the weekday's rules on that date only", () => {
  const hours = week();
  hours.exceptions.push({
    date: saturday,
    closed: false,
    shifts: [{ opensAt: "12:00", closesAt: "15:00" }],
  });
  const saved = valid(hours);
  assert.deepEqual(shiftsOfDate(saved, day(saturday)), [
    { start: 12 * 60, end: 15 * 60 },
  ]);
  // Friday night still runs to 02:00 on Saturday.
  assert.deepEqual(shiftsOfDate(saved, day(friday)), [
    { start: 18 * 60, end: 26 * 60 },
  ]);
});

test("a closed date has no shifts and leaves the previous night untouched", () => {
  const hours = week();
  hours.exceptions.push({ date: saturday, closed: true, shifts: [] });
  const saved = valid(hours);
  assert.deepEqual(shiftsOfDate(saved, day(saturday)), []);
  assert.equal(shiftsOfDate(saved, day(friday)).length, 1);
});

test("rejects substitute hours that overlap the neighbouring dates", () => {
  const early = week();
  early.exceptions.push({
    date: saturday,
    closed: false,
    shifts: [{ opensAt: "01:00", closesAt: "04:00" }],
  });
  assert.deepEqual(errors(early), [
    { code: "OPENING_HOURS_OVERLAP", path: "exceptions[0].shifts[0]" },
  ]);
  const late = week();
  late.exceptions.push({
    date: "2026-10-29",
    closed: false,
    shifts: [{ opensAt: "20:00", closesAt: "19:00" }],
  });
  // Thursday's substitute night runs into Friday's weekly shift: reported on that shift.
  assert.deepEqual(errors(late), [
    { code: "OPENING_HOURS_OVERLAP", path: "exceptions[0].shifts[0]" },
  ]);
  // Closing Friday removes its night, so a Saturday dawn shift becomes valid.
  const closedFriday = week();
  closedFriday.exceptions.push(
    { date: friday, closed: true, shifts: [] },
    {
      date: saturday,
      closed: false,
      shifts: [{ opensAt: "01:00", closesAt: "04:00" }],
    },
  );
  assert.deepEqual(errors(closedFriday), []);
});

test("rejects duplicate dates and malformed exceptions", () => {
  const hours = week();
  hours.exceptions.push(
    { date: saturday, closed: true, shifts: [] },
    { date: saturday, closed: true, shifts: [] },
  );
  assert.deepEqual(errors(hours), [
    { code: "OPENING_HOURS_DUPLICATE_DATE", path: "exceptions[1].date" },
  ]);
  assert.deepEqual(
    errors({
      rules: [{ weekday: 7, opensAt: "24:00", closesAt: "1:00" }],
      exceptions: [
        { date: "2026-02-30", closed: true, shifts: [] },
        { date: friday, closed: false, shifts: [] },
        {
          date: saturday,
          closed: true,
          shifts: [{ opensAt: "10:00", closesAt: "11:00" }],
        },
      ],
      extra: true,
    }).map((error) => error.path),
    [
      "extra",
      "rules[0].opensAt",
      "rules[0].closesAt",
      "rules[0].weekday",
      "exceptions[0].date",
      "exceptions[1].shifts",
      "exceptions[2].shifts",
    ],
  );
});

const SUNDAY = 0;
const MONDAY = 1;
const rule = (weekday: number, opensAt: string, closesAt: string) => ({
  weekday,
  opensAt,
  closesAt,
});
const weekOf = (...rules: ReturnType<typeof rule>[]): OpeningHours => ({
  rules,
  exceptions: [],
});
const overlap = (...paths: string[]) =>
  paths.map((path) => ({ code: "OPENING_HOURS_OVERLAP", path }));

test("weekly overlaps across midnight and the week boundary, once per conflict", () => {
  assert.deepEqual(
    errors(
      weekOf(rule(FRIDAY, "18:00", "02:00"), rule(SATURDAY, "01:00", "03:00")),
    ),
    overlap("rules[1]"),
  );
  assert.deepEqual(
    errors(
      weekOf(rule(SATURDAY, "23:00", "02:00"), rule(SUNDAY, "01:00", "03:00")),
    ),
    overlap("rules[1]"),
  );
  assert.deepEqual(
    errors(
      weekOf(rule(SUNDAY, "23:00", "02:00"), rule(MONDAY, "01:00", "03:00")),
    ),
    overlap("rules[1]"),
  );
  // Sunday listed first still reports the Sunday shift, the one that starts later.
  assert.deepEqual(
    errors(
      weekOf(rule(SUNDAY, "01:00", "03:00"), rule(SATURDAY, "23:00", "02:00")),
    ),
    overlap("rules[0]"),
  );
});

test("adjacent shifts and two separate shifts on one day are valid", () => {
  valid(
    weekOf(rule(SATURDAY, "23:00", "02:00"), rule(SUNDAY, "02:00", "06:00")),
  );
  valid(weekOf(rule(MONDAY, "11:00", "14:00"), rule(MONDAY, "18:00", "23:00")));
  valid(weekOf(rule(MONDAY, "11:00", "14:00"), rule(MONDAY, "14:00", "16:00")));
  // Every night of the week crossing midnight, each ending as the next one starts.
  valid(
    weekOf(...[0, 1, 2, 3, 4, 5, 6].map((day) => rule(day, "18:00", "02:00"))),
  );
});

test("one conflict is one error, and each shift that clashes is listed once", () => {
  // Saturday night clashes with Sunday in both weeks compared: still a single error.
  const night = weekOf(
    rule(SATURDAY, "22:00", "04:00"),
    rule(SUNDAY, "01:00", "02:00"),
    rule(SUNDAY, "03:00", "05:00"),
  );
  assert.deepEqual(errors(night), overlap("rules[1]", "rules[2]"));
  // A shift that clashes with two others is reported once.
  assert.deepEqual(
    errors(
      weekOf(
        rule(MONDAY, "10:00", "20:00"),
        rule(MONDAY, "09:00", "12:00"),
        rule(MONDAY, "11:00", "13:00"),
      ),
    ),
    overlap("rules[0]", "rules[2]"),
  );
});

// 2026-11-02 is a Monday, 2026-11-01 a Sunday.
const monday = "2026-11-02";
const lunchAndDinner = () =>
  weekOf(rule(MONDAY, "11:00", "14:00"), rule(MONDAY, "18:00", "23:00"));

test("exceptions: closed date and substitute hours replace that date only", () => {
  const closed = lunchAndDinner();
  closed.exceptions.push({ date: monday, closed: true, shifts: [] });
  const savedClosed = valid(closed);
  assert.deepEqual(shiftsOfDate(savedClosed, day(monday)), []);
  assert.equal(shiftsOfDate(savedClosed, day("2026-11-09")).length, 2);

  const substitute = lunchAndDinner();
  substitute.exceptions.push({
    date: monday,
    closed: false,
    // Overlaps the weekly lunch, but the weekly lunch does not apply on this date.
    shifts: [{ opensAt: "12:00", closesAt: "22:00" }],
  });
  assert.deepEqual(shiftsOfDate(valid(substitute), day(monday)), [
    { start: 12 * 60, end: 22 * 60 },
  ]);
});

test("exceptions: clashes with the previous night and with the next day", () => {
  const afterSunday = weekOf(rule(SUNDAY, "18:00", "02:00"));
  afterSunday.exceptions.push({
    date: monday,
    closed: false,
    shifts: [
      { opensAt: "11:00", closesAt: "14:00" },
      { opensAt: "01:00", closesAt: "03:00" },
    ],
  });
  assert.deepEqual(errors(afterSunday), overlap("exceptions[0].shifts[1]"));

  const intoTuesday = weekOf(rule(2, "01:00", "03:00"));
  intoTuesday.exceptions.push({
    date: monday,
    closed: false,
    shifts: [{ opensAt: "22:00", closesAt: "02:00" }],
  });
  assert.deepEqual(errors(intoTuesday), overlap("exceptions[0].shifts[0]"));
});

test("exceptions on consecutive dates are compared with each other", () => {
  const hours = weekOf();
  hours.exceptions.push(
    {
      date: "2026-11-03",
      closed: false,
      shifts: [{ opensAt: "01:00", closesAt: "03:00" }],
    },
    {
      date: monday,
      closed: false,
      shifts: [{ opensAt: "22:00", closesAt: "02:00" }],
    },
  );
  assert.deepEqual(errors(hours), overlap("exceptions[0].shifts[0]"));
  hours.exceptions[0]!.shifts[0] = { opensAt: "02:00", closesAt: "03:00" };
  assert.deepEqual(
    valid(hours).exceptions.map((item) => item.date),
    [monday, "2026-11-03"],
  );
});

test("an exception never makes an overlapping week valid", () => {
  const hours = weekOf(
    rule(MONDAY, "11:00", "15:00"),
    rule(MONDAY, "14:00", "18:00"),
  );
  // On this Monday the clash is gone, but every other Monday still has it.
  hours.exceptions.push({
    date: monday,
    closed: false,
    shifts: [{ opensAt: "11:00", closesAt: "14:00" }],
  });
  assert.deepEqual(errors(hours), overlap("rules[1]"));
});

test("week and exception errors come together, in form order", () => {
  const hours = weekOf(
    rule(FRIDAY, "18:00", "02:00"),
    rule(MONDAY, "11:00", "15:00"),
    rule(MONDAY, "14:00", "18:00"),
  );
  hours.exceptions.push(
    {
      date: "2026-11-07",
      closed: false,
      shifts: [{ opensAt: "18:00", closesAt: "20:00" }],
    },
    {
      date: saturday,
      closed: false,
      shifts: [{ opensAt: "01:00", closesAt: "03:00" }],
    },
  );
  const twice = [errors(hours), errors(hours)];
  assert.deepEqual(twice[0], overlap("rules[2]", "exceptions[1].shifts[0]"));
  assert.deepEqual(twice[1], twice[0]);
});

test("store settings: defaults are valid and values are normalized", () => {
  assert.deepEqual(validateStoreSettings(DEFAULT_STORE_SETTINGS), {
    ok: true,
    value: DEFAULT_STORE_SETTINGS,
  });
  const result = validateStoreSettings({
    ...DEFAULT_STORE_SETTINGS,
    fulfillmentModes: ["PICKUP", "DELIVERY"],
    acceptedPaymentMethods: ["PIX_ON_DELIVERY", "CASH"],
    pickupAddress: "  Rua A, 10  ",
    contactPhone: " ",
    deliveryAreaDescription: "",
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.fulfillmentModes, ["DELIVERY", "PICKUP"]);
  assert.deepEqual(result.value.acceptedPaymentMethods, [
    "CASH",
    "PIX_ON_DELIVERY",
  ]);
  assert.equal(result.value.pickupAddress, "Rua A, 10");
  assert.equal(result.value.contactPhone, null);
  assert.equal(result.value.deliveryAreaDescription, null);
});

test("store settings: rejects empty choices, negative money and missing pickup address", () => {
  const result = validateStoreSettings({
    ...DEFAULT_STORE_SETTINGS,
    fulfillmentModes: ["PICKUP"],
    deliveryFeeCents: -1,
    minimumOrderCents: 1.5,
    estimatedPrepMinutes: 0,
    acceptTimeoutMinutes: 61,
    acceptedPaymentMethods: [],
    contactPhone: "liga pra mim",
    pickupAddress: null,
  });
  assert.ok(!result.ok);
  assert.deepEqual(
    result.errors.map((error) => error.path),
    [
      "deliveryFeeCents",
      "minimumOrderCents",
      "estimatedPrepMinutes",
      "acceptTimeoutMinutes",
      "acceptedPaymentMethods",
      "contactPhone",
      "pickupAddress",
    ],
  );
  assert.deepEqual(
    validateStoreSettings({
      ...DEFAULT_STORE_SETTINGS,
      fulfillmentModes: ["DELIVERY", "DELIVERY"],
    }),
    {
      ok: false,
      errors: [{ code: "STORE_SETTINGS_INVALID", path: "fulfillmentModes" }],
    },
  );
});
