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
    hasUncertainIntent: ReturnType<typeof vi.fn>;
  };

  const page = (): Promise<StaffOrderPage> =>
    new Promise((resolve, reject) => requests.push({ resolve, reject }));
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  beforeEach(() => {
    requests = [];
    api = { list: vi.fn(() => page()), hasUncertainIntent: vi.fn(() => false) };
    TestBed.configureTestingModule({
      imports: [OrdersPage],
      providers: [{ provide: OrdersApi, useValue: api }],
    });
    fixture = TestBed.createComponent(OrdersPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
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
});
