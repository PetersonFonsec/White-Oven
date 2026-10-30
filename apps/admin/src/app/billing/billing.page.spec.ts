import { ComponentFixture, TestBed } from "@angular/core/testing";
import { BillingApi } from "./billing-api";
import { sampleReport } from "./billing.testing";
import { BillingPage } from "./billing.page";
import { periodLabel } from "./billing-report-view";

describe("BillingPage", () => {
  let fixture: ComponentFixture<BillingPage>;
  let api: { storeReport: ReturnType<typeof vi.fn> };
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    fixture.detectChanges();
  };
  const element = () => fixture.nativeElement as HTMLElement;
  const text = () => element().textContent ?? "";

  beforeEach(async () => {
    api = {
      storeReport: vi.fn((period: string | null) =>
        Promise.resolve(sampleReport(period ?? "2026-10")),
      ),
    };
    TestBed.configureTestingModule({
      imports: [BillingPage],
      providers: [{ provide: BillingApi, useValue: api }],
    });
    fixture = TestBed.createComponent(BillingPage);
    fixture.detectChanges();
    await fixture.whenStable();
    await drain();
  });
  afterEach(() => fixture.destroy());

  it("opens on the store's current month and says it is an estimate", async () => {
    expect(api.storeReport).toHaveBeenCalledWith(null);
    expect(text()).toContain("Estimativa.");
    expect(text()).toContain("Nada é cobrado ainda");
    expect(text()).toContain(periodLabel("2026-10"));
    expect(text()).toContain("Flex (3%)");
    expect(text()).toMatch(/Total estimado\s*R\$\s2,40/);
    await fixture.whenStable();
    expect(
      (element().querySelector("#billing-period") as HTMLInputElement).value,
    ).toBe("2026-10");
  });

  it("loads the chosen month and shows API errors", async () => {
    const input = element().querySelector(
      "#billing-period",
    ) as HTMLInputElement;
    input.value = "2026-08";
    input.dispatchEvent(new Event("input"));
    (
      element().querySelector("button[type=submit]") as HTMLButtonElement
    ).click();
    await drain();
    expect(api.storeReport).toHaveBeenLastCalledWith("2026-08");
    expect(text()).toContain(periodLabel("2026-08"));

    api.storeReport.mockRejectedValueOnce(new Error("Falha de rede"));
    (
      element().querySelector("button[type=submit]") as HTMLButtonElement
    ).click();
    await drain();
    expect(element().querySelector("[role=alert]")).not.toBeNull();
  });

  it("names an empty month instead of an empty table", async () => {
    api.storeReport.mockResolvedValueOnce({
      ...sampleReport("2026-07"),
      lines: [],
      subscriptions: [],
    });
    (
      element().querySelector("button[type=submit]") as HTMLButtonElement
    ).click();
    await drain();
    expect(text()).toContain("Nenhum pedido concluído no mês.");
    expect(text()).toContain("Nenhum plano vigente no mês.");
  });
});
