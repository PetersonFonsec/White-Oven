import { Location } from "@angular/common";
import { HttpErrorResponse } from "@angular/common/http";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, provideRouter } from "@angular/router";
import { TeamInvitePage } from "./team-invite.page";
import { TeamApi } from "./team-api";

const settle = () => new Promise((resolve) => setTimeout(resolve));
const failure = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { code, message: "x" } });

describe("TeamInvitePage", () => {
  const token = "B".repeat(43);
  const api = { preview: vi.fn(), redeem: vi.fn() };
  const location = { replaceState: vi.fn() };
  let routeToken: string | null = token;

  beforeEach(() => {
    api.preview.mockReset();
    api.redeem.mockReset();
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
      ],
    });
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
    return { element, set, submit };
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
      "senha-bem-segura",
      "Nova Pessoa",
    );
    expect(page.element.querySelector("[role=status]")!.textContent).toContain(
      "Você agora faz parte da equipe de Pizzaria Centro",
    );
    expect(page.element.querySelector("form")).toBeNull();
  });

  it("asks an existing account for its password only", async () => {
    api.preview.mockResolvedValue({
      storeName: "Pizzaria Centro",
      role: "MANAGER",
      email: "antiga@test.invalid",
      accountExists: true,
      expiresAt: "2026-10-28T12:00:00.000Z",
    });
    api.redeem.mockRejectedValueOnce(failure(401, "INVALID_CREDENTIALS"));
    const page = await render();
    expect(page.element.querySelector("#invite-name")).toBeNull();
    page.set("invite-password", "errada");
    await page.submit();
    expect(api.redeem).toHaveBeenCalledWith(token, "errada", undefined);
    expect(page.element.querySelector("[role=alert]")!.textContent).toContain(
      "E-mail ou senha incorretos.",
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
