import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const art = (page: Page) => page.locator("[data-pizza-art]");
const left = (page: Page) =>
  art(page).locator('[data-side="left"] [data-active="true"]');
const right = (page: Page) =>
  art(page).locator('[data-side="right"] [data-active="true"]');

test("Builder integrates controls, SVG halves, accessible description and prices", async ({
  page,
}) => {
  await page.goto("/");
  const price = page.locator("[data-price]");
  await expect(left(page)).toHaveAttribute("data-flavor", "calabresa");
  await expect(right(page)).toHaveAttribute("data-flavor", "margherita");
  await expect(price).toHaveText(/R\$\s52,00/);
  // Assert visible geometry, not just updated text or data attributes.
  await expect(left(page).locator("circle").first()).toBeVisible();
  await page.locator("#flavor-left").selectOption("queijos");
  await page.locator("#flavor-right").selectOption("frango");
  await expect(left(page)).toHaveAttribute("data-flavor", "queijos");
  await expect(left(page).locator("rect").first()).toBeVisible();
  await expect(right(page)).toHaveAttribute("data-flavor", "frango");
  await expect(right(page).locator("path").first()).toBeVisible();
  for (const group of await art(page)
    .locator('[data-flavor="calabresa"]')
    .all()) {
    await expect(group).toBeHidden();
  }
  await expect(price).toHaveText(/R\$\s62,00/);
  const clip = await art(page)
    .locator("[data-side]")
    .evaluateAll((groups) =>
      groups.map((group) => group.getAttribute("clip-path")),
    );
  expect(clip).toEqual([
    "url(#builder-pizza-left)",
    "url(#builder-pizza-right)",
  ]);
  await page.getByRole("radio", { name: "Inteira", exact: true }).check();
  await expect(page.locator("[data-right-control]")).toBeHidden();
  await expect(page.locator("#flavor-right")).toBeDisabled();
  await expect(right(page)).toHaveAttribute("data-flavor", "queijos");
  await expect(art(page).locator(".pizza-divider")).toBeHidden();
  await page.locator("#flavor-left").selectOption("calabresa");
  await expect(left(page)).toHaveAttribute("data-flavor", "calabresa");
  await expect(right(page)).toHaveAttribute("data-flavor", "calabresa");
  await expect(price).toHaveText(/R\$\s49,00/);
  await page.getByRole("radio", { name: "Meio a meio", exact: true }).check();
  await expect(page.locator("#flavor-right")).toBeEnabled();
  await expect(page.locator("#flavor-right")).toHaveValue("frango");
  await expect(right(page)).toHaveAttribute("data-flavor", "frango");
  // A vertical SVG stroke has zero-width bounds; visibility matchers treat it as hidden.
  await expect(art(page).locator(".pizza-divider")).toHaveCSS(
    "display",
    "inline",
  );
  await expect(price).toHaveText(/R\$\s59,00/);
  await expect(page.locator("[data-builder-status]")).toContainText(
    "Metade esquerda: Calabresa. Metade direita: Frango com catupiry",
  );
});

test("plan CTAs preselect the form and commissions are explicit", async ({
  page,
}) => {
  await page.goto("/");
  const flex = page
    .locator(".pricing-card")
    .filter({ has: page.getByRole("heading", { name: "WhiteOven Flex" }) });
  const pro = page.locator(".pricing-card--pro");
  await expect(flex.locator(".price")).toHaveText("3% por venda paga");
  await expect(flex.locator(".commission")).toContainText("Sem mensalidade");
  await expect(pro.locator(".price")).toHaveText("R$ 199/mês");
  await expect(pro.locator(".commission")).toContainText(
    "0% de comissão WhiteOven",
  );
  await page.getByRole("link", { name: "Tenho interesse no Flex" }).click();
  await expect(page.locator("#plan")).toHaveValue("flex");
  await expect(page).toHaveURL(/#interesse$/);
  await page.getByRole("link", { name: "Tenho interesse no Pro" }).click();
  await expect(page.locator("#plan")).toHaveValue("pro");
  await expect(page.locator("#plan-status")).toContainText(
    "Nenhum dado será cadastrado",
  );
});

test("prototype blocks submission including Enter and submit events without persisting PII", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.goto("/");
  await expect(page.locator("#responsible")).toBeEnabled();
  page.on("request", (request) =>
    requests.push(`${request.method()} ${request.url()}`),
  );
  const form = page.locator("#interest-form");
  await expect(form).not.toHaveAttribute("method", "dialog");
  await expect(form.locator('button[type="submit"]')).toBeDisabled();
  await page.locator("#responsible").fill("Teste de protótipo");
  await page.locator("#pizzeria").fill("Pizzaria de teste");
  await page.locator("#whatsapp").fill("11999999999");
  await page.locator("#responsible").press("Enter");
  expect(
    await form.evaluate((element) =>
      element.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    ),
  ).toBe(false);
  await expect(page.locator("#responsible")).toHaveValue("Teste de protótipo");
  expect(requests).toEqual([]);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookies: document.cookie,
    })),
  ).toEqual({ local: 0, session: 0, cookies: "" });
  await expect(page.locator("#form-notice")).toContainText(
    "não são enviados nem salvos",
  );
});

test("mobile menu handles toggling, Escape focus and anchor navigation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile navigation only");
  await page.goto("/");
  const toggle = page.locator(".menu-toggle");
  const nav = page.getByRole("navigation", { name: "Navegação principal" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(nav).toBeHidden();
  await toggle.click();
  await expect(nav).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(nav).toBeHidden();
  await toggle.click();
  await nav.getByRole("link", { name: "Planos", exact: true }).click();
  await expect(page).toHaveURL(/#planos$/);
  await expect(nav).toBeHidden();
});

test("without JavaScript navigation remains usable and prototype controls stay disabled", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: testInfo.project.use.viewport,
  });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4323/");
  await expect(
    page.getByRole("navigation", { name: "Navegação principal" }),
  ).toBeVisible();
  await expect(page.locator(".menu-toggle")).toBeHidden();
  await expect(page.locator("#flavor-left")).toBeDisabled();
  await expect(page.locator("#flavor-right")).toBeDisabled();
  await expect(page.locator("#responsible")).toBeDisabled();
  await expect(page.locator("#plan")).toBeDisabled();
  await expect(page.locator("#interest-form button")).toBeDisabled();
  await expect(page.locator("#interest-form noscript p")).toContainText(
    "inscrições ainda não estão disponíveis",
  );
  await expect(left(page)).toHaveAttribute("data-flavor", "calabresa");
  await expect(right(page)).toHaveAttribute("data-flavor", "margherita");
  await page
    .getByRole("navigation", { name: "Navegação principal" })
    .getByRole("link", { name: "Planos", exact: true })
    .click();
  await expect(page).toHaveURL(/#planos$/);
  await context.close();
});

test("page has no external requests, browser errors, fake links or horizontal overflow", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:4323")
      external.push(request.url());
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  for (const width of [320, 375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      `overflow at ${width}px`,
    ).toBe(true);
  }
  await expect(page.locator('a[href="#"]')).toHaveCount(0);
  await expect(page.locator(".store-badge[href]")).toHaveCount(0);
  await page.setViewportSize(testInfo.project.use.viewport!);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    ),
  ).toBe("auto");
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  if (process.env.UPDATE_DESIGN_SCREENSHOTS === "1") {
    // Avoid a sticky header covering the top of element captures during scrolling.
    await page.addStyleTag({
      content: ".site-header { position: static !important; }",
    });
    const directory = fileURLToPath(
      new URL("../../../../docs/design/screenshots/", import.meta.url),
    );
    await mkdir(directory, { recursive: true });
    await page.screenshot({
      path: `${directory}/${testInfo.project.name}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.locator(".hero").screenshot({
      path: `${directory}/${testInfo.project.name}-hero.png`,
      animations: "disabled",
    });
    await page.locator("#planos").screenshot({
      path: `${directory}/${testInfo.project.name}-pricing.png`,
      animations: "disabled",
    });
  }
});
