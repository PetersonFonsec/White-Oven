import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { OrderHistoryApi, addDays, localDay } from "./history-api";

const ORDER = "11111111-1111-4111-8111-111111111111";
const INCIDENT = "22222222-2222-4222-8222-222222222222";

describe("OrderHistoryApi", () => {
  let api: OrderHistoryApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(OrderHistoryApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it("sends only the filters that are set, and the cursor of the next page", async () => {
    const page = api.history(
      { from: "2026-10-01", status: "COMPLETED", number: 12 },
      40,
    );
    const request = http.expectOne(
      (req) => req.url === "/v1/admin/orders/history",
    );
    expect(request.request.params.keys().sort()).toEqual([
      "cursor",
      "from",
      "number",
      "status",
    ]);
    expect(request.request.params.get("number")).toBe("12");
    expect(request.request.params.get("cursor")).toBe("40");
    request.flush({ orders: [], nextCursor: null });
    expect(await page).toEqual({ orders: [], nextCursor: null });

    void api.history({});
    const bare = http.expectOne(
      (req) => req.url === "/v1/admin/orders/history",
    );
    expect(bare.request.params.keys()).toEqual([]);
    bare.flush({ orders: [], nextCursor: null });
  });

  it("records and resolves incidents, sending a blank note as null", async () => {
    void api.reportIncident(ORDER, {
      type: "QUALITY",
      description: "Massa crua",
      reportedBy: "CUSTOMER",
    });
    const created = http.expectOne(`/v1/admin/orders/${ORDER}/incidents`);
    expect(created.request.method).toBe("POST");
    expect(created.request.body).toEqual({
      type: "QUALITY",
      description: "Massa crua",
      reportedBy: "CUSTOMER",
    });
    created.flush({});

    void api.resolveIncident(ORDER, INCIDENT, "   ");
    const resolved = http.expectOne(
      `/v1/admin/orders/${ORDER}/incidents/${INCIDENT}/resolve`,
    );
    expect(resolved.request.body).toEqual({ resolutionNote: null });
    resolved.flush({});
  });

  it("asks the daily report for a range of days", () => {
    void api.dailyReport("2026-10-01", "2026-10-07");
    const request = http.expectOne(
      (req) => req.url === "/v1/admin/reports/daily",
    );
    expect(request.request.params.get("from")).toBe("2026-10-01");
    expect(request.request.params.get("to")).toBe("2026-10-07");
    request.flush({});
  });

  it("moves local calendar days across months and years", () => {
    expect(localDay(new Date(2026, 9, 5, 23, 59))).toBe("2026-10-05");
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-10-26", -6)).toBe("2026-10-20");
  });
});
