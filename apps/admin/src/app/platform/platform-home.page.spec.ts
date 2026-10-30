import { HttpErrorResponse } from "@angular/common/http";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import { Session } from "../core/session";
import {
  PlatformApi,
  type Plan,
  type PlanChange,
  type PlanSubscription,
  type PlatformTenant,
} from "./platform-api";
import { PlatformHomePage } from "./platform-home.page";

const sample: PlatformTenant = {
  id: "tenant-1",
  slug: "white-oven-centro",
  displayName: "White Oven Centro",
  status: "ACTIVE",
  createdAt: "2026-10-24T12:00:00.000Z",
  plan: { code: "FLEX", validFrom: "2026-10-24T12:00:00.000Z" },
  scheduledPlan: null,
};

const plans: Plan[] = [
  { code: "FLEX", feeBasisPoints: 300, monthlyFeeCents: 0 },
  { code: "PRO", feeBasisPoints: 0, monthlyFeeCents: 19900 },
];

describe("PlatformHomePage", () => {
  const api = {
    listTenants: vi.fn<() => Promise<PlatformTenant[]>>(),
    createTenant: vi.fn(),
    changeStatus: vi.fn(),
    listPlans: vi.fn<() => Promise<Plan[]>>(),
    listPlanSubscriptions: vi.fn<() => Promise<PlanSubscription[]>>(),
    changePlan: vi.fn<() => Promise<PlanChange>>(),
  };
  const session = { logout: vi.fn(), logoutUnconfirmed: signal(false) };

  beforeEach(() => {
    api.listTenants.mockReset().mockResolvedValue([sample]);
    api.createTenant.mockReset();
    api.changeStatus.mockReset();
    api.listPlans.mockReset().mockResolvedValue(plans);
    api.listPlanSubscriptions.mockReset().mockResolvedValue([
      {
        id: "period-1",
        ...plans[0]!,
        validFrom: "2026-10-24T12:00:00.000Z",
        validTo: null,
        createdAt: "2026-10-24T12:00:00.000Z",
      },
    ]);
    api.changePlan.mockReset();
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

  it("shows the current and scheduled plan of each tenant", async () => {
    api.listTenants.mockResolvedValue([
      {
        ...sample,
        scheduledPlan: { code: "PRO", validFrom: "2099-12-01T03:00:00.000Z" },
      },
    ]);
    const { element } = await render();
    const row = element.querySelector("tbody tr")!;
    expect(row.textContent).toContain("Flex");
    expect(row.textContent).toContain("Pro a partir de");
    expect(api.listPlans).toHaveBeenCalledOnce();
  });

  it("sets a plan from the dialog, shows its terms and history, then refreshes the list", async () => {
    api.changePlan.mockResolvedValue({
      subscriptionId: "period-2",
      plan: "PRO",
      validFrom: "2099-12-01T03:00:00.000Z",
      changed: true,
    });
    const { fixture, element } = await render();
    element
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Plano de White Oven Centro"]',
      )!
      .click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const dialog = element.querySelector("dialog.plan-dialog")!;
    expect(dialog.textContent).toContain("3% por venda, sem mensalidade");
    expect(dialog.textContent).toMatch(
      /sem comissão por venda, R\$\s?199,00 por mês/,
    );
    expect(dialog.textContent).toContain("primeiro dia do próximo mês");
    expect(dialog.querySelector(".plan-history")?.textContent).toContain(
      "Atual, desde",
    );
    const pro = dialog.querySelector<HTMLInputElement>("#plan-PRO")!;
    pro.click();
    fixture.detectChanges();
    await fixture.whenStable();
    dialog
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.changePlan).toHaveBeenCalledWith("tenant-1", "PRO");
    expect(element.querySelector("dialog.plan-dialog")).toBeNull();
    expect(element.querySelector('[role="status"]')?.textContent).toContain(
      "Plano Pro agendado para",
    );
    expect(api.listTenants).toHaveBeenCalledTimes(2);
  });

  it("explains that a tenant needs a plan before reactivation", async () => {
    api.listTenants.mockResolvedValue([
      { ...sample, status: "SUSPENDED", plan: null },
    ]);
    api.changeStatus.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: { code: "PLAN_REQUIRED", message: "ignored" },
      }),
    );
    const { fixture, element } = await render();
    expect(element.querySelector("tbody tr")?.textContent).toContain(
      "Sem plano",
    );
    element
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Reativar White Oven Centro"]',
      )!
      .click();
    fixture.detectChanges();
    element
      .querySelector<HTMLButtonElement>(
        '[role="alertdialog"] .dialog-actions .button:not(.button--secondary)',
      )!
      .click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      element.querySelector('[role="alertdialog"] [role="alert"]')?.textContent,
    ).toContain("Defina um plano para a pizzaria antes de ativá-la");
  });
});
