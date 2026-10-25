import { HttpErrorResponse } from "@angular/common/http";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import { Session } from "../core/session";
import { PlatformApi, type PlatformTenant } from "./platform-api";
import { PlatformHomePage } from "./platform-home.page";

const sample: PlatformTenant = {
  id: "tenant-1",
  slug: "white-oven-centro",
  displayName: "White Oven Centro",
  status: "ACTIVE",
  createdAt: "2026-10-24T12:00:00.000Z",
};

describe("PlatformHomePage", () => {
  const api = {
    listTenants: vi.fn<() => Promise<PlatformTenant[]>>(),
    createTenant: vi.fn(),
    changeStatus: vi.fn(),
  };
  const session = { logout: vi.fn(), logoutUnconfirmed: signal(false) };

  beforeEach(() => {
    api.listTenants.mockReset().mockResolvedValue([sample]);
    api.createTenant.mockReset();
    api.changeStatus.mockReset();
    session.logout.mockReset();
    TestBed.configureTestingModule({
      imports: [PlatformHomePage],
      providers: [
        provideRouter([]),
        { provide: PlatformApi, useValue: api },
        { provide: Session, useValue: session },
      ],
    });
    vi.spyOn(TestBed.inject(Router), "navigateByUrl").mockResolvedValue(true);
  });

  const render = async () => {
    const fixture = TestBed.createComponent(PlatformHomePage);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  };

  it("shows tenant status and asks before suspending a store", async () => {
    const { fixture, element } = await render();
    expect(element.querySelector("h1")?.textContent).toContain(
      "Área de plataforma",
    );
    expect(element.textContent).toContain("White Oven Centro");
    expect(element.textContent).toContain("Ativa");
    expect(api.listTenants).toHaveBeenCalledOnce();

    element
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Suspender White Oven Centro"]',
      )!
      .click();
    fixture.detectChanges();
    expect(element.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(api.changeStatus).not.toHaveBeenCalled();
  });

  it("submits the tenant and idempotency key, then displays the one-time invite", async () => {
    api.createTenant.mockResolvedValue({
      tenantId: "tenant-new",
      inviteUrl: "http://localhost:4200/invite/synthetic-token",
      expiresIn: 72 * 60 * 60,
    });
    const { fixture, element } = await render();
    const set = (id: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("tenant-name", "Nova Pizzaria");
    set("tenant-slug", "nova-pizzaria");
    set("owner-email", "owner@example.test");
    element
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.createTenant).toHaveBeenCalledWith(
      {
        slug: "nova-pizzaria",
        displayName: "Nova Pizzaria",
        ownerEmail: "owner@example.test",
      },
      expect.stringMatching(/^[\da-f-]{36}$/),
    );
    expect(element.textContent).toContain("Convite pronto para compartilhar");
    expect(element.textContent).toContain("72 horas");
    expect(element.querySelector<HTMLInputElement>("#invite-link")?.value).toBe(
      "http://localhost:4200/invite/synthetic-token",
    );
  });

  it("surfaces a safe error and preserves form contents when creation fails", async () => {
    api.createTenant.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: { code: "TENANT_SLUG_TAKEN", message: "ignored" },
      }),
    );
    const { fixture, element } = await render();
    const set = (id: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("tenant-name", "Nova Pizzaria");
    set("tenant-slug", "nova-pizzaria");
    set("owner-email", "owner@example.test");
    element
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "identificador já está em uso",
    );
    expect(element.querySelector<HTMLInputElement>("#tenant-slug")?.value).toBe(
      "nova-pizzaria",
    );
  });

  it("preserves the created invite when refreshing the list fails", async () => {
    api.createTenant.mockResolvedValue({
      tenantId: "tenant-new",
      inviteUrl: "http://localhost:4200/invite/synthetic-token",
      expiresIn: 72 * 60 * 60,
    });
    const { fixture, element } = await render();
    api.listTenants.mockRejectedValueOnce(new Error("Falha temporária"));
    const set = (id: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("tenant-name", "Nova Pizzaria");
    set("tenant-slug", "nova-pizzaria");
    set("owner-email", "owner@example.test");
    element
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(element.textContent).toContain("Convite pronto para compartilhar");
    expect(element.querySelector<HTMLInputElement>("#invite-link")?.value).toBe(
      "http://localhost:4200/invite/synthetic-token",
    );
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "Pizzaria cadastrada e convite criado, mas a lista não pôde ser atualizada",
    );
    expect(element.querySelector<HTMLInputElement>("#tenant-slug")?.value).toBe(
      "",
    );
    expect(api.createTenant).toHaveBeenCalledOnce();
  });

  it("ignores stale list responses and keeps loading tied to the newest request", async () => {
    const { fixture } = await render();
    let resolveOld!: (value: PlatformTenant[]) => void;
    let rejectOld!: (reason: Error) => void;
    let resolveCurrent!: (value: PlatformTenant[]) => void;
    const oldRequest = new Promise<PlatformTenant[]>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    const currentRequest = new Promise<PlatformTenant[]>((resolve) => {
      resolveCurrent = resolve;
    });
    api.listTenants
      .mockReturnValueOnce(oldRequest)
      .mockReturnValueOnce(currentRequest);
    const page = fixture.componentInstance as unknown as {
      loadTenants: () => Promise<void>;
      tenants: () => PlatformTenant[];
      loading: () => boolean;
    };
    const first = page.loadTenants();
    const second = page.loadTenants();
    resolveCurrent([{ ...sample, id: "current", displayName: "Lista atual" }]);
    await second;
    expect(page.tenants()[0]?.displayName).toBe("Lista atual");
    expect(page.loading()).toBe(false);
    rejectOld(new Error("Erro obsoleto"));
    resolveOld([]);
    await first;
    fixture.detectChanges();
    expect(page.tenants()[0]?.displayName).toBe("Lista atual");
    expect(fixture.nativeElement.textContent).not.toContain("Erro obsoleto");
  });
});
