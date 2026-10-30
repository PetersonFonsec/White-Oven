import { ComponentFixture, TestBed } from "@angular/core/testing";
import { BillingApi, type BillingReport } from "./billing-api";
import { BillingPage } from "./billing.page";
import { periodLabel } from "./billing-report-view";
import { sampleReport } from "./billing.testing";

/** A promise the test resolves or rejects when it wants. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("BillingPage", () => {
  let fixture: ComponentFixture<BillingPage>;
  let api: { storeReport: ReturnType<typeof vi.fn> };
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    fixture.detectChanges();
  };
  const element = () => fixture.nativeElement as HTMLElement;
  const text = () => element().textContent ?? "";
  const caption = () => element().querySelector("caption")?.textContent ?? "";
  const ask = async (period: string) => {
    const input = element().querySelector(
      "#billing-period",
    ) as HTMLInputElement;
    input.value = period;
    input.dispatchEvent(new Event("input"));
    (
      element().querySelector("button[type=submit]") as HTMLButtonElement
    ).click();
    fixture.detectChanges();
  };

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
    expect(caption()).toContain(periodLabel("2026-10"));
    expect(text()).toContain("Flex (3%)");
    expect(text()).toMatch(/Total estimado\s*R\$\s2,40/);
    await fixture.whenStable();
    expect(
      (element().querySelector("#billing-period") as HTMLInputElement).value,
    ).toBe("2026-10");
  });

  it("loads the chosen month", async () => {
    await ask("2026-08");
    await drain();
    expect(api.storeReport).toHaveBeenLastCalledWith("2026-08");
    expect(caption()).toContain(periodLabel("2026-08"));
  });

  it("never leaves the previous month on screen when another month fails, and retries it", async () => {
    api.storeReport.mockRejectedValueOnce(new Error("Falha de rede"));
    await ask("2026-08");
    await drain();
    expect(element().querySelector("caption")).toBeNull();
    expect(text()).not.toContain("Total estimado");
    const alert = element().querySelector("[role=alert]")!;
    expect(alert.textContent).toContain(periodLabel("2026-08"));

    (
      [...alert.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Tentar novamente"),
      ) as HTMLButtonElement
    ).click();
    await drain();
    expect(api.storeReport).toHaveBeenLastCalledWith("2026-08");
    expect(element().querySelector("[role=alert]")).toBeNull();
    expect(caption()).toContain(periodLabel("2026-08"));
  });

  it("shows only the latest request when an older answer arrives late", async () => {
    const slow = deferred<BillingReport>();
    api.storeReport.mockReturnValueOnce(slow.promise);
    await ask("2026-07");
    // The form waits while a month loads; the page itself still guards a second load.
    const page = fixture.componentInstance as unknown as {
      period: string;
      load: () => Promise<void>;
    };
    page.period = "2026-09";
    await page.load();
    await drain();
    slow.resolve(sampleReport("2026-07"));
    await drain();
    expect(caption()).toContain(periodLabel("2026-09"));
    expect(caption()).not.toContain(periodLabel("2026-07"));
  });

  it("ignores an answer that arrives after the page is gone", async () => {
    const slow = deferred<BillingReport>();
    api.storeReport.mockReturnValueOnce(slow.promise);
    await ask("2026-07");
    const page = fixture.componentInstance as unknown as {
      report: () => BillingReport | null;
      loading: () => boolean;
    };
    fixture.destroy();
    slow.reject(new Error("cancelada"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(page.report()).toBeNull();
    expect(page.loading()).toBe(true);
  });

  it("names an empty month instead of an empty table", async () => {
    api.storeReport.mockResolvedValueOnce({
      ...sampleReport("2026-07"),
      lines: [],
      subscriptions: [],
    });
    await ask("2026-07");
    await drain();
    expect(text()).toContain("Nenhum pedido concluído no mês.");
    expect(text()).toContain("Nenhum plano vigente no mês.");
  });
});
