import { HttpErrorResponse } from "@angular/common/http";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router, provideRouter } from "@angular/router";
import { Session } from "../core/session";
import { LoginPage } from "./login.page";

const settle = () => new Promise((resolve) => setTimeout(resolve));
const apiError = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { code, message: "x" } });

describe("LoginPage", () => {
  const session = {
    login: vi.fn(),
    loginMfa: vi.fn(),
    retryLogout: vi.fn(),
    logoutUnconfirmed: signal(false),
  };

  beforeEach(() => {
    session.login.mockReset();
    session.loginMfa.mockReset();
    session.retryLogout.mockReset();
    session.logoutUnconfirmed.set(false);
    TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [provideRouter([]), { provide: Session, useValue: session }],
    });
    vi.spyOn(TestBed.inject(Router), "navigateByUrl").mockResolvedValue(true);
  });

  const render = () => {
    const fixture = TestBed.createComponent(LoginPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const type = (selector: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    const submit = async () => {
      element.querySelector("form")!.dispatchEvent(new Event("submit"));
      await settle();
      fixture.detectChanges();
    };
    return { element, type, submit, fixture };
  };

  it("labels every field and shows API errors in Portuguese as an alert", async () => {
    session.login.mockRejectedValue(apiError(401, "INVALID_CREDENTIALS"));
    const { element, type, submit } = render();
    for (const input of Array.from(element.querySelectorAll("input")))
      expect(element.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    type("#email", " dona@pizzaria.test ");
    type("#password", "errada");
    await submit();
    expect(session.login).toHaveBeenCalledWith("dona@pizzaria.test", "errada");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "E-mail ou senha incorretos.",
    );
  });

  it("asks for the second factor, accepts a recovery code and enters", async () => {
    session.login.mockResolvedValue({ mfaToken: "challenge" });
    session.loginMfa.mockResolvedValue(undefined);
    const { element, type, submit } = render();
    type("#email", "dona@pizzaria.test");
    type("#password", "senha-segura");
    await submit();
    expect(element.querySelector("h1")?.textContent).toContain("duas etapas");
    expect(element.querySelector<HTMLInputElement>("#password")).toBeNull();

    element.querySelector<HTMLButtonElement>("button.button--link")!.click();
    await settle();
    type("#factor", "abcde-fghij");
    await submit();
    expect(session.loginMfa).toHaveBeenCalledWith("challenge", {
      recoveryCode: "abcde-fghij",
    });
    expect(TestBed.inject(Router).navigateByUrl).toHaveBeenCalledWith("/");
  });

  it("goes back to the password when the challenge expired", async () => {
    session.login.mockResolvedValue({ mfaToken: "challenge" });
    session.loginMfa.mockRejectedValue(apiError(401, "MFA_CHALLENGE_INVALID"));
    const { element, type, submit } = render();
    type("#email", "dona@pizzaria.test");
    type("#password", "senha-segura");
    await submit();
    type("#factor", "123456");
    await submit();
    expect(element.querySelector("#password")).not.toBeNull();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "expirou",
    );
  });

  it("warns when the last logout was not confirmed and lets the person retry it", async () => {
    session.logoutUnconfirmed.set(true);
    session.retryLogout.mockResolvedValue("unconfirmed");
    const { element, fixture } = render();
    const warning = element.querySelector('[data-testid="logout-unconfirmed"]');
    expect(warning?.getAttribute("role")).toBe("status");
    expect(warning?.textContent).toContain("não conseguimos confirmar");
    expect(warning?.textContent).not.toContain("encerrada com sucesso");
    const retry = Array.from(element.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Tentar encerrar"),
    )!;
    retry.click();
    await settle();
    fixture.detectChanges();
    expect(session.retryLogout).toHaveBeenCalledTimes(1);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "Ainda não foi possível",
    );

    session.retryLogout.mockImplementation(async () => {
      session.logoutUnconfirmed.set(false);
      return "confirmed";
    });
    retry.click();
    await settle();
    fixture.detectChanges();
    expect(
      element.querySelector('[data-testid="logout-unconfirmed"]'),
    ).toBeNull();
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });
});
