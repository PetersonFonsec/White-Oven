import { ComponentFixture, TestBed } from "@angular/core/testing";
import { OrdersApi, type StaffOrder, type StaffOrderPage } from "./orders-api";
import { OrdersPage } from "./orders.page";

const fixtureOrder: StaffOrder = {
  id: "11111111-1111-4111-8111-111111111111",
  number: 24,
  status: "PLACED",
  placedAt: "2026-10-26T12:00:00.000Z",
  fulfillment: "DELIVERY",
  deliveryAddress: {
    street: "Rua A",
    number: "10",
    complement: null,
    district: "Centro",
    city: "São Paulo",
    state: "SP",
    postalCode: "01000-000",
    reference: "Portão azul",
  },
  paymentMethod: "CASH",
  changeForCents: 5000,
  notes: "Tocar a campainha",
  customerName: "<img src=x onerror=alert(1)>",
  customerPhone: "11999990000",
  items: [
    {
      kind: "PIZZA",
      quantity: 2,
      unitPriceCents: 5000,
      totalCents: 10000,
      snapshot: {
        size: { name: "Grande" },
        flavors: { LEFT: { name: "Calabresa" }, RIGHT: { name: "Marguerita" } },
        crust: { name: "Recheada" },
        extras: [{ name: "Azeitona" }],
        removals: [{ name: "Cebola" }],
      },
    },
  ],
  itemsSubtotalCents: 10000,
  deliveryFeeCents: 500,
  discountCents: 0,
  totalCents: 10500,
  history: [],
};

describe("OrdersPage", () => {
  let fixture: ComponentFixture<OrdersPage>;
  let requests: {
    resolve(page: StaffOrderPage): void;
    reject(error: unknown): void;
  }[];
  let api: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    hasUncertainIntent: ReturnType<typeof vi.fn>;
    pendingVersion: ReturnType<typeof vi.fn>;
    pendingOrderIds: ReturnType<typeof vi.fn>;
    requiresReconciliation: ReturnType<typeof vi.fn>;
  };

  const page = (): Promise<StaffOrderPage> =>
    new Promise((resolve, reject) => requests.push({ resolve, reject }));
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  beforeEach(() => {
    requests = [];
    api = {
      list: vi.fn(() => page()),
      get: vi.fn(),
      hasUncertainIntent: vi.fn(() => false),
      pendingVersion: vi.fn(() => 0),
      pendingOrderIds: vi.fn(() => []),
      requiresReconciliation: vi.fn(() => false),
    };
    TestBed.configureTestingModule({
      imports: [OrdersPage],
      providers: [{ provide: OrdersApi, useValue: api }],
    });
    fixture = TestBed.createComponent(OrdersPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("coalesces a manual refresh while initial polling data is still in flight", async () => {
    expect(api.list).toHaveBeenCalledTimes(2);
    void (
      fixture.componentInstance as unknown as { load(): Promise<void> }
    ).load();
    expect(api.list).toHaveBeenCalledTimes(2);
    requests
      .splice(0, 2)
      .forEach(({ resolve }) => resolve({ orders: [], nextCursor: null }));
    await drain();
    expect(api.list).toHaveBeenCalledTimes(4);
    requests
      .splice(0)
      .forEach(({ resolve }) => resolve({ orders: [], nextCursor: null }));
    await drain();
  });

  it("renders a dedicated escaped receipt before printing the order snapshot", async () => {
    requests
      .splice(0, 2)
      .forEach(({ resolve }) =>
        resolve({ orders: [fixtureOrder], nextCursor: null }),
      );
    await drain();
    const print = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("print", print);
    Object.defineProperty(window, "print", {
      configurable: true,
      value: print,
    });
    (
      fixture.componentInstance as unknown as { print(order: StaffOrder): void }
    ).print(fixtureOrder);
    fixture.detectChanges();
    await drain();
    const receipt = fixture.nativeElement.querySelector(
      ".receipt",
    ) as HTMLElement;
    expect(receipt.textContent).toContain("Pedido #24");
    expect(receipt.textContent).toContain("Entrega");
    expect(receipt.textContent).toContain("Portão azul");
    expect(receipt.textContent).toContain("Calabresa / Marguerita");
    expect(receipt.textContent).toContain("Adicionais: Azeitona");
    expect(receipt.textContent).toContain("Sem: Cebola");
    expect(receipt.textContent).toContain("Tocar a campainha");
    expect(receipt.querySelector("img")).toBeNull();
    expect(print).toHaveBeenCalledOnce();
  });

  it("recovers from a temporary polling failure and alerts once for a new order", async () => {
    const first = requests.splice(0, 2);
    first[0]!.reject(new Error("temporary network failure"));
    first[1]!.resolve({ orders: [], nextCursor: null });
    await drain();
    const component = fixture.componentInstance as unknown as {
      load(): Promise<void>;
      error(): string;
      playAlert(): void;
    };
    expect(component.error()).toBeTruthy();
    api.list.mockImplementation((section: string) =>
      Promise.resolve({
        orders: section === "active" ? [fixtureOrder] : [],
        nextCursor: null,
      }),
    );
    await component.load();
    expect(component.error()).toBe("");

    const newOrder = {
      ...fixtureOrder,
      id: "22222222-2222-4222-8222-222222222222",
      number: 25,
    };
    api.list.mockImplementation((section: string) =>
      Promise.resolve({
        orders: section === "active" ? [fixtureOrder, newOrder] : [],
        nextCursor: null,
      }),
    );
    const alert = vi.spyOn(component, "playAlert");
    await component.load();
    await component.load();
    expect(alert).toHaveBeenCalledOnce();
  });

  it("ignores responses when the board is destroyed", async () => {
    const component = fixture.componentInstance as unknown as {
      orders(): StaffOrder[];
    };
    fixture.destroy();
    requests
      .splice(0)
      .forEach(({ resolve }) =>
        resolve({ orders: [fixtureOrder], nextCursor: null }),
      );
    await drain();
    expect(component.orders()).toEqual([]);
  });

  it.each(["COMPLETED", "CANCELED", "REJECTED"] as const)(
    "removes an order from the active board after it becomes %s in another session",
    async (status) => {
      const initial = requests.splice(0, 2);
      initial[0]!.resolve({ orders: [fixtureOrder], nextCursor: null });
      initial[1]!.resolve({ orders: [], nextCursor: null });
      await drain();

      api.list.mockImplementation((section: string) =>
        Promise.resolve({
          orders: section === "closed" ? [{ ...fixtureOrder, status }] : [],
          nextCursor: null,
        }),
      );
      await (
        fixture.componentInstance as unknown as { load(): Promise<void> }
      ).load();
      const component = fixture.componentInstance as unknown as {
        orders(): StaffOrder[];
        columns(): { id: string; orders: StaffOrder[] }[];
      };
      expect(component.orders()).toHaveLength(1);
      expect(component.orders()[0]?.status).toBe(status);
      expect(
        component.columns().find((column) => column.id === "PLACED")?.orders,
      ).toEqual([]);
    },
  );

  it("keeps an active order when its status changes within the active section", async () => {
    const initial = requests.splice(0, 2);
    initial[0]!.resolve({ orders: [fixtureOrder], nextCursor: null });
    initial[1]!.resolve({ orders: [], nextCursor: null });
    await drain();
    api.list.mockImplementation((section: string) =>
      Promise.resolve({
        orders:
          section === "active"
            ? [{ ...fixtureOrder, status: "PREPARING" }]
            : [],
        nextCursor: null,
      }),
    );
    await (
      fixture.componentInstance as unknown as { load(): Promise<void> }
    ).load();
    const component = fixture.componentInstance as unknown as {
      orders(): StaffOrder[];
    };
    expect(component.orders()).toMatchObject([
      { id: fixtureOrder.id, status: "PREPARING" },
    ]);
  });

  it("preserves rows on partial failure, then removes rows after both sections reconcile", async () => {
    const initial = requests.splice(0, 2);
    initial[0]!.resolve({ orders: [fixtureOrder], nextCursor: null });
    initial[1]!.resolve({ orders: [], nextCursor: null });
    await drain();
    api.list.mockImplementation((section: string) =>
      section === "active"
        ? Promise.resolve({ orders: [], nextCursor: null })
        : Promise.reject(new Error("closed queue unavailable")),
    );
    const component = fixture.componentInstance as unknown as {
      load(): Promise<void>;
      orders(): StaffOrder[];
    };
    await component.load();
    expect(component.orders()).toEqual([fixtureOrder]);

    api.list.mockImplementation((section: string) =>
      Promise.resolve({
        orders:
          section === "closed"
            ? [{ ...fixtureOrder, status: "COMPLETED" }]
            : [],
        nextCursor: null,
      }),
    );
    await component.load();
    expect(component.orders()).toMatchObject([
      { id: fixtureOrder.id, status: "COMPLETED" },
    ]);
  });

  it("retains the previous snapshot when a later loaded page fails", async () => {
    const laterOrder = {
      ...fixtureOrder,
      id: "33333333-3333-4333-8333-333333333333",
      number: 25,
      status: "PREPARING" as const,
    };
    const initial = requests.splice(0, 2);
    initial[0]!.resolve({ orders: [fixtureOrder], nextCursor: 24 });
    initial[1]!.resolve({ orders: [], nextCursor: null });
    await drain();
    api.list.mockImplementation((section: string, cursor?: number) =>
      Promise.resolve({
        orders:
          section === "active"
            ? cursor === undefined
              ? [fixtureOrder]
              : [laterOrder]
            : [],
        nextCursor: cursor === undefined && section === "active" ? 24 : null,
      }),
    );
    const component = fixture.componentInstance as unknown as {
      load(): Promise<void>;
      loadMore(section: "active" | "closed"): Promise<void>;
      orders(): StaffOrder[];
    };
    await component.load();
    await component.loadMore("active");
    expect(component.orders()).toHaveLength(2);

    api.list.mockImplementation((section: string, cursor?: number) =>
      section === "active" && cursor !== undefined
        ? Promise.reject(new Error("second page unavailable"))
        : Promise.resolve({
            orders: section === "active" ? [fixtureOrder] : [],
            nextCursor: section === "active" ? 24 : null,
          }),
    );
    await component.load();
    expect(component.orders()).toMatchObject([
      { id: fixtureOrder.id },
      { id: laterOrder.id, status: "PREPARING" },
    ]);
  });

  it("refreshes a selected order by ID when it disappears from both lists", async () => {
    const initial = requests.splice(0, 2);
    initial[0]!.resolve({ orders: [fixtureOrder], nextCursor: null });
    initial[1]!.resolve({ orders: [], nextCursor: null });
    await drain();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(),
    });
    const component = fixture.componentInstance as unknown as {
      selected: { set(order: StaffOrder | null): void; (): StaffOrder | null };
      load(): Promise<void>;
    };
    component.selected.set(fixtureOrder);
    api.list.mockResolvedValue({ orders: [], nextCursor: null });
    api.get.mockResolvedValue({ ...fixtureOrder, status: "COMPLETED" });
    await component.load();
    expect(api.get).toHaveBeenCalledWith(fixtureOrder.id);
    expect(component.selected()?.status).toBe("COMPLETED");
  });

  it("does not let a response from an earlier board version overwrite newer state", async () => {
    const initial = requests.splice(0, 2);
    initial[0]!.resolve({ orders: [fixtureOrder], nextCursor: null });
    initial[1]!.resolve({ orders: [], nextCursor: null });
    await drain();
    const stalePages: {
      resolve(page: StaffOrderPage): void;
      reject(error: unknown): void;
    }[] = [];
    api.list.mockImplementation(() => page());
    const component = fixture.componentInstance as unknown as {
      refreshLoadedPages(): Promise<void>;
      orders: (() => StaffOrder[]) & {
        set(orders: StaffOrder[]): void;
      };
      mutationVersion: number;
    };
    const staleRefresh = component.refreshLoadedPages();
    component.mutationVersion++;
    component.orders.set([{ ...fixtureOrder, status: "READY" }]);
    stalePages.push(...requests.splice(0));
    stalePages.forEach(({ resolve }) =>
      resolve({ orders: [fixtureOrder], nextCursor: null }),
    );
    await staleRefresh;
    expect(component.orders()).toMatchObject([
      { id: fixtureOrder.id, status: "READY" },
    ]);
  });

  it("rebases loaded closed pages when a new terminal order shifts their boundary", async () => {
    const closedOrder = (number: number): StaffOrder => ({
      ...fixtureOrder,
      id: `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`,
      number,
      status: "COMPLETED",
    });
    const descending = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => closedOrder(from - index));
    const initial = requests.splice(0, 2);
    initial[0]!.resolve({ orders: [], nextCursor: null });
    initial[1]!.resolve({ orders: [], nextCursor: null });
    await drain();

    api.list.mockImplementation((section: string, cursor?: number) => {
      if (section === "active")
        return Promise.resolve({ orders: [], nextCursor: null });
      if (cursor === undefined)
        return Promise.resolve({
          orders: descending(201, 100),
          nextCursor: 102,
        });
      return Promise.resolve({ orders: descending(101, 100), nextCursor: 2 });
    });
    const component = fixture.componentInstance as unknown as {
      load(): Promise<void>;
      loadMore(section: "active" | "closed"): Promise<void>;
      orders(): StaffOrder[];
      refreshQueued: boolean;
    };
    component.refreshQueued = false;
    await component.load();
    await component.loadMore("closed");
    expect(component.orders()).toHaveLength(200);

    api.list.mockImplementation((section: string, cursor?: number) => {
      if (section === "active")
        return Promise.resolve({ orders: [], nextCursor: null });
      if (cursor === undefined)
        return Promise.resolve({
          orders: descending(202, 100),
          nextCursor: 103,
        });
      return Promise.resolve({ orders: descending(102, 100), nextCursor: 3 });
    });
    component.refreshQueued = false;
    await component.load();
    expect(api.list).toHaveBeenCalledWith("closed", 103);
    expect(component.orders()).toHaveLength(200);
    expect(component.orders().some((order) => order.number === 102)).toBe(true);
    expect(new Set(component.orders().map((order) => order.id)).size).toBe(200);
  });
});
