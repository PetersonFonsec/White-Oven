import { ComponentFixture, TestBed } from "@angular/core/testing";
import {
  type DailySales,
  OrderHistoryApi,
  addDays,
  localDay,
} from "../orders/history-api";
import { DailyReportPage } from "./daily-report.page";

const sales = (count: number, totalCents: number): DailySales => ({
  count,
  totalCents,
  itemsSubtotalCents: totalCents,
  deliveryFeeCents: 0,
  byFulfillment: {
    DELIVERY: { count: 0, totalCents: 0 },
    PICKUP: { count, totalCents },
  },
  byPaymentMethod: {
    CASH: { count, totalCents },
    CARD_ON_DELIVERY: { count: 0, totalCents: 0 },
    PIX_ON_DELIVERY: { count: 0, totalCents: 0 },
  },
});

describe("DailyReportPage", () => {
  let fixture: ComponentFixture<DailyReportPage>;
  let api: { dailyReport: ReturnType<typeof vi.fn> };
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    fixture.detectChanges();
  };
  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? "";
  const set = (selector: string, value: string) => {
    const input = (fixture.nativeElement as HTMLElement).querySelector(
      selector,
    ) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();
  };
  const submit = () =>
    (
      (fixture.nativeElement as HTMLElement).querySelector(
        "button[type=submit]",
      ) as HTMLButtonElement
    ).click();

  beforeEach(async () => {
    api = {
      dailyReport: vi.fn((from: string, to: string) =>
        Promise.resolve({
          from,
          to,
          timezone: "America/Sao_Paulo",
          days: [
            { date: from, ...sales(2, 8000) },
            { date: to, ...sales(0, 0) },
          ],
          totals: sales(2, 8000),
        }),
      ),
    };
    TestBed.configureTestingModule({
      imports: [DailyReportPage],
      providers: [{ provide: OrderHistoryApi, useValue: api }],
    });
    fixture = TestBed.createComponent(DailyReportPage);
    fixture.detectChanges();
    await fixture.whenStable();
    await drain();
  });
  afterEach(() => fixture.destroy());

  it("opens on the last seven days with the totals of the period", () => {
    const today = localDay(new Date());
    expect(api.dailyReport).toHaveBeenCalledWith(addDays(today, -6), today);
    expect(text()).toContain("America/Sao_Paulo");
    expect(text()).toContain("Período");
    expect(text()).toContain("80.00");
  });

  it("checks the range before asking: in order and 31 days at most", async () => {
    set("#report-from", "2026-10-10");
    set("#report-to", "2026-10-01");
    submit();
    await drain();
    expect(text()).toContain("data final igual ou posterior");
    set("#report-from", "2026-09-01");
    set("#report-to", "2026-10-02");
    submit();
    await drain();
    expect(text()).toContain("no máximo 31 dias");
    expect(api.dailyReport).toHaveBeenCalledTimes(1);
    set("#report-to", "2026-10-01");
    submit();
    await drain();
    expect(api.dailyReport).toHaveBeenLastCalledWith(
      "2026-09-01",
      "2026-10-01",
    );
  });
});
