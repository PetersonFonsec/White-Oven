import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { Credentials } from "../core/session";
import { Session } from "../core/session";
import {
  ORDER_INTENT_RECONCILIATION_AGE_MS,
  ORDER_INTENT_STORAGE_PREFIX,
  OrdersApi,
  type StaffOrder,
} from "./orders-api";

const order: StaffOrder = {
  id: "11111111-1111-4111-8111-111111111111",
  number: 17,
  status: "PLACED",
  placedAt: "2026-10-26T12:00:00.000Z",
  fulfillment: "PICKUP",
  deliveryAddress: null,
  paymentMethod: "CASH",
  changeForCents: null,
  notes: null,
  customerName: "Cliente",
  customerPhone: null,
  items: [],
  itemsSubtotalCents: 2500,
  deliveryFeeCents: 0,
  discountCents: 0,
  totalCents: 2500,
  history: [],
};

const tenantId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const intentKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const nextKey = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("OrdersApi", () => {
  let api: OrdersApi;
  let http: HttpTestingController;
  let auth: ReturnType<typeof signal<Credentials | null>>;

  const makeApi = () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Session, useValue: { credentials: auth } },
      ],
    });
    api = TestBed.inject(OrdersApi);
    http = TestBed.inject(HttpTestingController);
    TestBed.flushEffects();
  };
  const storageKey = () =>
    `${ORDER_INTENT_STORAGE_PREFIX}:${tenantId}:${userId}:${sessionId}`;
  const intent = () => JSON.parse(sessionStorage.getItem(storageKey())!);

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
      .mockReturnValueOnce(intentKey)
      .mockReturnValue(nextKey);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it("requests separately paged sections and preserves an uncertain transition key", async () => {
    const pagePromise = api.list("active", 42);
    const pageRequest = http.expectOne(
      "/v1/admin/orders?section=active&cursor=42",
    );
    pageRequest.flush({ orders: [order], nextCursor: null });
    expect((await pagePromise).orders).toEqual([order]);

    const first = api.transition(order, "PREPARING");
    const duplicate = api.transition(order, "PREPARING");
    expect(duplicate).toBe(first);
    expect(intent().intents[0]).toMatchObject({
      orderId: order.id,
      from: "PLACED",
      to: "PREPARING",
      idempotencyKey: intentKey,
      createdAt: expect.any(Number),
    });
    expect(JSON.stringify(intent())).not.toContain("access-token");

    const lostResponse = http.expectOne(
      `/v1/admin/orders/${order.id}/transitions`,
    );
    expect(lostResponse.request.headers.get("Idempotency-Key")).toBe(intentKey);
    lostResponse.error(new ProgressEvent("network failure"));
    await expect(first).rejects.toMatchObject({ status: 0 });
    expect(api.hasUncertainIntent(order.id)).toBe(true);

    const blockedDifferentCommand = api.transition(
      order,
      "REJECTED",
      "OTHER",
      "Outro motivo",
    );
    await expect(blockedDifferentCommand).rejects.toThrow();
    const retry = api.retryPending(order.id);
    const retryRequest = http.expectOne(
      `/v1/admin/orders/${order.id}/transitions`,
    );
    expect(retryRequest.request.headers.get("Idempotency-Key")).toBe(intentKey);
    expect(retryRequest.request.body).toMatchObject({
      from: "PLACED",
      to: "PREPARING",
    });
    retryRequest.flush({ order: { ...order, status: "READY" } });
    expect((await retry).order.status).toBe("READY");
    expect(api.hasUncertainIntent(order.id)).toBe(false);
    expect(sessionStorage.getItem(storageKey())).toBeNull();

    const next = api.transition(
      { ...order, status: "READY" },
      "OUT_FOR_DELIVERY",
    );
    const nextRequest = http.expectOne(
      `/v1/admin/orders/${order.id}/transitions`,
    );
    expect(nextRequest.request.headers.get("Idempotency-Key")).toBe(nextKey);
    nextRequest.flush({ order: { ...order, status: "OUT_FOR_DELIVERY" } });
    await next;
  });

  it("restores after reload without sending automatically and retries the same payload and key", async () => {
    const first = api.transition(order, "CANCELED", "OTHER", "Cliente pediu");
    const request = http.expectOne(`/v1/admin/orders/${order.id}/transitions`);
    request.error(new ProgressEvent("network failure"));
    await expect(first).rejects.toMatchObject({ status: 0 });
    const saved = intent();
    TestBed.resetTestingModule();

    makeApi();
    expect(api.pendingOrderIds()).toEqual([order.id]);
    expect(http.match(() => true)).toHaveLength(0);
    const retry = api.retryPending(order.id);
    const retryRequest = http.expectOne(
      `/v1/admin/orders/${order.id}/transitions`,
    );
    expect(retryRequest.request.headers.get("Idempotency-Key")).toBe(intentKey);
    expect(retryRequest.request.body).toEqual({
      from: "PLACED",
      to: "CANCELED",
      reasonCode: "OTHER",
      reasonText: "Cliente pediu",
    });
    expect(intent().intents[0]).toEqual(saved.intents[0]);
    retryRequest.flush({ order: { ...order, status: "CANCELED" } });
    await retry;
    expect(sessionStorage.getItem(storageKey())).toBeNull();
  });

  it("clears persisted intents when the authenticated tenant, user or session changes", async () => {
    const first = api.transition(order, "PREPARING");
    const request = http.expectOne(`/v1/admin/orders/${order.id}/transitions`);
    request.error(new ProgressEvent("network failure"));
    await expect(first).rejects.toMatchObject({ status: 0 });
    expect(sessionStorage.getItem(storageKey())).not.toBeNull();

    auth.set({
      token: "new-token",
      tenantId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      userId,
      sessionId,
      lineage: 2,
    });
    TestBed.flushEffects();
    expect(api.pendingOrderIds()).toEqual([]);
    expect(sessionStorage.getItem(storageKey())).toBeNull();
    expect(http.match(() => true)).toHaveLength(0);
  });

  it("clears pending intents when the authenticated session logs out", async () => {
    const first = api.transition(order, "PREPARING");
    const request = http.expectOne(`/v1/admin/orders/${order.id}/transitions`);
    request.error(new ProgressEvent("network failure"));
    await expect(first).rejects.toMatchObject({ status: 0 });
    expect(sessionStorage.getItem(storageKey())).not.toBeNull();

    auth.set(null);
    TestBed.flushEffects();
    expect(api.pendingOrderIds()).toEqual([]);
    expect(sessionStorage.getItem(storageKey())).toBeNull();
  });

  it("discards corrupt storage without breaking normal use", () => {
    sessionStorage.setItem(storageKey(), "not-json");
    TestBed.resetTestingModule();
    makeApi();
    expect(api.pendingOrderIds()).toEqual([]);
    expect(sessionStorage.getItem(storageKey())).toBeNull();
  });

  it("continues an action when sessionStorage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const transition = api.transition(order, "PREPARING");
    const request = http.expectOne(`/v1/admin/orders/${order.id}/transitions`);
    request.flush({ order: { ...order, status: "PREPARING" } });
    await transition;
    expect(api.pendingOrderIds()).toEqual([]);
  });

  it("requires a current GET reconciliation before retrying an aged intent", async () => {
    const startedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const first = api.transition(order, "PREPARING");
    const request = http.expectOne(`/v1/admin/orders/${order.id}/transitions`);
    request.error(new ProgressEvent("network failure"));
    await expect(first).rejects.toMatchObject({ status: 0 });
    vi.restoreAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(
      startedAt + ORDER_INTENT_RECONCILIATION_AGE_MS + 1,
    );
    TestBed.resetTestingModule();
    makeApi();
    await expect(api.retryPending(order.id)).rejects.toThrow(
      "reconciliar o pedido",
    );
    expect(http.match(() => true)).toHaveLength(0);

    const reconciliation = api.reconcilePending(order.id);
    const getRequest = http.expectOne(`/v1/admin/orders/${order.id}`);
    getRequest.flush({ ...order, status: "PREPARING" });
    const result = await reconciliation;
    expect(result.canRetry).toBe(false);
    expect(api.pendingOrderIds()).toEqual([]);
  });

  it("clears a definitively rejected intent so a corrected command gets a new key", async () => {
    const first = api.transition(order, "PREPARING");
    const request = http.expectOne(`/v1/admin/orders/${order.id}/transitions`);
    request.flush(
      { code: "ORDER_STATE_CONFLICT", message: "conflict" },
      { status: 409, statusText: "Conflict" },
    );
    await expect(first).rejects.toMatchObject({ status: 409 });
    expect(api.hasUncertainIntent(order.id)).toBe(false);
    expect(sessionStorage.getItem(storageKey())).toBeNull();
  });
});
