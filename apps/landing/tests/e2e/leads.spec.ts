import { test, expect, type Page } from "@playwright/test";
import { SqliteLeadStore } from "../../src/server/lead-store";
import { fileURLToPath } from "node:url";
const database = fileURLToPath(
  new URL("../../.data/leads.e2e.sqlite", import.meta.url),
);
async function fill(page: Page, suffix: string) {
  await expect(page.locator("#responsible")).toBeEnabled();
  await page.locator("#responsible").fill(`Pessoa Teste ${suffix}`);
  await page.locator("#pizzeria").fill(`Pizzaria Teste ${suffix}`);
  await page.locator("#whatsapp").fill("(11) 99999-9999");
  await page.locator("#volume").selectOption("FROM_301_TO_1000");
  await page.locator("#consent").check();
}
test("real submission, loading until server persistence, attribution and PII-free analytics", async ({
  page,
}, info) => {
  const events: unknown[] = [];
  await page.exposeFunction("captureAnalytics", (event: unknown) =>
    events.push(event),
  );
  await page.addInitScript(() =>
    window.addEventListener("whiteoven:analytics", (event) => {
      (
        window as unknown as { captureAnalytics: (value: unknown) => void }
      ).captureAnalytics((event as CustomEvent).detail);
    }),
  );
  await page.goto(
    "/?utm_source=test&utm_medium=e2e&utm_campaign=validation&utm_content=card&utm_term=pizza",
  );
  await page.locator("#flavor-left").selectOption("queijos");
  await page.getByRole("link", { name: "Tenho interesse no Flex" }).click();
  await fill(page, `${info.project.name}-${Date.now()}`);
  const name = await page.locator("#responsible").inputValue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/leads", async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Registrar meu interesse" }).click();
  await expect(page.getByRole("button", { name: "Enviando…" })).toBeDisabled();
  await expect(page.locator("#form-result")).toHaveText(
    "Registrando seu interesse…",
  );
  await expect(page.locator("#form-result")).not.toContainText(
    "Interesse registrado!",
  );
  release();
  await expect(page.locator("#form-result")).toContainText(
    "Interesse registrado!",
  );
  const store = new SqliteLeadStore(database);
  try {
    const saved = store
      .exportLeads()
      .find((lead) => lead.responsibleName === name)!;
    expect(saved).toBeTruthy();
    expect(saved.interestedPlan).toBe("FLEX");
    expect(saved.whatsapp).toBe("+5511999999999");
    expect(saved.contactConsent).toBe(true);
    expect(saved.attribution).toMatchObject({
      utm_source: "test",
      utm_medium: "e2e",
      utm_campaign: "validation",
      utm_content: "card",
      utm_term: "pizza",
      landingPath: "/",
    });
    expect(saved.funnel).toEqual({
      pizzaBuilderInteracted: true,
      planCtaClicked: true,
    });
    expect(saved.consentPolicy.controllerName).toBe(
      "Controlador sintético de testes",
    );
  } finally {
    store.close();
  }
  await expect.poll(() => events.length).toBeGreaterThanOrEqual(7);
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain(name);
  expect(serialized).not.toContain("99999");
  expect(serialized).not.toContain("Pizzaria Teste");
  expect(serialized).not.toContain("utm_");
  const names = events.map((event) => (event as { name: string }).name);
  for (const name of [
    "landing_view",
    "pizza_builder_interaction",
    "pricing_view",
    "plan_interest_click",
    "lead_form_started",
    "lead_form_submitted",
    "lead_form_success",
  ])
    expect(names).toContain(name);
  expect(
    await page.evaluate(() => [
      localStorage.length,
      sessionStorage.length,
      document.cookie,
    ]),
  ).toEqual([0, 0, ""]);
});
test("client validation, Pro selection, error and retry preserve fields and idempotency", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Tenho interesse no Pro" }).click();
  await expect(page.locator("#plan")).toHaveValue("PRO");
  await expect(page.locator("#consent")).not.toBeChecked();
  await page.getByRole("button", { name: "Registrar meu interesse" }).click();
  await expect(page.locator("#responsible")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await fill(page, `Retry-${info.project.name}-${Date.now()}`);
  const name = await page.locator("#responsible").inputValue();
  const keys: string[] = [];
  let attempt = 0;
  await page.route("**/api/leads", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (++attempt === 1)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          code: "UNAVAILABLE",
          message: "Não foi possível salvar. Tente novamente.",
        }),
      });
    return route.continue();
  });
  await page.getByRole("button", { name: "Registrar meu interesse" }).click();
  await expect(page.locator("#form-result")).toContainText("Tente novamente");
  await expect(page.locator("#responsible")).toHaveValue(name);
  await expect(page.locator("#plan")).toHaveValue("PRO");
  await expect(page.locator("#consent")).toBeChecked();
  await page.getByRole("button", { name: "Registrar meu interesse" }).click();
  await expect(page.locator("#form-result")).toContainText(
    "Interesse registrado!",
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const store = new SqliteLeadStore(database);
  try {
    expect(
      store.exportLeads().filter((lead) => lead.responsibleName === name),
    ).toHaveLength(1);
  } finally {
    store.close();
  }
});
test("privacy identifies configured controller and unavailable capture stays disabled", async ({
  page,
}) => {
  await page.goto("/privacidade");
  await expect(page.locator("main")).toContainText(
    "Controlador sintético de testes",
  );
  await expect(
    page.getByRole("link", { name: "privacy@example.test" }),
  ).toHaveAttribute("href", "mailto:privacy@example.test");
  await page.route("**/api/leads", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ available: false }),
    }),
  );
  await page.goto("/");
  await expect(page.locator("#availability-status")).toContainText(
    "indisponíveis",
  );
  await expect(page.locator("#responsible")).toBeDisabled();
});
