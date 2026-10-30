import { ComponentFixture, TestBed } from "@angular/core/testing";
import {
  BillingApi,
  type BillingEntry,
  type BillingReport,
} from "../billing/billing-api";
import { periodLabel } from "../billing/billing-report-view";
import { sampleReport } from "../billing/billing.testing";
import type { PlatformTenant } from "./platform-api";
import { TenantBillingDialog } from "./tenant-billing-dialog";

const tenant: PlatformTenant = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "bairro",
  displayName: "Pizzaria Bairro",
  status: "ACTIVE",
  createdAt: "2026-08-01T12:00:00Z",
  timeZone: "America/Sao_Paulo",
  plan: { code: "FLEX", validFrom: "2026-08-01T03:00:00Z" },
  scheduledPlan: null,
};

const entry = (
  id: string,
  orderNumber: number,
  overrides: Partial<BillingEntry> = {},
): BillingEntry => ({
  id,
  type: "ORDER_COMPLETED",
  orderId: `order-${id}`,
  orderNumber,
  plan: "FLEX",
  feeBasisPoints: 300,
  itemsSubtotalCents: 4000,
  deliveryFeeCents: 0,
  totalCents: 4000,
  paymentMethod: "CASH",
  occurredAt: "2026-10-10T15:00:00Z",
  period: "2026-10",
  reversesEntryId: null,
  reasonCode: null,
  reversedByEntryId: null,
  ...overrides,
});

const month = (period = "2026-10"): BillingEntry[] => [
  entry("a", 1, { period, reversedByEntryId: "r" }),
  entry("r", 1, {
    period,
    type: "ORDER_REVERSED",
    itemsSubtotalCents: -4000,
    totalCents: -4000,
    reversesEntryId: "a",
    reasonCode: "SALE_UNDONE",
  }),
  entry("b", 2, { period }),
  entry("c", 3, { period, plan: null, feeBasisPoints: null }),
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => (resolve = ok));
  return { promise, resolve };
}

describe("TenantBillingDialog", () => {
  let fixture: ComponentFixture<TenantBillingDialog>;
  let api: {
    tenantReport: ReturnType<typeof vi.fn>;
    tenantEntries: ReturnType<typeof vi.fn>;
    reverse: ReturnType<typeof vi.fn>;
  };
  const drain = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
    fixture.detectChanges();
  };
  const element = () => fixture.nativeElement as HTMLElement;
  const text = () => element().textContent ?? "";
  const caption = () => element().querySelector("caption")?.textContent ?? "";
  const button = (label: string) =>
    element().querySelector(
      `button[aria-label="${label}"]`,
    ) as HTMLButtonElement | null;
  const buttonNamed = (name: string) =>
    [...element().querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(name),
    ) as HTMLButtonElement | undefined;
  const alerts = () =>
    [...element().querySelectorAll("[role=alert]")].map(
      (alert) => alert.textContent ?? "",
    );
  const askReversal = async (orderNumber: number, reasonIndex = 0) => {
    button(`Estornar pedido #${orderNumber}`)!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const select = element().querySelector("select") as HTMLSelectElement;
    select.value = select.options[reasonIndex]!.value;
    select.dispatchEvent(new Event("change"));
    fixture.detectChanges();
    return element().querySelector(
      `form[aria-label="Estornar pedido #${orderNumber}"] button[type=submit]`,
    ) as HTMLButtonElement;
  };
  const changeMonth = async (period: string) => {
    const input = element().querySelector(
      "#tenant-billing-period",
    ) as HTMLInputElement;
    input.value = period;
    input.dispatchEvent(new Event("input"));
    (
      element().querySelector(
        'form[aria-label="Mês da cobrança"] button[type=submit]',
      ) as HTMLButtonElement
    ).click();
    await drain();
  };

  beforeEach(async () => {
    api = {
      tenantReport: vi.fn((_: string, period: string | null) =>
        Promise.resolve(sampleReport(period ?? "2026-10")),
      ),
      tenantEntries: vi.fn((_: string, period: string) =>
        Promise.resolve(month(period)),
      ),
      reverse: vi.fn(() => Promise.resolve({ entryId: "r2", changed: true })),
    };
    TestBed.configureTestingModule({
      imports: [TenantBillingDialog],
      providers: [{ provide: BillingApi, useValue: api }],
    });
    fixture = TestBed.createComponent(TenantBillingDialog);
    fixture.componentRef.setInput("tenant", tenant);
    fixture.detectChanges();
    await fixture.whenStable();
    await drain();
  });
  afterEach(() => fixture.destroy());

  it("shows the estimate and the same month's entries, offering reversal only where it applies", () => {
    expect(api.tenantReport).toHaveBeenCalledWith(tenant.id, null);
    expect(api.tenantEntries).toHaveBeenCalledWith(tenant.id, "2026-10");
    expect(text()).toContain("Estimativa.");
    expect(text()).toContain("Venda (estornada)");
    expect(text()).toContain("Estorno: venda desfeita");
    expect(text()).toContain("Sem plano registrado");
    // Already reversed, a reversal itself and an entry without a plan snapshot: no button.
    expect(button("Estornar pedido #1")).toBeNull();
    expect(button("Estornar pedido #3")).toBeNull();
    expect(button("Estornar pedido #2")).not.toBeNull();
  });

  it("shows nothing of the month when the report fails, and retries", async () => {
    api.tenantReport.mockRejectedValueOnce(new Error("Falha"));
    await changeMonth("2026-09");
    expect(element().querySelector("caption")).toBeNull();
    expect(element().querySelector("table.ledger")).toBeNull();
    expect(alerts().join()).toContain(`relatório de ${periodLabel("2026-09")}`);
    expect(api.tenantEntries).toHaveBeenCalledTimes(1);

    buttonNamed("Tentar novamente")!.click();
    await drain();
    expect(api.tenantReport).toHaveBeenLastCalledWith(tenant.id, "2026-09");
    expect(caption()).toContain(periodLabel("2026-09"));
    expect(alerts()).toEqual([]);
  });

  it("shows nothing of the month when its entries fail, not even the report", async () => {
    api.tenantEntries.mockRejectedValueOnce(new Error("Falha"));
    await changeMonth("2026-09");
    expect(element().querySelector("caption")).toBeNull();
    expect(button("Estornar pedido #2")).toBeNull();
    expect(alerts().join()).toContain(
      `lançamentos de ${periodLabel("2026-09")}`,
    );
  });

  it("swaps both the report and the entries when the month changes", async () => {
    await changeMonth("2026-09");
    expect(api.tenantEntries).toHaveBeenLastCalledWith(tenant.id, "2026-09");
    expect(caption()).toContain(periodLabel("2026-09"));
    expect(text()).toContain(`Lançamentos de ${periodLabel("2026-09")}`);
  });

  it("reverses with the chosen reason and reloads the month", async () => {
    const confirm = await askReversal(2, 1);
    confirm.click();
    await drain();
    expect(api.reverse).toHaveBeenCalledWith(tenant.id, "b", "SALE_UNDONE");
    expect(api.tenantReport).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Pedido #2 estornado.");
    expect(alerts()).toEqual([]);
  });

  it("says a confirmed reversal was recorded when the reload fails, and offers only a reload", async () => {
    api.tenantEntries.mockRejectedValueOnce(new Error("Falha"));
    const confirm = await askReversal(2);
    confirm.click();
    await drain();
    expect(api.reverse).toHaveBeenCalledTimes(1);
    const status = element().querySelector(".status--success")!.textContent!;
    expect(status).toContain("Pedido #2 estornado.");
    expect(status).toContain("não foram atualizados");
    expect(alerts().join()).not.toContain("não foi registrado");
    // No figures and no reversal button until the month is reloaded.
    expect(element().querySelector("caption")).toBeNull();
    expect(button("Estornar pedido #2")).toBeNull();

    buttonNamed("Tentar novamente")!.click();
    await drain();
    expect(api.reverse).toHaveBeenCalledTimes(1);
    expect(caption()).toContain(periodLabel("2026-10"));
  });

  it("keeps the month and says the reversal was not recorded when it fails", async () => {
    api.reverse.mockRejectedValueOnce(new Error("Falha"));
    const confirm = await askReversal(2);
    confirm.click();
    await drain();
    expect(api.reverse).toHaveBeenCalledWith(
      tenant.id,
      "b",
      "COMPLETED_BY_MISTAKE",
    );
    expect(alerts().join()).toContain(
      "O estorno do pedido #2 não foi registrado.",
    );
    expect(api.tenantReport).toHaveBeenCalledTimes(1);
    expect(caption()).toContain(periodLabel("2026-10"));
  });

  it("sends one reversal for a double click", async () => {
    const slow = deferred<{ entryId: string; changed: boolean }>();
    api.reverse.mockReturnValueOnce(slow.promise);
    const confirm = await askReversal(2);
    confirm.click();
    confirm.click();
    fixture.detectChanges();
    confirm.click();
    slow.resolve({ entryId: "r2", changed: true });
    await drain();
    expect(api.reverse).toHaveBeenCalledTimes(1);
  });

  it("refuses to reverse an entry already reversed or without a plan snapshot", async () => {
    const dialog = fixture.componentInstance as unknown as {
      reverse: (entry: BillingEntry) => Promise<void>;
    };
    await dialog.reverse(month()[0]!);
    await dialog.reverse(month()[3]!);
    expect(api.reverse).not.toHaveBeenCalled();
  });

  it("shows only the latest month when an older answer arrives late", async () => {
    const slow = deferred<BillingReport>();
    api.tenantReport.mockReturnValueOnce(slow.promise);
    const dialog = fixture.componentInstance as unknown as {
      period: string;
      load: () => Promise<boolean>;
    };
    dialog.period = "2026-07";
    const older = dialog.load();
    dialog.period = "2026-09";
    await dialog.load();
    slow.resolve(sampleReport("2026-07"));
    expect(await older).toBe(false);
    await drain();
    expect(caption()).toContain(periodLabel("2026-09"));
    expect(api.tenantEntries).not.toHaveBeenCalledWith(tenant.id, "2026-07");
  });
});
