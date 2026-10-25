import { HttpErrorResponse } from "@angular/common/http";
import { TestBed } from "@angular/core/testing";
import { TeamPage } from "./team.page";
import { type Team, TeamApi } from "./team-api";

const settle = () => new Promise((resolve) => setTimeout(resolve));
const conflict = (code: string) =>
  new HttpErrorResponse({ status: 409, error: { code, message: "x" } });
const TEAM: Team = {
  members: [
    {
      membershipId: "m-dona",
      name: "Dona Maria",
      email: "dona@test.invalid",
      role: "OWNER",
      since: "2026-10-01T12:00:00.000Z",
      you: true,
    },
    {
      membershipId: "m-joao",
      name: "João",
      email: "joao@test.invalid",
      role: "STAFF",
      since: "2026-10-02T12:00:00.000Z",
      you: false,
    },
  ],
  invites: [
    {
      id: "i-ana",
      email: "ana@test.invalid",
      role: "MANAGER",
      expiresAt: "2026-10-28T12:00:00.000Z",
    },
  ],
};

describe("TeamPage", () => {
  const api = {
    team: vi.fn(),
    invite: vi.fn(),
    cancelInvite: vi.fn(),
    changeRole: vi.fn(),
    revoke: vi.fn(),
  };

  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    api.team.mockResolvedValue(TEAM);
    TestBed.configureTestingModule({
      imports: [TeamPage],
      providers: [{ provide: TeamApi, useValue: api }],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(TeamPage);
    const element = fixture.nativeElement as HTMLElement;
    const flush = async () => {
      await settle();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();
    };
    await flush();
    const row = (label: string) =>
      element.querySelector<HTMLElement>(`li[aria-label="${label}"]`)!;
    const button = (scope: ParentNode, text: string) =>
      Array.from(scope.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === text,
      )!;
    const set = async (selector: string, value: string, event = "input") => {
      const input = element.querySelector<HTMLInputElement | HTMLSelectElement>(
        selector,
      )!;
      input.value = value;
      input.dispatchEvent(new Event(event));
      await flush();
    };
    return { fixture, element, flush, row, button, set };
  }

  it("lists members and pending invites, without actions on the OWNER's own row", async () => {
    const page = await render();
    const own = page.row("Dona Maria");
    expect(own.textContent).toContain("Você");
    expect(own.textContent).toContain("Outro dono pode alterar o seu papel.");
    expect(own.querySelector("button")).toBeNull();
    expect(page.button(page.row("João"), "Revogar acesso")).toBeTruthy();
    expect(page.row("ana@test.invalid").textContent).toContain("Gerente");
  });

  it("creates an invite and shows its link once", async () => {
    const page = await render();
    api.invite.mockResolvedValue({
      invite: {
        id: "i-bia",
        email: "bia@test.invalid",
        role: "MANAGER",
        expiresAt: "2026-10-28T12:00:00.000Z",
      },
      inviteUrl: "https://admin.test/equipe/convite/TOKEN",
      expiresIn: 259200,
    });
    await page.set("#invite-email", " bia@test.invalid ");
    await page.set("#invite-role", "MANAGER", "change");
    page.element.querySelector("form")!.dispatchEvent(new Event("submit"));
    await page.flush();
    expect(api.invite).toHaveBeenCalledWith(
      "bia@test.invalid",
      "MANAGER",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    const link = page.element.querySelector<HTMLInputElement>("#invite-link")!;
    expect(link.value).toBe("https://admin.test/equipe/convite/TOKEN");
    expect(page.element.textContent).toContain("expira em 72 horas");
    expect(api.team).toHaveBeenCalledTimes(2);
  });

  it("retries a failed invite with the same Idempotency-Key", async () => {
    const page = await render();
    api.invite.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 0, error: null }),
    );
    await page.set("#invite-email", "bia@test.invalid");
    const form = page.element.querySelector("form")!;
    form.dispatchEvent(new Event("submit"));
    await page.flush();
    expect(page.element.querySelector("[role=alert]")!.textContent).toContain(
      "Não foi possível falar com o servidor",
    );
    form.dispatchEvent(new Event("submit"));
    await page.flush();
    const [first, second] = api.invite.mock.calls;
    expect(second![2]).toBe(first![2]);
  });

  it("asks for an e-mail before calling the API", async () => {
    const page = await render();
    page.element.querySelector("form")!.dispatchEvent(new Event("submit"));
    await page.flush();
    expect(api.invite).not.toHaveBeenCalled();
    expect(
      page.element.querySelector("#invite-email-error")!.textContent,
    ).toContain("Informe o e-mail");
  });

  it("changes a role only after the button, and explains the last-owner refusal", async () => {
    const page = await render();
    const joao = page.row("João");
    expect(page.button(joao, "Alterar papel").disabled).toBe(true);
    await page.set("#role-m-joao", "OWNER", "change");
    expect(api.changeRole).not.toHaveBeenCalled();
    api.changeRole.mockRejectedValue(conflict("LAST_OWNER"));
    page.button(page.row("João"), "Alterar papel").click();
    await page.flush();
    expect(api.changeRole).toHaveBeenCalledWith("m-joao", "OWNER");
    expect(page.element.querySelector("[role=alert]")!.textContent).toContain(
      "pelo menos um dono",
    );
  });

  it("revokes only after confirmation and says the sessions ended", async () => {
    const page = await render();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    page.button(page.row("João"), "Revogar acesso").click();
    await page.flush();
    expect(api.revoke).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    api.revoke.mockResolvedValue(undefined);
    page.button(page.row("João"), "Revogar acesso").click();
    await page.flush();
    expect(api.revoke).toHaveBeenCalledWith("m-joao");
    expect(page.element.querySelector("[role=status]")!.textContent).toContain(
      "sessões da pessoa nesta loja foram encerradas",
    );
    confirm.mockRestore();
  });

  it("cancels a pending invite", async () => {
    const page = await render();
    api.cancelInvite.mockResolvedValue(undefined);
    page.button(page.row("ana@test.invalid"), "Cancelar convite").click();
    await page.flush();
    expect(api.cancelInvite).toHaveBeenCalledWith("i-ana");
    expect(page.element.textContent).toContain("O link deixou de valer.");
  });
});
