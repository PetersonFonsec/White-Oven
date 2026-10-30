import { ComponentFixture, TestBed } from "@angular/core/testing";
import { BillingApi, type BillingEntry } from "../billing/billing-api";
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

describe("TenantBillingDialog", () => {
  let fixture: ComponentFixture<TenantBillingDialog>;
  let api: {
    tenantReport: ReturnType<typeof vi.fn>;
    tenantEntries: ReturnType<typeof vi.fn>;
    reverse: ReturnType<typeof vi.fn>;
  };
  const drain = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
    fixture.detectChanges();
  };
  const element = () => fixture.nativeElement as HTMLElement;
  const text = () => element().textContent ?? "";
  const button = (label: string) =>
    element().querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;

  beforeEach(async () => {
    api = {
      tenantReport: vi.fn(() => Promise.resolve(sampleReport())),
      tenantEntries: vi.fn(() =>
        Promise.resolve([
          entry("a", 1, { reversedByEntryId: "r" }),
          entry("r", 1, {
            type: "ORDER_REVERSED",
            itemsSubtotalCents: -4000,
            totalCents: -4000,
            reversesEntryId: "a",
            reasonCode: "SALE_UNDONE",
          }),
          entry("b", 2),
          entry("c", 3, { plan: null, feeBasisPoints: null }),
        ]),
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
    expect(button("Estornar pedido #1")).toBeNull();
    expect(button("Estornar pedido #3")).toBeNull();
    expect(button("Estornar pedido #2")).not.toBeNull();
  });

  it("asks for a reason, reverses and reloads the month", async () => {
    button("Estornar pedido #2").click();
    fixture.detectChanges();
    await fixture.whenStable();
    const select = element().querySelector("#reason-b") as HTMLSelectElement;
    select.value = select.options[1]!.value;
    select.dispatchEvent(new Event("change"));
    fixture.detectChanges();
    (
      element().querySelector(
        'form[aria-label="Estornar pedido #2"] button[type=submit]',
      ) as HTMLButtonElement
    ).click();
    await drain();
    expect(api.reverse).toHaveBeenCalledWith(tenant.id, "b", "SALE_UNDONE");
    expect(api.tenantReport).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Pedido #2 estornado.");
  });

  it("keeps the dialog usable when a reversal fails", async () => {
    api.reverse.mockRejectedValueOnce(new Error("Falha"));
    button("Estornar pedido #2").click();
    fixture.detectChanges();
    (
      element().querySelector(
        'form[aria-label="Estornar pedido #2"] button[type=submit]',
      ) as HTMLButtonElement
    ).click();
    await drain();
    expect(api.reverse).toHaveBeenCalledWith(
      tenant.id,
      "b",
      "COMPLETED_BY_MISTAKE",
    );
    expect(element().querySelector("[role=alert]")).not.toBeNull();
    expect(api.tenantReport).toHaveBeenCalledTimes(1);
  });
});
