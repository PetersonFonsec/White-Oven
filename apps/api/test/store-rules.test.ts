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
  assert.deepEqual(errors(late), [
    { code: "OPENING_HOURS_OVERLAP", path: "exceptions[0]" },
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
