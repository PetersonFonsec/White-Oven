import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { OrdersApi, type StaffOrder } from "./orders-api";

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

describe("OrdersApi", () => {
  let api: OrdersApi;
  let http: HttpTestingController;
  const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(OrdersApi);
    http = TestBed.inject(HttpTestingController);
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(uuid)
      .mockReturnValue("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  afterEach(() => {
    http.verify();
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
    const lostResponse = http.expectOne(
      `/v1/admin/orders/${order.id}/transitions`,
    );
    expect(lostResponse.request.headers.get("Idempotency-Key")).toBe(uuid);
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
    expect(retryRequest.request.headers.get("Idempotency-Key")).toBe(uuid);
    expect(retryRequest.request.body).toMatchObject({
      from: "PLACED",
      to: "PREPARING",
    });
    retryRequest.flush({ order: { ...order, status: "READY" } });
    expect((await retry).order.status).toBe("READY");
    expect(api.hasUncertainIntent(order.id)).toBe(false);

    const next = api.transition(
      { ...order, status: "READY" },
      "OUT_FOR_DELIVERY",
    );
    const nextRequest = http.expectOne(
      `/v1/admin/orders/${order.id}/transitions`,
    );
    expect(nextRequest.request.headers.get("Idempotency-Key")).not.toBe(uuid);
    nextRequest.flush({ order: { ...order, status: "OUT_FOR_DELIVERY" } });
    await next;
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
  });
});
