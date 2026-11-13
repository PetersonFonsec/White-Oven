import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Button, Input, State } from "./primitives";
import { themeProperties } from "./theme";
import { DEFAULT_BRAND_COLORS, contrastFailures } from "@whiteoven/contracts";
@Component({
  imports: [Button, Input, State],
  template: `<button woButton disabled (click)="count = count + 1">
      Continuar</button
    ><label for="name">Nome</label><input woInput id="name" /><wo-state
      kind="error"
      heading="Falha"
      message="Tente novamente"
    />`,
})
class Fixture {
  count = 0;
}
it("keeps native disabled and label semantics and announces an error", async () => {
  const f = TestBed.createComponent(Fixture);
  await f.whenStable();
  const button: HTMLButtonElement = f.nativeElement.querySelector("button");
  button.click();
  expect(f.componentInstance.count).toBe(0);
  expect(f.nativeElement.querySelector("input").labels[0].textContent).toBe(
    "Nome",
  );
  expect(f.nativeElement.querySelector("[role=alert]").textContent).toBe(
    "Tente novamente",
  );
});
it("default colors pass contrast and each shell gets fresh tokens", () => {
  expect(contrastFailures(DEFAULT_BRAND_COLORS)).toEqual([]);
  expect(themeProperties()["--wo-primary"]).toBe("#FF6B00");
  expect(themeProperties()).not.toBe(themeProperties());
});
