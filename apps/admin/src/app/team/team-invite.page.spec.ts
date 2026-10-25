import { Location } from "@angular/common";
import { HttpErrorResponse } from "@angular/common/http";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, provideRouter, Router } from "@angular/router";
import { PendingTeamInvite } from "../core/pending-invite";
import { Session } from "../core/session";
import { TeamInvitePage } from "./team-invite.page";
import { TeamApi } from "./team-api";

const settle = () => new Promise((resolve) => setTimeout(resolve));
const failure = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { code, message: "x" } });

describe("TeamInvitePage", () => {
  const token = "B".repeat(43);
  const api = { preview: vi.fn(), redeem: vi.fn(), accept: vi.fn() };
  const signedIn = signal(false);
  const location = { replaceState: vi.fn() };
  let routeToken: string | null = token;

  beforeEach(() => {
    api.preview.mockReset();
    api.redeem.mockReset();
    api.accept.mockReset();
    signedIn.set(false);
    location.replaceState.mockReset();
    routeToken = token;
    TestBed.configureTestingModule({
      imports: [TeamInvitePage],
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
        { provide: TeamApi, useValue: api },
        { provide: Session, useValue: { signedIn } },
      ],
    });
    vi.spyOn(TestBed.inject(Router), "navigateByUrl").mockResolvedValue(true);
  });

  const render = async () => {
    const fixture = TestBed.createComponent(TeamInvitePage);
    const element = fixture.nativeElement as HTMLElement;
    const flush = async () => {
      await settle();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();
    };
    await flush();
    const set = (id: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    const submit = async () => {
      element.querySelector("form")!.dispatchEvent(new Event("submit"));
      await flush();
    };
    const click = async (text: string) => {
      Array.from(element.querySelectorAll("button"))
        .find((item) => item.textContent?.trim() === text)!
        .click();
      await flush();
    };
    return { element, set, submit, click };
  };

  it("hides the token, previews the invite and creates the account", async () => {
    api.preview.mockResolvedValue({
      storeName: "Pizzaria Centro",
      role: "STAFF",
      email: "nova@test.invalid",
      accountExists: false,
      expiresAt: "2026-10-28T12:00:00.000Z",
    });
    api.redeem.mockResolvedValue({
      storeName: "Pizzaria Centro",
      role: "STAFF",
      newAccount: true,
    });
    const page = await render();
    expect(location.replaceState).toHaveBeenCalledWith(
      "/equipe/convite/aceitar",
    );
    expect(api.preview).toHaveBeenCalledWith(token);
    expect(page.element.textContent).toContain("Pizzaria Centro");
    expect(page.element.textContent).toContain("nova@test.invalid");
    page.set("invite-name", " Nova Pessoa ");
    page.set("invite-password", "senha-bem-segura");
    page.set("invite-password-confirm", "senha-bem-segura");
    await page.submit();
    expect(api.redeem).toHaveBeenCalledWith(
      token,
      "Nova Pessoa",
      "senha-bem-segura",
    );
    expect(page.element.querySelector("[role=status]")!.textContent).toContain(
      "Você agora faz parte da equipe de Pizzaria Centro",
    );
    expect(page.element.querySelector("form")).toBeNull();
  });

  const existing = {
    storeName: "Pizzaria Centro",
    role: "MANAGER",
    email: "antiga@test.invalid",
    accountExists: true,
    expiresAt: "2026-10-28T12:00:00.000Z",
  };

  it("sends an existing account to sign in, keeping the token in memory only", async () => {
    api.preview.mockResolvedValue(existing);
    const page = await render();
    expect(page.element.querySelector("input[type=password]")).toBeNull();
    await page.click("Entrar para aceitar");
    expect(TestBed.inject(Router).navigateByUrl).toHaveBeenCalledWith(
      "/entrar",
    );
    expect(TestBed.inject(PendingTeamInvite).take()).toBe(token);
    expect(api.accept).not.toHaveBeenCalled();
  });

  it("comes back from the sign-in with the waiting token and accepts with the session", async () => {
    routeToken = null;
    TestBed.inject(PendingTeamInvite).hold(token);
    signedIn.set(true);
    api.preview.mockResolvedValue(existing);
    api.accept.mockResolvedValue({
      storeName: "Pizzaria Centro",
      role: "MANAGER",
      newAccount: false,
    });
    const page = await render();
    expect(api.preview).toHaveBeenCalledWith(token);
    expect(TestBed.inject(PendingTeamInvite).waiting()).toBe(false);
    await page.click("Aceitar convite");
    expect(api.accept).toHaveBeenCalledWith(token);
    expect(page.element.querySelector("[role=status]")!.textContent).toContain(
      "como Gerente",
    );
    expect(page.element.querySelector("a.button")!.getAttribute("href")).toBe(
      "/lojas",
    );
  });

  it("explains an invite for another account", async () => {
    signedIn.set(true);
    api.preview.mockResolvedValue(existing);
    api.accept.mockRejectedValue(failure(403, "INVITE_EMAIL_MISMATCH"));
    const page = await render();
    await page.click("Aceitar convite");
    expect(page.element.querySelector("[role=alert]")!.textContent).toContain(
      "Este convite é para outro e-mail.",
    );
  });

  it("refuses a malformed token without calling the API", async () => {
    routeToken = "curto";
    const page = await render();
    expect(location.replaceState).toHaveBeenCalledWith(
      "/equipe/convite/aceitar",
    );
    expect(api.preview).not.toHaveBeenCalled();
    expect(page.element.querySelector("[role=alert]")!.textContent).toContain(
      "inválido",
    );
  });

  it("explains a used or expired invite", async () => {
    api.preview.mockRejectedValue(failure(410, "INVITE_INVALID"));
    const page = await render();
    expect(page.element.querySelector("[role=alert]")!.textContent).toContain(
      "já foi usado ou expirou",
    );
    expect(page.element.querySelector("form")).toBeNull();
  });
});
