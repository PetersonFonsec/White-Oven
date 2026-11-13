import { TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import { EntryPage } from "./entry.page";
import { routes } from "../app.routes";
import { RouterTestingHarness } from "@angular/router/testing";
describe("entry and routes", () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] }),
  );
  it("associates validation errors with the field and blocks invalid submission", async () => {
    const fixture = TestBed.createComponent(EntryPage);
    const navigate = vi.spyOn(TestBed.inject(Router), "navigate");
    fixture.componentInstance.open();
    await fixture.whenStable();
    const field: HTMLInputElement =
      fixture.nativeElement.querySelector("#slug");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(
      fixture.nativeElement.querySelector("[role=alert]").textContent,
    ).toContain("Confira");
    expect(navigate).not.toHaveBeenCalled();
  });
  it("routes to the submitted store", () => {
    const fixture = TestBed.createComponent(EntryPage);
    const navigate = vi
      .spyOn(TestBed.inject(Router), "navigate")
      .mockResolvedValue(true);
    fixture.componentInstance.form.controls.slug.setValue("pizzaria-centro");
    fixture.componentInstance.open();
    expect(navigate).toHaveBeenCalledWith(["/lojas", "pizzaria-centro"]);
  });
  it("lazy loads the entry and provides a real 404 destination", async () => {
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl("/");
    expect(h.routeNativeElement?.textContent).toContain(
      "Qual é a sua pizzaria?",
    );
    await h.navigateByUrl("/nao-existe");
    expect(h.routeNativeElement?.textContent).toContain(
      "Página não encontrada",
    );
  });
});
