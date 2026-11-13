import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { OrdersPage } from "./orders.page";
import { Shop } from "../../core/commerce/shop";
import { Catalog } from "../../core/tenant/catalog";
import { StoreContext } from "../../core/tenant/store-context";

it("distinguishes loading, failure, empty history and filtered pages while retaining prior results on retry", async () => {
  const list = vi.fn();
  const state = signal({ ready: true, profile: { id: "a" } });
  let fail!: (reason: Error) => void;
  list.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: Shop,
        useValue: {
          state,
          model: { listCustomerOrders: list },
        },
      },
      { provide: Catalog, useValue: {} },
      { provide: StoreContext, useValue: { slug: () => "store" } },
    ],
  });
  const fixture = TestBed.createComponent(OrdersPage);
  const page = fixture.componentInstance;
  const content = () => {
    fixture.detectChanges();
    return fixture.nativeElement.textContent as string;
  };
  expect(content()).toContain("Consultando pedidos");
  expect(content()).not.toContain("Nenhum pedido");
  fail(new Error("Serviço indisponível"));
  await fixture.whenStable();
  expect(content()).toContain("Tentar novamente");
  expect(content()).not.toContain("ainda não fez");
  list.mockResolvedValueOnce({ orders: [], nextCursor: null });
  await page.load(false);
  expect(content()).toContain("ainda não fez pedidos");
  const order = {
    id: "abc",
    number: 1,
    totalCents: 100,
    status: "PLACED",
    placedAt: "2026-01-01T10:00:00Z",
    fulfillment: "PICKUP",
  };
  list.mockResolvedValueOnce({ orders: [order], nextCursor: 10 });
  await page.load(false);
  expect(content()).toContain("Pedido #1");
  list.mockRejectedValueOnce(new Error("Falha na próxima página"));
  await page.load(true);
  expect(content()).toContain("Pedido #1");
  expect(content()).toContain("Tentar novamente");
  let finish!: () => void;
  list.mockReturnValueOnce(
    new Promise(
      (resolve) =>
        (finish = () =>
          resolve({
            orders: [{ ...order, id: "def", number: 2 }],
            nextCursor: null,
          })),
    ),
  );
  const retry = Array.from(
    fixture.nativeElement.querySelectorAll(
      "button",
    ) as NodeListOf<HTMLButtonElement>,
  ).find((button) => button.textContent.includes("Tentar novamente"))!;
  retry.click();
  expect(list.mock.lastCall?.[0]).toBe(10);
  expect(content()).toContain("Carregando mais pedidos");
  expect(content()).toContain("Pedido #1");
  page.filter.set("completed");
  finish();
  await fixture.whenStable();
  expect(content()).toContain("Nenhum pedido neste filtro");
  page.filter.set("all");
  expect(content()).toContain("Pedido #2");

  let finishOld!: () => void;
  list.mockReturnValueOnce(
    new Promise((resolve) => {
      finishOld = () => resolve({ orders: [order], nextCursor: 10 });
    }),
  );
  const oldRequest = page.load(false);
  const oldSignal = list.mock.lastCall?.[1] as AbortSignal;
  list.mockResolvedValueOnce({ orders: [], nextCursor: null });
  state.set({ ready: true, profile: { id: "b" } });
  fixture.detectChanges();
  expect(oldSignal.aborted).toBe(true);
  finishOld();
  await oldRequest;
  expect(content()).toContain("ainda não fez pedidos");
  expect(page.cursor()).toBeNull();
  expect(page.items()).toEqual([]);
});
