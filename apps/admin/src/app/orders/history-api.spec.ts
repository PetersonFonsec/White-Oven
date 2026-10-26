import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { type Credentials, Session } from "../core/session";
import {
  INCIDENT_INTENT_STORAGE_PREFIX,
  OrderHistoryApi,
  PendingIncidentIntentError,
  addDays,
  localDay,
} from "./history-api";

const ORDER = "11111111-1111-4111-8111-111111111111";
const INCIDENT = "22222222-2222-4222-8222-222222222222";
const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const firstKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const nextKey = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const storageKey = `${INCIDENT_INTENT_STORAGE_PREFIX}:${tenantId}:${userId}:${sessionId}`;
const body = {
  type: "QUALITY" as const,
  description: "Massa crua",
  reportedBy: "CUSTOMER" as const,
};

describe("OrderHistoryApi", () => {
  let api: OrderHistoryApi;
  let http: HttpTestingController;
  let auth: ReturnType<typeof signal<Credentials | null>>;

  const makeApi = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Session, useValue: { credentials: auth } },
      ],
    });
    api = TestBed.inject(OrderHistoryApi);
    http = TestBed.inject(HttpTestingController);
    TestBed.flushEffects();
  };
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(() => {
    sessionStorage.clear();
    auth = signal({
      token: "access-token-is-not-persisted",
      tenantId,
      userId,
      sessionId,
      lineage: 1,
    });
    makeApi();
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(firstKey)
      .mockReturnValue(nextKey);
  });
  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

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
    const recorded = api.reportIncident(ORDER, body);
    const created = http.expectOne(`/v1/admin/orders/${ORDER}/incidents`);
    expect(created.request.method).toBe("POST");
    expect(created.request.headers.get("Idempotency-Key")).toBe(firstKey);
    expect(created.request.body).toEqual(body);
    expect(JSON.parse(sessionStorage.getItem(storageKey)!).intents).toEqual([
      expect.objectContaining({ orderId: ORDER, idempotencyKey: firstKey }),
    ]);
    created.flush({ id: INCIDENT });
    expect(await recorded).toEqual({ id: INCIDENT });
    expect(api.pendingIncident(ORDER)).toBeUndefined();
    expect(sessionStorage.getItem(storageKey)).toBeNull();

    void api.resolveIncident(ORDER, INCIDENT, "   ");
    const resolved = http.expectOne(
      `/v1/admin/orders/${ORDER}/incidents/${INCIDENT}/resolve`,
    );
    expect(resolved.request.body).toEqual({ resolutionNote: null });
    resolved.flush({});
  });

  it("O painel preserva a chave durante uma tentativa de recuperação", async () => {
    const lost = api.reportIncident(ORDER, body);
    http
      .expectOne(`/v1/admin/orders/${ORDER}/incidents`)
      .flush(null, { status: 503, statusText: "Unavailable" });
    await expect(lost).rejects.toBeTruthy();
    expect(api.pendingIncident(ORDER)).toMatchObject({
      idempotencyKey: firstKey,
      uncertain: true,
    });

    // A reload of the panel restores the intent; nothing is resent on its own.
    makeApi();
    await settle();
    http.expectNone(`/v1/admin/orders/${ORDER}/incidents`);
    expect(api.pendingIncident(ORDER)).toMatchObject({
      ...body,
      idempotencyKey: firstKey,
      uncertain: true,
    });

    // Another text for the same order waits for the pending record.
    await expect(
      api.reportIncident(ORDER, { ...body, description: "Outra" }),
    ).rejects.toBeInstanceOf(PendingIncidentIntentError);

    // The user's retry carries the same key; the API answers with the incident it kept.
    const retry = api.reportIncident(ORDER, body);
    const again = http.expectOne(`/v1/admin/orders/${ORDER}/incidents`);
    expect(again.request.headers.get("Idempotency-Key")).toBe(firstKey);
    again.flush({ id: INCIDENT }, { status: 200, statusText: "OK" });
    expect(await retry).toEqual({ id: INCIDENT });
    expect(api.pendingIncident(ORDER)).toBeUndefined();
    expect(sessionStorage.getItem(storageKey)).toBeNull();

    // The next incident is a new intent with a new key.
    void api.reportIncident(ORDER, body);
    const next = http.expectOne(`/v1/admin/orders/${ORDER}/incidents`);
    expect(next.request.headers.get("Idempotency-Key")).toBe(nextKey);
    next.flush({ id: INCIDENT });
  });

  it("drops the intent on a definite refusal and on another session", async () => {
    const refused = api.reportIncident(ORDER, body);
    http
      .expectOne(`/v1/admin/orders/${ORDER}/incidents`)
      .flush(
        { code: "INCIDENT_WINDOW_CLOSED" },
        { status: 422, statusText: "Unprocessable" },
      );
    await expect(refused).rejects.toBeTruthy();
    expect(api.pendingIncident(ORDER)).toBeUndefined();

    const lost = api.reportIncident(ORDER, body);
    http
      .expectOne(`/v1/admin/orders/${ORDER}/incidents`)
      .error(new ProgressEvent("error"));
    await expect(lost).rejects.toBeTruthy();
    expect(sessionStorage.getItem(storageKey)).not.toBeNull();
    auth.set({
      token: "other",
      tenantId,
      userId,
      sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      lineage: 2,
    });
    TestBed.flushEffects();
    expect(api.pendingIncident(ORDER)).toBeUndefined();
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("ignores stored intents of another scope or with invalid data", () => {
    const stored = (intent: Record<string, unknown>, scopeUser = userId) =>
      JSON.stringify({
        version: 1,
        scope: { tenantId, userId: scopeUser, sessionId },
        intents: [intent],
      });
    const valid = {
      orderId: ORDER,
      ...body,
      idempotencyKey: firstKey,
      createdAt: Date.now(),
    };
    for (const raw of [
      "not-json",
      stored(valid, nextKey),
      stored({ ...valid, idempotencyKey: "x" }),
      stored({ ...valid, type: "REFUND" }),
      stored({ ...valid, description: "" }),
    ]) {
      sessionStorage.setItem(storageKey, raw);
      makeApi();
      expect(api.pendingIncident(ORDER)).toBeUndefined();
      expect(sessionStorage.getItem(storageKey)).toBeNull();
    }
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
