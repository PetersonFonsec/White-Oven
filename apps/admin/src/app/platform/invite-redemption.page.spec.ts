import { Location } from "@angular/common";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, provideRouter, Router } from "@angular/router";
import { PlatformApi } from "./platform-api";
import { InviteRedemptionPage } from "./invite-redemption.page";

describe("InviteRedemptionPage", () => {
  const token = "A".repeat(43);
  const api = { redeemInvite: vi.fn() };
  const location = { replaceState: vi.fn() };
  let routeToken: string | null = token;

  beforeEach(() => {
    api.redeemInvite.mockReset();
    location.replaceState.mockReset();
    routeToken = token;
    TestBed.configureTestingModule({
      imports: [InviteRedemptionPage],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: {
                get: (key: string) => (key === "token" ? routeToken : null),
              },
            },
          },
        },
        { provide: Location, useValue: location },
        { provide: PlatformApi, useValue: api },
      ],
    });
    vi.spyOn(TestBed.inject(Router), "navigateByUrl").mockResolvedValue(true);
  });

  const render = async () => {
    const fixture = TestBed.createComponent(InviteRedemptionPage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  };

  it("removes the token from the address before rendering the form and keeps it in memory for redemption", async () => {
    api.redeemInvite.mockResolvedValue(undefined);
    const { fixture, element } = await render();
    expect(location.replaceState).toHaveBeenCalledWith("/invite/aceitar");
    expect(element.querySelector("form")).not.toBeNull();

    const set = (id: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("owner-name", "Pessoa Responsável");
    set("owner-password", "senham3_2-segura");
    set("owner-password-confirm", "senham3_2-segura");
    element
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.redeemInvite).toHaveBeenCalledWith(
      token,
      "Pessoa Responsável",
      "senham3_2-segura",
    );
    expect(TestBed.inject(Router).navigateByUrl).toHaveBeenCalledWith(
      "/invite/concluido",
      { replaceUrl: true },
    );
  });

  it("shows a safe error for an invalid token and never calls the API", async () => {
    routeToken = "bad-token";
    const { fixture, element } = await render();
    expect(location.replaceState).toHaveBeenCalledWith("/invite/aceitar");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "convite é inválido ou expirou",
    );
    element
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(api.redeemInvite).not.toHaveBeenCalled();
  });

  it("keeps the sanitized URL through form and API errors", async () => {
    api.redeemInvite.mockRejectedValue(new Error("Falha temporária"));
    const { fixture, element } = await render();
    const set = (id: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("owner-name", "Pessoa Responsável");
    set("owner-password", "senham3_2-segura");
    set("owner-password-confirm", "outra-senha-segura");
    element
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.textContent).toContain("As senhas não coincidem");
    expect(api.redeemInvite).not.toHaveBeenCalled();
    expect(location.replaceState).toHaveBeenCalledOnce();

    set("owner-password-confirm", "senham3_2-segura");
    element
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(api.redeemInvite).toHaveBeenCalledWith(
      token,
      "Pessoa Responsável",
      "senham3_2-segura",
    );
    expect(location.replaceState).toHaveBeenCalledOnce();
  });

  it("clears the in-memory token when the invite flow is cancelled", async () => {
    const { fixture, element } = await render();
    element.querySelector<HTMLButtonElement>(".button--cancel")!.click();
    await fixture.whenStable();
    await (
      fixture.componentInstance as unknown as {
        submit: () => Promise<void>;
      }
    ).submit();
    expect(TestBed.inject(Router).navigateByUrl).toHaveBeenCalledWith(
      "/entrar",
      { replaceUrl: true },
    );
    expect(api.redeemInvite).not.toHaveBeenCalled();
  });

  it("explains that refreshing requires reopening the original invitation", async () => {
    routeToken = null;
    const { element } = await render();
    expect(location.replaceState).not.toHaveBeenCalled();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "Abra novamente o link original recebido",
    );
  });
});
