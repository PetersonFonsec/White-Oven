import { HttpErrorResponse } from "@angular/common/http";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Session } from "../core/session";
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

  const store = signal<{ tenantId: string; displayName: string } | null>({
    tenantId: "A",
    displayName: "Loja A",
  });

  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    api.team.mockResolvedValue(TEAM);
    store.set({ tenantId: "A", displayName: "Loja A" });
    TestBed.configureTestingModule({
      imports: [TeamPage],
      providers: [
        { provide: TeamApi, useValue: api },
        { provide: Session, useValue: { store } },
      ],
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

  describe("with a store switch while requests are pending", () => {
    /** A promise the test settles by hand. */
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      return { promise, resolve, reject };
    };
    const TEAM_B: Team = {
      members: [
        {
          membershipId: "m-beto",
          name: "Beto",
          email: "beto@test.invalid",
          role: "OWNER",
          since: "2026-10-03T12:00:00.000Z",
          you: true,
        },
      ],
      invites: [],
    };
    const switchTo = async (
      page: Awaited<ReturnType<typeof render>>,
      tenantId: string,
    ) => {
      store.set({ tenantId, displayName: `Loja ${tenantId}` });
      await page.flush();
    };

    it("loads store A, then only store B after a switch", async () => {
      const page = await render();
      expect(page.element.textContent).toContain("João");
      api.team.mockResolvedValue(TEAM_B);
      await switchTo(page, "B");
      expect(api.team).toHaveBeenCalledTimes(2);
      expect(page.element.textContent).toContain("Beto");
      expect(page.element.textContent).not.toContain("João");
      expect(page.element.textContent).not.toContain("ana@test.invalid");
    });

    it("ignores store A's answer arriving after the switch", async () => {
      const lateA = deferred<Team>();
      api.team.mockReturnValueOnce(lateA.promise);
      const page = await render();
      expect(page.element.textContent).toContain("Carregando equipe");
      api.team.mockResolvedValue(TEAM_B);
      await switchTo(page, "B");
      lateA.resolve(TEAM);
      await page.flush();
      expect(page.element.textContent).toContain("Beto");
      expect(page.element.textContent).not.toContain("João");
    });

    it("shows store B's failure without any of store A's data", async () => {
      const page = await render();
      expect(page.element.textContent).toContain("João");
      api.team.mockRejectedValue(
        new HttpErrorResponse({ status: 0, error: null }),
      );
      await switchTo(page, "B");
      expect(page.element.querySelector("[role=alert]")!.textContent).toContain(
        "Não foi possível falar com o servidor",
      );
      expect(page.element.textContent).not.toContain("João");
      expect(page.element.querySelector("li")).toBeNull();
    });

    it("drops a role change and a revocation still pending when the store changes", async () => {
      for (const action of ["role", "revoke"] as const) {
        api.team.mockResolvedValue(TEAM);
        store.set({ tenantId: "A", displayName: "Loja A" });
        const pending = deferred<void>();
        const page = await render();
        if (action === "role") {
          api.changeRole.mockReturnValueOnce(pending.promise);
          await page.set("#role-m-joao", "MANAGER", "change");
          page.button(page.row("João"), "Alterar papel").click();
        } else {
          api.revoke.mockReturnValueOnce(pending.promise);
          vi.spyOn(window, "confirm").mockReturnValueOnce(true);
          page.button(page.row("João"), "Revogar acesso").click();
        }
        await page.flush();
        // Sent for store A, with store A's token: the interceptor reads it when sending.
        expect(
          action === "role" ? api.changeRole : api.revoke,
        ).toHaveBeenCalledWith(
          ...(action === "role" ? ["m-joao", "MANAGER"] : ["m-joao"]),
        );
        api.team.mockResolvedValue(TEAM_B);
        await switchTo(page, "B");
        const calls = api.team.mock.calls.length;
        pending.resolve();
        await page.flush();
        // No notice about store A, no reload for it, and B's buttons are not left waiting.
        expect(page.element.querySelector("[role=status]")).toBeNull();
        expect(api.team).toHaveBeenCalledTimes(calls);
        expect(page.element.textContent).toContain("Beto");
        expect(page.button(page.element, "Gerar convite").disabled).toBe(false);
        page.fixture.destroy();
      }
    });

    it("hides store A's invite link after the switch", async () => {
      const page = await render();
      api.invite.mockResolvedValue({
        invite: {
          id: "i-bia",
          email: "bia@test.invalid",
          role: "STAFF",
          expiresAt: "2026-10-28T12:00:00.000Z",
        },
        inviteUrl: "https://admin.test/equipe/convite/TOKEN-A",
        expiresIn: 259200,
      });
      await page.set("#invite-email", "bia@test.invalid");
      page.element.querySelector("form")!.dispatchEvent(new Event("submit"));
      await page.flush();
      expect(page.element.querySelector("#invite-link")).not.toBeNull();
      api.team.mockResolvedValue(TEAM_B);
      await switchTo(page, "B");
      expect(page.element.querySelector("#invite-link")).toBeNull();
      expect(page.element.textContent).not.toContain("bia@test.invalid");
    });

    it("changes nothing when destroyed during a request", async () => {
      const late = deferred<Team>();
      api.team.mockReturnValueOnce(late.promise);
      const page = await render();
      page.fixture.destroy();
      late.resolve(TEAM);
      await settle();
      expect(api.team).toHaveBeenCalledTimes(1);
      expect(page.element.textContent).not.toContain("João");
    });
  });
});
