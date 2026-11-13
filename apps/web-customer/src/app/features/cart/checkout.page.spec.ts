import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { CheckoutPage } from "./checkout.page";
import { Bag } from "./bag";
import { StoreContext } from "../../core/tenant/store-context";

it("keeps equivalent quotes and invalidates changes to fulfillment, payment, price, availability or menu version", async () => {
  const checkout = signal({
    fulfillmentModes: ["DELIVERY", "PICKUP"],
    acceptedPaymentMethods: ["CASH", "PIX_ON_DELIVERY"],
    deliveryFeeCents: 300,
    minimumOrderCents: 100,
  });
  const availability = signal("open");
  const menu = signal({ version: 1 });
  const invalidateQuote = vi.fn();
  const model = { invalidateQuote, quote: vi.fn(), confirm: vi.fn() };
  const shop = {
    state: signal({
      ready: true,
      cart: [{}],
      profile: { id: "a" },
      addresses: [{ id: "1" }, { id: "2" }],
    }),
    model,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: StoreContext, useValue: { checkout, availability } },
    ],
  });
  TestBed.overrideComponent(CheckoutPage, {
    set: {
      template: "",
      providers: [
        {
          provide: Bag,
          useValue: {
            shop,
            subtotal: () => 100,
            catalog: { menu, status: signal("ready") },
          },
        },
      ],
    },
  });
  const fixture = TestBed.createComponent(CheckoutPage);
  fixture.detectChanges();
  const page = fixture.componentInstance;
  page.form.controls.addressId.setValue("1");
  await page.submit();
  expect(model.quote).toHaveBeenCalledTimes(1);
  checkout.set({ ...checkout() });
  menu.set({ ...menu() });
  fixture.detectChanges();
  expect(invalidateQuote).not.toHaveBeenCalled();
  for (const change of [
    () => checkout.update((s) => ({ ...s, deliveryFeeCents: 400 })),
    () => page.form.controls.addressId.setValue("2"),
    () => page.form.controls.change.setValue("20"),
    () => page.form.controls.paymentMethod.setValue("PIX_ON_DELIVERY"),
    () => menu.set({ version: 2 }),
    () => availability.set("closed"),
  ]) {
    invalidateQuote.mockClear();
    change();
    fixture.detectChanges();
    expect(invalidateQuote).toHaveBeenCalledTimes(1);
    await page.submit();
  }
  expect(page.action().kind).toBe("blocked");
  expect(model.confirm).not.toHaveBeenCalled();
});
