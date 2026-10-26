import { HttpErrorResponse } from "@angular/common/http";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import {
  type HistoryEntry,
  type HistoryPage,
  type OrderDetail,
  OrderHistoryApi,
} from "./history-api";
import { OrderHistoryPage } from "./order-history.page";

const entry = (number: number, extra: Partial<HistoryEntry> = {}) => ({
  id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
  number,
  status: "COMPLETED" as const,
  placedAt: "2026-10-20T22:00:00.000Z",
  fulfillment: "DELIVERY" as const,
  paymentMethod: "CASH" as const,
  customerName: "Joana",
  totalCents: 4700,
  openIncidents: 0,
  ...extra,
});

const detail = (extra: Partial<OrderDetail> = {}): OrderDetail => ({
  ...entry(7),
  deliveryAddress: null,
  changeForCents: null,
  notes: null,
  customerPhone: null,
  items: [],
  itemsSubtotalCents: 4000,
  deliveryFeeCents: 700,
  discountCents: 0,
  history: [
    {
      from: "PLACED",
      to: "PREPARING",
      at: "2026-10-20T22:05:00.000Z",
      actorType: "STAFF",
      actorName: "Carla Forno",
    },
    {
      from: "PREPARING",
      to: "CANCELED",
      at: "2026-10-20T22:10:00.000Z",
      actorType: "SYSTEM",
      reasonCode: "ACCEPT_TIMEOUT",
    },
  ],
  incidents: [],
  ...extra,
});

const incident = {
  id: "99999999-9999-4999-8999-999999999999",
  type: "LATE_DELIVERY" as const,
  description: "Chegou frio",
  reportedBy: "CUSTOMER" as const,
  status: "OPEN" as const,
  resolutionNote: null,
  createdAt: "2026-10-20T23:00:00.000Z",
  createdByName: "Bruna",
  resolvedAt: null,
  resolvedByName: null,
};

describe("OrderHistoryPage", () => {
  let fixture: ComponentFixture<OrderHistoryPage>;
  let api: {
    history: ReturnType<typeof vi.fn>;
    detail: ReturnType<typeof vi.fn>;
    reportIncident: ReturnType<typeof vi.fn>;
    resolveIncident: ReturnType<typeof vi.fn>;
    pendingIncident: ReturnType<typeof vi.fn>;
  };
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    fixture.detectChanges();
  };
  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? "";
  const element = <T extends Element>(selector: string) =>
    (fixture.nativeElement as HTMLElement).querySelector<T>(selector)!;
  const button = (label: string) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll("button")].find(
      (item) => item.textContent?.trim().startsWith(label),
    )!;

  beforeEach(async () => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    api = {
      history: vi.fn((): Promise<HistoryPage> =>
        Promise.resolve({ orders: [entry(9), entry(8)], nextCursor: 8 }),
      ),
      detail: vi.fn(() => Promise.resolve(detail())),
      reportIncident: vi.fn(() => Promise.resolve(incident)),
      resolveIncident: vi.fn(() => Promise.resolve(incident)),
      pendingIncident: vi.fn(() => undefined),
    };
    TestBed.configureTestingModule({
      imports: [OrderHistoryPage],
      providers: [{ provide: OrderHistoryApi, useValue: api }],
    });
    fixture = TestBed.createComponent(OrderHistoryPage);
    fixture.detectChanges();
    await fixture.whenStable();
    await drain();
  });
  afterEach(() => {
    fixture.destroy();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  });

  it("lists the newest orders and loads the next page with the same filters", async () => {
    expect(api.history).toHaveBeenCalledWith({}, undefined);
    expect(text()).toContain("#9");
    expect(text()).toContain("Concluído");
    api.history.mockResolvedValueOnce({
      orders: [entry(7, { customerName: null, openIncidents: 2 })],
      nextCursor: null,
    });
    button("Carregar mais").click();
    await drain();
    expect(api.history).toHaveBeenLastCalledWith({}, 8);
    expect(text()).toContain("Cliente excluído");
    expect(text()).toContain("2 ocorrência(s) aberta(s)");
    expect(button("Carregar mais")).toBeUndefined();
  });

  it("applies the filters that are filled and refuses a reversed range locally", async () => {
    const set = (selector: string, value: string) => {
      const input = element<HTMLInputElement | HTMLSelectElement>(selector);
      input.value = value;
      input.dispatchEvent(
        new Event(input.tagName === "SELECT" ? "change" : "input"),
      );
    };
    set("#history-from", "2026-10-01");
    set("#history-to", "2026-10-10");
    set("#history-status", "CANCELED");
    set("#history-fulfillment", "PICKUP");
    set("#history-number", "12");
    fixture.detectChanges();
    button("Filtrar").click();
    await drain();
    expect(api.history).toHaveBeenLastCalledWith(
      {
        from: "2026-10-01",
        to: "2026-10-10",
        status: "CANCELED",
        fulfillment: "PICKUP",
        number: 12,
      },
      undefined,
    );

    const calls = api.history.mock.calls.length;
    set("#history-from", "2026-10-11");
    fixture.detectChanges();
    button("Filtrar").click();
    await drain();
    expect(api.history.mock.calls.length).toBe(calls);
    expect(text()).toContain("A data final precisa ser igual ou posterior");

    button("Limpar").click();
    await drain();
    expect(api.history).toHaveBeenLastCalledWith({}, undefined);
  });

  it("shows who moved the order and records and resolves incidents", async () => {
    button("#9").click();
    await drain();
    expect(text()).toContain("por Carla Forno");
    expect(text()).toContain("automático");
    expect(text()).toContain("Tempo de aceite esgotado");
    expect(text()).toContain("Nenhuma ocorrência registrada.");

    api.detail.mockResolvedValueOnce(detail({ incidents: [incident] }));
    const description = element<HTMLTextAreaElement>("#incident-description");
    description.value = "  Chegou frio  ";
    description.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    button("Registrar ocorrência").click();
    await drain();
    expect(api.reportIncident).toHaveBeenCalledWith(entry(7).id, {
      type: "LATE_DELIVERY",
      description: "Chegou frio",
      reportedBy: "CUSTOMER",
    });
    expect(text()).toContain("Atraso");
    expect(text()).toContain("Relatada pelo cliente");

    api.detail.mockResolvedValueOnce(
      detail({
        incidents: [
          {
            ...incident,
            status: "RESOLVED",
            resolvedByName: "Marcos",
            resolvedAt: "2026-10-21T10:00:00.000Z",
            resolutionNote: "Cupom",
          },
        ],
      }),
    );
    button("Marcar como resolvida").click();
    await drain();
    expect(api.resolveIncident).toHaveBeenCalledWith(
      entry(7).id,
      incident.id,
      "",
    );
    expect(text()).toContain("Resolvida por Marcos");
    expect(text()).toContain("Cupom");
  });

  it("offers to repeat an unconfirmed record with its key instead of a new form", async () => {
    const pending = {
      orderId: entry(7).id,
      type: "WRONG_ITEM" as const,
      description: "Veio calabresa",
      reportedBy: "STAFF" as const,
      idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      createdAt: Date.now(),
      uncertain: true,
    };
    api.pendingIncident.mockReturnValue(pending);
    button("#9").click();
    await drain();
    expect(text()).toContain("Registro aguardando confirmação");
    expect(text()).toContain("Item errado: Veio calabresa");
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        "#incident-description",
      ),
    ).toBeNull();

    api.reportIncident.mockImplementationOnce(() => {
      api.pendingIncident.mockReturnValue(undefined);
      return Promise.resolve(incident);
    });
    api.detail.mockResolvedValueOnce(detail({ incidents: [incident] }));
    button("Verificar / repetir registro").click();
    await drain();
    expect(api.reportIncident).toHaveBeenCalledWith(entry(7).id, {
      type: "WRONG_ITEM",
      description: "Veio calabresa",
      reportedBy: "STAFF",
    });
    expect(text()).not.toContain("Registro aguardando confirmação");
    expect(element("#incident-description")).toBeTruthy();
  });

  it("says a record whose answer was lost is kept for a retry", async () => {
    button("#9").click();
    await drain();
    api.reportIncident.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 0 }),
    );
    const description = element<HTMLTextAreaElement>("#incident-description");
    description.value = "Sem resposta";
    description.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    button("Registrar ocorrência").click();
    await drain();
    expect(text()).toContain("ficou guardado com a mesma chave");
  });

  it("explains an incident refused for an order that ended long ago", async () => {
    button("#9").click();
    await drain();
    api.reportIncident.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 422,
        error: { code: "INCIDENT_WINDOW_CLOSED" },
      }),
    );
    const description = element<HTMLTextAreaElement>("#incident-description");
    description.value = "Reclamação antiga";
    description.dispatchEvent(new Event("input"));
    fixture.detectChanges();
    button("Registrar ocorrência").click();
    await drain();
    expect(text()).toContain("até 30 dias depois do fim do pedido");
  });
});
