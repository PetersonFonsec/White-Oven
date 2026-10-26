import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  daysBetween,
  isCalendarDate,
  parseDailyReportQuery,
  parseOrderHistoryQuery,
  validateIncident,
  validateResolution,
} from "../src/order/order-history-rules";

describe("order history rules", () => {
  it("accepts only real calendar days", () => {
    for (const day of ["2026-10-26", "2028-02-29", "2026-12-31"])
      assert.ok(isCalendarDate(day), day);
    for (const day of [
      "2026-02-29",
      "2026-13-01",
      "2026-10-32",
      "1999-12-31",
      "26-10-2026",
      "2026-1-1",
      20261026,
      null,
    ])
      assert.ok(!isCalendarDate(day), String(day));
    assert.equal(daysBetween("2026-10-01", "2026-10-01"), 1);
    assert.equal(daysBetween("2026-10-01", "2026-10-31"), 31);
    // Across the end of daylight saving time elsewhere, still whole days.
    assert.equal(daysBetween("2026-02-01", "2026-03-31"), 59);
  });

  it("reads optional history filters and refuses unknown or malformed ones", () => {
    assert.deepEqual(parseOrderHistoryQuery({}), {
      ok: true,
      value: {
        from: null,
        to: null,
        status: null,
        fulfillment: null,
        number: null,
        cursor: null,
      },
    });
    assert.deepEqual(
      parseOrderHistoryQuery({
        from: "2026-10-01",
        to: "2026-10-01",
        status: "COMPLETED",
        fulfillment: "PICKUP",
        number: "12",
        cursor: "40",
      }),
      {
        ok: true,
        value: {
          from: "2026-10-01",
          to: "2026-10-01",
          status: "COMPLETED",
          fulfillment: "PICKUP",
          number: 12,
          cursor: 40,
        },
      },
    );
    assert.deepEqual(
      parseOrderHistoryQuery({
        from: "2026-10-02",
        to: "2026-10-01",
        status: "DONE",
        fulfillment: ["PICKUP"],
        number: "007",
        cursor: "99999999999",
        page: "2",
      }),
      {
        ok: false,
        paths: ["page", "fulfillment", "to", "status", "number", "cursor"],
      },
    );
  });

  it("asks the report for both days, in order, 31 at most", () => {
    assert.deepEqual(
      parseDailyReportQuery({ from: "2026-10-01", to: "2026-10-31" }),
      { ok: true, value: { from: "2026-10-01", to: "2026-10-31" } },
    );
    assert.deepEqual(parseDailyReportQuery({}), {
      ok: false,
      paths: ["from", "to"],
    });
    assert.deepEqual(
      parseDailyReportQuery({ from: "2026-10-01", to: "2026-11-01" }),
      { ok: false, paths: ["to"] },
    );
    assert.deepEqual(
      parseDailyReportQuery({ from: "2026-10-02", to: "2026-10-01" }),
      { ok: false, paths: ["to"] },
    );
    assert.deepEqual(
      parseDailyReportQuery({
        from: "2026-10-01",
        to: "2026-10-01",
        status: "COMPLETED",
      }),
      { ok: false, paths: ["status"] },
    );
  });

  it("validates incidents and resolutions, trimming text", () => {
    assert.deepEqual(
      validateIncident({
        type: "QUALITY",
        description: "  Massa crua ",
        reportedBy: "CUSTOMER",
      }),
      {
        ok: true,
        value: {
          type: "QUALITY",
          description: "Massa crua",
          reportedBy: "CUSTOMER",
        },
      },
    );
    // 1000 characters counts code points, like the database.
    assert.ok(
      validateIncident({
        type: "OTHER",
        description: "🍕".repeat(1000),
        reportedBy: "STAFF",
      }).ok,
    );
    assert.deepEqual(validateIncident(null), { ok: false, paths: [""] });
    assert.deepEqual(
      validateIncident({
        type: "REFUND",
        description: "x".repeat(1001),
        reportedBy: "SYSTEM",
        status: "RESOLVED",
      }),
      { ok: false, paths: ["status", "type", "description", "reportedBy"] },
    );
    assert.deepEqual(validateResolution({}), {
      ok: true,
      value: { resolutionNote: null },
    });
    assert.deepEqual(validateResolution({ resolutionNote: "  " }), {
      ok: true,
      value: { resolutionNote: null },
    });
    assert.deepEqual(validateResolution({ resolutionNote: " Feito " }), {
      ok: true,
      value: { resolutionNote: "Feito" },
    });
    assert.deepEqual(validateResolution({ resolutionNote: 1 }), {
      ok: false,
      paths: ["resolutionNote"],
    });
    assert.deepEqual(validateResolution({ note: "x" }), {
      ok: false,
      paths: ["note"],
    });
  });
});
