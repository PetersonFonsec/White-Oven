import { HttpErrorResponse } from "@angular/common/http";
import { TestBed } from "@angular/core/testing";
import { CatalogApi } from "../catalog/catalog-api";
import { catalogFixture } from "../catalog/catalog-fixture.testing";
import { SettingsPage } from "./settings.page";
import { StoreApi, type StoreState } from "./store-api";

const settle = () => new Promise((resolve) => setTimeout(resolve));
const DEFAULTS: StoreState["settings"] = {
  fulfillmentModes: ["DELIVERY"],
  deliveryFeeCents: 0,
  minimumOrderCents: 0,
  deliveryAreaDescription: null,
  estimatedPrepMinutes: 30,
  estimatedDeliveryMinutes: 40,
  acceptTimeoutMinutes: 10,
  acceptedPaymentMethods: ["CASH", "CARD_ON_DELIVERY", "PIX_ON_DELIVERY"],
  contactPhone: null,
  pickupAddress: null,
};
const state = (): StoreState => ({
  timezone: "America/Sao_Paulo",
  settingsSaved: false,
  settings: structuredClone(DEFAULTS),
  openingHours: {
    rules: [{ weekday: 5, opensAt: "18:00", closesAt: "23:00" }],
    exceptions: [],
  },
  pause: { paused: false, pausedUntil: null, timezone: "America/Sao_Paulo" },
});

describe("SettingsPage", () => {
  const store = {
    get: vi.fn(),
    updateSettings: vi.fn(),
    updateOpeningHours: vi.fn(),
    updatePricingPolicy: vi.fn(),
    pause: vi.fn(),
    startPause: vi.fn(),
    endPause: vi.fn(),
  };
  const catalog = { snapshot: vi.fn() };

  beforeEach(() => {
    for (const mock of [...Object.values(store), catalog.snapshot])
      mock.mockReset();
    store.get.mockImplementation(async () => state());
    catalog.snapshot.mockImplementation(async () => catalogFixture());
    store.updatePricingPolicy.mockImplementation(async (policy) => policy);
    store.updateSettings.mockImplementation(async (settings) => settings);
    store.updateOpeningHours.mockImplementation(async (hours) => hours);
    TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        { provide: StoreApi, useValue: store },
        { provide: CatalogApi, useValue: catalog },
      ],
    });
  });

  const render = async () => {
    const fixture = TestBed.createComponent(SettingsPage);
    const element = fixture.nativeElement as HTMLElement;
    const flush = async () => {
      await settle();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    await flush();
    const query = <T extends Element = HTMLElement>(selector: string) =>
      element.querySelector<T & Element>(selector);
    const button = (text: string) =>
      Array.from(element.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === text,
      )!;
    const click = async (text: string) => {
      button(text).click();
      await flush();
    };
    const type = async (selector: string, value: string) => {
      const input = query<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event("input"));
      await flush();
    };
    const check = async (selector: string, checked = true) => {
      const input = query<HTMLInputElement>(selector)!;
      input.checked = checked;
      input.dispatchEvent(new Event("change"));
      await flush();
    };
    const submit = async (text: string) => {
      button(text).closest("form")!.dispatchEvent(new Event("submit"));
      await flush();
    };
    const alert = () => query('[role="alert"]')?.textContent?.trim() ?? "";
    const notice = () => query(".settings-notice")?.textContent?.trim() ?? "";
    return {
      element,
      flush,
      query,
      button,
      click,
      type,
      check,
      submit,
      alert,
      notice,
    };
  };
  const examples = (page: Awaited<ReturnType<typeof render>>) =>
    Array.from(page.element.querySelectorAll(".examples strong")).map((item) =>
      item.textContent?.replace(/\s/g, ""),
    );

  describe("pricing policy", () => {
    it("previews the chosen policy before saving and saves cents", async () => {
      const page = await render();
      expect(page.element.textContent).toContain("Nenhuma política salva");
      expect(examples(page)).toEqual(["R$60.00", "R$60.00"]);

      await page.check('input[name="strategy"][value="AVERAGE"]');
      await page.type("#policy-surcharge", "3,5");
      expect(examples(page)).toEqual(["R$60.00", "R$58.50"]);
      expect(store.updatePricingPolicy).not.toHaveBeenCalled();

      await page.submit("Salvar política");
      expect(store.updatePricingPolicy).toHaveBeenCalledWith({
        halfAndHalfStrategy: "AVERAGE",
        halfAndHalfSurchargeCents: 350,
        maxExtrasPerHalf: 4,
      });
      expect(page.notice()).toBe("Política de preço salva.");
      expect(page.element.textContent).not.toContain("Nenhuma política salva");
    });

    it("does not send an invalid surcharge", async () => {
      const page = await render();
      await page.type("#policy-surcharge", "-2");
      await page.submit("Salvar política");
      expect(store.updatePricingPolicy).not.toHaveBeenCalled();
      expect(page.query("#policy-surcharge-error")?.textContent?.trim()).toBe(
        "O valor não pode ser negativo.",
      );
    });
  });

  describe("opening hours", () => {
    it("shows a shift that crosses midnight and saves the week", async () => {
      const page = await render();
      await page.click("Horários");
      await page.type("#rule-0-closes", "02:00");
      expect(page.element.textContent).toContain("fecha no dia seguinte");
      await page.submit("Salvar horários");
      expect(store.updateOpeningHours).toHaveBeenCalledWith({
        rules: [{ weekday: 5, opensAt: "18:00", closesAt: "02:00" }],
        exceptions: [],
      });
      expect(page.notice()).toBe("Horários salvos.");
    });

    it("shows the API's overlap next to the offending row and keeps the values", async () => {
      store.updateOpeningHours.mockRejectedValue(
        new HttpErrorResponse({
          status: 422,
          error: {
            code: "OPENING_HOURS_INVALID",
            message: "x",
            details: {
              errors: [{ code: "OPENING_HOURS_OVERLAP", path: "rules[1]" }],
            },
          },
        }),
      );
      const page = await render();
      await page.click("Horários");
      await page.type("#rule-0-closes", "02:00");
      // Saturday is the second fieldset after Friday in a Monday-first week.
      const saturday = Array.from(
        page.element.querySelectorAll("fieldset"),
      ).find(
        (item) =>
          item.querySelector("legend")?.textContent?.trim() === "Sábado",
      )!;
      Array.from(saturday.querySelectorAll("button"))
        .find((item) => item.textContent?.trim() === "Adicionar turno")!
        .click();
      await page.flush();
      await page.type("#rule-1-opens", "01:00");
      await page.type("#rule-1-closes", "03:00");
      await page.submit("Salvar horários");

      expect(page.alert()).toBe("Confira os horários destacados.");
      const input = page.query<HTMLInputElement>("#rule-1-opens")!;
      expect(input.value).toBe("01:00");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(page.query("#rules\\[1\\]-error")?.textContent?.trim()).toContain(
        "madrugada do dia anterior",
      );
      expect(page.query("#rule-0-opens")!.getAttribute("aria-invalid")).toBe(
        "false",
      );
    });

    it("refuses equal opening and closing before sending", async () => {
      const page = await render();
      await page.click("Horários");
      await page.type("#rule-0-closes", "18:00");
      await page.submit("Salvar horários");
      expect(store.updateOpeningHours).not.toHaveBeenCalled();
      expect(page.element.textContent).toContain(
        "Abertura e fechamento precisam ser diferentes.",
      );
    });

    it("adds date exceptions in date order and saves them with the week", async () => {
      const page = await render();
      await page.click("Horários");
      await page.type("#exception-date", "2026-12-31");
      // The second option, "Horário especial".
      const special = page.element.querySelectorAll<HTMLInputElement>(
        'input[name="exceptionClosed"]',
      )[1]!;
      special.checked = true;
      special.dispatchEvent(new Event("change"));
      await page.flush();
      await page.type("#exception-shift-0-opens", "19:00");
      await page.type("#exception-shift-0-closes", "03:00");
      await page.click("Incluir exceção");
      await page.type("#exception-date", "2026-12-25");
      await page.click("Incluir exceção");
      await page.type("#exception-date", "2026-12-25");
      await page.click("Incluir exceção");
      expect(page.element.textContent).toContain(
        "Já existe uma exceção para esta data.",
      );
      expect(page.element.textContent).toContain("19:00–03:00 (dia seguinte)");

      await page.submit("Salvar horários");
      expect(store.updateOpeningHours).toHaveBeenCalledWith({
        rules: [{ weekday: 5, opensAt: "18:00", closesAt: "23:00" }],
        exceptions: [
          { date: "2026-12-25", closed: true, shifts: [] },
          {
            date: "2026-12-31",
            closed: false,
            shifts: [{ opensAt: "19:00", closesAt: "03:00" }],
          },
        ],
      });
    });
  });

  describe("orders and delivery", () => {
    it("requires a pickup address when pickup is offered, before sending", async () => {
      const page = await render();
      await page.click("Pedidos e entrega");
      await page.check('input[name="mode-PICKUP"]');
      await page.submit("Salvar pedidos e entrega");
      expect(store.updateSettings).not.toHaveBeenCalled();
      expect(page.element.textContent).toContain(
        "Informe o endereço de retirada",
      );
      expect(page.query("#settings-pickup")!.getAttribute("aria-invalid")).toBe(
        "true",
      );
    });

    it("saves fee and minimum in cents with the chosen modes and payments", async () => {
      const page = await render();
      await page.click("Pedidos e entrega");
      await page.check('input[name="mode-PICKUP"]');
      await page.type("#settings-pickup", "Rua das Pizzas, 10");
      await page.type("#settings-fee", "7,5");
      await page.type("#settings-minimum", "30");
      await page.check('input[name="payment-CARD_ON_DELIVERY"]', false);
      await page.type("#settings-timeout", "15");
      await page.submit("Salvar pedidos e entrega");
      expect(store.updateSettings).toHaveBeenCalledWith({
        ...DEFAULTS,
        fulfillmentModes: ["DELIVERY", "PICKUP"],
        deliveryFeeCents: 750,
        minimumOrderCents: 3000,
        acceptTimeoutMinutes: 15,
        acceptedPaymentMethods: ["CASH", "PIX_ON_DELIVERY"],
        pickupAddress: "Rua das Pizzas, 10",
      });
      expect(page.notice()).toBe("Configurações de pedidos e entrega salvas.");
    });

    it("rejects negative money and an empty payment list", async () => {
      const page = await render();
      await page.click("Pedidos e entrega");
      await page.type("#settings-fee", "-1");
      for (const method of ["CASH", "CARD_ON_DELIVERY", "PIX_ON_DELIVERY"])
        await page.check(`input[name="payment-${method}"]`, false);
      await page.submit("Salvar pedidos e entrega");
      expect(store.updateSettings).not.toHaveBeenCalled();
      expect(page.query("#settings-fee-error")?.textContent?.trim()).toBe(
        "O valor não pode ser negativo.",
      );
      expect(page.element.textContent).toContain(
        "Escolha ao menos uma forma de pagamento.",
      );
    });

    it("keeps unsaved edits of one section when another is saved", async () => {
      const page = await render();
      await page.click("Pedidos e entrega");
      await page.type("#settings-fee", "9");
      await page.click("Política de preço");
      await page.submit("Salvar política");
      await page.click("Pedidos e entrega");
      expect(page.query<HTMLInputElement>("#settings-fee")!.value).toBe("9");
      expect(store.get).toHaveBeenCalledTimes(1);
    });
  });
});
